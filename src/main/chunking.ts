import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { bookDir } from './library'
import { readSpineRaw } from './epub'
import { sidecar } from './sidecar'
import { getOpenaiKey } from './settings'
import { chunkTokenSpans } from './tokenChunking'
import { normalizeParams, strategyIdOf } from '../shared/strategy'
import type {
  Chunk,
  ChunkParams,
  ChunkSet,
  ChunkSetSummary,
  ReadiumManifest
} from '../preload/types'

// Use a cheaper model than the retrieval-time embeddings — we only need a
// similarity signal between adjacent sentence windows, not high-quality vectors.
const SEMANTIC_EMBED_MODEL = 'text-embedding-3-small'
const SEMANTIC_EMBED_BATCH = 256

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
  textEnd: number,
  tokenCount?: number
): Chunk {
  return {
    id: `${sid}::${spineHref}#${textStart}`,
    strategyId: sid,
    spineHref,
    textStart,
    textEnd,
    text,
    ...(tokenCount !== undefined ? { tokenCount } : {})
  }
}

function chunkFixedTokens(
  spineHref: string,
  text: string,
  params: { size: number; overlap: number; encoding: 'cl100k_base' },
  sid: string
): Chunk[] {
  if (params.encoding !== 'cl100k_base') {
    throw new Error(`unsupported token encoding: ${params.encoding}`)
  }
  return chunkTokenSpans(text, params.size, params.overlap).map((span) =>
    makeChunk(
      sid,
      spineHref,
      text.slice(span.start, span.end),
      span.start,
      span.end,
      span.tokenCount
    )
  )
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

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 1
  return 1 - dot / denom
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const clamped = Math.max(0, Math.min(100, p))
  const idx = (clamped / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

async function embedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += SEMANTIC_EMBED_BATCH) {
    const batch = texts.slice(i, i + SEMANTIC_EMBED_BATCH)
    const result = await sidecar.embed(batch, SEMANTIC_EMBED_MODEL)
    if (result.embeddings.length !== batch.length) {
      throw new Error(
        `semantic chunker: embedding count mismatch (expected ${batch.length}, got ${result.embeddings.length})`
      )
    }
    out.push(...result.embeddings)
  }
  return out
}

function sentenceSpans(text: string): Span[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
  const spans: Span[] = []
  for (const seg of segmenter.segment(text)) {
    if (seg.segment.trim().length === 0) continue
    spans.push({
      text: seg.segment,
      start: seg.index,
      end: seg.index + seg.segment.length
    })
  }
  return spans
}

async function chunkSemantic(
  spineHref: string,
  text: string,
  params: { targetSize: number; breakpointPercentile: number; bufferSize: number },
  sid: string
): Promise<Chunk[]> {
  if (text.length === 0) return []
  const sentences = sentenceSpans(text)
  if (sentences.length === 0) return []
  if (sentences.length === 1) {
    const only = sentences[0]
    return [makeChunk(sid, spineHref, text.slice(only.start, only.end), only.start, only.end)]
  }

  // Build context windows: each window is the target sentence plus `bufferSize`
  // sentences of context on each side. The window text is what we embed, but
  // the *spans* we group are still individual sentences.
  const k = Math.max(0, Math.floor(params.bufferSize))
  const windowTexts: string[] = []
  for (let i = 0; i < sentences.length; i++) {
    const lo = Math.max(0, i - k)
    const hi = Math.min(sentences.length, i + k + 1)
    const window = sentences
      .slice(lo, hi)
      .map((s) => s.text)
      .join(' ')
      .trim()
    windowTexts.push(window)
  }

  const embeddings = await embedAll(windowTexts)
  // distances[i] is the distance between window[i] and window[i+1]; a high
  // value means the conversation is shifting between sentence i and i+1.
  const distances: number[] = []
  for (let i = 0; i < embeddings.length - 1; i++) {
    distances.push(cosineDistance(embeddings[i], embeddings[i + 1]))
  }

  const sortedDist = [...distances].sort((a, b) => a - b)
  const threshold = percentile(sortedDist, params.breakpointPercentile)
  const maxGroupSize = Math.max(params.targetSize * 2, params.targetSize + 1)

  const chunks: Chunk[] = []
  let group: Span[] = []
  const flush = (): void => {
    if (group.length === 0) return
    const start = group[0].start
    const end = group[group.length - 1].end
    chunks.push(makeChunk(sid, spineHref, text.slice(start, end), start, end))
    group = []
  }

  for (let i = 0; i < sentences.length; i++) {
    group.push(sentences[i])
    const groupSize = group[group.length - 1].end - group[0].start
    // distances[i] is the gap *after* sentence i — break before the next sentence
    // if the topic shifted enough, or if we've blown past the soft size ceiling.
    const isBreakpoint = i < distances.length && distances[i] > threshold
    const tooBig = groupSize >= maxGroupSize
    if (isBreakpoint || tooBig) flush()
  }
  flush()
  return chunks
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

  if (params.kind === 'semantic') {
    const apiKey = await getOpenaiKey()
    if (!apiKey) {
      throw new Error(
        'OpenAI API key is not set. Add it in Settings before running semantic chunking.'
      )
    }
    await sidecar.ensureStarted(apiKey)
  }

  const chunks: Chunk[] = []
  for (const item of spine) {
    const text = htmlToPlainText(item.rawHtml)
    switch (params.kind) {
      case 'fixed-token':
        chunks.push(...chunkFixedTokens(item.href, text, params, sid))
        break
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
      case 'semantic':
        chunks.push(...(await chunkSemantic(item.href, text, params, sid)))
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
