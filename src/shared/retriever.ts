export type RetrieverParams =
  | { kind: 'random'; seed?: number }
  | { kind: 'vector' }
  | { kind: 'bm25' }
  | { kind: 'hybrid-rrf'; rrfK?: number; vectorWeight?: number; bm25Weight?: number }

export const RRF_DEFAULT_K = 60
export const RANDOM_DEFAULT_SEED = 42

export function retrieverIdOf(params: RetrieverParams): string {
  switch (params.kind) {
    case 'random':
      return `random-${params.seed ?? RANDOM_DEFAULT_SEED}`
    case 'vector':
      return 'vector'
    case 'bm25':
      return 'bm25'
    case 'hybrid-rrf':
      return hybridRetrieverId(params)
  }
}

export function retrieverLabel(params: RetrieverParams): string {
  switch (params.kind) {
    case 'random':
      return `Random (seed=${params.seed ?? RANDOM_DEFAULT_SEED})`
    case 'vector':
      return 'Vector'
    case 'bm25':
      return 'BM25'
    case 'hybrid-rrf':
      return `Hybrid (RRF k=${params.rrfK ?? RRF_DEFAULT_K}, vector=${params.vectorWeight ?? 1}, BM25=${params.bm25Weight ?? 1})`
  }
}

export const DEFAULT_RETRIEVERS: RetrieverParams[] = [
  { kind: 'random' },
  { kind: 'vector' },
  { kind: 'bm25' },
  { kind: 'hybrid-rrf' }
]

// Old run records persisted before the retriever axis existed are all vector.
export function normalizeRetrieverParams(p: unknown): RetrieverParams {
  if (p && typeof p === 'object' && 'kind' in p) {
    const kind = (p as { kind: unknown }).kind
    if (kind === 'random') {
      const seed = (p as { seed?: number }).seed
      return {
        kind: 'random',
        seed: typeof seed === 'number' && Number.isInteger(seed) ? seed : RANDOM_DEFAULT_SEED
      }
    }
    if (kind === 'vector') return { kind: 'vector' }
    if (kind === 'bm25') return { kind: 'bm25' }
    if (kind === 'hybrid-rrf') {
      const rrfK = (p as { rrfK?: number }).rrfK
      const vectorWeight = (p as { vectorWeight?: number }).vectorWeight
      const bm25Weight = (p as { bm25Weight?: number }).bm25Weight
      return {
        kind: 'hybrid-rrf',
        rrfK: typeof rrfK === 'number' ? rrfK : RRF_DEFAULT_K,
        vectorWeight: typeof vectorWeight === 'number' ? vectorWeight : 1,
        bm25Weight: typeof bm25Weight === 'number' ? bm25Weight : 1
      }
    }
  }
  return { kind: 'vector' }
}

// Best-effort parse of a persisted retrieverId string back into params. Used
// when migrating older run summaries that only have the id.
export function parseRetrieverId(id: string | undefined | null): RetrieverParams {
  if (!id || id === 'vector') return { kind: 'vector' }
  if (id === 'bm25') return { kind: 'bm25' }
  const random = id.match(/^random-(-?\d+)$/)
  if (random) return { kind: 'random', seed: parseInt(random[1], 10) }
  const m = id.match(/^hybrid-rrf-(\d+)$/)
  if (m) return { kind: 'hybrid-rrf', rrfK: parseInt(m[1], 10) }
  const weighted = id.match(/^hybrid-rrf-(\d+)-v([\d.]+)-b([\d.]+)$/)
  if (weighted) {
    return {
      kind: 'hybrid-rrf',
      rrfK: parseInt(weighted[1], 10),
      vectorWeight: Number.parseFloat(weighted[2]),
      bm25Weight: Number.parseFloat(weighted[3])
    }
  }
  return { kind: 'vector' }
}

function hybridRetrieverId(
  params: Extract<RetrieverParams, { kind: 'hybrid-rrf' }>
): string {
  const rrfK = params.rrfK ?? RRF_DEFAULT_K
  const vectorWeight = params.vectorWeight ?? 1
  const bm25Weight = params.bm25Weight ?? 1
  return vectorWeight === 1 && bm25Weight === 1
    ? `hybrid-rrf-${rrfK}`
    : `hybrid-rrf-${rrfK}-v${vectorWeight}-b${bm25Weight}`
}
