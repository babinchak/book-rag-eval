import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { bookDir } from './library'
import { getChunkSet } from './chunking'
import { sidecar } from './sidecar'
import { getOpenaiKey, getVoyageKey } from './settings'
import { queryBm25 } from './bm25'
import { embeddingArtifactIdentity, embeddingDimensions } from './artifactConfig'
import { contentHash } from '../shared/artifactIdentity'
import { RANDOM_DEFAULT_SEED, RRF_DEFAULT_K, type RetrieverParams } from '../shared/retriever'
import type {
  AskResultPayload,
  Chunk,
  ChunkSet,
  EmbeddingModel,
  RetrievedChunkPayload
} from '../preload/types'

const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = 'text-embedding-3-large'

// Pool size pulled from each leg before RRF fusion. Larger gives RRF more
// material to work with; we still truncate to k after fusion.
const HYBRID_POOL_PER_LEG = 30

function vectorsDbPath(bookId: string, artifactId: string): string {
  return join(bookDir(bookId), 'vectors', `${artifactId}.db`)
}

export interface ScoredHit {
  id: string
  score: number // lower = better (distance convention)
  rank: number
}

export function rankRandomChunks(
  chunks: Array<Pick<Chunk, 'id'>>,
  query: string,
  k: number,
  seed = RANDOM_DEFAULT_SEED
): ScoredHit[] {
  if (!Number.isInteger(k) || k < 0) throw new Error('Random retrieval k must be non-negative')
  const ranked = chunks
    .map((chunk) => ({
      id: chunk.id,
      hash: contentHash({ seed, query, chunkId: chunk.id })
    }))
    .sort((left, right) => left.hash.localeCompare(right.hash) || left.id.localeCompare(right.id))
    .slice(0, k)
  return ranked.map((hit, index) => ({
    id: hit.id,
    score: Number.parseInt(hit.hash.slice(0, 12), 16) / 0xffffffffffff,
    rank: index + 1
  }))
}

export type RetrievalEmbeddingUsageSink = (model: EmbeddingModel, tokens: number) => void

async function queryVector(
  bookId: string,
  set: ChunkSet,
  query: string,
  k: number,
  embeddingModel: EmbeddingModel,
  onEmbeddingUsage?: RetrievalEmbeddingUsageSink
): Promise<ScoredHit[]> {
  const [openaiApiKey, voyageApiKey] = await Promise.all([getOpenaiKey(), getVoyageKey()])
  if (embeddingModel.startsWith('voyage-') && !voyageApiKey) {
    throw new Error('VOYAGE_API_KEY is not set. Add it to the environment before retrieving.')
  }
  if (!embeddingModel.startsWith('voyage-') && !openaiApiKey) {
    throw new Error('OpenAI API key is not set. Add it in Settings before retrieving.')
  }

  const artifact = embeddingArtifactIdentity(
    set,
    embeddingModel,
    embeddingDimensions(embeddingModel)
  )
  const dbPath = vectorsDbPath(bookId, artifact.id)
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(
      `No embeddings for "${set.strategyId}" and its current chunk artifact. Run "Embed" first.`
    )
  }

  await sidecar.ensureStarted({
    openaiApiKey: openaiApiKey ?? undefined,
    voyageApiKey: voyageApiKey ?? undefined
  })
  const queryResult = await sidecar.embed([query], embeddingModel, 'query')
  onEmbeddingUsage?.(embeddingModel, queryResult.tokens)
  const queryVec = queryResult.embeddings[0]

  const db = new Database(dbPath)
  sqliteVec.load(db)
  try {
    const buf = Buffer.from(new Float32Array(queryVec).buffer)
    const rows = db
      .prepare(
        `SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      )
      .all(buf, k) as Array<{ id: string; distance: number }>
    return rows.map((r, i) => ({ id: r.id, score: r.distance, rank: i + 1 }))
  } finally {
    db.close()
  }
}

// Reciprocal Rank Fusion: each result earns 1/(k+rank) from each ranked list
// it appears in. Score-free across heterogeneous retrievers — works directly
// on ranks without needing to normalize cosine distance against BM25 scores.
export function fuseRrfHits(
  lists: Array<{ hits: ScoredHit[]; weight?: number }>,
  rrfK: number
): ScoredHit[] {
  const fused = new Map<string, number>()
  for (const { hits, weight = 1 } of lists) {
    for (const hit of hits) {
      const contrib = weight / (rrfK + hit.rank)
      fused.set(hit.id, (fused.get(hit.id) ?? 0) + contrib)
    }
  }
  const sorted = Array.from(fused.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )
  // Negate so the "distance" convention (lower = better) holds for callers
  // that just sort by score. Magnitude is the RRF score.
  return sorted.map(([id, score], i) => ({ id, score: -score, rank: i + 1 }))
}

function resolveChunks(hits: ScoredHit[], chunkById: Map<string, Chunk>): RetrievedChunkPayload[] {
  const out: RetrievedChunkPayload[] = []
  hits.forEach((h, i) => {
    const chunk = chunkById.get(h.id)
    if (chunk) out.push({ chunk, distance: h.score, rank: i + 1 })
  })
  return out
}

export async function retrieve(
  bookId: string,
  strategyId: string,
  retriever: RetrieverParams,
  query: string,
  k: number,
  embeddingModel: EmbeddingModel = DEFAULT_EMBEDDING_MODEL,
  onEmbeddingUsage?: RetrievalEmbeddingUsageSink
): Promise<RetrievedChunkPayload[]> {
  const set = await getChunkSet(bookId, strategyId)
  let hits: ScoredHit[]
  if (retriever.kind === 'random') {
    hits = rankRandomChunks(set.chunks, query, k, retriever.seed)
  } else if (retriever.kind === 'vector') {
    hits = await queryVector(bookId, set, query, k, embeddingModel, onEmbeddingUsage)
  } else if (retriever.kind === 'bm25') {
    hits = (await queryBm25(bookId, strategyId, query, k, set)).map((h) => ({
      id: h.id,
      score: h.score,
      rank: h.rank
    }))
  } else {
    const pool = Math.max(k, HYBRID_POOL_PER_LEG)
    const [vec, bm] = await Promise.all([
      queryVector(bookId, set, query, pool, embeddingModel, onEmbeddingUsage),
      queryBm25(bookId, strategyId, query, pool, set).then((arr) =>
        arr.map((h) => ({ id: h.id, score: h.score, rank: h.rank }))
      )
    ])
    hits = fuseRrfHits(
      [
        { hits: vec, weight: retriever.vectorWeight },
        { hits: bm, weight: retriever.bm25Weight }
      ],
      retriever.rrfK ?? RRF_DEFAULT_K
    ).slice(0, k)
  }

  if (hits.length === 0) return []

  const chunkById = new Map(set.chunks.map((c) => [c.id, c]))
  return resolveChunks(hits, chunkById)
}

export async function ask(
  bookId: string,
  strategyId: string,
  retriever: RetrieverParams,
  query: string,
  k: number
): Promise<AskResultPayload> {
  const { runAgent } = await import('./agent')
  return runAgent(bookId, strategyId, retriever, query, k)
}
