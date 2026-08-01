export type DraftReviewStatus = 'pending' | 'approved' | 'rejected' | 'needs_revision'

export type DraftAuditDisposition = 'review' | 'revise' | 'reject'

export interface DraftRunBrowserSummary {
  runPath: string
  fingerprint: string
  name: string
  model: string
  status: string
  updatedAt: number
  actualCostUsd: number
  totalCases: number
  counts: Record<DraftReviewStatus, number>
}

export interface DraftCaseBrowserItem {
  candidateId: string
  bookId: string
  bookTitle: string
  bookAuthor: string
  evidenceKind: 'text' | 'table' | 'image'
  spineHref: string
  headingPath: string[]
  assets: string[]
  excerpt: string
  question: string
  canonicalSearchQuery: string
  answerSpan: string
  referenceAnswer: string
  tags: string[]
  difficulty: 'easy' | 'medium' | 'hard'
  reviewStatus: DraftReviewStatus
  reviewerNotes: string
  reviewedAt?: number
  auditDisposition: DraftAuditDisposition
  auditFlags: string[]
  model: string
}

export interface DraftCaseBrowserData {
  run: DraftRunBrowserSummary
  books: Array<{ bookId: string; title: string; author: string; cases: number }>
  cases: DraftCaseBrowserItem[]
}

export interface DraftCaseReviewUpdate {
  candidateId: string
  reviewStatus?: DraftReviewStatus
  question?: string
  canonicalSearchQuery?: string
  answerSpan?: string
  referenceAnswer?: string
  tags?: string[]
  difficulty?: 'easy' | 'medium' | 'hard'
  reviewerNotes?: string
}
