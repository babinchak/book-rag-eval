import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { configureLibraryDir } from '../main/library'
import { loadCanonicalBookDocument } from '../main/canonicalStore'
import { getChunkSet, runChunking } from '../main/chunking'
import { listEmbeddingSets, runEmbedding } from '../main/embeddings'
import { listBm25Indexes, runBm25Indexing } from '../main/bm25'
import { retrieve } from '../main/retrieval'
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
  type ContextCandidate
} from '../shared/evalMetrics'
import {
  parseExperimentConfig,
  type ExperimentConfig,
  type ExperimentRetriever
} from '../shared/experimentSchema'
import type {
  ChunkSet,
  EmbeddingModel,
  EvalCase,
  RetrievedChunkPayload,
  RetrieverParams
} from '../preload/types'

export const HEADLESS_RUN_SCHEMA_VERSION = 1
const execFileAsync = promisify(execFile)

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
  sourceControl: {
    gitCommit: string | null
    workingTreeDiffHash: string | null
  }
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
  estimatedEmbeddingTokens: number
  estimatedCostUsd: number | null
  unknownCostModels: EmbeddingModel[]
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
  contextBudget: number
  retrievedChunkIds: string[]
  retrievedTokens: number
  metrics: Omit<ReturnType<typeof computeRetrievalMetrics>, 'candidateRelevance'>
}

interface QueryCacheEntry {
  chunkArtifactId: string
  hits: Array<{ chunkId: string; distance: number; rank: number }>
}

export interface CostLedger {
  embeddingIndexTokens: number
  embeddingQueryTokens: number
  actualCostUsd: number
  byModel: Partial<
    Record<
      EmbeddingModel,
      { indexTokens: number; queryTokens: number; costUsd: number }
    >
  >
}

export interface HeadlessRun {
  schemaVersion: typeof HEADLESS_RUN_SCHEMA_VERSION
  fingerprint: string
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

async function sourceControlState(): Promise<ExperimentPlan['sourceControl']> {
  const projectDir = process.env.BOOK_RAG_EVAL_APP_DIR ?? process.cwd()
  try {
    const [{ stdout: commit }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8'
      }),
      execFileAsync('git', ['-C', projectDir, 'diff', '--binary', 'HEAD', '--'], {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      })
    ])
    return {
      gitCommit: commit.trim(),
      workingTreeDiffHash: diff.length > 0 ? contentHash(diff) : null
    }
  } catch {
    return { gitCommit: null, workingTreeDiffHash: null }
  }
}

function reproducibleConfig(config: LoadedExperiment): object {
  return {
    schemaVersion: config.schemaVersion,
    name: config.name,
    books: config.books.map((selection) => ({
      bookId: selection.bookId,
      evalSetId: selection.evalSetId ?? null,
      externalEvalSet: selection.evalSetPath !== undefined
    })),
    chunkers: config.chunkers,
    retrievers: config.retrievers,
    contextBudgets: config.contextBudgets,
    candidatePoolSize: config.candidatePoolSize,
    splits: config.splits,
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
    let cases = evalSet.cases.filter((evalCase) => config.splits.includes(evalCase.split))
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

function approximateChunkTokens(sourceTokens: number, chunker: ExperimentConfig['chunkers'][number]): number {
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
        retriever.kind === 'bm25' ? [] : [retriever.embeddingModel]
      )
    )
  ]
}

function retrieverNeedsBm25(retriever: ExperimentRetriever): boolean {
  return retriever.kind === 'bm25' || retriever.kind === 'hybrid-rrf'
}

function retrieverParams(retriever: ExperimentRetriever): RetrieverParams {
  switch (retriever.kind) {
    case 'bm25':
      return { kind: 'bm25' }
    case 'vector':
      return { kind: 'vector' }
    case 'hybrid-rrf':
      return { kind: 'hybrid-rrf', rrfK: retriever.rrfK }
  }
}

function priceOf(config: LoadedExperiment, model: EmbeddingModel): number | undefined {
  return config.pricing.embeddingUsdPerMillion[model]
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
  const sourceControl = await sourceControlState()
  if (sourceControl.gitCommit === null) {
    warnings.push('Git commit could not be resolved; this run is not tied to a source revision.')
  } else if (sourceControl.workingTreeDiffHash !== null) {
    warnings.push(
      `Tracked source changes are present (diff ${sourceControl.workingTreeDiffHash.slice(0, 12)}); commit before a portfolio run.`
    )
  }
  let estimatedEmbeddingTokens = 0
  let estimatedCostUsd = 0
  const unknownCostModels = new Set<EmbeddingModel>()

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
        return { model, artifactId: identity.id, exists }
      })
      artifacts.push({
        bookId: book.bookId,
        strategyId,
        chunkArtifactId: chunkIdentity.id,
        chunkExists: chunkSet !== null,
        estimatedChunkTokens,
        bm25ArtifactId: bm25Identity.id,
        bm25Exists: bm25Sets.some((set) => set.artifactId === bm25Identity.id),
        embeddingArtifacts: embeddingPlans
      })

      for (const retriever of config.retrievers) {
        if (retriever.kind === 'bm25') continue
        const queryTokens = book.cases
          .filter((evalCase) => evalCase.scope === 'within_book')
          .reduce(
            (total, evalCase) => total + countChunkTokens(evalCase.canonicalSearchQuery),
            0
          )
        estimatedEmbeddingTokens += queryTokens
        const price = priceOf(config, retriever.embeddingModel)
        if (price === undefined) unknownCostModels.add(retriever.embeddingModel)
        else estimatedCostUsd += (queryTokens / 1_000_000) * price
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
    withinBookCases * config.chunkers.length * config.retrievers.length
  const experimentCells = retrievalQueries * config.contextBudgets.length

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
    estimatedEmbeddingTokens,
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

function emptyLedger(): CostLedger {
  return {
    embeddingIndexTokens: 0,
    embeddingQueryTokens: 0,
    actualCostUsd: 0,
    byModel: {}
  }
}

function recordCost(
  run: HeadlessRun,
  config: LoadedExperiment,
  model: EmbeddingModel,
  kind: 'index' | 'query',
  tokens: number
): void {
  const price = priceOf(config, model)
  if (price === undefined) {
    throw new Error(`No embedding price configured for ${model}`)
  }
  const cost = (tokens / 1_000_000) * price
  const current = run.ledger.byModel[model] ?? { indexTokens: 0, queryTokens: 0, costUsd: 0 }
  if (kind === 'index') {
    run.ledger.embeddingIndexTokens += tokens
    current.indexTokens += tokens
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

function queryKey(
  bookId: string,
  chunkArtifactId: string,
  retriever: ExperimentRetriever,
  evalCase: EvalCase,
  candidatePoolSize: number
): string {
  return contentHash({
    bookId,
    chunkArtifactId,
    retriever,
    query: evalCase.canonicalSearchQuery,
    candidatePoolSize
  })
}

function resultKey(queryId: string, contextBudget: number): string {
  return `${queryId}:${contextBudget}`
}

function reconstructHits(cache: QueryCacheEntry, set: ChunkSet): RetrievedChunkPayload[] {
  const chunks = new Map(set.chunks.map((chunk) => [chunk.id, chunk]))
  return cache.hits.flatMap((hit) => {
    const chunk = chunks.get(hit.chunkId)
    return chunk ? [{ chunk, distance: hit.distance, rank: hit.rank }] : []
  })
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

async function readExistingRun(path: string, fingerprint: string): Promise<HeadlessRun | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as HeadlessRun
    if (parsed.schemaVersion !== HEADLESS_RUN_SCHEMA_VERSION || parsed.fingerprint !== fingerprint) {
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
  const run: HeadlessRun =
    existing ?? {
      schemaVersion: HEADLESS_RUN_SCHEMA_VERSION,
      fingerprint: plan.fingerprint,
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
    for (const book of prepared.books) {
      for (const chunker of prepared.config.chunkers) {
        const summary = await runChunking(book.bookId, chunker)
        const set = await getChunkSet(book.bookId, summary.artifactId ?? summary.strategyId)
        const chunkArtifactId = set.artifactId!

        for (const retriever of prepared.config.retrievers) {
          if (retrieverNeedsBm25(retriever)) {
            await runBm25Indexing(book.bookId, set.strategyId)
          }
          if (retriever.kind !== 'bm25') {
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
            const embed = await runEmbedding(
              book.bookId,
              set.strategyId,
              retriever.embeddingModel
            )
            if (embed.totalTokens > 0) {
              recordCost(run, prepared.config, retriever.embeddingModel, 'index', embed.totalTokens)
              run.updatedAt = Date.now()
              await writeJsonAtomic(plan.runPath, run)
            }
          }

          for (const evalCase of book.cases) {
            if (evalCase.scope !== 'within_book') continue
            const queryId = queryKey(
              book.bookId,
              chunkArtifactId,
              retriever,
              evalCase,
              prepared.config.candidatePoolSize
            )
            const missingBudgets = prepared.config.contextBudgets.filter(
              (budget) => !completed.has(resultKey(queryId, budget))
            )
            if (missingBudgets.length === 0) continue

            let hits: RetrievedChunkPayload[]
            const cached = run.queryCache[queryId]
            if (cached) {
              hits = reconstructHits(cached, set)
            } else {
              if (retriever.kind !== 'bm25') {
                assertAffordable(
                  run,
                  prepared.config,
                  retriever.embeddingModel,
                  countChunkTokens(evalCase.canonicalSearchQuery)
                )
              }
              hits = await retrieve(
                book.bookId,
                set.strategyId,
                retrieverParams(retriever),
                evalCase.canonicalSearchQuery,
                prepared.config.candidatePoolSize,
                retriever.kind === 'bm25' ? undefined : retriever.embeddingModel,
                (model, tokens) => recordCost(run, prepared.config, model, 'query', tokens)
              )
              run.queryCache[queryId] = {
                chunkArtifactId,
                hits: hits.map((hit) => ({
                  chunkId: hit.chunk.id,
                  distance: hit.distance,
                  rank: hit.rank
                }))
              }
              run.updatedAt = Date.now()
              await writeJsonAtomic(plan.runPath, run)
            }

            for (const budget of missingBudgets) {
              const assembled = assembleContextBudget(
                contextCandidates(book.bookId, hits),
                budget,
                countChunkTokens
              )
              const metricCandidates = assembled.items.map((item) => ({
                ...item.candidate,
                tokenCount: item.tokenCount
              }))
              const metrics = computeRetrievalMetrics(metricCandidates, evalCase.goldEvidence)
              const { candidateRelevance, ...persistedMetrics } = metrics
              void candidateRelevance
              const key = resultKey(queryId, budget)
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
                contextBudget: budget,
                retrievedChunkIds: assembled.items.map((item) => item.candidate.id),
                retrievedTokens: assembled.totalTokens,
                metrics: persistedMetrics
              })
              completed.add(key)
              run.updatedAt = Date.now()
              await writeJsonAtomic(plan.runPath, run)
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
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

export async function exportRun(
  runPath: string,
  format: 'jsonl' | 'csv'
): Promise<string> {
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
    'contextBudget',
    'retrievedTokens',
    'hitAtK',
    'mrr',
    'ndcgAtK',
    'evidenceRecall',
    'fullEvidenceSuccess',
    'contextPrecision',
    'goldSpanCoverage',
    'tokensBeforeFirstEvidence',
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
        row.contextBudget,
        row.retrievedTokens,
        row.metrics.hitAtK,
        row.metrics.mrr,
        row.metrics.ndcgAtK,
        row.metrics.evidenceRecall,
        row.metrics.fullEvidenceSuccess,
        row.metrics.contextPrecision,
        row.metrics.goldSpanCoverage,
        row.metrics.tokensBeforeFirstEvidence,
        row.metrics.correctBookRecall
      ]
        .map(csvCell)
        .join(',')
    )
  ]
  await fs.writeFile(outputPath, lines.join('\n') + '\n', 'utf8')
  return outputPath
}
