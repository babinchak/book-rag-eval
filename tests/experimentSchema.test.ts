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
  assert.equal(config.retrievers[0].vectorWeight, 1)
  assert.equal(config.retrievers[0].bm25Weight, 1)
  assert.equal(config.candidatePoolSize, 50)
  assert.deepEqual(config.splits, ['dev'])
  assert.deepEqual(config.excludeEvidenceKinds, [])
  assert.equal(config.outputDir, '.rag-eval/runs')
  assert.deepEqual(config.queryModes, ['reference'])
})

test('parses weighted hybrid retrieval', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'weighted-hybrid',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 256, overlap: 32 }],
    retrievers: [
      {
        kind: 'hybrid-rrf',
        embeddingModel: 'voyage-4-large',
        vectorWeight: 0.75,
        bm25Weight: 0.25
      }
    ],
    contextBudgets: [8192]
  })

  assert.equal(config.retrievers[0].vectorWeight, 0.75)
  assert.equal(config.retrievers[0].bm25Weight, 0.25)
})

test('supports excluding non-text evidence tracks from an experiment', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'text-only',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 256, overlap: 32 }],
    retrievers: [{ kind: 'bm25' }],
    contextBudgets: [8192],
    excludeEvidenceKinds: ['table', 'image']
  })

  assert.deepEqual(config.excludeEvidenceKinds, ['table', 'image'])
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
  assert.deepEqual(config.pricing.rerankingUsdPerMillion, {})
})

test('parses Voyage vector retrieval and pricing', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'voyage',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 256, overlap: 32 }],
    retrievers: [{ kind: 'vector', embeddingModel: 'voyage-4-large' }],
    contextBudgets: [4096],
    pricing: { embeddingUsdPerMillion: { 'voyage-4-large': 0.12 } }
  })
  assert.equal(config.retrievers[0].embeddingModel, 'voyage-4-large')
  assert.equal(config.pricing.embeddingUsdPerMillion['voyage-4-large'], 0.12)
})

test('parses a Voyage reranking stage and pricing', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'rerank',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 256, overlap: 32 }],
    retrievers: [
      {
        kind: 'bm25',
        reranker: { kind: 'voyage', model: 'rerank-2.5-lite' }
      }
    ],
    contextBudgets: [8192],
    pricing: { rerankingUsdPerMillion: { 'rerank-2.5-lite': 0.02 } }
  })
  assert.equal(config.retrievers[0].reranker?.model, 'rerank-2.5-lite')
  assert.equal(config.pricing.rerankingUsdPerMillion['rerank-2.5-lite'], 0.02)
})

test('parses local ColBERTv2 and BGE-M3 retrieval modes', () => {
  const config = parseExperimentConfig({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'local-models',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 256, overlap: 32 }],
    retrievers: [
      { kind: 'colbertv2' },
      { kind: 'bge-m3', mode: 'dense' },
      { kind: 'bge-m3', mode: 'sparse' },
      { kind: 'bge-m3', mode: 'colbert-dense-shortlist', shortlist: 100 }
    ],
    contextBudgets: [8192]
  })

  assert.equal(config.retrievers[0].model, 'lightonai/colbertv2.0')
  assert.equal(config.retrievers[1].model, 'BAAI/bge-m3')
  assert.equal(config.retrievers[3].shortlist, 100)
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

test('accepts question/reference comparisons and rejects duplicate query modes', () => {
  const base = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    name: 'query-comparison',
    books: [{ bookId: 'book-1', evalSetId: 'reviewed' }],
    chunkers: [{ kind: 'fixed-token', size: 100, overlap: 10 }],
    retrievers: [{ kind: 'bm25' }],
    contextBudgets: [2048]
  }
  assert.deepEqual(
    parseExperimentConfig({ ...base, queryModes: ['question', 'reference'] }).queryModes,
    ['question', 'reference']
  )
  assert.throws(
    () => parseExperimentConfig({ ...base, queryModes: ['question', 'question'] }),
    /queryModes must be unique/
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
