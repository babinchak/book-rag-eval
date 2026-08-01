import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapMean, reportMarkdown, summarizeRun } from '../src/headless/report'
import type { HeadlessRun, HeadlessResultRow } from '../src/headless/experimentRunner'

function row(
  strategyId: string,
  caseId: string,
  recall: number,
  retriever: HeadlessResultRow['retriever'] = { kind: 'bm25' }
): HeadlessResultRow {
  return {
    key: `${strategyId}-${caseId}`,
    bookId: 'book-1',
    evalSetId: 'eval-1',
    caseId,
    split: 'dev',
    scope: 'within_book',
    strategyId,
    chunkArtifactId: `${strategyId}-artifact`,
    retriever,
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
  assert.deepEqual(bootstrapMean([0, 1, 1], 100, 'stable'), bootstrapMean([0, 1, 1], 100, 'stable'))
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
      actualCostUsd: 0.0012,
      byModel: {},
      indexingByArtifact: [
        {
          bookId: 'book-1',
          strategyId: 'baseline',
          chunkArtifactId: 'chunks-1',
          embeddingArtifactId: 'embeddings-1',
          model: 'voyage-4-large',
          tokens: 10_000,
          costUsd: 0.0012
        }
      ]
    },
    queryCache: {
      'baseline-case-1': {
        chunkArtifactId: 'chunks-1',
        hits: [],
        retrievalLatencyMs: 10,
        rerankLatencyMs: 20,
        nominalRerankCostUsd: 0.001
      },
      'baseline-case-2': {
        chunkArtifactId: 'chunks-1',
        hits: [],
        retrievalLatencyMs: 12,
        rerankLatencyMs: 22,
        nominalRerankCostUsd: 0.001
      },
      'candidate-case-1': {
        chunkArtifactId: 'chunks-2',
        hits: [],
        retrievalLatencyMs: 5,
        nominalEmbeddingQueryCostUsd: 0.0001
      },
      'candidate-case-2': {
        chunkArtifactId: 'chunks-2',
        hits: [],
        retrievalLatencyMs: 7,
        nominalEmbeddingQueryCostUsd: 0.0001
      }
    },
    results: [
      row('baseline', 'case-1', 0),
      row('baseline', 'case-2', 1),
      row('candidate', 'case-1', 1),
      row('candidate', 'case-2', 1),
      row('baseline', 'case-1', 0, { kind: 'random', seed: 42 }),
      row('baseline', 'case-2', 0, { kind: 'random', seed: 42 }),
      row('candidate', 'case-1', 0, { kind: 'random', seed: 42 }),
      row('candidate', 'case-2', 0, { kind: 'random', seed: 42 })
    ]
  } as HeadlessRun

  const report = summarizeRun(run, 100)
  const candidate = report.groups.find(
    (group) => group.strategyId === 'candidate' && group.retriever === 'bm25'
  )!
  assert.equal(candidate.metrics.evidenceRecall.mean, 1)
  assert.equal(candidate.evidenceRecallDeltaFromBaseline.mean, 0.5)
  const randomCandidate = report.groups.find(
    (group) => group.strategyId === 'candidate' && group.retriever === 'random:seed42'
  )!
  assert.equal(randomCandidate.evidenceRecallDeltaFromBaseline.mean, 0)
  const candidatePerformance = report.queryPerformance.find(
    (group) => group.strategyId === 'candidate' && group.retriever === 'bm25'
  )!
  assert.equal(candidatePerformance.retrievalLatencyMs.p50, 7)
  assert.equal(candidatePerformance.nominalTotalQueryCostUsd, 0.0002)
  assert.match(reportMarkdown(report), /Retrieval experiment report/)
  assert.match(reportMarkdown(report), /Online query performance/)
  assert.match(reportMarkdown(report), /candidate/)
  assert.match(reportMarkdown(report), /Document embedding cost by artifact/)
  assert.match(reportMarkdown(report), /voyage-4-large/)
})
