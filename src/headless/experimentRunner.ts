import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { configureLibraryDir } from '../main/library'
import { loadCanonicalBookDocument } from '../main/canonicalStore'
import { getChunkSet, runChunking } from '../main/chunking'
import { listEmbeddingSets, runEmbedding } from '../main/embeddings'
import { listBm25Indexes, runBm25Indexing } from '../main/bm25'
import { fuseRrfHits, retrieve, type ScoredHit } from '../main/retrieval'
import { rerankVoyage, type VoyageRerankModel } from '../main/reranking'
import {
  bm25ArtifactIdentity,
  chunkArtifactIdentity,
  embeddingArtifactIdentity,
  embeddingDimensions
} from '../main/artifactConfig'
import { countChunkTokens } from '../main/tokenChunking'
import { getEvalSet } from '../main/evals'
import { strategyIdOf } from '../shared/strategy'
import { contentHash } from '../shared/artifactIdentity'
import { parseEvalSet } from '../shared/evalSchema'
import {
  assembleContextBudget,
  computeRetrievalMetrics,
  RETRIEVAL_METRIC_VERSION,
  type ContextCandidate
} from '../shared/evalMetrics'
import {
  parseExperimentConfig,
  type ExperimentConfig,
  type ExperimentContextPolicy,
  type ExperimentQueryMode,
  type ExperimentRetriever
} from '../shared/experimentSchema'
import type {
  ChunkSet,
  EmbeddingModel,
  EvalCase,
  RetrievedChunkPayload,
  RetrieverParams
} from '../preload/types'
import { readSourceControlState, type SourceControlState } from './sourceControl'
import { localRetrievalSidecar } from './localRetrievalSidecar'

export const HEADLESS_RUN_SCHEMA_VERSION = 1

interface LoadedExperiment extends Omit<ExperimentConfig, 'libraryDir' | 'outputDir'> {
  libraryDir: string
  outputDir: string
}

export interface PlannedArtifact {
  bookId: string
  strategyId: string
  chunkArtifactId: string
  chunkExists: boolean
  estimatedChunkTokens: number
  bm25ArtifactId?: string
  bm25Exists?: boolean
  embeddingArtifacts: Array<{
    model: EmbeddingModel
    artifactId: string
    exists: boolean
    estimatedTokens: number
    estimatedCostUsd: number | null
  }>
  localArtifacts: Array<{
    kind: 'colbertv2' | 'bge-m3'
    model: string
    artifactId: string
    artifactDir: string
    exists: boolean
  }>
}

export interface ExperimentPlan {
  schemaVersion: 1
  fingerprint: string
  name: string
  configPath: string
  libraryDir: string
  outputDir: string
  runPath: string
  sourceControl: SourceControlState
  books: Array<{
    bookId: string
    evalSetId: string
    sourceHash: string
    evalSetHash: string
    selectedCases: number
  }>
  artifacts: PlannedArtifact[]
  experimentCells: number
  retrievalQueries: number
  cachedRetrievalQueries: number
  missingRetrievalQueries: number
  estimatedEmbeddingTokens: number
  estimatedRerankTokens: number
  estimatedCostUsd: number | null
  unknownCostModels: Array<EmbeddingModel | VoyageRerankModel>
  warnings: string[]
}

interface PreparedBook {
  bookId: string
  evalSetId: string
  sourceHash: string
  evalSetHash: string
  cases: EvalCase[]
}

interface PreparedExperiment {
  configPath: string
  config: LoadedExperiment
  books: PreparedBook[]
}

export interface HeadlessResultRow {
  key: string
  bookId: string
  evalSetId: string
  caseId: string
  split: string
  scope: string
  strategyId: string
  chunkArtifactId: string
  retriever: ExperimentRetriever
  queryMode?: ExperimentQueryMode
  retrievalQuery?: string
  contextPolicy?: ExperimentContextPolicy
  routingPolicy?: { kind: 'flat' } | { kind: 'oracle' } | { kind: 'bge-profile'; topK: number }
  routedBookIds?: string[]
  routingMetrics?: { requiredBookRecall: number; allRequiredBooks: boolean }
  contextBudget: number
  retrievedChunkIds: string[]
  retrievedTokens: number
  metrics: Omit<ReturnType<typeof computeRetrievalMetrics>, 'candidateRelevance'>
}

interface QueryCacheEntry {
  schemaVersion?: 1
  chunkArtifactId: string
  hits: Array<{ chunkId: string; distance: number; rank: number }>
  routingLatencyMs?: number
  retrievalLatencyMs?: number
  embeddingModel?: EmbeddingModel
  embeddingQueryTokens?: number
  nominalEmbeddingQueryCostUsd?: number
  rerankLatencyMs?: number
  rerankModel?: VoyageRerankModel
  rerankTokens?: number
  nominalRerankCostUsd?: number
  createdAt?: number
}

export interface CostLedger {
  embeddingIndexTokens: number
  embeddingQueryTokens: number
  actualCostUsd: number
  rerankTokens: number
  rerankCostUsd: number
  byReranker: Partial<Record<VoyageRerankModel, { tokens: number; costUsd: number }>>
  byModel: Partial<
    Record<EmbeddingModel, { indexTokens: number; queryTokens: number; costUsd: number }>
  >
  indexingByArtifact: Array<{
    bookId: string
    strategyId: string
    chunkArtifactId: string
    embeddingArtifactId: string
    model: EmbeddingModel
    tokens: number
    costUsd: number
  }>
  localIndexes: Array<{
    bookId: string
    strategyId: string
    chunkArtifactId: string
    kind: 'colbertv2' | 'bge-m3'
    model: string
    artifactId: string
    indexingLatencyMs: number
    storageBytes: number
  }>
}

export interface HeadlessRun {
  schemaVersion: typeof HEADLESS_RUN_SCHEMA_VERSION
  fingerprint: string
  metricVersion?: number
  status: 'running' | 'completed' | 'failed'
  configPath: string
  plan: ExperimentPlan
  startedAt: number
  updatedAt: number
  completedAt?: number
  maxUsd: number
  ledger: CostLedger
  queryCache: Record<string, QueryCacheEntry>
  results: HeadlessResultRow[]
  error?: string
}

function resolveFrom(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path)
}

function reproducibleConfig(config: LoadedExperiment): object {
  return {
    schemaVersion: config.schemaVersion,
    metricVersion: RETRIEVAL_METRIC_VERSION,
    name: config.name,
    books: config.books.map((selection) => ({
      bookId: selection.bookId,
      evalSetId: selection.evalSetId ?? null,
      externalEvalSet: selection.evalSetPath !== undefined
    })),
    chunkers: config.chunkers,
    retrievers: config.retrievers,
    queryModes: config.queryModes,
    contextPolicies: config.contextPolicies,
    contextBudgets: config.contextBudgets,
    candidatePoolSize: config.candidatePoolSize,
    splits: config.splits,
    excludeEvidenceKinds: config.excludeEvidenceKinds,
    maxCasesPerBook: config.maxCasesPerBook,
    pricing: config.pricing
  }
}

export async function loadExperiment(
  configPath: string,
  libraryDirOverride?: string
): Promise<PreparedExperiment> {
  const absoluteConfigPath = resolve(configPath)
  const configDir = dirname(absoluteConfigPath)
  const raw = await fs.readFile(absoluteConfigPath, 'utf8')
  const parsed = parseExperimentConfig(parseYaml(raw) as unknown)
  const configuredLibraryDir =
    libraryDirOverride ?? parsed.libraryDir ?? process.env.BOOK_RAG_EVAL_LIBRARY_DIR
  if (!configuredLibraryDir) {
    throw new Error(
      'No library directory configured. Set libraryDir in the experiment or BOOK_RAG_EVAL_LIBRARY_DIR.'
    )
  }
  const config: LoadedExperiment = {
    ...parsed,
    libraryDir: resolveFrom(configDir, configuredLibraryDir),
    outputDir: resolveFrom(configDir, parsed.outputDir)
  }
  configureLibraryDir(config.libraryDir)

  const books: PreparedBook[] = []
  for (const selection of config.books) {
    const documentPromise = loadCanonicalBookDocument(selection.bookId)
    const evalSetPromise =
      selection.evalSetPath !== undefined
        ? fs
            .readFile(resolveFrom(configDir, selection.evalSetPath), 'utf8')
            .then((serialized) => parseEvalSet(JSON.parse(serialized) as unknown, selection.bookId))
        : getEvalSet(selection.bookId, selection.evalSetId!)
    const [document, evalSet] = await Promise.all([documentPromise, evalSetPromise])
    let cases = evalSet.cases.filter(
      (evalCase) =>
        config.splits.includes(evalCase.split) &&
        !evalCase.goldEvidence.some((evidence) =>
          config.excludeEvidenceKinds.includes(evidence.kind)
        )
    )
    if (config.maxCasesPerBook !== undefined) cases = cases.slice(0, config.maxCasesPerBook)
    books.push({
      bookId: selection.bookId,
      evalSetId: evalSet.id,
      sourceHash: document.sourceHash,
      evalSetHash: contentHash(evalSet),
      cases
    })
  }
  return { configPath: absoluteConfigPath, config, books }
}

function approximateChunkTokens(
  sourceTokens: number,
  chunker: ExperimentConfig['chunkers'][number]
): number {
  if (chunker.kind === 'fixed-token') {
    return Math.ceil(sourceTokens * (chunker.size / (chunker.size - chunker.overlap)))
  }
  if (chunker.kind === 'fixed') {
    return Math.ceil(sourceTokens * (chunker.size / (chunker.size - chunker.overlap)))
  }
  return Math.ceil(sourceTokens * 1.02)
}

function identitySet(
  bookId: string,
  chunker: ExperimentConfig['chunkers'][number],
  artifactId: string
): ChunkSet {
  return {
    artifactId,
    bookId,
    strategyId: strategyIdOf(chunker),
    params: chunker,
    count: 0,
    generatedAt: 0,
    chunks: []
  }
}

function embeddingModels(config: LoadedExperiment): EmbeddingModel[] {
  return [
    ...new Set(
      config.retrievers.flatMap((retriever) =>
        retriever.kind === 'vector' || retriever.kind === 'hybrid-rrf'
          ? [retriever.embeddingModel]
          : []
      )
    )
  ]
}

function retrieverNeedsEmbedding(
  retriever: ExperimentRetriever
): retriever is Extract<ExperimentRetriever, { kind: 'vector' | 'hybrid-rrf' }> {
  return retriever.kind === 'vector' || retriever.kind === 'hybrid-rrf'
}

function retrieverNeedsBm25(retriever: ExperimentRetriever): boolean {
  return retriever.kind === 'bm25' || retriever.kind === 'hybrid-rrf'
}

function retrieverParams(retriever: ExperimentRetriever): RetrieverParams {
  switch (retriever.kind) {
    case 'random':
      return { kind: 'random', seed: retriever.seed }
    case 'bm25':
      return { kind: 'bm25' }
    case 'vector':
      return { kind: 'vector' }
    case 'hybrid-rrf':
      return {
        kind: 'hybrid-rrf',
        rrfK: retriever.rrfK,
        vectorWeight: retriever.vectorWeight,
        bm25Weight: retriever.bm25Weight
      }
    case 'colbertv2':
    case 'bge-m3':
      throw new Error(`${retriever.kind} is handled by the local retrieval sidecar`)
  }
}

type LocalRetriever = Extract<ExperimentRetriever, { kind: 'colbertv2' | 'bge-m3' }>

function isLocalRetriever(retriever: ExperimentRetriever): retriever is LocalRetriever {
  return retriever.kind === 'colbertv2' || retriever.kind === 'bge-m3'
}

function localArtifactIdentity(chunkArtifactId: string, retriever: LocalRetriever): string {
  return contentHash({
    kind: retriever.kind,
    model: retriever.model,
    chunkArtifactId,
    maxLength: retriever.kind === 'bge-m3' ? 512 : undefined
  })
}

function localArtifactDir(
  outputDir: string,
  chunkArtifactId: string,
  retriever: LocalRetriever
): string {
  return join(
    dirname(outputDir),
    'artifacts',
    'local-retrieval',
    localArtifactIdentity(chunkArtifactId, retriever)
  )
}

async function localArtifactExists(artifactDir: string): Promise<boolean> {
  try {
    await fs.access(join(artifactDir, 'manifest.json'))
    return true
  } catch {
    return false
  }
}

function withoutReranker(retriever: ExperimentRetriever): ExperimentRetriever {
  const { reranker: _reranker, ...base } = retriever
  void _reranker
  return base as ExperimentRetriever
}

function priceOf(config: LoadedExperiment, model: EmbeddingModel): number | undefined {
  return config.pricing.embeddingUsdPerMillion[model]
}

function rerankPriceOf(config: LoadedExperiment, model: VoyageRerankModel): number | undefined {
  return config.pricing.rerankingUsdPerMillion[model]
}

export async function planExperiment(
  configPath: string,
  libraryDirOverride?: string
): Promise<ExperimentPlan> {
  const prepared = await loadExperiment(configPath, libraryDirOverride)
  const { config } = prepared
  const models = embeddingModels(config)
  const artifacts: PlannedArtifact[] = []
  const warnings: string[] = []
  const sourceControl = await readSourceControlState()
  if (sourceControl.gitCommit === null) {
    warnings.push('Git commit could not be resolved; this run is not tied to a source revision.')
  } else if (sourceControl.workingTreeDiffHash !== null) {
    warnings.push(
      `Tracked source changes are present (diff ${sourceControl.workingTreeDiffHash.slice(0, 12)}); commit before a portfolio run.`
    )
  }
  let estimatedEmbeddingTokens = 0
  let estimatedRerankTokenCount = 0
  let estimatedCostUsd = 0
  let cachedRetrievalQueries = 0
  let missingRetrievalQueries = 0
  const unknownCostModels = new Set<EmbeddingModel | VoyageRerankModel>()

  for (const book of prepared.books) {
    if (book.cases.some((evalCase) => evalCase.scope === 'library')) {
      warnings.push(
        `${book.bookId}/${book.evalSetId} contains library-scope cases; the current runner skips them until library-wide retrieval is enabled.`
      )
    }
    const document = await loadCanonicalBookDocument(book.bookId)
    const sourceTokens = document.spine.reduce(
      (total, spine) => total + countChunkTokens(spine.text),
      0
    )
    const [embeddingSets, bm25Sets] = await Promise.all([
      listEmbeddingSets(book.bookId),
      listBm25Indexes(book.bookId)
    ])

    for (const chunker of config.chunkers) {
      const strategyId = strategyIdOf(chunker)
      const chunkIdentity = chunkArtifactIdentity(book.bookId, chunker, document)
      let chunkSet: ChunkSet | null = null
      try {
        chunkSet = await getChunkSet(book.bookId, chunkIdentity.id)
      } catch {
        // Missing is expected in a plan.
      }
      const estimatedChunkTokens = chunkSet
        ? chunkSet.chunks.reduce(
            (total, chunk) => total + (chunk.tokenCount ?? countChunkTokens(chunk.text)),
            0
          )
        : approximateChunkTokens(sourceTokens, chunker)
      const setForIdentity = chunkSet ?? identitySet(book.bookId, chunker, chunkIdentity.id)
      const bm25Identity = bm25ArtifactIdentity(setForIdentity)
      const embeddingPlans = models.map((model) => {
        const identity = embeddingArtifactIdentity(
          setForIdentity,
          model,
          embeddingDimensions(model)
        )
        const exists = embeddingSets.some((set) => set.artifactId === identity.id)
        if (!exists) {
          estimatedEmbeddingTokens += estimatedChunkTokens
          const price = priceOf(config, model)
          if (price === undefined) unknownCostModels.add(model)
          else estimatedCostUsd += (estimatedChunkTokens / 1_000_000) * price
        }
        const price = priceOf(config, model)
        return {
          model,
          artifactId: identity.id,
          exists,
          estimatedTokens: exists ? 0 : estimatedChunkTokens,
          estimatedCostUsd:
            exists || price === undefined
              ? exists
                ? 0
                : null
              : (estimatedChunkTokens / 1_000_000) * price
        }
      })
      const localPlans: PlannedArtifact['localArtifacts'] = []
      const plannedLocalArtifacts = new Set<string>()
      for (const retriever of config.retrievers.filter(isLocalRetriever)) {
        const artifactId = localArtifactIdentity(chunkIdentity.id, retriever)
        if (plannedLocalArtifacts.has(artifactId)) continue
        plannedLocalArtifacts.add(artifactId)
        const artifactDir = localArtifactDir(config.outputDir, chunkIdentity.id, retriever)
        localPlans.push({
          kind: retriever.kind,
          model: retriever.model,
          artifactId,
          artifactDir,
          exists: await localArtifactExists(artifactDir)
        })
      }
      artifacts.push({
        bookId: book.bookId,
        strategyId,
        chunkArtifactId: chunkIdentity.id,
        chunkExists: chunkSet !== null,
        estimatedChunkTokens,
        bm25ArtifactId: bm25Identity.id,
        bm25Exists: bm25Sets.some((set) => set.artifactId === bm25Identity.id),
        embeddingArtifacts: embeddingPlans,
        localArtifacts: localPlans
      })

      for (const retriever of config.retrievers) {
        for (const evalCase of book.cases.filter(
          (candidate) => candidate.scope === 'within_book'
        )) {
          for (const queryMode of config.queryModes) {
            const retrievalQuery = retrievalQueryFor(evalCase, queryMode)
            const queryId = queryKey(
              book.bookId,
              chunkIdentity.id,
              retriever,
              evalCase,
              queryMode,
              retrievalQuery,
              config.candidatePoolSize
            )
            const cached = await resolveRetrievalTrace(
              config.outputDir,
              queryId,
              book.bookId,
              chunkIdentity.id,
              retriever,
              evalCase,
              queryMode,
              retrievalQuery,
              config.candidatePoolSize
            )
            if (cached) {
              cachedRetrievalQueries += 1
              continue
            }
            missingRetrievalQueries += 1
            const baseRetriever = withoutReranker(retriever)
            const baseQueryId = queryKey(
              book.bookId,
              chunkIdentity.id,
              baseRetriever,
              evalCase,
              queryMode,
              retrievalQuery,
              config.candidatePoolSize
            )
            const baseCached = retriever.reranker
              ? await resolveRetrievalTrace(
                  config.outputDir,
                  baseQueryId,
                  book.bookId,
                  chunkIdentity.id,
                  baseRetriever,
                  evalCase,
                  queryMode,
                  retrievalQuery,
                  config.candidatePoolSize
                )
              : null
            if (retriever.reranker) {
              const estimatedTokens =
                baseCached && chunkSet
                  ? estimatedRerankTokens(
                      retrievalQuery,
                      reconstructHits(baseCached.trace, chunkSet)
                    )
                  : countChunkTokens(retrievalQuery) * config.candidatePoolSize +
                    Math.ceil(
                      (estimatedChunkTokens / Math.max(chunkSet?.chunks.length ?? 1, 1)) *
                        config.candidatePoolSize
                    )
              estimatedRerankTokenCount += estimatedTokens
              const rerankPrice = rerankPriceOf(config, retriever.reranker.model)
              if (rerankPrice === undefined) unknownCostModels.add(retriever.reranker.model)
              else estimatedCostUsd += (estimatedTokens / 1_000_000) * rerankPrice
            }
            if (!retrieverNeedsEmbedding(retriever) || baseCached) continue
            const queryTokens = countChunkTokens(retrievalQuery)
            estimatedEmbeddingTokens += queryTokens
            const price = priceOf(config, retriever.embeddingModel)
            if (price === undefined) unknownCostModels.add(retriever.embeddingModel)
            else estimatedCostUsd += (queryTokens / 1_000_000) * price
          }
        }
      }
    }
  }

  const fingerprint = contentHash({
    config: reproducibleConfig(config),
    sourceControl,
    books: prepared.books.map((book) => ({
      bookId: book.bookId,
      sourceHash: book.sourceHash,
      evalSetHash: book.evalSetHash,
      caseIds: book.cases.map((evalCase) => evalCase.id)
    }))
  })
  const runPath = join(config.outputDir, `${config.name}-${fingerprint.slice(0, 16)}.json`)
  const withinBookCases = prepared.books.reduce(
    (total, book) =>
      total + book.cases.filter((evalCase) => evalCase.scope === 'within_book').length,
    0
  )
  const retrievalQueries =
    withinBookCases * config.chunkers.length * config.retrievers.length * config.queryModes.length
  const experimentCells =
    retrievalQueries * config.contextPolicies.length * config.contextBudgets.length

  return {
    schemaVersion: 1,
    fingerprint,
    name: config.name,
    configPath: prepared.configPath,
    libraryDir: config.libraryDir,
    outputDir: config.outputDir,
    runPath,
    sourceControl,
    books: prepared.books.map((book) => ({
      bookId: book.bookId,
      evalSetId: book.evalSetId,
      sourceHash: book.sourceHash,
      evalSetHash: book.evalSetHash,
      selectedCases: book.cases.length
    })),
    artifacts,
    experimentCells,
    retrievalQueries,
    cachedRetrievalQueries,
    missingRetrievalQueries,
    estimatedEmbeddingTokens,
    estimatedRerankTokens: estimatedRerankTokenCount,
    estimatedCostUsd: unknownCostModels.size === 0 ? estimatedCostUsd : null,
    unknownCostModels: [...unknownCostModels],
    warnings
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temporaryPath, path)
}

function retrievalTracePath(outputDir: string, queryId: string): string {
  return join(dirname(outputDir), 'cache', 'retrieval', `${queryId}.json`)
}

async function readRetrievalTrace(
  outputDir: string,
  queryId: string
): Promise<QueryCacheEntry | null> {
  try {
    const trace = JSON.parse(
      await fs.readFile(retrievalTracePath(outputDir, queryId), 'utf8')
    ) as QueryCacheEntry
    return trace.chunkArtifactId && Array.isArray(trace.hits) ? trace : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeRetrievalTrace(
  outputDir: string,
  queryId: string,
  trace: QueryCacheEntry
): Promise<void> {
  await writeJsonAtomic(retrievalTracePath(outputDir, queryId), trace)
}

interface ResolvedRetrievalTrace {
  trace: QueryCacheEntry
  synthesized: boolean
}

function scoredHits(trace: QueryCacheEntry): ScoredHit[] {
  return trace.hits.map((hit) => ({
    id: hit.chunkId,
    score: hit.distance,
    rank: hit.rank
  }))
}

async function resolveRetrievalTrace(
  outputDir: string,
  queryId: string,
  bookId: string,
  chunkArtifactId: string,
  retriever: ExperimentRetriever,
  evalCase: EvalCase,
  queryMode: ExperimentQueryMode,
  retrievalQuery: string,
  candidatePoolSize: number
): Promise<ResolvedRetrievalTrace | null> {
  const direct = await readRetrievalTrace(outputDir, queryId)
  if (direct?.chunkArtifactId === chunkArtifactId) {
    return { trace: direct, synthesized: false }
  }
  if (retriever.reranker) return null
  if (retriever.kind !== 'hybrid-rrf') return null

  const vectorRetriever: ExperimentRetriever = {
    kind: 'vector',
    embeddingModel: retriever.embeddingModel
  }
  const bm25Retriever: ExperimentRetriever = { kind: 'bm25' }
  const vectorQueryId = queryKey(
    bookId,
    chunkArtifactId,
    vectorRetriever,
    evalCase,
    queryMode,
    retrievalQuery,
    candidatePoolSize
  )
  const bm25QueryId = queryKey(
    bookId,
    chunkArtifactId,
    bm25Retriever,
    evalCase,
    queryMode,
    retrievalQuery,
    candidatePoolSize
  )
  const [vectorTrace, bm25Trace] = await Promise.all([
    readRetrievalTrace(outputDir, vectorQueryId),
    readRetrievalTrace(outputDir, bm25QueryId)
  ])
  if (
    vectorTrace?.chunkArtifactId !== chunkArtifactId ||
    bm25Trace?.chunkArtifactId !== chunkArtifactId
  ) {
    return null
  }

  const startedAt = performance.now()
  const hits = fuseRrfHits(
    [
      { hits: scoredHits(vectorTrace), weight: retriever.vectorWeight },
      { hits: scoredHits(bm25Trace), weight: retriever.bm25Weight }
    ],
    retriever.rrfK
  ).slice(0, candidatePoolSize)
  const fusionLatencyMs = performance.now() - startedAt
  return {
    synthesized: true,
    trace: {
      schemaVersion: 1,
      chunkArtifactId,
      retrievalLatencyMs:
        Math.max(vectorTrace.retrievalLatencyMs ?? 0, bm25Trace.retrievalLatencyMs ?? 0) +
        fusionLatencyMs,
      embeddingModel: vectorTrace.embeddingModel,
      embeddingQueryTokens: vectorTrace.embeddingQueryTokens,
      nominalEmbeddingQueryCostUsd: vectorTrace.nominalEmbeddingQueryCostUsd,
      createdAt: Date.now(),
      hits: hits.map((hit) => ({
        chunkId: hit.id,
        distance: hit.score,
        rank: hit.rank
      }))
    }
  }
}

function emptyLedger(): CostLedger {
  return {
    embeddingIndexTokens: 0,
    embeddingQueryTokens: 0,
    actualCostUsd: 0,
    rerankTokens: 0,
    rerankCostUsd: 0,
    byReranker: {},
    byModel: {},
    indexingByArtifact: [],
    localIndexes: []
  }
}

interface IndexCostContext {
  bookId: string
  strategyId: string
  chunkArtifactId: string
  embeddingArtifactId: string
}

function recordCost(
  run: HeadlessRun,
  config: LoadedExperiment,
  model: EmbeddingModel,
  kind: 'index' | 'query',
  tokens: number,
  indexContext?: IndexCostContext
): number {
  const price = priceOf(config, model)
  if (price === undefined) {
    throw new Error(`No embedding price configured for ${model}`)
  }
  const cost = (tokens / 1_000_000) * price
  const current = run.ledger.byModel[model] ?? { indexTokens: 0, queryTokens: 0, costUsd: 0 }
  if (kind === 'index') {
    if (!indexContext) throw new Error('Index cost recording requires artifact context')
    run.ledger.embeddingIndexTokens += tokens
    current.indexTokens += tokens
    run.ledger.indexingByArtifact ??= []
    const existing = run.ledger.indexingByArtifact.find(
      (item) => item.embeddingArtifactId === indexContext.embeddingArtifactId
    )
    if (existing) {
      existing.tokens += tokens
      existing.costUsd += cost
    } else {
      run.ledger.indexingByArtifact.push({
        ...indexContext,
        model,
        tokens,
        costUsd: cost
      })
    }
  } else {
    run.ledger.embeddingQueryTokens += tokens
    current.queryTokens += tokens
  }
  current.costUsd += cost
  run.ledger.byModel[model] = current
  run.ledger.actualCostUsd += cost
  if (run.ledger.actualCostUsd > run.maxUsd + 1e-9) {
    throw new Error(
      `Cost ceiling exceeded: $${run.ledger.actualCostUsd.toFixed(6)} > $${run.maxUsd.toFixed(6)}`
    )
  }
  return cost
}

function assertAffordable(
  run: HeadlessRun,
  config: LoadedExperiment,
  model: EmbeddingModel,
  tokens: number
): void {
  const price = priceOf(config, model)
  if (price === undefined) throw new Error(`No embedding price configured for ${model}`)
  const projected = run.ledger.actualCostUsd + (tokens / 1_000_000) * price
  if (projected > run.maxUsd + 1e-9) {
    throw new Error(
      `Cost ceiling would be exceeded: projected $${projected.toFixed(6)} > $${run.maxUsd.toFixed(6)}`
    )
  }
}

function recordRerankCost(
  run: HeadlessRun,
  config: LoadedExperiment,
  model: VoyageRerankModel,
  tokens: number
): number {
  const price = rerankPriceOf(config, model)
  if (price === undefined) throw new Error(`No reranking price configured for ${model}`)
  const cost = (tokens / 1_000_000) * price
  const current = run.ledger.byReranker[model] ?? { tokens: 0, costUsd: 0 }
  current.tokens += tokens
  current.costUsd += cost
  run.ledger.byReranker[model] = current
  run.ledger.rerankTokens += tokens
  run.ledger.rerankCostUsd += cost
  run.ledger.actualCostUsd += cost
  if (run.ledger.actualCostUsd > run.maxUsd + 1e-9) {
    throw new Error(
      `Cost ceiling exceeded: $${run.ledger.actualCostUsd.toFixed(6)} > $${run.maxUsd.toFixed(6)}`
    )
  }
  return cost
}

function assertRerankAffordable(
  run: HeadlessRun,
  config: LoadedExperiment,
  model: VoyageRerankModel,
  estimatedTokens: number
): void {
  const price = rerankPriceOf(config, model)
  if (price === undefined) throw new Error(`No reranking price configured for ${model}`)
  const projected = run.ledger.actualCostUsd + (estimatedTokens / 1_000_000) * price
  if (projected > run.maxUsd + 1e-9) {
    throw new Error(
      `Cost ceiling would be exceeded: projected $${projected.toFixed(6)} > $${run.maxUsd.toFixed(6)}`
    )
  }
}

function estimatedRerankTokens(query: string, hits: RetrievedChunkPayload[]): number {
  return (
    countChunkTokens(query) * hits.length +
    hits.reduce(
      (total, hit) => total + (hit.chunk.tokenCount ?? countChunkTokens(hit.chunk.text)),
      0
    )
  )
}

function queryKey(
  bookId: string,
  chunkArtifactId: string,
  retriever: ExperimentRetriever,
  evalCase: EvalCase,
  queryMode: ExperimentQueryMode,
  retrievalQuery: string,
  candidatePoolSize: number
): string {
  return contentHash({
    bookId,
    chunkArtifactId,
    retriever,
    caseId: evalCase.id,
    queryMode,
    query: retrievalQuery,
    candidatePoolSize
  })
}

function retrievalQueryFor(evalCase: EvalCase, queryMode: ExperimentQueryMode): string {
  return queryMode === 'question' ? evalCase.question : evalCase.canonicalSearchQuery
}

function contextPolicyId(policy: ExperimentContextPolicy): string {
  return policy.kind === 'chunks' ? 'chunks' : `neighbors-${policy.window}`
}

function resultKey(
  queryId: string,
  contextPolicy: ExperimentContextPolicy,
  contextBudget: number
): string {
  return `${queryId}:${contextPolicyId(contextPolicy)}:${contextBudget}`
}

function reconstructHits(cache: QueryCacheEntry, set: ChunkSet): RetrievedChunkPayload[] {
  const chunks = new Map(set.chunks.map((chunk) => [chunk.id, chunk]))
  return cache.hits.flatMap((hit) => {
    const chunk = chunks.get(hit.chunkId)
    return chunk ? [{ chunk, distance: hit.distance, rank: hit.rank }] : []
  })
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? await directorySize(child) : (await fs.stat(child)).size
  }
  return total
}

async function ensureLocalIndex(
  outputDir: string,
  set: ChunkSet,
  retriever: LocalRetriever
): Promise<{
  artifactId: string
  artifactDir: string
  built: boolean
  indexingLatencyMs: number
  storageBytes: number
}> {
  const artifactId = localArtifactIdentity(set.artifactId!, retriever)
  const artifactDir = localArtifactDir(outputDir, set.artifactId!, retriever)
  if (await localArtifactExists(artifactDir)) {
    const manifest = JSON.parse(await fs.readFile(join(artifactDir, 'manifest.json'), 'utf8')) as {
      indexingLatencyMs?: number
    }
    return {
      artifactId,
      artifactDir,
      built: false,
      indexingLatencyMs: manifest.indexingLatencyMs ?? 0,
      storageBytes: await directorySize(artifactDir)
    }
  }
  const documents = set.chunks.map((chunk) => ({ id: chunk.id, text: chunk.text }))
  const result =
    retriever.kind === 'colbertv2'
      ? await localRetrievalSidecar.indexColbert(artifactDir, documents, retriever.model)
      : await localRetrievalSidecar.indexBge(artifactDir, documents, retriever.model)
  return {
    artifactId,
    artifactDir,
    built: true,
    indexingLatencyMs: result.indexingLatencyMs,
    storageBytes: await directorySize(artifactDir)
  }
}

async function retrieveLocal(
  outputDir: string,
  set: ChunkSet,
  retriever: LocalRetriever,
  query: string,
  k: number
): Promise<{ hits: RetrievedChunkPayload[]; latencyMs: number }> {
  const { artifactDir } = await ensureLocalIndex(outputDir, set, retriever)
  const result =
    retriever.kind === 'colbertv2'
      ? await localRetrievalSidecar.queryColbert(artifactDir, query, k)
      : await localRetrievalSidecar.queryBge(
          artifactDir,
          query,
          k,
          retriever.mode,
          retriever.shortlist
        )
  const chunks = new Map(set.chunks.map((chunk) => [chunk.id, chunk]))
  return {
    latencyMs: result.queryLatencyMs,
    hits: result.hits.flatMap((hit) => {
      const chunk = chunks.get(hit.id)
      return chunk ? [{ chunk, distance: -hit.score, rank: hit.rank }] : []
    })
  }
}

function contextCandidates(bookId: string, hits: RetrievedChunkPayload[]): ContextCandidate[] {
  return hits.map(({ chunk }) => ({
    id: chunk.id,
    bookId,
    spineHref: chunk.spineHref,
    textStart: chunk.textStart,
    textEnd: chunk.textEnd,
    canonicalNodeIds: chunk.canonicalNodeIds ?? [],
    tokenCount: chunk.tokenCount ?? countChunkTokens(chunk.text),
    text: chunk.text
  }))
}

function applyContextPolicy(
  hits: RetrievedChunkPayload[],
  set: ChunkSet,
  policy: ExperimentContextPolicy
): RetrievedChunkPayload[] {
  if (policy.kind === 'chunks') return hits

  const chunkIndex = new Map(set.chunks.map((chunk, index) => [chunk.id, index]))
  const seen = new Set<string>()
  const expanded: RetrievedChunkPayload[] = []
  for (const hit of hits) {
    const index = chunkIndex.get(hit.chunk.id)
    if (index === undefined) continue
    for (let offset = -policy.window; offset <= policy.window; offset++) {
      const chunk = set.chunks[index + offset]
      if (!chunk || chunk.spineHref !== hit.chunk.spineHref || seen.has(chunk.id)) continue
      seen.add(chunk.id)
      expanded.push({ chunk, distance: hit.distance, rank: expanded.length + 1 })
    }
  }
  return expanded
}

async function readExistingRun(path: string, fingerprint: string): Promise<HeadlessRun | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as HeadlessRun
    if (
      parsed.schemaVersion !== HEADLESS_RUN_SCHEMA_VERSION ||
      parsed.fingerprint !== fingerprint
    ) {
      throw new Error(`Existing run at ${path} has a different fingerprint or schema`)
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function runExperiment(
  configPath: string,
  maxUsd: number,
  options: { libraryDir?: string; resume?: boolean } = {}
): Promise<HeadlessRun> {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error('--max-usd must be non-negative')
  const prepared = await loadExperiment(configPath, options.libraryDir)
  const plan = await planExperiment(configPath, options.libraryDir)
  if (plan.unknownCostModels.length > 0) {
    throw new Error(`Missing pricing for: ${plan.unknownCostModels.join(', ')}`)
  }
  if (plan.estimatedCostUsd !== null && plan.estimatedCostUsd > maxUsd) {
    throw new Error(
      `Planned cost $${plan.estimatedCostUsd.toFixed(6)} exceeds --max-usd $${maxUsd.toFixed(6)}`
    )
  }

  const existing = options.resume ? await readExistingRun(plan.runPath, plan.fingerprint) : null
  if (!options.resume && (await readExistingRun(plan.runPath, plan.fingerprint))) {
    throw new Error(`Run already exists at ${plan.runPath}; use resume`)
  }
  const run: HeadlessRun = existing ?? {
    schemaVersion: HEADLESS_RUN_SCHEMA_VERSION,
    fingerprint: plan.fingerprint,
    metricVersion: RETRIEVAL_METRIC_VERSION,
    status: 'running',
    configPath: prepared.configPath,
    plan,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    maxUsd,
    ledger: emptyLedger(),
    queryCache: {},
    results: []
  }
  run.ledger.indexingByArtifact ??= []
  run.ledger.localIndexes ??= []
  run.ledger.rerankTokens ??= 0
  run.ledger.rerankCostUsd ??= 0
  run.ledger.byReranker ??= {}
  if (run.ledger.actualCostUsd > maxUsd + 1e-9) {
    throw new Error(
      `Existing run has already spent $${run.ledger.actualCostUsd.toFixed(6)}, above the new --max-usd $${maxUsd.toFixed(6)}`
    )
  }
  run.status = 'running'
  run.maxUsd = maxUsd
  delete run.error
  await writeJsonAtomic(plan.runPath, run)

  try {
    const completed = new Set(run.results.map((row) => row.key))
    let resultsSinceCheckpoint = 0
    for (const book of prepared.books) {
      for (const chunker of prepared.config.chunkers) {
        const summary = await runChunking(book.bookId, chunker)
        const set = await getChunkSet(book.bookId, summary.artifactId ?? summary.strategyId)
        const chunkArtifactId = set.artifactId!

        for (const retriever of prepared.config.retrievers) {
          if (isLocalRetriever(retriever)) {
            const localIndex = await ensureLocalIndex(run.plan.outputDir, set, retriever)
            if (
              !run.ledger.localIndexes.some((item) => item.artifactId === localIndex.artifactId)
            ) {
              run.ledger.localIndexes.push({
                bookId: book.bookId,
                strategyId: set.strategyId,
                chunkArtifactId,
                kind: retriever.kind,
                model: retriever.model,
                artifactId: localIndex.artifactId,
                indexingLatencyMs: localIndex.indexingLatencyMs,
                storageBytes: localIndex.storageBytes
              })
              run.updatedAt = Date.now()
              await writeJsonAtomic(plan.runPath, run)
            }
          }
          if (retrieverNeedsBm25(retriever)) {
            await runBm25Indexing(book.bookId, set.strategyId)
          }
          if (retrieverNeedsEmbedding(retriever)) {
            const exactTokens = set.chunks.reduce(
              (total, chunk) => total + (chunk.tokenCount ?? countChunkTokens(chunk.text)),
              0
            )
            const existingEmbedding = (await listEmbeddingSets(book.bookId)).find(
              (item) =>
                item.artifactId ===
                embeddingArtifactIdentity(
                  set,
                  retriever.embeddingModel,
                  embeddingDimensions(retriever.embeddingModel)
                ).id
            )
            if (!existingEmbedding || existingEmbedding.count !== set.chunks.length) {
              assertAffordable(run, prepared.config, retriever.embeddingModel, exactTokens)
            }
            const embeddingIdentity = embeddingArtifactIdentity(
              set,
              retriever.embeddingModel,
              embeddingDimensions(retriever.embeddingModel)
            )
            await runEmbedding(
              book.bookId,
              set.strategyId,
              retriever.embeddingModel,
              async (tokens) => {
                recordCost(run, prepared.config, retriever.embeddingModel, 'index', tokens, {
                  bookId: book.bookId,
                  strategyId: set.strategyId,
                  chunkArtifactId,
                  embeddingArtifactId: embeddingIdentity.id
                })
                run.updatedAt = Date.now()
                await writeJsonAtomic(plan.runPath, run)
              }
            )
          }

          for (const evalCase of book.cases) {
            if (evalCase.scope !== 'within_book') continue
            for (const queryMode of prepared.config.queryModes) {
              const retrievalQuery = retrievalQueryFor(evalCase, queryMode)
              const queryId = queryKey(
                book.bookId,
                chunkArtifactId,
                retriever,
                evalCase,
                queryMode,
                retrievalQuery,
                prepared.config.candidatePoolSize
              )
              const missingCells = prepared.config.contextPolicies.flatMap((contextPolicy) =>
                prepared.config.contextBudgets.flatMap((budget) =>
                  completed.has(resultKey(queryId, contextPolicy, budget))
                    ? []
                    : [{ contextPolicy, budget }]
                )
              )
              if (missingCells.length === 0) continue

              let hits: RetrievedChunkPayload[]
              const cachedFromRun = run.queryCache[queryId]
              const resolvedTrace = cachedFromRun
                ? { trace: cachedFromRun, synthesized: false }
                : await resolveRetrievalTrace(
                    run.plan.outputDir,
                    queryId,
                    book.bookId,
                    chunkArtifactId,
                    retriever,
                    evalCase,
                    queryMode,
                    retrievalQuery,
                    prepared.config.candidatePoolSize
                  )
              if (resolvedTrace) {
                hits = reconstructHits(resolvedTrace.trace, set)
                run.queryCache[queryId] = resolvedTrace.trace
                if (resolvedTrace.synthesized) {
                  await writeRetrievalTrace(run.plan.outputDir, queryId, resolvedTrace.trace)
                }
              } else {
                const baseRetriever = withoutReranker(retriever)
                const baseQueryId = queryKey(
                  book.bookId,
                  chunkArtifactId,
                  baseRetriever,
                  evalCase,
                  queryMode,
                  retrievalQuery,
                  prepared.config.candidatePoolSize
                )
                const baseResolved = retriever.reranker
                  ? await resolveRetrievalTrace(
                      run.plan.outputDir,
                      baseQueryId,
                      book.bookId,
                      chunkArtifactId,
                      baseRetriever,
                      evalCase,
                      queryMode,
                      retrievalQuery,
                      prepared.config.candidatePoolSize
                    )
                  : null
                let baseHits: RetrievedChunkPayload[]
                let retrievalLatencyMs = 0
                let embeddingModel: EmbeddingModel | undefined
                let embeddingQueryTokens: number | undefined
                let nominalEmbeddingQueryCostUsd: number | undefined
                if (baseResolved) {
                  baseHits = reconstructHits(baseResolved.trace, set)
                  retrievalLatencyMs = baseResolved.trace.retrievalLatencyMs ?? 0
                  embeddingModel = baseResolved.trace.embeddingModel
                  embeddingQueryTokens = baseResolved.trace.embeddingQueryTokens
                  nominalEmbeddingQueryCostUsd = baseResolved.trace.nominalEmbeddingQueryCostUsd
                  if (baseResolved.synthesized) {
                    await writeRetrievalTrace(run.plan.outputDir, baseQueryId, baseResolved.trace)
                  }
                } else {
                  if (retrieverNeedsEmbedding(baseRetriever)) {
                    assertAffordable(
                      run,
                      prepared.config,
                      baseRetriever.embeddingModel,
                      countChunkTokens(retrievalQuery)
                    )
                  }
                  const retrievalStartedAt = performance.now()
                  if (isLocalRetriever(baseRetriever)) {
                    const local = await retrieveLocal(
                      run.plan.outputDir,
                      set,
                      baseRetriever,
                      retrievalQuery,
                      prepared.config.candidatePoolSize
                    )
                    baseHits = local.hits
                    retrievalLatencyMs = local.latencyMs
                  } else {
                    baseHits = await retrieve(
                      book.bookId,
                      set.strategyId,
                      retrieverParams(baseRetriever),
                      baseRetriever.kind === 'random' ? evalCase.id : retrievalQuery,
                      prepared.config.candidatePoolSize,
                      retrieverNeedsEmbedding(baseRetriever)
                        ? baseRetriever.embeddingModel
                        : undefined,
                      (model, tokens) => {
                        embeddingModel = model
                        embeddingQueryTokens = (embeddingQueryTokens ?? 0) + tokens
                        nominalEmbeddingQueryCostUsd =
                          (nominalEmbeddingQueryCostUsd ?? 0) +
                          recordCost(run, prepared.config, model, 'query', tokens)
                      }
                    )
                    retrievalLatencyMs = performance.now() - retrievalStartedAt
                  }
                  if (retriever.reranker) {
                    await writeRetrievalTrace(run.plan.outputDir, baseQueryId, {
                      schemaVersion: 1,
                      chunkArtifactId,
                      retrievalLatencyMs,
                      embeddingModel,
                      embeddingQueryTokens,
                      nominalEmbeddingQueryCostUsd,
                      createdAt: Date.now(),
                      hits: baseHits.map((hit) => ({
                        chunkId: hit.chunk.id,
                        distance: hit.distance,
                        rank: hit.rank
                      }))
                    })
                  }
                }

                let rerankLatencyMs: number | undefined
                let rerankTokens: number | undefined
                let nominalRerankCostUsd: number | undefined
                if (retriever.reranker) {
                  const estimatedTokens = estimatedRerankTokens(retrievalQuery, baseHits)
                  assertRerankAffordable(
                    run,
                    prepared.config,
                    retriever.reranker.model,
                    Math.ceil(estimatedTokens * 1.2)
                  )
                  const rerankStartedAt = performance.now()
                  const reranked = await rerankVoyage(
                    retrievalQuery,
                    baseHits,
                    retriever.reranker.model
                  )
                  rerankLatencyMs = performance.now() - rerankStartedAt
                  rerankTokens = reranked.tokens ?? estimatedTokens
                  nominalRerankCostUsd = recordRerankCost(
                    run,
                    prepared.config,
                    retriever.reranker.model,
                    rerankTokens
                  )
                  hits = reranked.hits
                } else {
                  hits = baseHits
                }
                const trace: QueryCacheEntry = {
                  schemaVersion: 1,
                  chunkArtifactId,
                  retrievalLatencyMs,
                  embeddingModel,
                  embeddingQueryTokens,
                  nominalEmbeddingQueryCostUsd,
                  rerankLatencyMs,
                  rerankModel: retriever.reranker?.model,
                  rerankTokens,
                  nominalRerankCostUsd,
                  createdAt: Date.now(),
                  hits: hits.map((hit) => ({
                    chunkId: hit.chunk.id,
                    distance: hit.distance,
                    rank: hit.rank
                  }))
                }
                run.queryCache[queryId] = trace
                await writeRetrievalTrace(run.plan.outputDir, queryId, trace)
                run.updatedAt = Date.now()
                await writeJsonAtomic(plan.runPath, run)
              }

              for (const { contextPolicy, budget } of missingCells) {
                const contextHits = applyContextPolicy(hits, set, contextPolicy)
                const assembled = assembleContextBudget(
                  contextCandidates(book.bookId, contextHits),
                  budget,
                  countChunkTokens
                )
                const metricCandidates = assembled.items.map((item) => ({
                  ...item.candidate,
                  tokenCount: item.tokenCount,
                  sourceRanges: item.sourceRanges,
                  payloadSegments: item.payloadSegments
                }))
                const metrics = computeRetrievalMetrics(metricCandidates, evalCase.goldEvidence, {
                  contextBudgetTokens: budget,
                  countTokens: countChunkTokens
                })
                const { candidateRelevance, ...persistedMetrics } = metrics
                void candidateRelevance
                const key = resultKey(queryId, contextPolicy, budget)
                run.results.push({
                  key,
                  bookId: book.bookId,
                  evalSetId: book.evalSetId,
                  caseId: evalCase.id,
                  split: evalCase.split,
                  scope: evalCase.scope,
                  strategyId: set.strategyId,
                  chunkArtifactId,
                  retriever,
                  queryMode,
                  retrievalQuery,
                  contextPolicy,
                  contextBudget: budget,
                  retrievedChunkIds: assembled.items.map((item) => item.candidate.id),
                  retrievedTokens: assembled.totalTokens,
                  metrics: persistedMetrics
                })
                completed.add(key)
                run.updatedAt = Date.now()
                resultsSinceCheckpoint += 1
                if (resultsSinceCheckpoint >= 100) {
                  await writeJsonAtomic(plan.runPath, run)
                  resultsSinceCheckpoint = 0
                }
              }
            }
          }
        }
      }
    }
    run.status = 'completed'
    run.completedAt = Date.now()
    run.updatedAt = run.completedAt
    await writeJsonAtomic(plan.runPath, run)
    return run
  } catch (error) {
    run.status = 'failed'
    run.error = (error as Error).message
    run.updatedAt = Date.now()
    await writeJsonAtomic(plan.runPath, run)
    throw error
  } finally {
    localRetrievalSidecar.stop()
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

export async function cacheRunRetrievalTraces(
  runPath: string
): Promise<{ cached: number; cacheDir: string }> {
  const absoluteRunPath = resolve(runPath)
  const run = JSON.parse(await fs.readFile(absoluteRunPath, 'utf8')) as HeadlessRun
  let cached = 0
  for (const [queryId, trace] of Object.entries(run.queryCache)) {
    await writeRetrievalTrace(run.plan.outputDir, queryId, {
      schemaVersion: 1,
      createdAt: trace.createdAt ?? run.updatedAt,
      ...trace
    })
    cached += 1
  }
  return {
    cached,
    cacheDir: join(dirname(run.plan.outputDir), 'cache', 'retrieval')
  }
}

export async function exportRun(runPath: string, format: 'jsonl' | 'csv'): Promise<string> {
  const absoluteRunPath = resolve(runPath)
  const run = JSON.parse(await fs.readFile(absoluteRunPath, 'utf8')) as HeadlessRun
  const outputPath = absoluteRunPath.replace(/\.json$/i, `.${format}`)
  if (format === 'jsonl') {
    await fs.writeFile(
      outputPath,
      run.results.map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8'
    )
    return outputPath
  }

  const headers = [
    'bookId',
    'evalSetId',
    'caseId',
    'split',
    'scope',
    'strategyId',
    'chunkArtifactId',
    'retriever',
    'queryMode',
    'retrievalQuery',
    'contextPolicy',
    'contextBudget',
    'retrievedTokens',
    'hitAtK',
    'mrr',
    'ndcgAtK',
    'evidenceRecall',
    'fullEvidenceSuccess',
    'contextPrecision',
    'exactEvidenceDensity',
    'goldSpanCoverage',
    'tokensBeforeFirstEvidence',
    'tokensToFirstEvidence',
    'tokensToFullEvidence',
    'evidenceEfficiency',
    'payloadEvidenceEfficiency',
    'correctBookRecall'
  ]
  const lines = [
    headers.map(csvCell).join(','),
    ...run.results.map((row) =>
      [
        row.bookId,
        row.evalSetId,
        row.caseId,
        row.split,
        row.scope,
        row.strategyId,
        row.chunkArtifactId,
        JSON.stringify(row.retriever),
        row.queryMode ?? 'reference',
        row.retrievalQuery ?? '',
        JSON.stringify(row.contextPolicy ?? { kind: 'chunks' }),
        row.contextBudget,
        row.retrievedTokens,
        row.metrics.hitAtK,
        row.metrics.mrr,
        row.metrics.ndcgAtK,
        row.metrics.evidenceRecall,
        row.metrics.fullEvidenceSuccess,
        row.metrics.contextPrecision,
        row.metrics.exactEvidenceDensity,
        row.metrics.goldSpanCoverage,
        row.metrics.tokensBeforeFirstEvidence,
        row.metrics.tokensToFirstEvidence,
        row.metrics.tokensToFullEvidence,
        row.metrics.evidenceEfficiency,
        row.metrics.payloadEvidenceEfficiency,
        row.metrics.correctBookRecall
      ]
        .map(csvCell)
        .join(',')
    )
  ]
  await fs.writeFile(outputPath, lines.join('\n') + '\n', 'utf8')
  return outputPath
}
