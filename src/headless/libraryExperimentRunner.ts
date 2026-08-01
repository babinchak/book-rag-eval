import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { configureLibraryDir } from '../main/library'
import { loadCanonicalBookDocument } from '../main/canonicalStore'
import { getChunkSet, runChunking } from '../main/chunking'
import { queryBm25, runBm25Indexing } from '../main/bm25'
import {
  embedRetrievalQuery,
  fuseRrfHits,
  queryVectorWithEmbedding,
  rankRandomChunks
} from '../main/retrieval'
import { rerankVoyage } from '../main/reranking'
import { countChunkTokens } from '../main/tokenChunking'
import { contentHash } from '../shared/artifactIdentity'
import { parseEvalSet, type BenchmarkEvalCase } from '../shared/evalSchema'
import { assembleContextBudget, computeRetrievalMetrics } from '../shared/evalMetrics'
import type { ExperimentRetriever } from '../shared/experimentSchema'
import type { ChunkSet, EmbeddingModel, RetrievedChunkPayload } from '../preload/types'
import { localRetrievalSidecar } from './localRetrievalSidecar'
import { readSourceControlState } from './sourceControl'
import type { CostLedger, HeadlessResultRow, HeadlessRun } from './experimentRunner'

const positiveInteger = z.number().int().positive()
const rerankerSchema = z.object({ kind: z.literal('voyage'), model: z.literal('rerank-2.5-lite') })
const retrieverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('random'), seed: z.number().int().default(42), reranker: rerankerSchema.optional() }),
  z.object({ kind: z.literal('bm25'), reranker: rerankerSchema.optional() }),
  z.object({
    kind: z.literal('vector'),
    embeddingModel: z.enum(['text-embedding-3-large', 'voyage-4-large']),
    reranker: rerankerSchema.optional()
  }),
  z.object({
    kind: z.literal('hybrid-rrf'),
    embeddingModel: z.enum(['text-embedding-3-large', 'voyage-4-large']),
    rrfK: positiveInteger.default(60),
    vectorWeight: z.number().positive().default(1),
    bm25Weight: z.number().positive().default(1),
    reranker: rerankerSchema.optional()
  }),
  z.object({
    kind: z.literal('colbertv2'),
    model: z.literal('lightonai/colbertv2.0').default('lightonai/colbertv2.0'),
    reranker: rerankerSchema.optional()
  }),
  z.object({
    kind: z.literal('bge-m3'),
    model: z.literal('BAAI/bge-m3').default('BAAI/bge-m3'),
    mode: z.enum(['dense', 'sparse', 'colbert-dense-shortlist', 'hybrid-dense-sparse-rrf', 'hybrid-all-rrf']),
    shortlist: positiveInteger.default(200),
    reranker: rerankerSchema.optional()
  })
])
const routingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flat') }),
  z.object({ kind: z.literal('oracle') }),
  z.object({ kind: z.literal('bge-profile'), topK: positiveInteger })
])
const configSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  libraryDir: z.string().optional(),
  corpusPath: z.string().min(1),
  evalDir: z.string().min(1),
  outputDir: z.string().default('.rag-eval/runs'),
  chunker: z.object({
    kind: z.literal('fixed-token'),
    size: positiveInteger,
    overlap: z.number().int().nonnegative(),
    encoding: z.literal('cl100k_base').default('cl100k_base')
  }),
  pipelines: z.array(z.object({ id: z.string().min(1), retriever: retrieverSchema, routing: routingSchema })).min(1),
  contextBudgets: z.array(positiveInteger).min(1),
  candidatePoolSize: positiveInteger.default(50),
  pricing: z.object({
    embeddingUsdPerMillion: z.object({
      'text-embedding-3-large': z.number().nonnegative().optional(),
      'voyage-4-large': z.number().nonnegative().optional()
    }),
    rerankingUsdPerMillion: z.object({ 'rerank-2.5-lite': z.number().nonnegative() })
  })
})

type Config = z.infer<typeof configSchema>
export type LibraryRoutingPolicy = z.infer<typeof routingSchema>
interface BookSpec { bookId: string; title: string; author: string }
interface PreparedBook extends BookSpec { set: ChunkSet; headings: string[] }
interface LibraryHit extends RetrievedChunkPayload { bookId: string }
interface Trace {
  routedBookIds: string[]
  routingLatencyMs: number
  retrievalLatencyMs: number
  rerankLatencyMs?: number
  rerankTokens?: number
  nominalRerankCostUsd?: number
  hits: Array<{ bookId: string; chunkId: string; distance: number; rank: number }>
}

function from(base: string, path: string): string { return isAbsolute(path) ? path : resolve(base, path) }
function artifactsRoot(outputDir: string): string { return dirname(outputDir) }
function localArtifactId(set: ChunkSet, retriever: Extract<ExperimentRetriever, { kind: 'colbertv2' | 'bge-m3' }>): string {
  return contentHash({ kind: retriever.kind, model: retriever.model, chunkArtifactId: set.artifactId, maxLength: retriever.kind === 'bge-m3' ? 512 : undefined })
}
function localArtifactDir(outputDir: string, set: ChunkSet, retriever: Extract<ExperimentRetriever, { kind: 'colbertv2' | 'bge-m3' }>): string {
  return join(artifactsRoot(outputDir), 'artifacts', 'local-retrieval', localArtifactId(set, retriever))
}
function compositeId(bookId: string, chunkId: string): string { return `${bookId}:${chunkId}` }
function emptyLedger(): CostLedger {
  return { embeddingIndexTokens: 0, embeddingQueryTokens: 0, actualCostUsd: 0, rerankTokens: 0, rerankCostUsd: 0, byReranker: {}, byModel: {}, indexingByArtifact: [], localIndexes: [] }
}
async function writeAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, path)
}
function price(config: Config, model: EmbeddingModel): number {
  const value = config.pricing.embeddingUsdPerMillion[model]
  if (value === undefined) throw new Error(`Missing price for ${model}`)
  return value
}
function recordEmbedding(run: HeadlessRun, config: Config, model: EmbeddingModel, tokens: number): void {
  const cost = (tokens / 1_000_000) * price(config, model)
  const current = run.ledger.byModel[model] ?? { indexTokens: 0, queryTokens: 0, costUsd: 0 }
  current.queryTokens += tokens
  current.costUsd += cost
  run.ledger.byModel[model] = current
  run.ledger.embeddingQueryTokens += tokens
  run.ledger.actualCostUsd += cost
  if (run.ledger.actualCostUsd > run.maxUsd) throw new Error('Cost ceiling exceeded')
}
function recordRerank(run: HeadlessRun, config: Config, tokens: number): number {
  const cost = (tokens / 1_000_000) * config.pricing.rerankingUsdPerMillion['rerank-2.5-lite']
  const current = run.ledger.byReranker['rerank-2.5-lite'] ?? { tokens: 0, costUsd: 0 }
  current.tokens += tokens
  current.costUsd += cost
  run.ledger.byReranker['rerank-2.5-lite'] = current
  run.ledger.rerankTokens += tokens
  run.ledger.rerankCostUsd += cost
  run.ledger.actualCostUsd += cost
  if (run.ledger.actualCostUsd > run.maxUsd) throw new Error('Cost ceiling exceeded')
  return cost
}

function profileDocuments(books: PreparedBook[]): Array<{ id: string; text: string }> {
  return books.flatMap((book) => {
    const base = `Book: ${book.title}\nAuthor: ${book.author}\n`
    const groups: string[][] = []
    for (let index = 0; index < book.headings.length; index += 80) groups.push(book.headings.slice(index, index + 80))
    if (groups.length === 0) groups.push([])
    return groups.map((headings, index) => ({ id: `${book.bookId}::${index}`, text: `${base}Table of contents and headings:\n${headings.join('\n')}` }))
  })
}

async function ensureRouterIndex(config: Config, books: PreparedBook[]): Promise<string> {
  const documents = profileDocuments(books)
  const id = contentHash({ kind: 'six-book-bge-profile-router-v1', documents })
  const path = join(artifactsRoot(config.outputDir), 'artifacts', 'book-router', id)
  try { await fs.access(join(path, 'manifest.json')) } catch { await localRetrievalSidecar.indexBge(path, documents, 'BAAI/bge-m3') }
  return path
}

async function routeBooks(policy: LibraryRoutingPolicy, query: string, evalCase: BenchmarkEvalCase, books: PreparedBook[], routerPath: string): Promise<{ bookIds: string[]; latencyMs: number }> {
  const started = performance.now()
  if (policy.kind === 'flat') return { bookIds: books.map((book) => book.bookId), latencyMs: performance.now() - started }
  if (policy.kind === 'oracle') return { bookIds: [...new Set(evalCase.goldEvidence.map((evidence) => evidence.bookId))], latencyMs: performance.now() - started }
  const result = await localRetrievalSidecar.queryBge(routerPath, query, 50, 'dense', 50)
  const selected: string[] = []
  for (const hit of result.hits) {
    const bookId = hit.id.split('::')[0]
    if (!selected.includes(bookId)) selected.push(bookId)
    if (selected.length >= policy.topK) break
  }
  return { bookIds: selected, latencyMs: result.queryLatencyMs }
}

async function queryLocalBook(config: Config, book: PreparedBook, retriever: Extract<ExperimentRetriever, { kind: 'colbertv2' | 'bge-m3' }>, query: string, k: number): Promise<LibraryHit[]> {
  const path = localArtifactDir(config.outputDir, book.set, retriever)
  const result = retriever.kind === 'colbertv2'
    ? await localRetrievalSidecar.queryColbert(path, query, k)
    : await localRetrievalSidecar.queryBge(path, query, k, retriever.mode, retriever.shortlist)
  const chunks = new Map(book.set.chunks.map((chunk) => [chunk.id, chunk]))
  return result.hits.flatMap((hit) => {
    const chunk = chunks.get(hit.id)
    return chunk ? [{ bookId: book.bookId, chunk, distance: -hit.score, rank: hit.rank }] : []
  })
}

function merge(hits: LibraryHit[], k: number): LibraryHit[] {
  return hits.sort((a, b) => a.distance - b.distance || compositeId(a.bookId, a.chunk.id).localeCompare(compositeId(b.bookId, b.chunk.id))).slice(0, k).map((hit, index) => ({ ...hit, rank: index + 1 }))
}

async function retrieveLibrary(config: Config, run: HeadlessRun, books: PreparedBook[], retriever: ExperimentRetriever, query: string, k: number, caches: { base: Map<string, LibraryHit[]>; vectors: Map<string, number[]> }): Promise<LibraryHit[]> {
  const baseRetriever = { ...retriever, reranker: undefined } as ExperimentRetriever
  const selectedKey = books.map((book) => book.bookId).sort().join(',')
  const cacheKey = contentHash({ selectedKey, baseRetriever, query, k })
  const cached = caches.base.get(cacheKey)
  if (cached) return cached
  let hits: LibraryHit[]
  if (baseRetriever.kind === 'random') {
    const all = books.flatMap((book) => book.set.chunks.map((chunk) => ({ bookId: book.bookId, chunk })))
    const ranked = rankRandomChunks(all.map((item) => ({ id: compositeId(item.bookId, item.chunk.id) })), query, k, baseRetriever.seed)
    const byId = new Map(all.map((item) => [compositeId(item.bookId, item.chunk.id), item]))
    hits = ranked.flatMap((hit) => { const item = byId.get(hit.id); return item ? [{ ...item, distance: hit.score, rank: hit.rank }] : [] })
  } else if (baseRetriever.kind === 'bm25') {
    hits = merge((await Promise.all(books.map(async (book) => (await queryBm25(book.bookId, book.set.strategyId, query, k, book.set)).map((hit) => ({ bookId: book.bookId, chunk: book.set.chunks.find((chunk) => chunk.id === hit.id)!, distance: hit.score, rank: hit.rank }))))).flat().filter((hit) => hit.chunk), k)
  } else if (baseRetriever.kind === 'vector' || baseRetriever.kind === 'hybrid-rrf') {
    const vectorKey = `${baseRetriever.embeddingModel}|${query}`
    let vector = caches.vectors.get(vectorKey)
    if (!vector) {
      vector = await embedRetrievalQuery(query, baseRetriever.embeddingModel, (model, tokens) => recordEmbedding(run, config, model, tokens))
      caches.vectors.set(vectorKey, vector)
    }
    const vectorHits = merge((await Promise.all(books.map(async (book) => (await queryVectorWithEmbedding(book.bookId, book.set, vector!, k, baseRetriever.embeddingModel)).map((hit) => ({ bookId: book.bookId, chunk: book.set.chunks.find((chunk) => chunk.id === hit.id)!, distance: hit.score, rank: hit.rank }))))).flat().filter((hit) => hit.chunk), k)
    if (baseRetriever.kind === 'vector') hits = vectorHits
    else {
      const bmHits = await retrieveLibrary(config, run, books, { kind: 'bm25' }, query, k, caches)
      const byId = new Map([...vectorHits, ...bmHits].map((hit) => [compositeId(hit.bookId, hit.chunk.id), hit]))
      const fused = fuseRrfHits([
        { hits: vectorHits.map((hit) => ({ id: compositeId(hit.bookId, hit.chunk.id), score: hit.distance, rank: hit.rank })), weight: baseRetriever.vectorWeight },
        { hits: bmHits.map((hit) => ({ id: compositeId(hit.bookId, hit.chunk.id), score: hit.distance, rank: hit.rank })), weight: baseRetriever.bm25Weight }
      ], baseRetriever.rrfK).slice(0, k)
      hits = fused.map((hit, index) => ({ ...byId.get(hit.id)!, distance: hit.score, rank: index + 1 }))
    }
  } else {
    hits = merge((await Promise.all(books.map((book) => queryLocalBook(config, book, baseRetriever, query, k)))).flat(), k)
  }
  caches.base.set(cacheKey, hits)
  return hits
}

function reconstruct(trace: Trace, books: PreparedBook[]): LibraryHit[] {
  const chunks = new Map(books.flatMap((book) => book.set.chunks.map((chunk) => [compositeId(book.bookId, chunk.id), chunk] as const)))
  return trace.hits.flatMap((hit) => { const chunk = chunks.get(compositeId(hit.bookId, hit.chunkId)); return chunk ? [{ bookId: hit.bookId, chunk, distance: hit.distance, rank: hit.rank }] : [] })
}

export async function runLibraryExperiment(configPath: string, maxUsd: number, libraryDirOverride?: string): Promise<HeadlessRun> {
  const absoluteConfig = resolve(configPath)
  const base = dirname(absoluteConfig)
  const parsed = configSchema.parse(parseYaml(await fs.readFile(absoluteConfig, 'utf8')))
  const config: Config = { ...parsed, corpusPath: from(base, parsed.corpusPath), evalDir: from(base, parsed.evalDir), outputDir: from(base, parsed.outputDir) }
  const libraryDir = resolve(libraryDirOverride ?? parsed.libraryDir ?? process.env.BOOK_RAG_EVAL_LIBRARY_DIR ?? '')
  if (!libraryDir) throw new Error('Library directory is required')
  configureLibraryDir(libraryDir)
  const corpus = JSON.parse(await fs.readFile(config.corpusPath, 'utf8')) as { books: BookSpec[] }
  const books: PreparedBook[] = []
  const cases: BenchmarkEvalCase[] = []
  for (const spec of corpus.books) {
    const [document, summary, evalSet] = await Promise.all([
      loadCanonicalBookDocument(spec.bookId),
      runChunking(spec.bookId, config.chunker),
      fs.readFile(join(config.evalDir, `${spec.bookId}.json`), 'utf8').then((raw) => parseEvalSet(JSON.parse(raw), spec.bookId))
    ])
    const set = await getChunkSet(spec.bookId, summary.artifactId ?? summary.strategyId)
    books.push({ ...spec, set, headings: [...new Set(document.spine.flatMap((spine) => spine.nodes.flatMap((node) => node.headingPath.map((heading) => heading.text).filter(Boolean))))] })
    cases.push(...evalSet.cases.filter((evalCase) => evalCase.scope === 'library'))
    await runBm25Indexing(spec.bookId, set.strategyId)
  }
  const sourceControl = await readSourceControlState()
  const fingerprint = contentHash({ config: parsed, cases, corpus, sourceControl, metricVersion: 2 })
  const runPath = join(config.outputDir, `${config.name}-${fingerprint.slice(0, 16)}.json`)
  let run: HeadlessRun
  try { run = JSON.parse(await fs.readFile(runPath, 'utf8')) as HeadlessRun } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    run = {
      schemaVersion: 1,
      metricVersion: 2,
      fingerprint,
      status: 'running',
      configPath: absoluteConfig,
      plan: {
        schemaVersion: 1, fingerprint, name: config.name, configPath: absoluteConfig, libraryDir, outputDir: config.outputDir, runPath, sourceControl,
        books: books.map((book) => ({ bookId: book.bookId, evalSetId: 'six-book-library-v1', sourceHash: '', evalSetHash: '', selectedCases: cases.filter((evalCase) => evalCase.goldEvidence.some((evidence) => evidence.bookId === book.bookId)).length })),
        artifacts: [], experimentCells: cases.length * config.pipelines.length * config.contextBudgets.length, retrievalQueries: cases.length * config.pipelines.length, cachedRetrievalQueries: 0, missingRetrievalQueries: cases.length * config.pipelines.length, estimatedEmbeddingTokens: 0, estimatedRerankTokens: 0, estimatedCostUsd: null, unknownCostModels: [], warnings: ['Provisional unreviewed library-wide development cases']
      },
      startedAt: Date.now(), updatedAt: Date.now(), maxUsd, ledger: emptyLedger(), queryCache: {}, results: []
    }
  }
  run.status = 'running'; run.maxUsd = maxUsd; delete run.error
  await writeAtomic(runPath, run)
  const routerPath = await ensureRouterIndex(config, books)
  const completed = new Set(run.results.map((row) => row.key))
  const caches = { base: new Map<string, LibraryHit[]>(), vectors: new Map<string, number[]>() }
  try {
    for (const pipeline of config.pipelines) {
      for (const evalCase of cases) {
        const query = evalCase.question
        const queryId = contentHash({ corpus: corpus.books.map((book) => book.bookId), pipeline, caseId: evalCase.id, query, candidatePoolSize: config.candidatePoolSize })
        const missing = config.contextBudgets.filter((budget) => !completed.has(`${queryId}:chunks:${budget}`))
        if (missing.length === 0) continue
        let trace = run.queryCache[queryId] as unknown as Trace | undefined
        let hits: LibraryHit[]
        if (trace?.hits?.[0] && 'bookId' in trace.hits[0]) hits = reconstruct(trace, books)
        else {
          const route = await routeBooks(pipeline.routing, query, evalCase, books, routerPath)
          const selectedBooks = route.bookIds.map((bookId) => books.find((book) => book.bookId === bookId)!).filter(Boolean)
          const retrievalStarted = performance.now()
          hits = await retrieveLibrary(config, run, selectedBooks, pipeline.retriever, query, config.candidatePoolSize, caches)
          const retrievalLatencyMs = performance.now() - retrievalStarted
          let rerankLatencyMs: number | undefined, rerankTokens: number | undefined, nominalRerankCostUsd: number | undefined
          if (pipeline.retriever.reranker) {
            const started = performance.now()
            const reranked = await rerankVoyage(query, hits, pipeline.retriever.reranker.model)
            rerankLatencyMs = performance.now() - started
            rerankTokens = reranked.tokens ?? 0
            nominalRerankCostUsd = recordRerank(run, config, rerankTokens)
            hits = reranked.hits as LibraryHit[]
          }
          trace = { routedBookIds: route.bookIds, routingLatencyMs: route.latencyMs, retrievalLatencyMs, rerankLatencyMs, rerankTokens, nominalRerankCostUsd, hits: hits.map((hit) => ({ bookId: hit.bookId, chunkId: hit.chunk.id, distance: hit.distance, rank: hit.rank })) }
          run.queryCache[queryId] = trace as never
          run.updatedAt = Date.now(); await writeAtomic(runPath, run)
        }
        const requiredBooks = [...new Set(evalCase.goldEvidence.map((evidence) => evidence.bookId))]
        const routedBookIds = trace.routedBookIds
        for (const budget of missing) {
          const assembled = assembleContextBudget(hits.map((hit) => ({ id: compositeId(hit.bookId, hit.chunk.id), bookId: hit.bookId, spineHref: hit.chunk.spineHref, textStart: hit.chunk.textStart, textEnd: hit.chunk.textEnd, canonicalNodeIds: hit.chunk.canonicalNodeIds ?? [], tokenCount: hit.chunk.tokenCount ?? countChunkTokens(hit.chunk.text), text: hit.chunk.text })), budget, countChunkTokens)
          const metrics = computeRetrievalMetrics(assembled.items.map((item) => ({ ...item.candidate, tokenCount: item.tokenCount, sourceRanges: item.sourceRanges, payloadSegments: item.payloadSegments })), evalCase.goldEvidence, { contextBudgetTokens: budget, countTokens: countChunkTokens })
          const { candidateRelevance: _, ...persisted } = metrics; void _
          const key = `${queryId}:chunks:${budget}`
          const row: HeadlessResultRow = {
            key, bookId: evalCase.goldEvidence[0]?.bookId ?? corpus.books[0].bookId, evalSetId: 'six-book-library-v1-provisional', caseId: evalCase.id, split: evalCase.split, scope: evalCase.scope,
            strategyId: books[0].set.strategyId, chunkArtifactId: contentHash(books.map((book) => book.set.artifactId)), retriever: pipeline.retriever, queryMode: 'question', retrievalQuery: query, contextPolicy: { kind: 'chunks' }, contextBudget: budget,
            retrievedChunkIds: assembled.items.map((item) => item.candidate.id), retrievedTokens: assembled.totalTokens, metrics: persisted,
            routingPolicy: pipeline.routing, routedBookIds, routingMetrics: { requiredBookRecall: requiredBooks.filter((bookId) => routedBookIds.includes(bookId)).length / requiredBooks.length, allRequiredBooks: requiredBooks.every((bookId) => routedBookIds.includes(bookId)) }
          }
          run.results.push(row); completed.add(key); run.updatedAt = Date.now()
        }
        await writeAtomic(runPath, run)
      }
    }
    run.status = 'completed'; run.completedAt = Date.now(); run.updatedAt = run.completedAt; await writeAtomic(runPath, run); return run
  } catch (error) {
    run.status = 'failed'; run.error = (error as Error).message; run.updatedAt = Date.now(); await writeAtomic(runPath, run); throw error
  } finally { localRetrievalSidecar.stop() }
}
