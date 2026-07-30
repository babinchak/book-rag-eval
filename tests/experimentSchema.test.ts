import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPERIMENT_SCHEMA_VERSION,
  parseExperimentConfig
} from '../src/shared/experimentSchema'

test('parses a retrieval experiment and fills deterministic defaults', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'smoke',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 1024, overlap: 128 }],
    retrievers: [{ kind: 'hybrid-rrf', embeddingModel: 'text-embedding-3-small' }],
    contextBudgets: [2048, 4096]
  })

  assert.equal(config.chunkers[0].kind, 'fixed-token')
  assert.equal(config.retrievers[0].kind, 'hybrid-rrf')
  assert.equal(config.retrievers[0].rrfK, 60)
  assert.equal(config.candidatePoolSize, 50)
  assert.deepEqual(config.splits, ['dev'])
  assert.equal(config.outputDir, '.rag-eval/runs')
})

test('rejects invalid overlap and duplicate context budgets', () => {
  const base = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'invalid',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    retrievers: [{ kind: 'bm25' }],
    contextBudgets: [2048, 2048]
  }

  assert.throws(
    () =>
      parseExperimentConfig({
        ...base,
        chunkers: [{ kind: 'fixed-token', size: 100, overlap: 100 }]
      }),
    /overlap must be smaller|contextBudgets must be unique/
  )
})
