import assert from 'node:assert/strict'
import test from 'node:test'
import { contentHash, createArtifactIdentity, stableJson } from '../src/shared/artifactIdentity'
import {
  bm25ArtifactIdentity,
  embeddingArtifactIdentity,
  embeddingDimensions,
  embeddingProvider,
  resolvedChunkArtifactId
} from '../src/main/artifactConfig'
import type { ChunkSet } from '../src/preload/types'

test('fingerprints objects independently of key insertion order', () => {
  const left = {
    chunker: { kind: 'fixed-token', size: 1024, overlap: 128 },
    books: ['a', 'b']
  }
  const right = {
    books: ['a', 'b'],
    chunker: { overlap: 128, size: 1024, kind: 'fixed-token' }
  }

  assert.equal(stableJson(left), stableJson(right))
  assert.equal(contentHash(left), contentHash(right))
})

test('preserves meaningful array order and normalizes omitted object values', () => {
  assert.notEqual(contentHash(['a', 'b']), contentHash(['b', 'a']))
  assert.equal(contentHash({ a: 1, ignored: undefined }), contentHash({ a: 1 }))
  assert.equal(contentHash({ zero: -0 }), contentHash({ zero: 0 }))
})

test('includes artifact kind, config, dependencies, and identity version', () => {
  const chunks = createArtifactIdentity(
    'chunks',
    { chunker: { kind: 'fixed-token', size: 1024, overlap: 128 } },
    { corpus: 'corpus-hash', parser: 'parser-v1' }
  )
  const vectors = createArtifactIdentity(
    'embeddings',
    { chunker: { kind: 'fixed-token', size: 1024, overlap: 128 } },
    { corpus: 'corpus-hash', parser: 'parser-v1' }
  )

  assert.match(chunks.id, /^[a-f0-9]{64}$/)
  assert.notEqual(chunks.id, vectors.id)
  assert.equal(chunks.dependencies.corpus, 'corpus-hash')
})

test('rejects values that JSON cannot fingerprint reproducibly', () => {
  assert.throws(() => contentHash({ invalid: Number.NaN }), /Non-finite number/)
  assert.throws(() => contentHash({ invalid: BigInt(1) }), /Unsupported fingerprint value/)
})

test('index identities depend on the exact chunk artifact and index configuration', () => {
  const set: ChunkSet = {
    artifactId: 'a'.repeat(64),
    bookId: 'book-1',
    strategyId: 'fixed-token-cl100k_base-1024-128',
    params: { kind: 'fixed-token', size: 1024, overlap: 128, encoding: 'cl100k_base' },
    count: 1,
    generatedAt: 1,
    chunks: [
      {
        id: 'chunk-1',
        strategyId: 'fixed-token-cl100k_base-1024-128',
        spineHref: 'chapter.xhtml',
        textStart: 0,
        textEnd: 5,
        text: 'claim'
      }
    ]
  }

  assert.equal(resolvedChunkArtifactId(set), set.artifactId)
  assert.notEqual(
    embeddingArtifactIdentity(set, 'text-embedding-3-small', 1536).id,
    embeddingArtifactIdentity(set, 'text-embedding-3-large', 3072).id
  )
  assert.equal(embeddingProvider('voyage-4-large'), 'voyage')
  assert.equal(embeddingDimensions('voyage-4-large'), 1024)
  assert.equal(embeddingArtifactIdentity(set, 'voyage-4-large', 1024).config.provider, 'voyage')
  assert.equal(
    bm25ArtifactIdentity(set).dependencies.chunks,
    embeddingArtifactIdentity(set, 'text-embedding-3-small', 1536).dependencies.chunks
  )
})

test('legacy chunk artifacts are fingerprinted from content rather than a strategy label', () => {
  const base: ChunkSet = {
    bookId: 'book-1',
    strategyId: 'fixed-10-0',
    params: { kind: 'fixed', size: 10, overlap: 0 },
    count: 1,
    generatedAt: 1,
    chunks: [
      {
        id: 'chunk-1',
        strategyId: 'fixed-10-0',
        spineHref: 'chapter.xhtml',
        textStart: 0,
        textEnd: 5,
        text: 'first'
      }
    ]
  }
  const changed: ChunkSet = {
    ...base,
    chunks: [{ ...base.chunks[0], text: 'other' }]
  }

  assert.notEqual(resolvedChunkArtifactId(base), resolvedChunkArtifactId(changed))
})
