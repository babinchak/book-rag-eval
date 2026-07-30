import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assembleContextBudget,
  computeRetrievalMetrics,
  type ContextCandidate,
  type RankedEvidenceCandidate
} from '../src/shared/evalMetrics'
import type { GoldEvidence } from '../src/shared/evalSchema'

function candidate(
  id: string,
  start: number,
  end: number,
  overrides: Partial<RankedEvidenceCandidate> = {}
): RankedEvidenceCandidate {
  return {
    id,
    bookId: 'book-1',
    spineHref: 'chapter.xhtml',
    textStart: start,
    textEnd: end,
    canonicalNodeIds: [],
    tokenCount: 10,
    ...overrides
  }
}

const MULTI_EVIDENCE: GoldEvidence[] = [
  {
    id: 'first',
    requirementId: 'claim-a',
    kind: 'text',
    bookId: 'book-1',
    nodeId: 'node-a',
    spineHref: 'chapter.xhtml',
    textStart: 100,
    textEnd: 200
  },
  {
    id: 'second',
    requirementId: 'claim-b',
    kind: 'text',
    bookId: 'book-1',
    nodeId: 'node-b',
    spineHref: 'chapter.xhtml',
    textStart: 400,
    textEnd: 500
  }
]

test('separates binary Hit@k from requirement-level evidence recall', () => {
  const metrics = computeRetrievalMetrics(
    [candidate('noise', 0, 50), candidate('partial', 100, 160)],
    MULTI_EVIDENCE
  )

  assert.equal(metrics.hitAtK, 1)
  assert.equal(metrics.firstHitRank, 2)
  assert.equal(metrics.mrr, 0.5)
  assert.equal(metrics.evidenceRecall, 0.5)
  assert.equal(metrics.fullEvidenceSuccess, 0)
  assert.equal(metrics.goldSpanCoverage, 0.3)
  assert.equal(metrics.tokensBeforeFirstEvidence, 10)
})

test('counts alternatives once and gives full credit for table or image node hits', () => {
  const evidence: GoldEvidence[] = [
    {
      id: 'text-alternative',
      requirementId: 'diagram',
      kind: 'text',
      bookId: 'book-1',
      nodeId: 'caption',
      spineHref: 'chapter.xhtml',
      textStart: 10,
      textEnd: 30
    },
    {
      id: 'image-alternative',
      requirementId: 'diagram',
      kind: 'image',
      bookId: 'book-1',
      nodeId: 'figure-1',
      spineHref: 'chapter.xhtml'
    }
  ]
  const metrics = computeRetrievalMetrics(
    [candidate('image-hit', 100, 100, { canonicalNodeIds: ['figure-1'] })],
    evidence
  )

  assert.equal(metrics.evidenceRecall, 1)
  assert.equal(metrics.fullEvidenceSuccess, 1)
  assert.equal(metrics.goldSpanCoverage, 1)
})

test('computes coverage-aware nDCG without rewarding duplicate hits', () => {
  const duplicateA = candidate('duplicate-a', 100, 200)
  const metrics = computeRetrievalMetrics(
    [duplicateA, { ...duplicateA, id: 'duplicate-a-2' }, candidate('claim-b', 400, 500)],
    MULTI_EVIDENCE
  )
  const ideal = 1 + 1 / Math.log2(3)
  const actual = 1 + 1 / Math.log2(4)

  assert.ok(metrics.ndcgAtK !== null)
  assert.ok(Math.abs(metrics.ndcgAtK! - actual / ideal) < 1e-12)
  assert.equal(metrics.fullEvidenceSuccess, 1)
})

test('returns not-applicable retrieval metrics for unanswerable cases', () => {
  const metrics = computeRetrievalMetrics([candidate('anything', 0, 10)], [])
  assert.equal(metrics.hitAtK, null)
  assert.equal(metrics.evidenceRecall, null)
  assert.equal(metrics.candidateRelevance[0].relevant, false)
})

test('assembles contexts under an exact token budget and removes overlap', () => {
  const contextCandidates: ContextCandidate[] = [
    {
      ...candidate('first', 0, 10),
      text: 'abcdefghij'
    },
    {
      ...candidate('overlap', 5, 15),
      text: 'fghijklmno'
    },
    {
      ...candidate('too-large', 20, 30),
      text: 'pqrstuvwxy'
    }
  ]
  const assembled = assembleContextBudget(contextCandidates, 15, (text) => text.length)

  assert.deepEqual(
    assembled.items.map((item) => ({ id: item.candidate.id, text: item.text })),
    [
      { id: 'first', text: 'abcdefghij' },
      { id: 'overlap', text: 'klmno' }
    ]
  )
  assert.equal(assembled.totalTokens, 15)
  assert.deepEqual(assembled.skippedOverBudgetIds, ['too-large'])
})

test('validates context budgets and skips duplicate candidates', () => {
  const item: ContextCandidate = { ...candidate('same', 0, 5), text: 'hello' }
  const assembled = assembleContextBudget([item, item], 10, (text) => text.length)

  assert.equal(assembled.items.length, 1)
  assert.deepEqual(assembled.skippedDuplicateIds, ['same'])
  assert.throws(() => assembleContextBudget([], -1, () => 0), /non-negative integer/)
})
