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
  path: string
  manifest: ReadiumManifest
  spineItems: SpineItem[]
}

export type LoadEpubResult =
  | { ok: true; data: LoadedEpub | null }
  | { ok: false; error: string }
