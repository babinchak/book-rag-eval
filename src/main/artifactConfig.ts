import { createArtifactIdentity, type ArtifactIdentity } from '../shared/artifactIdentity'
import type { CanonicalBookDocument } from '../shared/canonicalDocument'
import type { ChunkParams, ChunkSet, EmbeddingModel } from '../preload/types'

export const BM25_TOKENIZER = 'porter unicode61'
export const EMBEDDING_NORMALIZATION = 'provider-default'
export const SEMANTIC_CHUNK_EMBEDDING_MODEL = 'text-embedding-3-small'
export const CHUNKER_IMPLEMENTATION_VERSION = 'chunkers-v4'

export function chunkArtifactIdentity(
  bookId: string,
  params: ChunkParams,
  document: CanonicalBookDocument
): ArtifactIdentity {
  return createArtifactIdentity(
    'chunks',
    {
      bookId,
      implementation: CHUNKER_IMPLEMENTATION_VERSION,
      chunker: params,
      ...(params.kind === 'semantic'
        ? { semanticEmbeddingModel: SEMANTIC_CHUNK_EMBEDDING_MODEL }
        : {})
    },
    {
      canonicalSource: document.sourceHash,
      parser: document.parserVersion,
      schema: String(document.schemaVersion)
    }
  )
}

export function embeddingDimensions(model: EmbeddingModel): number {
  switch (model) {
    case 'text-embedding-3-small':
      return 1536
    case 'text-embedding-3-large':
      return 3072
    case 'voyage-4-large':
      return 1024
  }
}

export function embeddingProvider(model: EmbeddingModel): 'openai' | 'voyage' {
  return model.startsWith('voyage-') ? 'voyage' : 'openai'
}

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
      provider: model.startsWith('voyage-') ? 'voyage' : 'openai',
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
