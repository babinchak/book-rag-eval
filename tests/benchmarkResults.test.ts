import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getBenchmarkRunResults, listBenchmarkRuns } from '../src/main/benchmarkResults'

test('lists normalized headless result matrices and rejects paths outside runs', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'book-rag-results-browser-'))
  context.after(async () => fs.rm(root, { recursive: true, force: true }))
  const runsDir = join(root, 'runs')
  const runPath = join(runsDir, 'smoke.json')
  await fs.mkdir(runsDir, { recursive: true })
  await fs.writeFile(
    runPath,
    JSON.stringify({
      schemaVersion: 1,
      fingerprint: 'fingerprint-1',
      status: 'completed',
      configPath: 'smoke.yaml',
      plan: { name: 'smoke' },
      startedAt: 1,
      updatedAt: 2,
      maxUsd: 0,
      ledger: { embeddingIndexTokens: 0, embeddingQueryTokens: 0, actualCostUsd: 0, byModel: {} },
      queryCache: {},
      results: [
        {
          key: 'cell-1',
          bookId: 'book-1',
          evalSetId: 'provisional',
          caseId: 'case-1',
          split: 'dev',
          scope: 'within_book',
          strategyId: 'fixed-token-cl100k_base-256-32',
          chunkArtifactId: 'chunks-1',
          retriever: { kind: 'bm25' },
          contextBudget: 2048,
          retrievedChunkIds: ['chunk-1'],
          retrievedTokens: 200,
          metrics: {
            hitAtK: 1,
            mrr: 1,
            ndcgAtK: 1,
            evidenceRecall: 1,
            fullEvidenceSuccess: 1,
            contextPrecision: 1,
            goldSpanCoverage: 1,
            tokensBeforeFirstEvidence: 0,
            correctBookRecall: 1,
            firstHitRank: 1
          }
        }
      ]
    }),
    'utf8'
  )

  const runs = await listBenchmarkRuns(root)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].uniqueCases, 1)
  assert.match(runs[0].caseSetFingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(runs[0].queryModes, ['reference'])

  const results = await getBenchmarkRunResults(runPath, root)
  assert.equal(results.cells[0].queryMode, 'reference')
  assert.equal(results.run.caseSetFingerprint, runs[0].caseSetFingerprint)
  assert.equal(results.cells[0].metrics.hitAtK, 1)
  await assert.rejects(() => getBenchmarkRunResults(join(root, 'outside.json'), root), /inside/)
})
