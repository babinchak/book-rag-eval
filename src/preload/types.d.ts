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
