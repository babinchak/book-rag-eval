import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseEvidenceReviewPacket, type EvidenceReviewPacket } from '../shared/authoringSchema'
import { isLikelyCorpusBoilerplate } from './evidenceSampler'
import type { DraftGenerationRun, EvalDraftRecord } from './draftGeneration'

export const DRAFT_AUDIT_VERSION = 1

export type DraftAuditDisposition = 'review' | 'revise' | 'reject'

export interface DraftAuditItem {
  candidateId: string
  bookId: string
  bookTitle: string
  evidenceKind: EvalDraftRecord['evidenceKind']
  disposition: DraftAuditDisposition
  flags: string[]
  question: string
  canonicalSearchQuery: string
  answerSpan: string
  referenceAnswer: string
  excerpt: string
}

export interface DraftAudit {
  schemaVersion: typeof DRAFT_AUDIT_VERSION
  sourceRunFingerprint: string
  generatedAt: number
  totalDrafts: number
  flaggedDrafts: number
  recommendedRejects: number
  recommendedRevisions: number
  pendingHumanReview: number
  byBook: Array<{
    bookId: string
    title: string
    drafts: number
    flagged: number
  }>
  items: DraftAuditItem[]
}

function normalized(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function duplicateValues(
  drafts: EvalDraftRecord[],
  valueOf: (draft: EvalDraftRecord) => string
): Set<string> {
  const counts = new Map<string, number>()
  for (const draft of drafts) {
    const value = normalized(valueOf(draft))
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value))
}

function flagsFor(
  draft: EvalDraftRecord,
  excerpt: string,
  duplicateQuestions: Set<string>,
  duplicateQueries: Set<string>
): string[] {
  const flags: string[] = []
  if (
    isLikelyCorpusBoilerplate(excerpt) ||
    draft.tags.some((tag) => /^(?:license|refund|legal|disclaimer|contact_information)$/i.test(tag))
  ) {
    flags.push('corpus_boilerplate')
  }
  if (
    /\b(?:the author|thinkers|the text|this work|the passage|what does it|what is said)\b/i.test(
      draft.question
    )
  ) {
    flags.push('vague_wording')
  }
  if (duplicateQuestions.has(normalized(draft.question))) {
    flags.push('duplicate_question')
  }
  if (duplicateQueries.has(normalized(draft.canonicalSearchQuery))) {
    flags.push('duplicate_query')
  }
  if (draft.tags.includes('answer_span_repaired')) {
    flags.push('answer_span_repaired')
  }
  if (
    draft.evidenceKind === 'image' &&
    (/^(?:chart|engravings?|figure|illustration|image)$/i.test(excerpt.trim()) ||
      (excerpt.match(/[\p{L}\p{N}]+/gu) ?? []).length < 4)
  ) {
    flags.push('weak_image_metadata')
  }
  const tocMarkers = excerpt.match(/\b(?:preface|introduction|section)\b|§/gi) ?? []
  if (draft.evidenceKind === 'table' && tocMarkers.length >= 5) {
    flags.push('toc_like_table')
  }
  return flags
}

function dispositionFor(flags: string[]): DraftAuditDisposition {
  if (
    flags.some((flag) =>
      ['corpus_boilerplate', 'weak_image_metadata', 'toc_like_table'].includes(flag)
    )
  ) {
    return 'reject'
  }
  return flags.length > 0 ? 'revise' : 'review'
}

export function buildDraftAudit(run: DraftGenerationRun, packet: EvidenceReviewPacket): DraftAudit {
  const candidateById = new Map(packet.candidates.map((candidate) => [candidate.id, candidate]))
  const bookById = new Map(packet.books.map((book) => [book.bookId, book]))
  const duplicateQuestions = duplicateValues(run.drafts, (draft) => draft.question)
  const duplicateQueries = duplicateValues(run.drafts, (draft) => draft.canonicalSearchQuery)
  const items = run.drafts.map((draft): DraftAuditItem => {
    const candidate = candidateById.get(draft.candidateId)
    if (!candidate) {
      throw new Error(`Draft ${draft.candidateId} has no canonical evidence candidate`)
    }
    const book = bookById.get(draft.bookId)
    if (!book) throw new Error(`Draft ${draft.candidateId} has no packet book`)
    const flags = flagsFor(draft, candidate.excerpt, duplicateQuestions, duplicateQueries)
    return {
      candidateId: draft.candidateId,
      bookId: draft.bookId,
      bookTitle: book.title,
      evidenceKind: draft.evidenceKind,
      disposition: dispositionFor(flags),
      flags,
      question: draft.question,
      canonicalSearchQuery: draft.canonicalSearchQuery,
      answerSpan: draft.answerSpan,
      referenceAnswer: draft.referenceAnswer,
      excerpt: candidate.excerpt
    }
  })
  const byBook = packet.books.map((book) => {
    const bookItems = items.filter((item) => item.bookId === book.bookId)
    return {
      bookId: book.bookId,
      title: book.title,
      drafts: bookItems.length,
      flagged: bookItems.filter((item) => item.flags.length > 0).length
    }
  })
  return {
    schemaVersion: DRAFT_AUDIT_VERSION,
    sourceRunFingerprint: run.fingerprint,
    generatedAt: Date.now(),
    totalDrafts: items.length,
    flaggedDrafts: items.filter((item) => item.flags.length > 0).length,
    recommendedRejects: items.filter((item) => item.disposition === 'reject').length,
    recommendedRevisions: items.filter((item) => item.disposition === 'revise').length,
    pendingHumanReview: run.drafts.filter((draft) => draft.reviewStatus === 'pending').length,
    byBook,
    items
  }
}

function markdownFor(audit: DraftAudit): string {
  const lines = [
    '# Eval draft audit',
    '',
    `- Drafts: ${audit.totalDrafts}`,
    `- Flagged: ${audit.flaggedDrafts}`,
    `- Recommended rejects: ${audit.recommendedRejects}`,
    `- Recommended revisions: ${audit.recommendedRevisions}`,
    `- Pending human review: ${audit.pendingHumanReview}`,
    '',
    'Recommendations are triage only; they do not change human review status.',
    '',
    '## Coverage by book',
    '',
    '| Book | Drafts | Flagged |',
    '| --- | ---: | ---: |',
    ...audit.byBook.map(
      (book) => `| ${book.title.replace(/\|/g, '\\|')} | ${book.drafts} | ${book.flagged} |`
    ),
    '',
    '## Priority queue',
    ''
  ]
  for (const item of audit.items.filter((candidate) => candidate.flags.length > 0)) {
    lines.push(
      `### ${item.disposition.toUpperCase()}: ${item.bookTitle}`,
      '',
      `- Candidate: \`${item.candidateId}\``,
      `- Evidence: ${item.evidenceKind}`,
      `- Flags: ${item.flags.join(', ')}`,
      `- Question: ${item.question}`,
      `- Search query: ${item.canonicalSearchQuery}`,
      `- Answer span: ${item.answerSpan}`,
      `- Reference answer: ${item.referenceAnswer}`,
      '',
      '<details><summary>Canonical excerpt</summary>',
      '',
      item.excerpt,
      '',
      '</details>',
      ''
    )
  }
  return `${lines.join('\n')}\n`
}

export async function writeDraftAudit(
  runPath: string,
  outputPath?: string
): Promise<{ markdownPath: string; jsonPath: string; audit: DraftAudit }> {
  const absoluteRunPath = resolve(runPath)
  const run = JSON.parse(await fs.readFile(absoluteRunPath, 'utf8')) as DraftGenerationRun
  if (run.status !== 'completed' && run.status !== 'completed_with_failures') {
    throw new Error(`Draft run must be completed before auditing; status is ${run.status}`)
  }
  const packet = parseEvidenceReviewPacket(
    JSON.parse(await fs.readFile(run.plan.packetPath, 'utf8')) as unknown
  )
  if (packet.corpusFingerprint !== run.plan.corpusFingerprint) {
    throw new Error('Canonical evidence packet no longer matches the draft run fingerprint')
  }
  const audit = buildDraftAudit(run, packet)
  const markdownPath = resolve(outputPath ?? absoluteRunPath.replace(/\.json$/i, '.audit.md'))
  const jsonPath = /\.md$/i.test(markdownPath)
    ? markdownPath.replace(/\.md$/i, '.json')
    : `${markdownPath}.json`
  await fs.mkdir(dirname(markdownPath), { recursive: true })
  await Promise.all([
    fs.writeFile(markdownPath, markdownFor(audit), 'utf8'),
    fs.writeFile(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  ])
  return { markdownPath, jsonPath, audit }
}
