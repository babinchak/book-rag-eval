import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HeadlessRun } from '../src/headless/experimentRunner'
import { writeTournamentReport } from '../src/headless/tournamentReport'

function run(name: string, retriever: HeadlessRun['results'][number]['retriever'], score: number): HeadlessRun {
  return {
    schemaVersion: 1,
    metricVersion: 2,
    fingerprint: name,
    status: 'completed',
    configPath: `${name}.yaml`,
    plan: {
      name,
      sourceControl: { gitCommit: 'abc', workingTreeDiffHash: null }
    } as HeadlessRun['plan'],
    startedAt: 1,
    updatedAt: name === 'candidate' ? 3 : 2,
    completedAt: 3,
    maxUsd: 1,
    ledger: {
      embeddingIndexTokens: 0,
      embeddingQueryTokens: 0,
      actualCostUsd: 0.01,
      rerankTokens: 0,
      rerankCostUsd: 0,
      byReranker: {},
      byModel: {},
      indexingByArtifact: [],
      localIndexes: []
    },
    queryCache: {},
    results: [512, 8192].map((contextBudget) => ({
      key: `${name}:${contextBudget}`,
      bookId: 'book-1',
      evalSetId: 'eval-1',
      caseId: 'case-1',
      split: 'dev',
      scope: 'within_book',
      strategyId: 'fixed-token-cl100k_base-256-32',
      chunkArtifactId: 'chunks-1',
      retriever,
      queryMode: 'question',
      retrievalQuery: 'question',
      contextPolicy: { kind: 'chunks' },
      contextBudget,
      retrievedChunkIds: [],
      retrievedTokens: contextBudget,
      metrics: {
        hitAtK: 1,
        mrr: score,
        ndcgAtK: score,
        evidenceRecall: score,
        fullEvidenceSuccess: score,
        contextPrecision: score,
        exactEvidenceDensity: score,
        goldSpanCoverage: score,
        tokensBeforeFirstEvidence: 10,
        tokensToFirstEvidence: 20,
        tokensToFullEvidence: 30,
        evidenceEfficiency: score,
        payloadEvidenceEfficiency: score,
        correctBookRecall: 1,
        firstHitRank: 1
      }
    }))
  }
}

test('merges compatible runs into a ranked tournament report and SVG', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'book-rag-tournament-'))
  context.after(async () => fs.rm(root, { recursive: true, force: true }))
  const baselinePath = join(root, 'baseline.json')
  const candidatePath = join(root, 'candidate.json')
  await fs.writeFile(baselinePath, JSON.stringify(run('baseline', { kind: 'bm25' }, 0.5)))
  await fs.writeFile(
    candidatePath,
    JSON.stringify(run('candidate', { kind: 'colbertv2', model: 'lightonai/colbertv2.0' }, 0.8))
  )

  const output = await writeTournamentReport(candidatePath, join(root, 'tournament.md'), 8192, 2)
  const summary = JSON.parse(await fs.readFile(output.jsonPath, 'utf8')) as {
    strategies: Array<{ label: string }>
    totalMeteredCostUsd: number
    runDirectoryMeteredCostUsd: number
  }
  assert.match(summary.strategies[0].label, /ColBERTv2/)
  assert.equal(summary.totalMeteredCostUsd, 0.02)
  assert.equal(summary.runDirectoryMeteredCostUsd, 0.02)
  assert.match(await fs.readFile(output.markdownPath, 'utf8'), /provisional and unreviewed/i)
  assert.match(await fs.readFile(output.svgPath, 'utf8'), /<polyline/)
})
