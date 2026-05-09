export interface ReadiumManifestLink {
  href: string
  type?: string
  title?: string
  rel?: string | string[]
}

export interface ReadiumManifest {
  metadata?: {
    title?: string
    author?: unknown
    language?: string | string[]
    [key: string]: unknown
  }
  readingOrder?: ReadiumManifestLink[]
  resources?: ReadiumManifestLink[]
  toc?: ReadiumManifestLink[]
  [key: string]: unknown
}

export interface SpineItem {
  href: string
  html: string
}

export interface LoadedEpub {
  id: string
  manifest: ReadiumManifest
  spineItems: SpineItem[]
}

export interface BookSummary {
  id: string
  title: string
  author: string | null
  addedAt: number
  sizeBytes: number
  coverDataUrl: string | null
}

export interface ImportOutcome {
  summary: BookSummary
  alreadyExisted: boolean
}

export type LibraryListResult =
  | { ok: true; books: BookSummary[] }
  | { ok: false; error: string }

export type LibraryImportResult =
  | { ok: true; data: ImportOutcome | null }
  | { ok: false; error: string }

export type LibraryOpenResult = { ok: true; data: LoadedEpub } | { ok: false; error: string }

export type LibraryRemoveResult = { ok: true } | { ok: false; error: string }

export type ChunkParams =
  | { kind: 'fixed'; size: number; overlap: number }
  | { kind: 'paragraph'; targetSize: number }
  | { kind: 'sentence'; targetSize: number }
  | { kind: 'structural'; maxSize: number }

export interface Chunk {
  id: string
  strategyId: string
  spineHref: string
  textStart: number
  textEnd: number
  text: string
}

export interface ChunkSetSummary {
  strategyId: string
  params: ChunkParams
  count: number
  generatedAt: number
}

export interface ChunkSet extends ChunkSetSummary {
  bookId: string
  chunks: Chunk[]
}

export type ChunksRunResult =
  | { ok: true; data: ChunkSetSummary }
  | { ok: false; error: string }

export type ChunksListResult =
  | { ok: true; sets: ChunkSetSummary[] }
  | { ok: false; error: string }

export type ChunksGetResult = { ok: true; data: ChunkSet } | { ok: false; error: string }

export interface EmbeddingSetSummary {
  strategyId: string
  count: number
  model: string
  updatedAt: number
}

export interface EmbedRunResult {
  embedded: number
  skipped: number
  totalTokens: number
  model: string
}

export type EmbedRunIpcResult =
  | { ok: true; data: EmbedRunResult }
  | { ok: false; error: string }

export type EmbeddingsListIpcResult =
  | { ok: true; sets: EmbeddingSetSummary[] }
  | { ok: false; error: string }

export type EmbeddingsRemoveIpcResult = { ok: true } | { ok: false; error: string }

export type SettingsHasKeyResult = { ok: true; hasKey: boolean } | { ok: false; error: string }
export type SettingsSetKeyResult = { ok: true } | { ok: false; error: string }
export type SettingsClearKeyResult = { ok: true } | { ok: false; error: string }
export type SettingsGetStringResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string }
export type SettingsSetStringResult = { ok: true } | { ok: false; error: string }

export interface RetrievedChunkPayload {
  chunk: Chunk
  distance: number
  rank: number
}

export interface AskResultPayload {
  answer: string
  retrieved: RetrievedChunkPayload[]
  promptTokens: number
  completionTokens: number
  totalTokens: number
  model: string
  langsmithRunUrl?: string
}

export type AskIpcResult = { ok: true; data: AskResultPayload } | { ok: false; error: string }

export interface GoldSpan {
  spineHref: string
  textStart: number
  textEnd: number
}

export interface EvalCase {
  id: string
  question: string
  goldSpans: GoldSpan[]
  notes?: string
}

export interface EvalSet {
  id: string
  bookId: string
  cases: EvalCase[]
  createdAt: number
  updatedAt: number
}

export interface EvalSetSummary {
  id: string
  caseCount: number
  updatedAt: number
}

export interface RetrievedDetail {
  chunkId: string
  distance: number
  hit: boolean
  overlap: number
  rank: number
}

export interface EvalCaseResult {
  caseId: string
  question: string
  retrieved: RetrievedDetail[]
  recallAtK: number
  mrr: number
  hitRank: number | null
  // Agentic / citation fields (optional for backward compat with older runs)
  answer?: string
  citedRanks?: number[]
  citedChunkIds?: string[]
  citationPrecision?: number
  citationRecall?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  langsmithRunUrl?: string
}

export type EvalMode = 'retrieval' | 'agentic'

export interface EvalRunResult {
  id: string
  bookId: string
  evalSetId: string
  strategyId: string
  k: number
  ranAt: number
  mode?: EvalMode
  meanRecallAtK: number
  meanMRR: number
  meanCitationPrecision?: number
  meanCitationRecall?: number
  totalPromptTokens?: number
  totalCompletionTokens?: number
  totalTokens?: number
  cases: EvalCaseResult[]
}

export interface EvalRunSummary {
  id: string
  evalSetId: string
  strategyId: string
  k: number
  ranAt: number
  mode?: EvalMode
  meanRecallAtK: number
  meanMRR: number
  meanCitationPrecision?: number
  meanCitationRecall?: number
  caseCount: number
}

export type EvalRunGetIpcResult = { ok: true; data: EvalRunResult } | { ok: false; error: string }

export interface LocateQuoteHit {
  goldSpan: GoldSpan
  preview: string
}

export type EvalSetsListIpcResult =
  | { ok: true; sets: EvalSetSummary[] }
  | { ok: false; error: string }
export type EvalSetGetIpcResult = { ok: true; data: EvalSet } | { ok: false; error: string }
export type EvalSetCreateIpcResult = { ok: true; data: EvalSet } | { ok: false; error: string }
export type EvalSetDeleteIpcResult = { ok: true } | { ok: false; error: string }
export type EvalCaseAddIpcResult = { ok: true; data: EvalCase } | { ok: false; error: string }
export type EvalCaseRemoveIpcResult = { ok: true } | { ok: false; error: string }
export type EvalCaseUpdateIpcResult = { ok: true; data: EvalCase } | { ok: false; error: string }
export type EvalLocateIpcResult =
  | { ok: true; data: LocateQuoteHit }
  | { ok: false; error: string }
export type EvalRunIpcResult = { ok: true; data: EvalRunResult } | { ok: false; error: string }
export type EvalRunsListIpcResult =
  | { ok: true; runs: EvalRunSummary[] }
  | { ok: false; error: string }

export interface AutoGenerateFailure {
  chunkId: string
  error: string
}

export interface AutoGenerateProgress {
  generated: number
  failed: number
  failures: AutoGenerateFailure[]
}

export type EvalAutoGenerateIpcResult =
  | { ok: true; data: AutoGenerateProgress }
  | { ok: false; error: string }
