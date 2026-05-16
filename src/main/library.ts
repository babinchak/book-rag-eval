import { app, dialog } from 'electron'
import { promises as fs, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { runReadiumManifest, extractSpineHtml } from './epub'
import type {
  BookSummary,
  CollectionSummary,
  ImportOutcome,
  LoadedEpub,
  ReadiumManifest,
  ReadiumManifestLink
} from '../preload/types'

interface IndexEntry {
  id: string
  title: string
  author: string | null
  addedAt: number
  sizeBytes: number
  coverExt: string | null
  collectionId?: string | null
}

interface LibraryIndex {
  books: IndexEntry[]
}

interface CollectionEntry {
  id: string
  name: string
  addedAt: number
}

interface CollectionsFile {
  collections: CollectionEntry[]
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

function libraryDir(): string {
  return join(app.getPath('userData'), 'library')
}

function indexPath(): string {
  return join(libraryDir(), 'index.json')
}

function collectionsPath(): string {
  return join(libraryDir(), 'collections.json')
}

export function bookDir(id: string): string {
  return join(libraryDir(), id)
}

async function ensureLibraryDir(): Promise<void> {
  await fs.mkdir(libraryDir(), { recursive: true })
}

async function readIndex(): Promise<LibraryIndex> {
  await ensureLibraryDir()
  try {
    const raw = await fs.readFile(indexPath(), 'utf8')
    return JSON.parse(raw) as LibraryIndex
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { books: [] }
    throw err
  }
}

async function writeIndex(index: LibraryIndex): Promise<void> {
  await ensureLibraryDir()
  const tmp = indexPath() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
  await fs.rename(tmp, indexPath())
}

async function readCollections(): Promise<CollectionsFile> {
  await ensureLibraryDir()
  try {
    const raw = await fs.readFile(collectionsPath(), 'utf8')
    return JSON.parse(raw) as CollectionsFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { collections: [] }
    throw err
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function normalizeAuthor(author: unknown): string | null {
  if (!author) return null
  if (typeof author === 'string') return author
  if (Array.isArray(author)) {
    const names = author
      .map((a) => (typeof a === 'string' ? a : (a as { name?: string })?.name))
      .filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.join(', ') : null
  }
  if (typeof author === 'object') return (author as { name?: string }).name ?? null
  return null
}

function relIncludes(rel: string | string[] | undefined, target: string): boolean {
  if (!rel) return false
  if (typeof rel === 'string') return rel === target
  return rel.includes(target)
}

function findCoverLink(manifest: ReadiumManifest): ReadiumManifestLink | null {
  const candidates = [...(manifest.resources ?? []), ...(manifest.readingOrder ?? [])]
  return candidates.find((link) => relIncludes(link.rel, 'cover')) ?? null
}

async function extractCover(
  epubPath: string,
  manifest: ReadiumManifest,
  outDir: string
): Promise<string | null> {
  const cover = findCoverLink(manifest)
  if (!cover) return null
  const zip = new AdmZip(epubPath)
  const candidate = cover.href.startsWith('/') ? cover.href.slice(1) : cover.href
  const entry = zip.getEntry(candidate) ?? zip.getEntry(decodeURIComponent(candidate))
  if (!entry) return null
  let ext = EXT_BY_MIME[cover.type ?? ''] || candidate.split('.').pop()?.toLowerCase() || null
  if (!ext) return null
  if (ext === 'jpeg') ext = 'jpg'
  await fs.writeFile(join(outDir, `cover.${ext}`), entry.getData())
  return ext
}

async function readCoverDataUrl(id: string, ext: string | null): Promise<string | null> {
  if (!ext) return null
  try {
    const data = await fs.readFile(join(bookDir(id), `cover.${ext}`))
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

function entryToSummary(entry: IndexEntry, coverDataUrl: string | null): BookSummary {
  return {
    id: entry.id,
    title: entry.title,
    author: entry.author,
    addedAt: entry.addedAt,
    sizeBytes: entry.sizeBytes,
    coverDataUrl,
    collectionId: entry.collectionId ?? null
  }
}

export async function listCollections(): Promise<CollectionSummary[]> {
  const [index, file] = await Promise.all([readIndex(), readCollections()])
  const counts = new Map<string, number>()
  for (const b of index.books) {
    const id = b.collectionId ?? null
    if (id == null) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return file.collections
    .map((c) => ({ id: c.id, name: c.name, addedAt: c.addedAt, bookCount: counts.get(c.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listLibrary(): Promise<BookSummary[]> {
  const index = await readIndex()
  const summaries = await Promise.all(
    index.books.map(async (e) => entryToSummary(e, await readCoverDataUrl(e.id, e.coverExt)))
  )
  return summaries.sort((a, b) => b.addedAt - a.addedAt)
}

export async function importEpubFromDialog(): Promise<ImportOutcome | null> {
  const result = await dialog.showOpenDialog({
    title: 'Add EPUB to library',
    properties: ['openFile'],
    filters: [{ name: 'EPUB', extensions: ['epub'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const sourcePath = result.filePaths[0]

  const id = await sha256File(sourcePath)
  const index = await readIndex()
  const existing = index.books.find((b) => b.id === id)
  if (existing) {
    const cover = await readCoverDataUrl(existing.id, existing.coverExt)
    return { summary: entryToSummary(existing, cover), alreadyExisted: true }
  }

  const dir = bookDir(id)
  await fs.mkdir(dir, { recursive: true })
  const targetEpub = join(dir, 'book.epub')
  await fs.copyFile(sourcePath, targetEpub)
  const manifest = await runReadiumManifest(targetEpub)
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  const coverExt = await extractCover(targetEpub, manifest, dir)
  const stat = await fs.stat(targetEpub)

  const fallbackTitle = sourcePath.split(/[\\/]/).pop()?.replace(/\.epub$/i, '') ?? 'Untitled'
  const entry: IndexEntry = {
    id,
    title:
      typeof manifest.metadata?.title === 'string' && manifest.metadata.title.trim().length > 0
        ? manifest.metadata.title
        : fallbackTitle,
    author: normalizeAuthor(manifest.metadata?.author),
    addedAt: Date.now(),
    sizeBytes: stat.size,
    coverExt
  }
  index.books.push(entry)
  await writeIndex(index)
  const cover = await readCoverDataUrl(id, coverExt)
  return { summary: entryToSummary(entry, cover), alreadyExisted: false }
}

export async function openBook(id: string): Promise<LoadedEpub> {
  const dir = bookDir(id)
  const epubPath = join(dir, 'book.epub')
  const manifestRaw = await fs.readFile(join(dir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw) as ReadiumManifest
  const spineItems = extractSpineHtml(epubPath, manifest)
  return { id, manifest, spineItems }
}

export async function removeBook(id: string): Promise<void> {
  const index = await readIndex()
  index.books = index.books.filter((b) => b.id !== id)
  await writeIndex(index)
  await fs.rm(bookDir(id), { recursive: true, force: true })
}
