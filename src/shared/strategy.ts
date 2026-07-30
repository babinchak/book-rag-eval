import type { ChunkParams } from '../preload/types'

export function strategyIdOf(params: ChunkParams): string {
  switch (params.kind) {
    case 'fixed-token':
      return `fixed-token-${params.encoding}-${params.size}-${params.overlap}`
    case 'fixed':
      return `fixed-${params.size}-${params.overlap}`
    case 'paragraph':
      return `paragraph-${params.targetSize}`
    case 'sentence':
      return `sentence-${params.targetSize}`
    case 'structural':
      return `structural-${params.maxSize}`
    case 'semantic':
      return `semantic-${params.targetSize}-p${params.breakpointPercentile}-b${params.bufferSize}`
  }
}

export function strategyLabel(params: ChunkParams): string {
  switch (params.kind) {
    case 'fixed-token':
      return `Fixed tokens ${params.size}/${params.overlap}`
    case 'fixed':
      return `Fixed chars ${params.size}/${params.overlap} (legacy)`
    case 'paragraph':
      return `Paragraph ~${params.targetSize}`
    case 'sentence':
      return `Sentence ~${params.targetSize}`
    case 'structural':
      return `Structural ≤${params.maxSize}`
    case 'semantic':
      return `Semantic ~${params.targetSize} (p${params.breakpointPercentile})`
  }
}

export const DEFAULT_STRATEGIES: ChunkParams[] = [
  { kind: 'fixed-token', size: 1024, overlap: 128, encoding: 'cl100k_base' },
  { kind: 'paragraph', targetSize: 1200 },
  { kind: 'sentence', targetSize: 1200 },
  { kind: 'structural', maxSize: 4000 },
  { kind: 'semantic', targetSize: 1200, breakpointPercentile: 95, bufferSize: 1 }
]

export function normalizeParams(p: unknown): ChunkParams {
  if (p && typeof p === 'object' && 'kind' in p) {
    const kind = (p as { kind: unknown }).kind
    if (kind === 'fixed-token') {
      const tokenParams = p as Omit<Extract<ChunkParams, { kind: 'fixed-token' }>, 'encoding'> & {
        encoding?: 'cl100k_base'
      }
      return { ...tokenParams, encoding: tokenParams.encoding ?? 'cl100k_base' }
    }
    return p as ChunkParams
  }
  // Backward compat: old persisted chunks had { size, overlap } without kind
  if (
    p &&
    typeof p === 'object' &&
    'size' in p &&
    typeof (p as { size: unknown }).size === 'number' &&
    'overlap' in p &&
    typeof (p as { overlap: unknown }).overlap === 'number'
  ) {
    const old = p as { size: number; overlap: number }
    return { kind: 'fixed', size: old.size, overlap: old.overlap }
  }
  throw new Error('invalid chunk params')
}
