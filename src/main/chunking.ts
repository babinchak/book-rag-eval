import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { bookDir } from './library'
import { readSpineRaw } from './epub'
import { normalizeParams, strategyIdOf } from '../shared/strategy'
import type {
  Chunk,
  ChunkParams,
  ChunkSet,
  ChunkSetSummary,
  ReadiumManifest
} from '../preload/types'

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

const BLOCK_CLOSE_RE = /<\/(?:p|div|h[1-6]|section|article|li|blockquote)>/gi

interface Span {
  text: string
  start: number
  end: number
}

function findParagraphSpans(rawHtml: string): Span[] {
  const fragments: string[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  const re = new RegExp(BLOCK_CLOSE_RE.source, 'gi')
  while ((match = re.exec(rawHtml)) !== null) {
    fragments.push(rawHtml.slice(lastIdx, match.index))
    lastIdx = match.index + match[0].length
  }
  fragments.push(rawHtml.slice(lastIdx))

  const paragraphs: Span[] = []
  let pos = 0
  for (const frag of fragments) {
    const text = htmlToPlainText(frag)
    if (text.length === 0) continue
    if (paragraphs.length > 0) pos += 1
    paragraphs.push({ text, start: pos, end: pos + text.length })
    pos += text.length
  }
  return paragraphs
}

function makeChunk(
  sid: string,
  spineHref: string,
  text: string,
  textStart: number,
  textEnd: number
): Chunk {
  return {
    id: `${sid}::${spineHref}#${textStart}`,
    strategyId: sid,
    spineHref,
    textStart,
    textEnd,
    text
  }
}

function chunkFixed(
  spineHref: string,
  text: string,
  params: { size: number; overlap: number },
  sid: string
): Chunk[] {
  if (text.length === 0) return []
  const stride = params.size - params.overlap
  if (stride <= 0) throw new Error('overlap must be smaller than size')
  const out: Chunk[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + params.size, text.length)
    out.push(makeChunk(sid, spineHref, text.slice(start, end), start, end))
    if (end === text.length) break
    start += stride
  }
  return out
}

function groupSpansToChunks(
  spineHref: string,
  spans: Span[],
  targetSize: number,
  sid: string,
  fullText: string | null
): Chunk[] {
  const chunks: Chunk[] = []
  let cur: Span[] = []
  let curSize = 0

  const flush = (): void => {
    if (cur.length === 0) return
    const start = cur[0].start
    const end = cur[cur.length - 1].end
    const text = fullText !== null ? fullText.slice(start, end) : cur.map((s) => s.text).join(' ')
    chunks.push(makeChunk(sid, spineHref, text, start, end))
    cur = []
    curSize = 0
  }

  for (const span of spans) {
    if (cur.length > 0 && curSize + span.text.length > targetSize) {
      flush()
    }
    cur.push(span)
    curSize += span.text.length + 1
  }
  flush()
  return chunks
}

function chunkParagraphs(
  spineHref: string,
  rawHtml: string,
  params: { targetSize: number },
  sid: string
): Chunk[] {
  const paragraphs = findParagraphSpans(rawHtml)
  if (paragraphs.length === 0) return []
  return groupSpansToChunks(spineHref, paragraphs, params.targetSize, sid, null)
}

function chunkSentences(
  spineHref: string,
  text: string,
  params: { targetSize: number },
  sid: string
): Chunk[] {
  if (text.length === 0) return []
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  const sentences: Span[] = []
  for (const seg of segmenter.segment(text)) {
    if (seg.segment.trim().length === 0) continue
    sentences.push({
      text: seg.segment,
      start: seg.index,
      end: seg.index + seg.segment.length
    })
  }
  if (sentences.length === 0) return []
  return groupSpansToChunks(spineHref, sentences, params.targetSize, sid, text)
}

function chunkStructural(
  spineHref: string,
  text: string,
  params: { maxSize: number },
  sid: string
): Chunk[] {
  if (text.length === 0) return []
  if (text.length <= params.maxSize) {
    return [makeChunk(sid, spineHref, text, 0, text.length)]
  }
  const out: Chunk[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + params.maxSize, text.length)
    out.push(makeChunk(sid, spineHref, text.slice(start, end), start, end))
    start = end
  }
  return out
}

async function readManifest(bookId: string): Promise<ReadiumManifest> {
  const raw = await fs.readFile(join(bookDir(bookId), 'manifest.json'), 'utf8')
  return JSON.parse(raw) as ReadiumManifest
}

export async function runChunking(
  bookId: string,
  paramsRaw: ChunkParams
): Promise<ChunkSetSummary> {
  const params = normalizeParams(paramsRaw)
  const sid = strategyIdOf(params)
  const manifest = await readManifest(bookId)
  const epubPath = join(bookDir(bookId), 'book.epub')
  const spine = readSpineRaw(epubPath, manifest)

  const chunks: Chunk[] = []
  for (const item of spine) {
    const text = htmlToPlainText(item.rawHtml)
    switch (params.kind) {
      case 'fixed':
        chunks.push(...chunkFixed(item.href, text, params, sid))
        break
      case 'paragraph':
        chunks.push(...chunkParagraphs(item.href, item.rawHtml, params, sid))
        break
      case 'sentence':
        chunks.push(...chunkSentences(item.href, text, params, sid))
        break
      case 'structural':
        chunks.push(...chunkStructural(item.href, text, params, sid))
        break
    }
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
        params: normalizeParams(set.params),
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
  const set = JSON.parse(raw) as ChunkSet
  set.params = normalizeParams(set.params)
  return set
}
