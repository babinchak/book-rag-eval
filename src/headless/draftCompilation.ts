import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { contentHash } from '../shared/artifactIdentity'
import { parseEvidenceReviewPacket, type GeneratedEvalDraft } from '../shared/authoringSchema'
import {
  EVAL_SCHEMA_VERSION,
  parseEvalSet,
  type BenchmarkEvalCase,
  type BenchmarkEvalSet,
  type GoldEvidence
} from '../shared/evalSchema'
import { validateDraft, type DraftGenerationRun, type EvalDraftRecord } from './draftGeneration'

export interface CompiledDraftManifest {
  schemaVersion: 1
  sourceRunFingerprint: string
  corpusId: string
  corpusFingerprint: string
  reviewer: string
  approvedCases: number
  rejectedCandidates: number
  evalSets: Array<{
    bookId: string
    evalSetId: string
    cases: number
    path: string
    hash: string
  }>
  compilationFingerprint: string
}

function generatedValue(draft: EvalDraftRecord): GeneratedEvalDraft {
  return {
    question: draft.question,
    searchQuery: draft.canonicalSearchQuery,
    answerSpan: draft.answerSpan,
    referenceAnswer: draft.referenceAnswer,
    tags: draft.tags,
    difficulty: draft.difficulty
  }
}

function evalCaseFromDraft(
  draft: EvalDraftRecord,
  reviewedBy: string,
  run: DraftGenerationRun
): BenchmarkEvalCase {
  const evidence: GoldEvidence = {
    id: 'evidence-1',
    requirementId: 'required-1',
    kind: draft.evidenceKind,
    bookId: draft.bookId,
    nodeId: draft.nodeId,
    spineHref: draft.spineHref,
    ...(draft.evidenceKind === 'text'
      ? {
          textStart: draft.evidenceTextStart!,
          textEnd: draft.evidenceTextEnd!
        }
      : {})
  }
  return {
    id: `case-${contentHash({
      corpusFingerprint: run.plan.corpusFingerprint,
      candidateId: draft.candidateId
    }).slice(0, 20)}`,
    question: draft.question,
    canonicalSearchQuery: draft.canonicalSearchQuery,
    scope: 'within_book',
    answerability: 'answerable',
    goldEvidence: [evidence],
    tags: draft.tags,
    difficulty: draft.difficulty,
    split: 'dev',
    provenance: {
      kind: 'llm_assisted',
      model: draft.provenance.model,
      promptHash: draft.provenance.promptHash,
      source: draft.candidateId,
      reviewedBy
    },
    referenceAnswers: [draft.referenceAnswer],
    notes: `Approved from canonical evidence candidate ${draft.candidateId}.`,
    searchQuery: draft.canonicalSearchQuery,
    goldSpans:
      draft.evidenceKind === 'text'
        ? [
            {
              bookId: draft.bookId,
              nodeId: draft.nodeId,
              spineHref: draft.spineHref,
              textStart: draft.evidenceTextStart!,
              textEnd: draft.evidenceTextEnd!
            }
          ]
        : []
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, path)
}

function assertDraftIdentity(
  draft: EvalDraftRecord,
  candidate: ReturnType<typeof parseEvidenceReviewPacket>['candidates'][number],
  run: DraftGenerationRun
): void {
  const expected = {
    bookId: candidate.bookId,
    sourceHash: candidate.sourceHash,
    nodeId: candidate.nodeId,
    spineHref: candidate.spineHref
  }
  for (const [field, value] of Object.entries(expected)) {
    if (draft[field as keyof typeof expected] !== value) {
      throw new Error(`Approved draft ${draft.candidateId} changed immutable ${field}`)
    }
  }
  if (
    draft.provenance.model !== run.plan.model.name ||
    draft.provenance.promptHash !== run.plan.promptHash ||
    draft.provenance.packetFingerprint !== run.plan.corpusFingerprint
  ) {
    throw new Error(`Approved draft ${draft.candidateId} changed immutable provenance`)
  }
}

export async function compileApprovedDrafts(
  runPath: string,
  outputDir: string,
  reviewedBy: string
): Promise<{ manifestPath: string; manifest: CompiledDraftManifest }> {
  const reviewer = reviewedBy.trim()
  if (!reviewer) throw new Error('--reviewed-by is required')
  const absoluteRunPath = resolve(runPath)
  const run = JSON.parse(await fs.readFile(absoluteRunPath, 'utf8')) as DraftGenerationRun
  if (run.status !== 'completed' && run.status !== 'completed_with_failures') {
    throw new Error(`Draft run must be completed before compilation; status is ${run.status}`)
  }
  if (run.failures.length > 0) {
    throw new Error(`Draft run has ${run.failures.length} unresolved generation failures`)
  }
  const pending = run.drafts.filter((draft) => draft.reviewStatus === 'pending')
  if (pending.length > 0) {
    throw new Error(`${pending.length} drafts are still pending human review`)
  }

  const packet = parseEvidenceReviewPacket(
    JSON.parse(await fs.readFile(run.plan.packetPath, 'utf8')) as unknown
  )
  if (packet.corpusFingerprint !== run.plan.corpusFingerprint) {
    throw new Error('Canonical evidence packet no longer matches the draft run fingerprint')
  }
  const candidates = new Map(packet.candidates.map((candidate) => [candidate.id, candidate]))
  const approved: EvalDraftRecord[] = []
  for (const draft of run.drafts.filter((candidate) => candidate.reviewStatus === 'approved')) {
    const candidate = candidates.get(draft.candidateId)
    if (!candidate) throw new Error(`Approved draft has unknown candidate ${draft.candidateId}`)
    assertDraftIdentity(draft, candidate, run)
    const validated = validateDraft(
      candidate,
      generatedValue(draft),
      draft.provenance.model,
      draft.provenance.promptHash,
      draft.provenance.packetFingerprint
    )
    approved.push({ ...validated, reviewStatus: 'approved' })
  }
  if (approved.length === 0) throw new Error('No approved drafts to compile')

  const absoluteOutputDir = resolve(outputDir)
  const byBook = new Map<string, EvalDraftRecord[]>()
  for (const draft of approved) {
    const drafts = byBook.get(draft.bookId) ?? []
    drafts.push(draft)
    byBook.set(draft.bookId, drafts)
  }

  const compiledSets: Array<{ set: BenchmarkEvalSet; path: string; hash: string }> = []
  for (const [bookId, drafts] of byBook) {
    const timestamp = run.completedAt ?? run.updatedAt
    const set = parseEvalSet({
      schemaVersion: EVAL_SCHEMA_VERSION,
      id: `${run.plan.name}-${bookId.slice(0, 12)}`,
      bookId,
      createdAt: timestamp,
      updatedAt: timestamp,
      cases: drafts.map((draft) => evalCaseFromDraft(draft, reviewer, run))
    })
    const path = join(absoluteOutputDir, `${bookId}.json`)
    const hash = contentHash(set)
    compiledSets.push({ set, path, hash })
  }

  const manifestCore = {
    schemaVersion: 1 as const,
    sourceRunFingerprint: run.fingerprint,
    corpusId: run.plan.corpusId,
    corpusFingerprint: run.plan.corpusFingerprint,
    reviewer,
    approvedCases: approved.length,
    rejectedCandidates: run.drafts.filter((draft) => draft.reviewStatus === 'rejected').length,
    evalSets: compiledSets.map(({ set, path, hash }) => ({
      bookId: set.bookId,
      evalSetId: set.id,
      cases: set.cases.length,
      path: basename(path),
      hash
    }))
  }
  const manifest: CompiledDraftManifest = {
    ...manifestCore,
    compilationFingerprint: contentHash(manifestCore)
  }
  await fs.mkdir(absoluteOutputDir, { recursive: true })
  await Promise.all([
    ...compiledSets.map(({ set, path }) => writeJsonAtomic(path, set)),
    writeJsonAtomic(join(absoluteOutputDir, 'manifest.json'), manifest)
  ])
  return {
    manifestPath: join(absoluteOutputDir, 'manifest.json'),
    manifest
  }
}
