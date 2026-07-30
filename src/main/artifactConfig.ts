import { createArtifactIdentity, type ArtifactIdentity } from '../shared/artifactIdentity'
import type { ChunkSet } from '../preload/types'

export const BM25_TOKENIZER = 'porter unicode61'
export const EMBEDDING_NORMALIZATION = 'provider-default'

export function resolvedChunkArtifactId(set: ChunkSet): string {
  if (set.artifactId) return set.artifactId
  return createArtifactIdentity('legacy-chunks', {
    bookId: set.bookId,
    strategyId: set.strategyId,
    params: set.params,
    chunks: set.chunks.map((chunk) => ({
      id: chunk.id,
      spineHref: chunk.spineHref,
      textStart: chunk.textStart,
      textEnd: chunk.textEnd,
      text: chunk.text
    }))
  }).id
}

export function embeddingArtifactIdentity(
  set: ChunkSet,
  model: string,
  dimensions: number
): ArtifactIdentity {
  return createArtifactIdentity(
    'embeddings',
    {
      provider: 'openai',
      model,
      dimensions,
      normalization: EMBEDDING_NORMALIZATION
    },
    { chunks: resolvedChunkArtifactId(set) }
  )
}

export function bm25ArtifactIdentity(set: ChunkSet): ArtifactIdentity {
  return createArtifactIdentity(
    'bm25',
    {
      engine: 'sqlite-fts5',
      scoring: 'bm25',
      tokenizer: BM25_TOKENIZER
    },
    { chunks: resolvedChunkArtifactId(set) }
  )
}
