import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { generatedEvalDraftSchema, parseEvidenceReviewPacket } from '../shared/authoringSchema'
import type {
  DraftCaseBrowserData,
  DraftCaseReviewUpdate,
  DraftReviewStatus,
  DraftRunBrowserSummary
} from '../shared/caseBrowser'
import { buildDraftAudit } from '../headless/draftAudit'
import { contentHash } from '../shared/artifactIdentity'
import {
  validateDraft,
  type DraftGenerationRun,
  type EvalDraftRecord
} from '../headless/draftGeneration'

const REVIEWABLE_STATUSES = new Set<DraftReviewStatus>([
  'pending',
  'approved',
  'rejected',
  'needs_revision'
])

function artifactsRoot(override?: string): string {
  return resolve(
    override ?? process.env.BOOK_RAG_EVAL_ARTIFACTS_DIR ?? join(process.cwd(), '.rag-eval')
  )
}

function draftRunsDir(override?: string): string {
  return join(artifactsRoot(override), 'eval-drafts')
}

function assertAllowedRunPath(runPath: string, override?: string): string {
  const root = draftRunsDir(override)
  const absolute = resolve(runPath)
  const child = relative(root, absolute)
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`Draft run must be inside ${root}`)
  }
  return absolute
}

async function readRun(runPath: string, override?: string): Promise<DraftGenerationRun> {
  const absolute = assertAllowedRunPath(runPath, override)
  const run = JSON.parse(await fs.readFile(absolute, 'utf8')) as DraftGenerationRun
  if (!Array.isArray(run.drafts) || !run.plan?.packetPath || !run.fingerprint) {
    throw new Error(`${absolute} is not a draft generation run`)
  }
  for (const draft of run.drafts) {
    if (!REVIEWABLE_STATUSES.has(draft.reviewStatus)) draft.reviewStatus = 'pending'
  }
  return run
}

function emptyCounts(): Record<DraftReviewStatus, number> {
  return { pending: 0, approved: 0, rejected: 0, needs_revision: 0 }
}

function summaryOf(runPath: string, run: DraftGenerationRun): DraftRunBrowserSummary {
  const counts = emptyCounts()
  for (const draft of run.drafts) counts[draft.reviewStatus] += 1
  return {
    runPath,
    fingerprint: run.fingerprint,
    name: run.plan.name,
    model: run.drafts[0]?.provenance.model ?? run.plan.model.name,
    status: run.status,
    updatedAt: run.updatedAt,
    actualCostUsd: run.ledger.actualCostUsd,
    totalCases: run.drafts.length,
    counts
  }
}

export async function listDraftCaseRuns(override?: string): Promise<DraftRunBrowserSummary[]> {
  const root = draftRunsDir(override)
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const summaries: DraftRunBrowserSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.audit.json')) continue
    const runPath = join(root, name)
    try {
      const run = await readRun(runPath, override)
      summaries.push(summaryOf(runPath, run))
    } catch {
      // The artifact directory can also contain auxiliary JSON. Only expose runs.
    }
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function getDraftCaseBrowser(
  runPath: string,
  override?: string
): Promise<DraftCaseBrowserData> {
  const absolute = assertAllowedRunPath(runPath, override)
  const run = await readRun(absolute, override)
  const packet = parseEvidenceReviewPacket(
    JSON.parse(await fs.readFile(run.plan.packetPath, 'utf8')) as unknown
  )
  if (packet.corpusFingerprint !== run.plan.corpusFingerprint) {
    throw new Error('Canonical evidence packet no longer matches the draft run fingerprint')
  }
  const audit = buildDraftAudit(run, packet)
  const auditById = new Map(audit.items.map((item) => [item.candidateId, item]))
  const candidates = new Map(packet.candidates.map((candidate) => [candidate.id, candidate]))
  const books = new Map(packet.books.map((book) => [book.bookId, book]))
  const cases = run.drafts.map((draft) => {
    const candidate = candidates.get(draft.candidateId)
    const book = books.get(draft.bookId)
    const audited = auditById.get(draft.candidateId)
    if (!candidate || !book || !audited) {
      throw new Error(`Draft ${draft.candidateId} is missing canonical review data`)
    }
    return {
      caseId: `case-${contentHash({
        corpusFingerprint: run.plan.corpusFingerprint,
        candidateId: draft.candidateId
      }).slice(0, 20)}`,
      candidateId: draft.candidateId,
      bookId: draft.bookId,
      bookTitle: book.title,
      bookAuthor: book.author,
      evidenceKind: draft.evidenceKind,
      spineHref: draft.spineHref,
      headingPath: candidate.headingPath,
      assets: candidate.assets,
      excerpt: candidate.excerpt,
      question: draft.question,
      canonicalSearchQuery: draft.canonicalSearchQuery,
      answerSpan: draft.answerSpan,
      referenceAnswer: draft.referenceAnswer,
      tags: draft.tags,
      difficulty: draft.difficulty,
      reviewStatus: draft.reviewStatus,
      reviewerNotes: draft.reviewerNotes ?? '',
      reviewedAt: draft.reviewedAt,
      auditDisposition: audited.disposition,
      auditFlags: audited.flags,
      model: draft.provenance.model
    }
  })
  return {
    run: summaryOf(absolute, run),
    books: packet.books.map((book) => ({
      bookId: book.bookId,
      title: book.title,
      author: book.author,
      cases: cases.filter((item) => item.bookId === book.bookId).length
    })),
    cases
  }
}

function generatedValue(draft: EvalDraftRecord): unknown {
  return {
    question: draft.question,
    searchQuery: draft.canonicalSearchQuery,
    answerSpan: draft.answerSpan,
    referenceAnswer: draft.referenceAnswer,
    tags: draft.tags,
    difficulty: draft.difficulty
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, path)
}

export async function updateDraftCaseReview(
  runPath: string,
  update: DraftCaseReviewUpdate,
  override?: string
): Promise<DraftCaseBrowserData> {
  const absolute = assertAllowedRunPath(runPath, override)
  const run = await readRun(absolute, override)
  const index = run.drafts.findIndex((draft) => draft.candidateId === update.candidateId)
  if (index < 0) throw new Error(`Unknown draft candidate ${update.candidateId}`)
  const current = run.drafts[index]
  const nextStatus = update.reviewStatus ?? current.reviewStatus
  if (!REVIEWABLE_STATUSES.has(nextStatus)) throw new Error('Invalid review status')
  const parsed = generatedEvalDraftSchema.parse({
    question: update.question ?? current.question,
    searchQuery: update.canonicalSearchQuery ?? current.canonicalSearchQuery,
    answerSpan: update.answerSpan ?? current.answerSpan,
    referenceAnswer: update.referenceAnswer ?? current.referenceAnswer,
    tags: update.tags ?? current.tags,
    difficulty: update.difficulty ?? current.difficulty
  })
  let next: EvalDraftRecord = {
    ...current,
    question: parsed.question,
    canonicalSearchQuery: parsed.searchQuery,
    answerSpan: parsed.answerSpan,
    referenceAnswer: parsed.referenceAnswer,
    tags: parsed.tags,
    difficulty: parsed.difficulty,
    reviewStatus: nextStatus,
    reviewerNotes: update.reviewerNotes ?? current.reviewerNotes ?? '',
    reviewedAt: nextStatus === 'pending' ? undefined : Date.now()
  }
  if (nextStatus === 'approved') {
    const packet = parseEvidenceReviewPacket(
      JSON.parse(await fs.readFile(run.plan.packetPath, 'utf8')) as unknown
    )
    const candidate = packet.candidates.find((item) => item.id === next.candidateId)
    if (!candidate) throw new Error(`Missing canonical candidate ${next.candidateId}`)
    const validated = validateDraft(
      candidate,
      generatedValue(next),
      next.provenance.model,
      next.provenance.promptHash,
      next.provenance.packetFingerprint
    )
    next = {
      ...validated,
      reviewStatus: 'approved',
      reviewerNotes: next.reviewerNotes,
      reviewedAt: next.reviewedAt
    }
  }
  const changedFields = [
    'reviewStatus',
    'question',
    'canonicalSearchQuery',
    'answerSpan',
    'referenceAnswer',
    'tags',
    'difficulty',
    'reviewerNotes'
  ].filter(
    (field) =>
      JSON.stringify(current[field as keyof EvalDraftRecord]) !==
      JSON.stringify(next[field as keyof EvalDraftRecord])
  )
  if (changedFields.length === 0) return getDraftCaseBrowser(absolute, override)
  run.drafts[index] = next
  const now = Date.now()
  run.reviewEvents = [
    ...(run.reviewEvents ?? []),
    {
      candidateId: current.candidateId,
      at: now,
      previousStatus: current.reviewStatus,
      reviewStatus: next.reviewStatus,
      changedFields
    }
  ]
  run.updatedAt = now
  await writeJsonAtomic(absolute, run)
  return getDraftCaseBrowser(absolute, override)
}
