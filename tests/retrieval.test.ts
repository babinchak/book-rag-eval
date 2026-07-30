import assert from 'node:assert/strict'
import test from 'node:test'
import { rankRandomChunks } from '../src/main/retrieval'
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
