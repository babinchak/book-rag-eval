import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { bookDir } from './library'
import { readSpineRaw } from './epub'
import type {
  Chunk,
  ChunkParams,
  ChunkSet,
  ChunkSetSummary,
  ReadiumManifest
} from '../preload/types'

export function strategyId(params: ChunkParams): string {
  return `fixed-${params.size}-${params.overlap}`
}

function chunksDir(bookId: string): string {
  return join(bookDir(bookId), 'chunks')
}

function chunkSetPath(bookId: string, sid: string): string {
  return join(chunksDir(bookId), `${sid}.json`)
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function chunkSpineItem(
  spineHref: string,
  text: string,
  params: ChunkParams,
  sid: string
): Chunk[] {
  if (text.length === 0) return []
  const stride = params.size - params.overlap
  if (stride <= 0) throw new Error('overlap must be smaller than size')
  const out: Chunk[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + params.size, text.length)
    out.push({
      id: `${sid}::${spineHref}#${start}`,
      strategyId: sid,
      spineHref,
      textStart: start,
      textEnd: end,
      text: text.slice(start, end)
    })
    if (end === text.length) break
    start += stride
  }
  return out
}

async function readManifest(bookId: string): Promise<ReadiumManifest> {
  const raw = await fs.readFile(join(bookDir(bookId), 'manifest.json'), 'utf8')
  return JSON.parse(raw) as ReadiumManifest
}

export async function runChunking(bookId: string, params: ChunkParams): Promise<ChunkSetSummary> {
  const sid = strategyId(params)
  const manifest = await readManifest(bookId)
  const epubPath = join(bookDir(bookId), 'book.epub')
  const spine = readSpineRaw(epubPath, manifest)

  const chunks: Chunk[] = []
  for (const item of spine) {
    chunks.push(...chunkSpineItem(item.href, htmlToPlainText(item.rawHtml), params, sid))
  }

  const set: ChunkSet = {
    bookId,
    strategyId: sid,
    params,
    count: chunks.length,
    generatedAt: Date.now(),
    chunks
  }

  await fs.mkdir(chunksDir(bookId), { recursive: true })
  const tmp = chunkSetPath(bookId, sid) + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(set), 'utf8')
  await fs.rename(tmp, chunkSetPath(bookId, sid))

  return { strategyId: sid, params, count: chunks.length, generatedAt: set.generatedAt }
}

export async function listChunkSets(bookId: string): Promise<ChunkSetSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(chunksDir(bookId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const summaries: ChunkSetSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(chunksDir(bookId), name), 'utf8')
      const set = JSON.parse(raw) as ChunkSet
      summaries.push({
        strategyId: set.strategyId,
        params: set.params,
        count: set.count,
        generatedAt: set.generatedAt
      })
    } catch {
      // skip unreadable/corrupt sets
    }
  }
  return summaries.sort((a, b) => b.generatedAt - a.generatedAt)
}

export async function getChunkSet(bookId: string, sid: string): Promise<ChunkSet> {
  const raw = await fs.readFile(chunkSetPath(bookId, sid), 'utf8')
  return JSON.parse(raw) as ChunkSet
}
