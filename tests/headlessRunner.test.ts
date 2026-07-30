import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { buildCanonicalBookDocument } from '../src/shared/canonicalDocument'
import { EVAL_SCHEMA_VERSION } from '../src/shared/evalSchema'

const execFileAsync = promisify(execFile)
const launcher = resolve('scripts/rag-eval.mjs')

async function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [launcher, ...args], {
    cwd: resolve('.'),
    encoding: 'utf8'
  })
}

test('plans, runs, resumes, and exports a zero-cost BM25 experiment', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'book-rag-eval-headless-'))
  context.after(async () => fs.rm(root, { recursive: true, force: true }))

  const libraryDir = join(root, 'library')
  const bookId = 'book-1'
  const bookDir = join(libraryDir, bookId)
  const evalsDir = join(bookDir, 'evals')
  await fs.mkdir(evalsDir, { recursive: true })

  const href = 'OPS/chapter.xhtml'
  const rawHtml =
    '<html><body><h1>Freedom</h1><p>The central claim is that freedom requires responsibility.</p></body></html>'
  const zip = new AdmZip()
  zip.addFile(href, Buffer.from(rawHtml, 'utf8'))
  zip.writeZip(join(bookDir, 'book.epub'))
  await fs.writeFile(
    join(bookDir, 'manifest.json'),
    JSON.stringify({ readingOrder: [{ href }] }),
    'utf8'
  )

  const canonical = buildCanonicalBookDocument(bookId, [{ href, rawHtml }])
  const paragraph = canonical.spine[0].nodes.find((node) => node.kind === 'paragraph')!
  const claimStart = canonical.spine[0].text.indexOf('freedom requires responsibility')
  const claimEnd = claimStart + 'freedom requires responsibility'.length
  await fs.writeFile(
    join(evalsDir, 'reviewed.json'),
    JSON.stringify({
      schemaVersion: EVAL_SCHEMA_VERSION,
      id: 'reviewed',
      bookId,
      createdAt: 1,
      updatedAt: 1,
      cases: [
        {
          id: 'case-1',
          question: 'What does freedom require?',
          canonicalSearchQuery: 'freedom responsibility',
          searchQuery: 'freedom responsibility',
          scope: 'within_book',
          answerability: 'answerable',
          goldEvidence: [
            {
              id: 'evidence-1',
              requirementId: 'required-1',
              kind: 'text',
              bookId,
              nodeId: paragraph.id,
              spineHref: href,
              textStart: claimStart,
              textEnd: claimEnd
            }
          ],
          goldSpans: [
            {
              bookId,
              nodeId: paragraph.id,
              spineHref: href,
              textStart: claimStart,
              textEnd: claimEnd
            }
          ],
          tags: ['direct-fact'],
          difficulty: 'easy',
          split: 'dev',
          provenance: { kind: 'human' }
        }
      ]
    }),
    'utf8'
  )

  const configPath = join(root, 'smoke.yaml')
  await fs.writeFile(
    configPath,
    [
      'schemaVersion: 1',
      'name: integration-smoke',
      'libraryDir: ./library',
      'outputDir: ./results',
      'books:',
      `  - bookId: ${bookId}`,
      '    evalSetId: reviewed',
      'chunkers:',
      '  - kind: fixed-token',
      '    size: 32',
      '    overlap: 4',
      'retrievers:',
      '  - kind: bm25',
      'contextBudgets: [16, 64]',
      'candidatePoolSize: 10',
      'splits: [dev]'
    ].join('\n'),
    'utf8'
  )

  const plan = JSON.parse((await cli('plan', configPath)).stdout) as {
    books: Array<{ selectedCases: number }>
    retrievalQueries: number
    experimentCells: number
    estimatedCostUsd: number
    runPath: string
    artifacts: Array<{ chunkExists: boolean }>
  }
  assert.equal(plan.books[0].selectedCases, 1)
  assert.equal(plan.retrievalQueries, 1)
  assert.equal(plan.experimentCells, 2)
  assert.equal(plan.estimatedCostUsd, 0)
  assert.equal(plan.artifacts[0].chunkExists, false)

  await cli('run', configPath, '--max-usd', '0')
  const first = JSON.parse(await fs.readFile(plan.runPath, 'utf8')) as {
    status: string
    results: Array<{ metrics: { hitAtK: number | null } }>
    ledger: { actualCostUsd: number }
    plan: { runPath: string }
  }
  assert.equal(first.status, 'completed')
  assert.equal(first.results.length, 2)
  assert.equal(first.ledger.actualCostUsd, 0)
  assert.ok(first.results.some((row) => row.metrics.hitAtK === 1))

  await assert.rejects(() => cli('run', configPath, '--max-usd', '0'), /use resume/)
  await cli('resume', configPath, '--max-usd', '0')
  const resumed = JSON.parse(await fs.readFile(plan.runPath, 'utf8')) as {
    results: unknown[]
  }
  assert.equal(resumed.results.length, 2)

  const jsonlPath = (await cli('export', first.plan.runPath, '--format', 'jsonl')).stdout.trim()
  const csvPath = (await cli('export', first.plan.runPath, '--format', 'csv')).stdout.trim()
  assert.match(await fs.readFile(jsonlPath, 'utf8'), /"caseId":"case-1"/)
  assert.match(await fs.readFile(csvPath, 'utf8'), /"evidenceRecall"/)
})
