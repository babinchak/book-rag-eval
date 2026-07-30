import { z } from 'zod'

export const EVAL_SCHEMA_VERSION = 2

export type EvalScope = 'within_book' | 'library'
export type EvalAnswerability = 'answerable' | 'unanswerable'
export type EvalSplit = 'dev' | 'test'
export type EvalDifficulty = 'easy' | 'medium' | 'hard'
export type EvidenceKind = 'text' | 'table' | 'image'
export type EvalProvenanceKind = 'human' | 'llm_assisted' | 'synthetic' | 'imported'

export interface EvalProvenance {
  kind: EvalProvenanceKind
  source?: string
  model?: string
  promptHash?: string
  reviewedBy?: string
}

export interface GoldEvidence {
  id: string
  // Every distinct requirement must be retrieved. Items with the same
  // requirementId are alternative valid sources for satisfying it.
  requirementId: string
  kind: EvidenceKind
  bookId: string
  nodeId: string
  spineHref: string
  textStart?: number
  textEnd?: number
}

export interface BenchmarkEvalCase {
  id: string
  question: string
  canonicalSearchQuery: string
  scope: EvalScope
  answerability: EvalAnswerability
  goldEvidence: GoldEvidence[]
  tags: string[]
  difficulty: EvalDifficulty
  split: EvalSplit
  provenance: EvalProvenance
  referenceAnswers?: string[]
  notes?: string
  // Compatibility aliases for the existing Electron UI and historical runs.
  searchQuery: string
  goldSpans: LegacyGoldSpan[]
}

export interface LegacyGoldSpan {
  bookId?: string
  nodeId?: string
  spineHref: string
  textStart: number
  textEnd: number
}

export interface BenchmarkEvalSet {
  schemaVersion: typeof EVAL_SCHEMA_VERSION
  id: string
  bookId: string
  cases: BenchmarkEvalCase[]
  createdAt: number
  updatedAt: number
}

const provenanceSchema = z.object({
  kind: z.enum(['human', 'llm_assisted', 'synthetic', 'imported']),
  source: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptHash: z.string().min(1).optional(),
  reviewedBy: z.string().min(1).optional()
})

const legacyGoldSpanSchema = z.object({
  bookId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  spineHref: z.string().min(1),
  textStart: z.number().int().nonnegative(),
  textEnd: z.number().int().positive()
})

const goldEvidenceSchema = z
  .object({
    id: z.string().min(1),
    requirementId: z.string().min(1),
    kind: z.enum(['text', 'table', 'image']),
    bookId: z.string().min(1),
    nodeId: z.string().min(1),
    spineHref: z.string().min(1),
    textStart: z.number().int().nonnegative().optional(),
    textEnd: z.number().int().positive().optional()
  })
  .superRefine((evidence, context) => {
    const hasStart = evidence.textStart !== undefined
    const hasEnd = evidence.textEnd !== undefined
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: 'custom',
        message: 'textStart and textEnd must either both be present or both be absent'
      })
    }
    if (hasStart && hasEnd && evidence.textEnd! <= evidence.textStart!) {
      context.addIssue({ code: 'custom', message: 'textEnd must be greater than textStart' })
    }
    if (evidence.kind === 'text' && !hasStart) {
      context.addIssue({ code: 'custom', message: 'text evidence requires exact offsets' })
    }
  })

const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    canonicalSearchQuery: z.string().min(1),
    scope: z.enum(['within_book', 'library']),
    answerability: z.enum(['answerable', 'unanswerable']),
    goldEvidence: z.array(goldEvidenceSchema),
    tags: z.array(z.string().min(1)),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    split: z.enum(['dev', 'test']),
    provenance: provenanceSchema,
    referenceAnswers: z.array(z.string().min(1)).optional(),
    notes: z.string().optional(),
    searchQuery: z.string().min(1),
    goldSpans: z.array(legacyGoldSpanSchema)
  })
  .superRefine((evalCase, context) => {
    if (evalCase.answerability === 'answerable' && evalCase.goldEvidence.length === 0) {
      context.addIssue({ code: 'custom', message: 'answerable cases require gold evidence' })
    }
    if (evalCase.answerability === 'unanswerable' && evalCase.goldEvidence.length > 0) {
      context.addIssue({ code: 'custom', message: 'unanswerable cases cannot have gold evidence' })
    }
  })

const evalSetSchema = z.object({
  schemaVersion: z.literal(EVAL_SCHEMA_VERSION),
  id: z.string().min(1),
  bookId: z.string().min(1),
  cases: z.array(evalCaseSchema),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function legacySpansOf(value: unknown): LegacyGoldSpan[] {
  if (!Array.isArray(value)) return []
  return value.map((span) => legacyGoldSpanSchema.parse(span))
}

function evidenceFromLegacySpan(span: LegacyGoldSpan, bookId: string, index: number): GoldEvidence {
  if (!span.nodeId) {
    throw new Error(
      `Legacy gold span ${span.spineHref}:${span.textStart}-${span.textEnd} has no canonical nodeId`
    )
  }
  return {
    id: `evidence-${index + 1}`,
    requirementId: `required-${index + 1}`,
    kind: 'text',
    bookId: span.bookId ?? bookId,
    nodeId: span.nodeId,
    spineHref: span.spineHref,
    textStart: span.textStart,
    textEnd: span.textEnd
  }
}

function compatibilitySpansOf(evidence: GoldEvidence[]): LegacyGoldSpan[] {
  return evidence
    .filter(
      (item): item is GoldEvidence & { textStart: number; textEnd: number } =>
        item.textStart !== undefined && item.textEnd !== undefined
    )
    .map((item) => ({
      bookId: item.bookId,
      nodeId: item.nodeId,
      spineHref: item.spineHref,
      textStart: item.textStart,
      textEnd: item.textEnd
    }))
}

function migrateCase(value: unknown, bookId: string): BenchmarkEvalCase {
  const raw = recordOf(value, 'eval case')
  const rawSpans = legacySpansOf(raw.goldSpans)
  const rawEvidence = Array.isArray(raw.goldEvidence)
    ? raw.goldEvidence.map((item) => goldEvidenceSchema.parse(item))
    : rawSpans.map((span, index) => evidenceFromLegacySpan(span, bookId, index))
  const answerability =
    raw.answerability === 'unanswerable' || raw.answerability === 'answerable'
      ? raw.answerability
      : rawEvidence.length > 0
        ? 'answerable'
        : 'unanswerable'
  const canonicalSearchQuery = stringOf(raw.canonicalSearchQuery, stringOf(raw.searchQuery))
  const provenance =
    raw.provenance === undefined
      ? { kind: 'imported' as const, source: 'legacy-eval-schema-v1' }
      : provenanceSchema.parse(raw.provenance)

  return evalCaseSchema.parse({
    id: stringOf(raw.id),
    question: stringOf(raw.question),
    canonicalSearchQuery,
    scope: raw.scope ?? 'within_book',
    answerability,
    goldEvidence: rawEvidence,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    difficulty: raw.difficulty ?? 'medium',
    split: raw.split ?? 'dev',
    provenance,
    referenceAnswers: raw.referenceAnswers,
    notes: raw.notes,
    searchQuery: canonicalSearchQuery,
    goldSpans: compatibilitySpansOf(rawEvidence)
  })
}

export function parseEvalSet(value: unknown, expectedBookId?: string): BenchmarkEvalSet {
  const raw = recordOf(value, 'eval set')
  const bookId = stringOf(raw.bookId, expectedBookId)
  if (expectedBookId && bookId !== expectedBookId) {
    throw new Error(`Eval set book ${bookId} does not match expected book ${expectedBookId}`)
  }
  const createdAt = numberOf(raw.createdAt, 0)
  return evalSetSchema.parse({
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: stringOf(raw.id),
    bookId,
    cases: Array.isArray(raw.cases) ? raw.cases.map((item) => migrateCase(item, bookId)) : [],
    createdAt,
    updatedAt: numberOf(raw.updatedAt, createdAt)
  })
}

export function goldEvidenceFromSpans(bookId: string, spans: LegacyGoldSpan[]): GoldEvidence[] {
  return spans.map((span, index) => evidenceFromLegacySpan(span, bookId, index))
}

export function compatibilityGoldSpans(evidence: GoldEvidence[]): LegacyGoldSpan[] {
  return compatibilitySpansOf(evidence)
}
