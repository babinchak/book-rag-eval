import type { ChunkParams } from '../preload/types'
import type { RetrieverParams } from './retriever'
import { strategyIdOf } from './strategy'
import { retrieverIdOf } from './retriever'

// A SavedStrategy is the user's atomic, runnable recipe — what the
// eval leaderboard ranks. It bundles every pipeline stage as a typed slot
// or chain. Each saved strategy has a stable id (used in run records) and
// a display name the user controls.
export interface SavedStrategy {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  config: StrategyConfig
}

export interface StrategyConfig {
  chunker: ChunkParams
  augment: AugmentStep[]
  embedding: EmbeddingSlot
  retriever: RetrieverParams
  postRetrieve: PostRetrieveStep[]
  generation: GenerationSlot
}

// Augment stage — stackable steps that enrich a chunk before embedding.
// v1 ships "breadcrumb" only; "summary" is reserved for the next pass.
export type AugmentStep =
  | { kind: 'breadcrumb' }
  | { kind: 'summary'; model: string }

export interface EmbeddingSlot {
  model: 'text-embedding-3-small' | 'text-embedding-3-large'
}

// Post-retrieve stage — stackable steps that reshape candidates before
// the answer model sees them. v1 ships only the no-op identity reranker
// (preserves shape for future cross-encoder / Cohere reranker work).
export type PostRetrieveStep =
  | { kind: 'rerank-identity' }
  | { kind: 'dedup' }

export interface GenerationSlot {
  model: 'gpt-4o-mini' | 'gpt-4o' | 'gpt-4.1' | 'gpt-4.1-mini'
  topK: number
}

export const DEFAULT_EMBEDDING_MODEL: EmbeddingSlot['model'] = 'text-embedding-3-large'
export const DEFAULT_CHAT_MODEL: GenerationSlot['model'] = 'gpt-4o-mini'
export const DEFAULT_TOP_K = 5

// The "chunkerId" identifies the chunker output on disk (chunks/, vectors/,
// bm25/ are all keyed by it). Multiple SavedStrategy entries can share the
// same chunkerId — e.g. two strategies that differ only in retriever or
// topK can reuse the same chunks + embeddings.
export function chunkerIdOf(config: StrategyConfig): string {
  return strategyIdOf(config.chunker)
}

// retrieverIdOf-of-config — what the eval run row records for backwards
// compatibility with the pre-saved-strategy retrieverId column.
export function configRetrieverId(config: StrategyConfig): string {
  return retrieverIdOf(config.retriever)
}

export function newSavedStrategyId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const suffix = Math.random().toString(36).slice(2, 8)
  return slug ? `${slug}-${suffix}` : `strategy-${suffix}`
}

// Seed entries — populate strategies.json on first run from the historical
// hardcoded defaults so existing chunks/embeddings on disk are still
// reachable through a named strategy.
export function defaultSeedStrategies(): SavedStrategy[] {
  const now = Date.now()
  const chunkers: ChunkParams[] = [
    { kind: 'fixed', size: 1200, overlap: 200 },
    { kind: 'paragraph', targetSize: 1200 },
    { kind: 'sentence', targetSize: 1200 },
    { kind: 'structural', maxSize: 4000 },
    { kind: 'semantic', targetSize: 1200, breakpointPercentile: 95, bufferSize: 1 }
  ]
  const retrievers: RetrieverParams[] = [
    { kind: 'vector' },
    { kind: 'bm25' },
    { kind: 'hybrid-rrf' }
  ]
  const out: SavedStrategy[] = []
  for (const chunker of chunkers) {
    for (const retriever of retrievers) {
      const config: StrategyConfig = {
        chunker,
        augment: [],
        embedding: { model: DEFAULT_EMBEDDING_MODEL },
        retriever,
        postRetrieve: [],
        generation: { model: DEFAULT_CHAT_MODEL, topK: DEFAULT_TOP_K }
      }
      const name = `${strategyLabelShort(chunker)} · ${retrieverLabelShort(retriever)}`
      out.push({
        id: `seed-${strategyIdOf(chunker)}-${retrieverIdOf(retriever)}`,
        name,
        createdAt: now,
        updatedAt: now,
        config
      })
    }
  }
  return out
}

function strategyLabelShort(p: ChunkParams): string {
  switch (p.kind) {
    case 'fixed':
      return `Fixed ${p.size}/${p.overlap}`
    case 'paragraph':
      return `Para ~${p.targetSize}`
    case 'sentence':
      return `Sent ~${p.targetSize}`
    case 'structural':
      return `Struct ≤${p.maxSize}`
    case 'semantic':
      return `Sem ~${p.targetSize}`
  }
}

function retrieverLabelShort(r: RetrieverParams): string {
  switch (r.kind) {
    case 'vector':
      return 'Vector'
    case 'bm25':
      return 'BM25'
    case 'hybrid-rrf':
      return 'Hybrid'
  }
}

export function isValidSavedStrategy(x: unknown): x is SavedStrategy {
  if (!x || typeof x !== 'object') return false
  const s = x as Partial<SavedStrategy>
  return (
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number' &&
    s.config !== undefined &&
    typeof s.config === 'object' &&
    s.config.chunker !== undefined &&
    s.config.retriever !== undefined
  )
}
