import type { ChunkParams } from '../preload/types'

export function strategyIdOf(params: ChunkParams): string {
  switch (params.kind) {
    case 'fixed':
      return `fixed-${params.size}-${params.overlap}`
    case 'paragraph':
      return `paragraph-${params.targetSize}`
    case 'sentence':
      return `sentence-${params.targetSize}`
    case 'structural':
      return `structural-${params.maxSize}`
  }
}

export function strategyLabel(params: ChunkParams): string {
  switch (params.kind) {
    case 'fixed':
      return `Fixed ${params.size}/${params.overlap}`
    case 'paragraph':
      return `Paragraph ~${params.targetSize}`
    case 'sentence':
      return `Sentence ~${params.targetSize}`
    case 'structural':
      return `Structural ≤${params.maxSize}`
  }
}

export const DEFAULT_STRATEGIES: ChunkParams[] = [
  { kind: 'fixed', size: 1200, overlap: 200 },
  { kind: 'paragraph', targetSize: 1200 },
  { kind: 'sentence', targetSize: 1200 },
  { kind: 'structural', maxSize: 4000 }
]

export function normalizeParams(p: unknown): ChunkParams {
  if (p && typeof p === 'object' && 'kind' in p) {
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
