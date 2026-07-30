import { z } from 'zod'

export const EVIDENCE_REVIEW_PACKET_SCHEMA_VERSION = 1
export const EVAL_DRAFT_RUN_SCHEMA_VERSION = 1

const canonicalNodeKindSchema = z.enum([
  'heading',
  'paragraph',
  'blockquote',
  'list',
  'table',
  'image',
  'footnote',
  'other'
])

const evidenceCandidateSchema = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  sourceHash: z.string().min(1),
  nodeId: z.string().min(1),
  kind: canonicalNodeKindSchema,
  spineHref: z.string().min(1),
  textStart: z.number().int().nonnegative(),
  textEnd: z.number().int().nonnegative(),
  headingPath: z.array(z.string()),
  excerpt: z.string(),
  assets: z.array(z.string()),
  reviewStatus: z.literal('pending')
})

const evidenceReviewPacketSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_REVIEW_PACKET_SCHEMA_VERSION),
  corpusId: z.string().min(1),
  corpusFingerprint: z.string().min(1),
  candidatesPerBook: z.number().int().positive(),
  books: z.array(
    z.object({
      bookId: z.string().min(1),
      title: z.string().min(1),
      author: z.string().min(1),
      sourceHash: z.string().min(1),
      selectedCandidates: z.number().int().nonnegative(),
      availableKinds: z.record(z.string(), z.number().int().nonnegative()),
      tags: z.array(z.string()).optional()
    })
  ),
  candidates: z.array(evidenceCandidateSchema)
})

export const generatedEvalDraftSchema = z.object({
  question: z.string().min(10),
  searchQuery: z.string().min(3),
  answerSpan: z.string().min(1),
  referenceAnswer: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  difficulty: z.enum(['easy', 'medium', 'hard'])
})

export type EvidenceCandidate = z.infer<typeof evidenceCandidateSchema>
export type EvidenceReviewPacket = z.infer<typeof evidenceReviewPacketSchema>
export type GeneratedEvalDraft = z.infer<typeof generatedEvalDraftSchema>

export function parseEvidenceReviewPacket(value: unknown): EvidenceReviewPacket {
  const packet = evidenceReviewPacketSchema.parse(value)
  const bookHashes = new Map(packet.books.map((book) => [book.bookId, book.sourceHash]))
  for (const candidate of packet.candidates) {
    if (candidate.textEnd < candidate.textStart) {
      throw new Error(`Candidate ${candidate.id} has reversed offsets`)
    }
    if (bookHashes.get(candidate.bookId) !== candidate.sourceHash) {
      throw new Error(`Candidate ${candidate.id} does not match its book source hash`)
    }
  }
  return packet
}
