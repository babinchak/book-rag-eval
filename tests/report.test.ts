import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapMean, reportMarkdown, summarizeRun } from '../src/headless/report'
import type { HeadlessRun, HeadlessResultRow } from '../src/headless/experimentRunner'

function row(strategyId: string, caseId: string, recall: number): HeadlessResultRow {
  return {
    key: `${strategyId}-${caseId}`,
    bookId: 'book-1',
    evalSetId: 'eval-1',
    caseId,
    split: 'dev',
    scope: 'within_book',
    strategyId,
    chunkArtifactId: `${strategyId}-artifact`,
    retriever: { kind: 'bm25' },
    contextBudget: 2048,
    retrievedChunkIds: [],
    retrievedTokens: 100,
    metrics: {
      hitAtK: recall,
      mrr: recall,
      ndcgAtK: recall,
      evidenceRecall: recall,
      fullEvidenceSuccess: recall,
      contextPrecision: recall / 2,
      goldSpanCoverage: recall,
      tokensBeforeFirstEvidence: recall ? 10 : 100,
      correctBookRecall: 1,
      firstHitRank: recall ? 1 : null
    }
  }
}

test('builds deterministic bootstrap estimates and paired strategy deltas', () => {
  assert.deepEqual(
    bootstrapMean([0, 1, 1], 100, 'stable'),
    bootstrapMean([0, 1, 1], 100, 'stable')
  )
  const run = {
    schemaVersion: 1,
    fingerprint: 'run-1',
    status: 'completed',
    configPath: 'experiment.yaml',
    plan: {
      sourceControl: { gitCommit: 'abc', workingTreeDiffHash: null }
    },
    startedAt: 1,
    updatedAt: 2,
    completedAt: 2,
    maxUsd: 0,
    ledger: {
      embeddingIndexTokens: 0,
      embeddingQueryTokens: 0,
      actualCostUsd: 0,
      byModel: {}
    },
    queryCache: {},
    results: [
      row('baseline', 'case-1', 0),
      row('baseline', 'case-2', 1),
      row('candidate', 'case-1', 1),
      row('candidate', 'case-2', 1)
    ]
  } as HeadlessRun

  const report = summarizeRun(run, 100)
  const candidate = report.groups.find((group) => group.strategyId === 'candidate')!
  assert.equal(candidate.metrics.evidenceRecall.mean, 1)
  assert.equal(candidate.evidenceRecallDeltaFromBaseline.mean, 0.5)
  assert.match(reportMarkdown(report), /Retrieval experiment report/)
  assert.match(reportMarkdown(report), /candidate/)
})
