import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  planDraftGeneration,
  retryDraftFailures,
  runDraftGeneration,
  validateDraft,
  type DraftModel
} from '../src/headless/draftGeneration'
import { compileApprovedDrafts } from '../src/headless/draftCompilation'
import { writeDraftAudit } from '../src/headless/draftAudit'
import { parseEvalSet } from '../src/shared/evalSchema'

test('plans, validates, meters, and resumes canonical draft generation', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'book-rag-drafts-'))
  context.after(async () => fs.rm(root, { recursive: true, force: true }))
  const packetPath = join(root, 'packet.json')
  const configPath = join(root, 'drafts.yaml')
  const sourceHash = 'source-1'
  await fs.writeFile(
    packetPath,
    JSON.stringify({
      schemaVersion: 1,
      corpusId: 'corpus-1',
      corpusFingerprint: 'corpus-fingerprint-1',
      candidatesPerBook: 1,
      books: [
        {
          bookId: 'book-1',
          title: 'Freedom',
          author: 'A. Thinker',
          sourceHash,
          selectedCandidates: 1,
          availableKinds: { paragraph: 1 }
        }
      ],
      candidates: [
        {
          id: 'candidate-1',
          bookId: 'book-1',
          sourceHash,
          nodeId: 'node-1',
          kind: 'paragraph',
          spineHref: 'OPS/chapter.xhtml',
          textStart: 100,
          textEnd: 180,
          headingPath: ['Responsibility'],
          excerpt:
            'Freedom requires responsibility and careful judgment in every deliberate action.',
          assets: [],
          reviewStatus: 'pending'
        }
      ]
    }),
    'utf8'
  )
  await fs.writeFile(
    configPath,
    [
      'schemaVersion: 1',
      'name: integration-drafts',
      'packetPath: ./packet.json',
      'outputDir: ./runs',
      'model:',
      '  provider: openai',
      '  name: fake-model-1',
      '  temperature: 0',
      '  maxOutputTokensPerCandidate: 100',
      'pricing:',
      '  inputUsdPerMillion: 1',
      '  outputUsdPerMillion: 2',
      'maxAttemptsPerCandidate: 2'
    ].join('\n'),
    'utf8'
  )

  const responses = [
    {
      draft: {
        question: 'What does freedom require?',
        searchQuery: 'conditions for deliberate freedom',
        answerSpan: 'not copied from evidence',
        referenceAnswer: 'Responsibility.',
        tags: ['direct_fact'],
        difficulty: 'easy' as const
      },
      rawModelContent: '{"answerSpan":"not copied from evidence"}',
      inputTokens: 100,
      outputTokens: 20
    },
    {
      draft: {
        question: 'What does freedom require?',
        searchQuery: 'conditions for deliberate freedom',
        answerSpan: 'Freedom requires responsibility',
        referenceAnswer: 'Freedom requires responsibility.',
        tags: ['direct_fact'],
        difficulty: 'easy' as const
      },
      resolvedModel: 'fake-model-1-snapshot',
      inputTokens: 110,
      outputTokens: 22
    }
  ]
  let calls = 0
  const fakeModel: DraftModel = {
    async generate() {
      return responses[calls++]
    }
  }

  const firstPlan = await planDraftGeneration(configPath)
  const secondPlan = await planDraftGeneration(configPath)
  assert.equal(firstPlan.fingerprint, secondPlan.fingerprint)
  assert.equal(firstPlan.candidates, 1)
  assert.ok(firstPlan.estimatedCostUsd > 0)

  await assert.rejects(
    () =>
      runDraftGeneration(configPath, firstPlan.estimatedCostUsd / 2, {
        model: fakeModel
      }),
    /exceeds --max-usd/
  )
  const run = await runDraftGeneration(configPath, 1, { model: fakeModel })
  assert.equal(run.status, 'completed')
  assert.equal(run.attempts.length, 2)
  assert.equal(run.attempts[0].rawModelContent, '{"answerSpan":"not copied from evidence"}')
  assert.match(run.attempts[0].validationError ?? '', /exact contiguous/)
  assert.equal(run.drafts.length, 1)
  assert.equal(run.drafts[0].provenance.model, 'fake-model-1-snapshot')
  assert.equal(run.drafts[0].evidenceTextStart, 100)
  assert.equal(run.drafts[0].evidenceTextEnd, 131)
  assert.equal(run.ledger.requests, 2)
  assert.equal(run.ledger.actualCostUsd, 0.000294)

  const resumed = await runDraftGeneration(configPath, 1, {
    resume: true,
    model: {
      async generate() {
        throw new Error('resume should not call the model')
      }
    }
  })
  assert.equal(resumed.drafts.length, 1)
  assert.equal(resumed.ledger.requests, 2)

  const failedRun = JSON.parse(await fs.readFile(run.plan.runPath, 'utf8')) as {
    status: string
    attempts: Array<{ validationError?: string }>
    drafts: unknown[]
    failures: Array<{ candidateId: string; error: string }>
  }
  failedRun.status = 'completed_with_failures'
  failedRun.drafts = []
  failedRun.failures = [{ candidateId: 'candidate-1', error: 'simulated exhausted validation' }]
  for (const attempt of failedRun.attempts) {
    attempt.validationError = 'simulated exhausted validation'
  }
  await fs.writeFile(run.plan.runPath, JSON.stringify(failedRun), 'utf8')
  let recoveryCalls = 0
  const recovered = await retryDraftFailures(run.plan.runPath, 1, 1, {
    model: {
      async generate() {
        recoveryCalls += 1
        return {
          draft: responses[1].draft,
          resolvedModel: 'fake-model-1-snapshot',
          inputTokens: 105,
          outputTokens: 21
        }
      }
    }
  })
  assert.equal(recoveryCalls, 1)
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.drafts.length, 1)
  assert.equal(recovered.failures.length, 0)
  assert.equal(recovered.recoveryEvents?.length, 1)
  assert.equal(recovered.recoveryEvents?.[0].additionalAttempts, 1)

  const auditPath = join(root, 'draft-review')
  const audit = await writeDraftAudit(run.plan.runPath, auditPath)
  assert.equal(audit.audit.totalDrafts, 1)
  assert.equal(audit.audit.flaggedDrafts, 0)
  assert.equal(audit.audit.pendingHumanReview, 1)
  assert.equal(audit.markdownPath, auditPath)
  assert.equal(audit.jsonPath, `${auditPath}.json`)
  assert.match(await fs.readFile(audit.markdownPath, 'utf8'), /Pending human review: 1/)

  const compiledDir = join(root, 'compiled')
  await assert.rejects(
    () => compileApprovedDrafts(run.plan.runPath, compiledDir, 'Reviewer One'),
    /pending human review/
  )
  const reviewedRun = JSON.parse(await fs.readFile(run.plan.runPath, 'utf8')) as {
    drafts: Array<{ reviewStatus: string; sourceHash: string }>
  }
  reviewedRun.drafts[0].reviewStatus = 'needs_revision'
  await fs.writeFile(run.plan.runPath, JSON.stringify(reviewedRun), 'utf8')
  await assert.rejects(
    () => compileApprovedDrafts(run.plan.runPath, compiledDir, 'Reviewer One'),
    /pending human review/
  )
  reviewedRun.drafts[0].reviewStatus = 'approved'
  reviewedRun.drafts[0].sourceHash = 'tampered-source'
  await fs.writeFile(run.plan.runPath, JSON.stringify(reviewedRun), 'utf8')
  await assert.rejects(
    () => compileApprovedDrafts(run.plan.runPath, compiledDir, 'Reviewer One'),
    /changed immutable sourceHash/
  )
  reviewedRun.drafts[0].sourceHash = sourceHash
  await fs.writeFile(run.plan.runPath, JSON.stringify(reviewedRun), 'utf8')
  const compiled = await compileApprovedDrafts(run.plan.runPath, compiledDir, 'Reviewer One')
  assert.equal(compiled.manifest.approvedCases, 1)
  const evalPath = join(compiledDir, compiled.manifest.evalSets[0].path)
  const evalSet = parseEvalSet(JSON.parse(await fs.readFile(evalPath, 'utf8')))
  assert.equal(evalSet.cases.length, 1)
  assert.equal(evalSet.cases[0].provenance.reviewedBy, 'Reviewer One')
  assert.equal(evalSet.cases[0].goldEvidence[0].textStart, 100)
})

test('allows short exact spans for image metadata evidence', () => {
  const record = validateDraft(
    {
      id: 'image-candidate',
      bookId: 'book-1',
      sourceHash: 'source-1',
      nodeId: 'image-1',
      kind: 'image',
      spineHref: 'chapter.xhtml',
      textStart: 0,
      textEnd: 5,
      headingPath: ['Figures'],
      excerpt: 'Chart',
      assets: ['chart.png'],
      reviewStatus: 'pending'
    },
    {
      question: 'What kind of visual is identified?',
      searchQuery: 'type of depicted visual',
      answerSpan: 'Chart',
      referenceAnswer: 'It is identified as a chart.',
      tags: ['image_metadata'],
      difficulty: 'easy'
    },
    'model-snapshot',
    'prompt-hash',
    'packet-fingerprint'
  )

  assert.equal(record.evidenceKind, 'image')
  assert.equal(record.answerSpan, 'Chart')
})

test('snaps a long near-exact model span back to canonical book text', () => {
  const candidate = {
    id: 'text-candidate',
    bookId: 'book-1',
    sourceHash: 'source-1',
    nodeId: 'paragraph-1',
    kind: 'paragraph' as const,
    spineHref: 'chapter.xhtml',
    textStart: 50,
    textEnd: 180,
    headingPath: ['Experiments'],
    excerpt:
      'He now admits that in the shortest reactions there is neither apperception nor will, but only a practiced reflex.',
    assets: [],
    reviewStatus: 'pending' as const
  }
  const record = validateDraft(
    candidate,
    {
      question: 'What does the author now admit about the shortest reactions?',
      searchQuery: 'author concession about rapid reactions',
      answerSpan: 'he admits that in the shortest reactions there is neither apperception nor will',
      referenceAnswer: 'They contain neither apperception nor will.',
      tags: ['direct_fact'],
      difficulty: 'medium'
    },
    'model-snapshot',
    'prompt-hash',
    'packet-fingerprint'
  )

  assert.equal(
    record.answerSpan,
    'admits that in the shortest reactions there is neither apperception nor will'
  )
  assert.ok(record.tags.includes('answer_span_repaired'))
  assert.equal(
    candidate.excerpt.slice(
      record.evidenceTextStart! - candidate.textStart,
      record.evidenceTextEnd! - candidate.textStart
    ),
    record.answerSpan
  )
  assert.throws(
    () =>
      validateDraft(
        candidate,
        {
          question: 'What does the author say?',
          searchQuery: 'author statement in experiment',
          answerSpan: 'an unrelated invented answer',
          referenceAnswer: 'Nothing supported.',
          tags: ['direct_fact'],
          difficulty: 'easy'
        },
        'model-snapshot',
        'prompt-hash',
        'packet-fingerprint'
      ),
    /exact contiguous substring/
  )
})
