import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  getDraftCaseBrowser,
  listDraftCaseRuns,
  updateDraftCaseReview
} from '../src/main/benchmarkCases'

test('browses and safely persists review decisions for canonical drafts', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'book-rag-case-browser-'))
  context.after(async () => fs.rm(root, { recursive: true, force: true }))
  const runsDir = join(root, 'eval-drafts')
  const packetPath = join(root, 'packet.json')
  const runPath = join(runsDir, 'smoke.json')
  await fs.mkdir(runsDir, { recursive: true })
  await fs.writeFile(
    packetPath,
    JSON.stringify({
      schemaVersion: 1,
      corpusId: 'smoke-corpus',
      corpusFingerprint: 'corpus-1',
      candidatesPerBook: 1,
      books: [
        {
          bookId: 'book-1',
          title: 'Meditations',
          author: 'Marcus Aurelius',
          sourceHash: 'source-1',
          selectedCandidates: 1,
          availableKinds: { paragraph: 1 }
        }
      ],
      candidates: [
        {
          id: 'candidate-1',
          bookId: 'book-1',
          sourceHash: 'source-1',
          nodeId: 'node-1',
          kind: 'paragraph',
          spineHref: 'chapter.xhtml',
          textStart: 100,
          textEnd: 154,
          headingPath: ['Book II'],
          excerpt: 'The Stoics held that material objects alone existed.',
          assets: [],
          reviewStatus: 'pending'
        }
      ]
    }),
    'utf8'
  )
  await fs.writeFile(
    runPath,
    JSON.stringify({
      schemaVersion: 1,
      fingerprint: 'run-1',
      status: 'completed',
      plan: {
        name: 'six-book-smoke',
        packetPath,
        corpusId: 'smoke-corpus',
        corpusFingerprint: 'corpus-1',
        promptHash: 'prompt-1',
        model: { name: 'draft-model' }
      },
      startedAt: 1,
      updatedAt: 2,
      maxUsd: 1,
      ledger: { inputTokens: 10, outputTokens: 10, actualCostUsd: 0.001, requests: 1 },
      attempts: [],
      drafts: [
        {
          candidateId: 'candidate-1',
          bookId: 'book-1',
          sourceHash: 'source-1',
          nodeId: 'node-1',
          spineHref: 'chapter.xhtml',
          evidenceKind: 'text',
          evidenceTextStart: 126,
          evidenceTextEnd: 154,
          question: 'What did the Stoics believe existed?',
          canonicalSearchQuery: 'Stoic view material existence',
          answerSpan: 'material objects alone existed',
          referenceAnswer: 'They believed that only material objects existed.',
          tags: ['stoicism'],
          difficulty: 'medium',
          reviewStatus: 'pending',
          provenance: {
            kind: 'llm_assisted',
            model: 'draft-model',
            promptHash: 'prompt-1',
            packetFingerprint: 'corpus-1'
          }
        }
      ],
      failures: []
    }),
    'utf8'
  )

  const runs = await listDraftCaseRuns(root)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].counts.pending, 1)

  const browser = await getDraftCaseBrowser(runPath, root)
  assert.equal(browser.books[0].title, 'Meditations')
  assert.equal(browser.cases[0].excerpt, 'The Stoics held that material objects alone existed.')
  assert.equal(browser.cases[0].reviewStatus, 'pending')

  const needsChanges = await updateDraftCaseReview(
    runPath,
    {
      candidateId: 'candidate-1',
      reviewStatus: 'needs_revision',
      reviewerNotes: 'Make the book context explicit.'
    },
    root
  )
  assert.equal(needsChanges.run.counts.needs_revision, 1)
  assert.equal(needsChanges.cases[0].reviewerNotes, 'Make the book context explicit.')

  const approved = await updateDraftCaseReview(
    runPath,
    {
      candidateId: 'candidate-1',
      reviewStatus: 'approved',
      question: 'According to Meditations, what did the Stoics believe existed?',
      reviewerNotes: 'Clear and supported.'
    },
    root
  )
  assert.equal(approved.run.counts.approved, 1)
  assert.equal(approved.run.counts.needs_revision, 0)
  assert.equal(approved.cases[0].reviewStatus, 'approved')
  const persisted = JSON.parse(await fs.readFile(runPath, 'utf8')) as {
    reviewEvents: unknown[]
  }
  assert.equal(persisted.reviewEvents.length, 2)

  await assert.rejects(
    () => getDraftCaseBrowser(join(root, 'outside.json'), root),
    /must be inside/
  )
})
