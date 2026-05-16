import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { bookDir } from './library'
import { getChunkSet } from './chunking'
import { sidecar } from './sidecar'
import { getOpenaiKey } from './settings'
import { queryBm25 } from './bm25'
import { RRF_DEFAULT_K, type RetrieverParams } from '../shared/retriever'
import type { AskResultPayload, Chunk, RetrievedChunkPayload } from '../preload/types'

const EMBEDDING_MODEL = 'text-embedding-3-large'

// Pool size pulled from each leg before RRF fusion. Larger gives RRF more
// material to work with; we still truncate to k after fusion.
const HYBRID_POOL_PER_LEG = 30

function vectorsDbPath(bookId: string, sid: string): string {
  return join(bookDir(bookId), 'vectors', `${sid}.db`)
}

interface ScoredHit {
  id: string
  score: number // lower = better (distance convention)
  rank: number
}

async function queryVector(
  bookId: string,
  strategyId: string,
  query: string,
  k: number
): Promise<ScoredHit[]> {
  const apiKey = await getOpenaiKey()
  if (!apiKey) {
    throw new Error('OpenAI API key is not set. Add it in Settings before retrieving.')
  }

  const dbPath = vectorsDbPath(bookId, strategyId)
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(`No embeddings for "${strategyId}". Run "Embed" on this chunk set first.`)
  }

  await sidecar.ensureStarted(apiKey)
  const queryResult = await sidecar.embed([query], EMBEDDING_MODEL)
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
function fuseRrf(lists: ScoredHit[][], rrfK: number): ScoredHit[] {
  const fused = new Map<string, number>()
  for (const list of lists) {
    for (const hit of list) {
      const contrib = 1 / (rrfK + hit.rank)
      fused.set(hit.id, (fused.get(hit.id) ?? 0) + contrib)
    }
  }
  const sorted = Array.from(fused.entries()).sort((a, b) => b[1] - a[1])
  // Negate so the "distance" convention (lower = better) holds for callers
  // that just sort by score. Magnitude is the RRF score.
  return sorted.map(([id, score], i) => ({ id, score: -score, rank: i + 1 }))
}

function resolveChunks(
  hits: ScoredHit[],
  chunkById: Map<string, Chunk>
): RetrievedChunkPayload[] {
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
  k: number
): Promise<RetrievedChunkPayload[]> {
  let hits: ScoredHit[]
  if (retriever.kind === 'vector') {
    hits = await queryVector(bookId, strategyId, query, k)
  } else if (retriever.kind === 'bm25') {
    hits = (await queryBm25(bookId, strategyId, query, k)).map((h) => ({
      id: h.id,
      score: h.score,
      rank: h.rank
    }))
  } else {
    const pool = Math.max(k, HYBRID_POOL_PER_LEG)
    const [vec, bm] = await Promise.all([
      queryVector(bookId, strategyId, query, pool),
      queryBm25(bookId, strategyId, query, pool).then((arr) =>
        arr.map((h) => ({ id: h.id, score: h.score, rank: h.rank }))
      )
    ])
    hits = fuseRrf([vec, bm], retriever.rrfK ?? RRF_DEFAULT_K).slice(0, k)
  }

  if (hits.length === 0) return []

  const set = await getChunkSet(bookId, strategyId)
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
