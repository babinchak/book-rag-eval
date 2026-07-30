import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPERIMENT_SCHEMA_VERSION, parseExperimentConfig } from '../src/shared/experimentSchema'

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

test('parses a deterministic random retrieval control', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'random-control',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 1024, overlap: 128 }],
    retrievers: [{ kind: 'random' }],
    contextBudgets: [2048]
  })

  assert.deepEqual(config.retrievers, [{ kind: 'random', seed: 42 }])
  assert.deepEqual(config.pricing.embeddingUsdPerMillion, {})
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

test('accepts portable eval files and rejects ambiguous eval sources', () => {
  const base = {
    schemaVersion: 1,
    name: 'portable',
    chunkers: [{ kind: 'fixed-token', size: 256, overlap: 32 }],
    retrievers: [{ kind: 'bm25' }],
    contextBudgets: [2048]
  }
  const parsed = parseExperimentConfig({
    ...base,
    books: [{ bookId: 'book-1', evalSetPath: '../benchmarks/evals/book-1.json' }]
  })
  assert.equal(parsed.books[0].evalSetPath, '../benchmarks/evals/book-1.json')
  assert.throws(
    () =>
      parseExperimentConfig({
        ...base,
        books: [{ bookId: 'book-1', evalSetId: 'draft', evalSetPath: 'draft.json' }]
      }),
    /exactly one/
  )
})
