import assert from 'node:assert/strict'
import test from 'node:test'
import { fuseRrfHits, rankRandomChunks } from '../src/main/retrieval'
import { normalizeRetrieverParams, parseRetrieverId, retrieverIdOf } from '../src/shared/retriever'

const chunks = Array.from({ length: 20 }, (_, index) => ({ id: `chunk-${index}` }))

test('random retrieval is deterministic per query and seed', () => {
  const first = rankRandomChunks(chunks, 'meaning of virtue', 8, 42)
  const repeated = rankRandomChunks(chunks, 'meaning of virtue', 8, 42)
  const anotherQuery = rankRandomChunks(chunks, 'origin of conscience', 8, 42)
  const anotherSeed = rankRandomChunks(chunks, 'meaning of virtue', 8, 43)

  assert.deepEqual(first, repeated)
  assert.notDeepEqual(
    first.map((hit) => hit.id),
    anotherQuery.map((hit) => hit.id)
  )
  assert.notDeepEqual(
    first.map((hit) => hit.id),
    anotherSeed.map((hit) => hit.id)
  )
  assert.deepEqual(
    first.map((hit) => hit.rank),
    [1, 2, 3, 4, 5, 6, 7, 8]
  )
  assert.equal(new Set(first.map((hit) => hit.id)).size, first.length)
})

test('random retriever identity preserves its seed', () => {
  const params = normalizeRetrieverParams({ kind: 'random', seed: 123 })
  assert.deepEqual(params, { kind: 'random', seed: 123 })
  assert.equal(retrieverIdOf(params), 'random-123')
  assert.deepEqual(parseRetrieverId('random-123'), params)
})

test('weighted RRF changes which retrieval leg wins', () => {
  const vector = [
    { id: 'vector-only', score: 0.1, rank: 1 },
    { id: 'shared', score: 0.2, rank: 2 }
  ]
  const bm25 = [
    { id: 'bm25-only', score: -10, rank: 1 },
    { id: 'shared', score: -5, rank: 2 }
  ]
  const vectorBiased = fuseRrfHits(
    [
      { hits: vector, weight: 3 },
      { hits: bm25, weight: 1 }
    ],
    60
  )
  const bm25Biased = fuseRrfHits(
    [
      { hits: vector, weight: 1 },
      { hits: bm25, weight: 3 }
    ],
    60
  )

  assert.equal(vectorBiased[0].id, 'shared')
  assert.equal(vectorBiased[1].id, 'vector-only')
  assert.equal(bm25Biased[1].id, 'bm25-only')
})

test('weighted hybrid identity is round-trippable', () => {
  const params = {
    kind: 'hybrid-rrf' as const,
    rrfK: 60,
    vectorWeight: 0.75,
    bm25Weight: 0.25
  }
  const id = retrieverIdOf(params)
  assert.equal(id, 'hybrid-rrf-60-v0.75-b0.25')
  assert.deepEqual(parseRetrieverId(id), params)
})
