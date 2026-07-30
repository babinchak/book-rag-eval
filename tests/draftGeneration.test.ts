import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  planDraftGeneration,
  runDraftGeneration,
  type DraftModel
} from '../src/headless/draftGeneration'
import { compileApprovedDrafts } from '../src/headless/draftCompilation'
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

  const compiledDir = join(root, 'compiled')
  await assert.rejects(
    () => compileApprovedDrafts(run.plan.runPath, compiledDir, 'Reviewer One'),
    /pending human review/
  )
  const reviewedRun = JSON.parse(await fs.readFile(run.plan.runPath, 'utf8')) as {
    drafts: Array<{ reviewStatus: string; sourceHash: string }>
  }
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
