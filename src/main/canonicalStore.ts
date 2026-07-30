import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { bookDir } from './library'
import { readSpineRaw } from './epub'
import {
  buildCanonicalBookDocument,
  CANONICAL_DOCUMENT_SCHEMA_VERSION,
  CANONICAL_PARSER_VERSION,
  canonicalSourceHashOf,
  type CanonicalBookDocument
} from '../shared/canonicalDocument'
import type { ReadiumManifest } from '../preload/types'

const CANONICAL_FILENAME = 'canonical-document.v1.json'

export function canonicalDocumentPath(bookId: string): string {
  return join(bookDir(bookId), CANONICAL_FILENAME)
}

async function readManifest(bookId: string): Promise<ReadiumManifest> {
  const raw = await fs.readFile(join(bookDir(bookId), 'manifest.json'), 'utf8')
  return JSON.parse(raw) as ReadiumManifest
}

function isCurrent(candidate: CanonicalBookDocument, bookId: string, sourceHash: string): boolean {
  return (
    candidate.schemaVersion === CANONICAL_DOCUMENT_SCHEMA_VERSION &&
    candidate.parserVersion === CANONICAL_PARSER_VERSION &&
    candidate.bookId === bookId &&
    candidate.sourceHash === sourceHash
  )
}

export async function loadCanonicalBookDocument(bookId: string): Promise<CanonicalBookDocument> {
  const manifest = await readManifest(bookId)
  const epubPath = join(bookDir(bookId), 'book.epub')
  const spine = readSpineRaw(epubPath, manifest)
  const sourceHash = canonicalSourceHashOf(spine)
  const path = canonicalDocumentPath(bookId)

  try {
    const saved = JSON.parse(await fs.readFile(path, 'utf8')) as CanonicalBookDocument
    if (isCurrent(saved, bookId, sourceHash)) return saved
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error
    }
  }

  const canonical = buildCanonicalBookDocument(bookId, spine)
  const temporaryPath = `${path}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(canonical), 'utf8')
  await fs.rename(temporaryPath, path)
  return canonical
}
