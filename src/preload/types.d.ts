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
  lastOpenedAt: number | null
  sizeBytes: number
  coverDataUrl: string | null
  collectionId: string | null
}

export interface ImportOutcome {
  summary: BookSummary
  alreadyExisted: boolean
}

export interface CollectionSummary {
  id: string
  name: string
  addedAt: number
  bookCount: number
}

export interface IpcError {
  message: string
  stack?: string
  cause?: string
  errorId?: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource = 'main' | 'renderer' | 'sidecar'

export interface LogEntry {
  ts: number
  level: LogLevel
  source: LogSource
  tag: string
  msg: string
  data?: unknown
}

export type ErrorOrigin =
  | 'ipc'
  | 'sidecar'
  | 'renderer-window'
  | 'renderer-unhandled'
  | 'renderer-boundary'

export interface ErrorRecordSummary {
  id: string
  ts: number
  origin: ErrorOrigin
  message: string
  ipcHandler?: string
  count: number
}

export interface RendererErrorReport {
  origin: 'renderer-window' | 'renderer-unhandled' | 'renderer-boundary'
  message: string
  stack?: string
  componentStack?: string
  url?: string
}

export type ErrorsListIpcResult =
  | { ok: true; entries: ErrorRecordSummary[] }
  | { ok: false; error: IpcError }
export type ErrorsBundleIpcResult = { ok: true; markdown: string } | { ok: false; error: IpcError }
export type ErrorsReportIpcResult = { ok: true; errorId: string } | { ok: false; error: IpcError }

export type LibraryListResult = { ok: true; books: BookSummary[] } | { ok: false; error: IpcError }

export type CollectionsListResult =
  | { ok: true; collections: CollectionSummary[] }
  | { ok: false; error: IpcError }

export type LibraryImportResult =
  | { ok: true; data: ImportOutcome | null }
  | { ok: false; error: IpcError }

export type LibraryOpenResult = { ok: true; data: LoadedEpub } | { ok: false; error: IpcError }

export type LibraryRemoveResult = { ok: true } | { ok: false; error: IpcError }

export type ChunkParams =
  | {
      kind: 'fixed-token'
      size: number
      overlap: number
      encoding: 'cl100k_base'
    }
  // Legacy character-window chunker. Kept so existing chunk sets and saved
  // strategies remain reproducible; new strategies default to fixed-token.
  | { kind: 'fixed'; size: number; overlap: number }
  | { kind: 'paragraph'; targetSize: number }
  | { kind: 'sentence'; targetSize: number }
  | { kind: 'structural'; maxSize: number }
  | {
      kind: 'semantic'
      targetSize: number
      breakpointPercentile: number
      bufferSize: number
    }

export interface Chunk {
  id: string
  strategyId: string
  spineHref: string
  textStart: number
  textEnd: number
  text: string
  tokenCount?: number
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

export type ChunksRunResult = { ok: true; data: ChunkSetSummary } | { ok: false; error: IpcError }

export type ChunksListResult =
  | { ok: true; sets: ChunkSetSummary[] }
  | { ok: false; error: IpcError }

export type ChunksGetResult = { ok: true; data: ChunkSet } | { ok: false; error: IpcError }

export interface EmbeddingSetSummary {
  strategyId: string
  count: number
  model: string
  updatedAt: number
  // Cumulative tokens spent embedding this set (across all runs). Undefined for
  // legacy sets that predate cost tracking.
  totalTokens?: number
}

export interface EmbedRunResult {
  embedded: number
  skipped: number
  totalTokens: number
  model: string
}

export type EmbedRunIpcResult = { ok: true; data: EmbedRunResult } | { ok: false; error: IpcError }

export type EmbeddingsListIpcResult =
  | { ok: true; sets: EmbeddingSetSummary[] }
  | { ok: false; error: IpcError }

export type EmbeddingsRemoveIpcResult = { ok: true } | { ok: false; error: IpcError }

export interface Bm25IndexSummary {
  strategyId: string
  count: number
  updatedAt: number
}

export interface Bm25RunResult {
  indexed: number
  skipped: number
}

export type Bm25RunIpcResult = { ok: true; data: Bm25RunResult } | { ok: false; error: IpcError }
export type Bm25ListIpcResult =
  | { ok: true; sets: Bm25IndexSummary[] }
  | { ok: false; error: IpcError }
export type Bm25RemoveIpcResult = { ok: true } | { ok: false; error: IpcError }

export type RetrieverParams =
  | { kind: 'vector' }
  | { kind: 'bm25' }
  | { kind: 'hybrid-rrf'; rrfK?: number }

export type AugmentStep = { kind: 'breadcrumb' } | { kind: 'summary'; model: string }

export type PostRetrieveStep = { kind: 'rerank-identity' } | { kind: 'dedup' }

export interface EmbeddingSlot {
  model: 'text-embedding-3-small' | 'text-embedding-3-large'
}

export interface GenerationSlot {
  model: 'gpt-4o-mini' | 'gpt-4o' | 'gpt-4.1' | 'gpt-4.1-mini'
  topK: number
}

export interface StrategyConfig {
  chunker: ChunkParams
  augment: AugmentStep[]
  embedding: EmbeddingSlot
  retriever: RetrieverParams
  postRetrieve: PostRetrieveStep[]
  generation: GenerationSlot
}

export interface SavedStrategy {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  config: StrategyConfig
}

export type StrategiesListIpcResult =
  | { ok: true; strategies: SavedStrategy[] }
  | { ok: false; error: IpcError }
export type StrategyGetIpcResult =
  | { ok: true; data: SavedStrategy }
  | { ok: false; error: IpcError }
export type StrategyMutateIpcResult =
  | { ok: true; data: SavedStrategy }
  | { ok: false; error: IpcError }
export type StrategyDeleteIpcResult = { ok: true } | { ok: false; error: IpcError }

export type SettingsHasKeyResult = { ok: true; hasKey: boolean } | { ok: false; error: IpcError }
export type SettingsSetKeyResult = { ok: true } | { ok: false; error: IpcError }
export type SettingsClearKeyResult = { ok: true } | { ok: false; error: IpcError }
export type SettingsGetStringResult =
  | { ok: true; value: string | null }
  | { ok: false; error: IpcError }
export type SettingsSetStringResult = { ok: true } | { ok: false; error: IpcError }

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

export type AskIpcResult = { ok: true; data: AskResultPayload } | { ok: false; error: IpcError }

export interface GoldSpan {
  spineHref: string
  textStart: number
  textEnd: number
}

export interface EvalCase {
  id: string
  question: string
  searchQuery: string
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
  searchQuery?: string
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
  model?: string
  langsmithRunUrl?: string
}

export type EvalMode = 'retrieval' | 'agentic'

export interface EvalRunResult {
  id: string
  bookId: string
  evalSetId: string
  strategyId: string
  // Optional for backward compat: older runs predate the retriever axis and
  // are all vector. Format matches `retrieverIdOf(params)` from shared/retriever.
  retrieverId?: string
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
  // Model used for the chat side of agentic runs. Needed to price tokens in the UI.
  agentModel?: string
  cases: EvalCaseResult[]
}

export interface EvalRunSummary {
  id: string
  evalSetId: string
  strategyId: string
  retrieverId?: string
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
  agentModel?: string
  caseCount: number
}

export type EvalRunGetIpcResult = { ok: true; data: EvalRunResult } | { ok: false; error: IpcError }

export interface LocateQuoteHit {
  goldSpan: GoldSpan
  preview: string
}

export type EvalSetsListIpcResult =
  | { ok: true; sets: EvalSetSummary[] }
  | { ok: false; error: IpcError }
export type EvalSetGetIpcResult = { ok: true; data: EvalSet } | { ok: false; error: IpcError }
export type EvalSetCreateIpcResult = { ok: true; data: EvalSet } | { ok: false; error: IpcError }
export type EvalSetDeleteIpcResult = { ok: true } | { ok: false; error: IpcError }
export type EvalCaseAddIpcResult = { ok: true; data: EvalCase } | { ok: false; error: IpcError }
export type EvalCaseRemoveIpcResult = { ok: true } | { ok: false; error: IpcError }
export type EvalCaseUpdateIpcResult = { ok: true; data: EvalCase } | { ok: false; error: IpcError }
export type EvalLocateIpcResult =
  | { ok: true; data: LocateQuoteHit }
  | { ok: false; error: IpcError }
export type EvalRunIpcResult = { ok: true; data: EvalRunResult } | { ok: false; error: IpcError }
export type EvalRunsListIpcResult =
  | { ok: true; runs: EvalRunSummary[] }
  | { ok: false; error: IpcError }

export interface AutoGenerateFailure {
  // For auto-generate this is a chunk ID; for backfill it's a case ID.
  id: string
  error: IpcError
}

export interface AutoGenerateProgress {
  generated: number
  failed: number
  failures: AutoGenerateFailure[]
  // LLM usage for this autogen / backfill run, when the model is known.
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  model?: string
}

export type EvalAutoGenerateIpcResult =
  | { ok: true; data: AutoGenerateProgress }
  | { ok: false; error: IpcError }
