import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { bookDir, listLibrary } from './library'
import { readSpineRaw } from './epub'
import { ask, retrieve } from './retrieval'
import { getChunkSet } from './chunking'
import { getOpenaiKey } from './settings'
import { captureIpcError } from './ipcContext'
import { retrieverIdOf, type RetrieverParams } from '../shared/retriever'
import type {
  AutoGenerateProgress,
  Chunk,
  EvalCase,
  EvalCaseResult,
  EvalMode,
  EvalRunResult,
  EvalRunSummary,
  EvalSet,
  EvalSetSummary,
  GoldSpan,
  LocateQuoteHit,
  ReadiumManifest,
  RetrievedChunkPayload,
  RetrievedDetail
} from '../preload/types'

function evalsDir(bookId: string): string {
  return join(bookDir(bookId), 'evals')
}

function evalSetPath(bookId: string, setId: string): string {
  return join(evalsDir(bookId), `${setId}.json`)
}

function evalRunsDir(bookId: string): string {
  return join(bookDir(bookId), 'eval-runs')
}

function evalRunPath(bookId: string, runId: string): string {
  return join(evalRunsDir(bookId), `${runId}.json`)
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

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

async function readManifest(bookId: string): Promise<ReadiumManifest> {
  const raw = await fs.readFile(join(bookDir(bookId), 'manifest.json'), 'utf8')
  return JSON.parse(raw) as ReadiumManifest
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

function isValidSetId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}

export async function listEvalSets(bookId: string): Promise<EvalSetSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(evalsDir(bookId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const summaries: EvalSetSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(evalsDir(bookId), name), 'utf8')
      const set = JSON.parse(raw) as EvalSet
      summaries.push({
        id: set.id,
        caseCount: set.cases.length,
        updatedAt: set.updatedAt
      })
    } catch {
      // skip
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getEvalSet(bookId: string, setId: string): Promise<EvalSet> {
  const raw = await fs.readFile(evalSetPath(bookId, setId), 'utf8')
  return JSON.parse(raw) as EvalSet
}

export async function createEvalSet(bookId: string, setId: string): Promise<EvalSet> {
  if (!isValidSetId(setId)) {
    throw new Error('Eval set id must be 1-64 chars of [a-zA-Z0-9_-]')
  }
  try {
    await fs.access(evalSetPath(bookId, setId))
    throw new Error(`Eval set "${setId}" already exists`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const now = Date.now()
  const set: EvalSet = {
    id: setId,
    bookId,
    cases: [],
    createdAt: now,
    updatedAt: now
  }
  await writeJsonAtomic(evalSetPath(bookId, setId), set)
  return set
}

export async function deleteEvalSet(bookId: string, setId: string): Promise<void> {
  await fs.rm(evalSetPath(bookId, setId), { force: true })
}

export async function addCase(
  bookId: string,
  setId: string,
  question: string,
  searchQuery: string,
  goldSpans: GoldSpan[],
  notes?: string
): Promise<EvalCase> {
  const trimmedQ = question.trim()
  if (!trimmedQ) throw new Error('Question is required')
  const trimmedSQ = searchQuery.trim()
  if (!trimmedSQ) throw new Error('Search query is required')
  if (goldSpans.length === 0) throw new Error('At least one gold span is required')
  const set = await getEvalSet(bookId, setId)
  const newCase: EvalCase = {
    id: randomUUID(),
    question: trimmedQ,
    searchQuery: trimmedSQ,
    goldSpans,
    notes
  }
  set.cases.push(newCase)
  set.updatedAt = Date.now()
  await writeJsonAtomic(evalSetPath(bookId, setId), set)
  return newCase
}

export async function removeCase(
  bookId: string,
  setId: string,
  caseId: string
): Promise<void> {
  const set = await getEvalSet(bookId, setId)
  set.cases = set.cases.filter((c) => c.id !== caseId)
  set.updatedAt = Date.now()
  await writeJsonAtomic(evalSetPath(bookId, setId), set)
}

export async function updateCase(
  bookId: string,
  setId: string,
  caseId: string,
  updates: { question?: string; searchQuery?: string; goldSpans?: GoldSpan[]; notes?: string }
): Promise<EvalCase> {
  const set = await getEvalSet(bookId, setId)
  const idx = set.cases.findIndex((c) => c.id === caseId)
  if (idx === -1) throw new Error(`Case ${caseId} not found`)
  const existing = set.cases[idx]

  let question = existing.question
  if (updates.question !== undefined) {
    const trimmed = updates.question.trim()
    if (!trimmed) throw new Error('Question is required')
    question = trimmed
  }

  let searchQuery = existing.searchQuery
  if (updates.searchQuery !== undefined) {
    const trimmed = updates.searchQuery.trim()
    if (!trimmed) throw new Error('Search query is required')
    searchQuery = trimmed
  }

  let goldSpans = existing.goldSpans
  if (updates.goldSpans !== undefined) {
    if (updates.goldSpans.length === 0) throw new Error('At least one gold span is required')
    goldSpans = updates.goldSpans
  }

  const updated: EvalCase = {
    ...existing,
    question,
    searchQuery,
    goldSpans,
    notes: updates.notes !== undefined ? updates.notes : existing.notes
  }
  set.cases[idx] = updated
  set.updatedAt = Date.now()
  await writeJsonAtomic(evalSetPath(bookId, setId), set)
  return updated
}

export async function locateQuote(
  bookId: string,
  quote: string
): Promise<LocateQuoteHit | null> {
  const needle = normalizeWhitespace(quote)
  if (!needle) return null
  const manifest = await readManifest(bookId)
  const epubPath = join(bookDir(bookId), 'book.epub')
  const spine = readSpineRaw(epubPath, manifest)
  for (const item of spine) {
    const haystack = htmlToPlainText(item.rawHtml)
    const idx = haystack.indexOf(needle)
    if (idx >= 0) {
      const previewStart = Math.max(0, idx - 30)
      const previewEnd = Math.min(haystack.length, idx + needle.length + 30)
      const preview = haystack.slice(previewStart, previewEnd)
      return {
        goldSpan: {
          spineHref: item.href,
          textStart: idx,
          textEnd: idx + needle.length
        },
        preview: (previewStart > 0 ? '…' : '') + preview + (previewEnd < haystack.length ? '…' : '')
      }
    }
  }
  return null
}

interface ChunkLite {
  id: string
  spineHref: string
  textStart: number
  textEnd: number
}

const HIT_OVERLAP_RATIO = 0.3

function computeOverlap(chunk: ChunkLite, goldSpans: GoldSpan[]): number {
  let total = 0
  for (const gold of goldSpans) {
    if (chunk.spineHref !== gold.spineHref) continue
    const overlapStart = Math.max(chunk.textStart, gold.textStart)
    const overlapEnd = Math.min(chunk.textEnd, gold.textEnd)
    if (overlapEnd > overlapStart) total += overlapEnd - overlapStart
  }
  return total
}

function isHit(chunk: ChunkLite, goldSpans: GoldSpan[]): boolean {
  for (const gold of goldSpans) {
    if (chunk.spineHref !== gold.spineHref) continue
    const overlapStart = Math.max(chunk.textStart, gold.textStart)
    const overlapEnd = Math.min(chunk.textEnd, gold.textEnd)
    const overlap = Math.max(0, overlapEnd - overlapStart)
    const goldLen = gold.textEnd - gold.textStart
    if (goldLen > 0 && overlap / goldLen >= HIT_OVERLAP_RATIO) return true
  }
  return false
}

function parseCitations(answer: string): number[] {
  const ranks = new Set<number>()
  const regex = /\[(\d+(?:\s*,\s*\d+)*)\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(answer)) !== null) {
    for (const numStr of match[1].split(',')) {
      const n = parseInt(numStr.trim(), 10)
      if (Number.isFinite(n) && n > 0) ranks.add(n)
    }
  }
  return Array.from(ranks).sort((a, b) => a - b)
}

export async function runEval(
  bookId: string,
  setId: string,
  strategyId: string,
  retriever: RetrieverParams,
  k: number,
  mode: EvalMode = 'retrieval',
  caseIds?: string[]
): Promise<EvalRunResult> {
  const set = await getEvalSet(bookId, setId)
  if (set.cases.length === 0) {
    throw new Error('Eval set has no cases. Add cases before running.')
  }

  const casesToRun =
    caseIds && caseIds.length > 0 ? set.cases.filter((c) => caseIds.includes(c.id)) : set.cases
  if (casesToRun.length === 0) {
    throw new Error('No matching cases to run.')
  }

  const caseResults: EvalCaseResult[] = []
  let totalRecall = 0
  let totalMRR = 0
  let totalCitPrec = 0
  let totalCitRec = 0
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalTokens = 0

  for (const c of casesToRun) {
    if (mode === 'retrieval') {
      if (!c.searchQuery || !c.searchQuery.trim()) {
        throw new Error(
          `Case ${c.id} has no searchQuery. Run "Backfill missing search queries" from the AutoGen panel first.`
        )
      }
      const retrieved = await retrieve(bookId, strategyId, retriever, c.searchQuery, k)
      let firstHitRank: number | null = null
      const details: RetrievedDetail[] = retrieved.map((r) => {
        const overlap = computeOverlap(r.chunk, c.goldSpans)
        const hit = isHit(r.chunk, c.goldSpans)
        if (hit && firstHitRank === null) firstHitRank = r.rank
        return { chunkId: r.chunk.id, distance: r.distance, hit, overlap, rank: r.rank }
      })
      const recallAtK = firstHitRank !== null ? 1 : 0
      const mrr = firstHitRank !== null ? 1 / firstHitRank : 0

      caseResults.push({
        caseId: c.id,
        question: c.question,
        searchQuery: c.searchQuery,
        retrieved: details,
        recallAtK,
        mrr,
        hitRank: firstHitRank
      })

      totalRecall += recallAtK
      totalMRR += mrr
    } else {
      const agentResult = await ask(bookId, strategyId, retriever, c.question, k)
      const retrieved = agentResult.retrieved

      let firstHitRank: number | null = null
      const details: RetrievedDetail[] = retrieved.map((r) => {
        const overlap = computeOverlap(r.chunk, c.goldSpans)
        const hit = isHit(r.chunk, c.goldSpans)
        if (hit && firstHitRank === null) firstHitRank = r.rank
        return { chunkId: r.chunk.id, distance: r.distance, hit, overlap, rank: r.rank }
      })
      const recallAtK = firstHitRank !== null ? 1 : 0
      const mrr = firstHitRank !== null ? 1 / firstHitRank : 0

      const citedRanks = parseCitations(agentResult.answer)
      const byRank = new Map<number, RetrievedChunkPayload>()
      for (const r of retrieved) byRank.set(r.rank, r)
      const citedDetails: RetrievedChunkPayload[] = []
      for (const rank of citedRanks) {
        const r = byRank.get(rank)
        if (r) citedDetails.push(r)
      }
      const citedChunkIds = citedDetails.map((r) => r.chunk.id)
      const citedHits = citedDetails.filter((r) => isHit(r.chunk, c.goldSpans))
      const totalGoldOverlapping = retrieved.filter((r) => isHit(r.chunk, c.goldSpans)).length
      const citationPrecision =
        citedDetails.length === 0 ? 0 : citedHits.length / citedDetails.length
      const citationRecall =
        totalGoldOverlapping === 0 ? 0 : citedHits.length / totalGoldOverlapping

      caseResults.push({
        caseId: c.id,
        question: c.question,
        retrieved: details,
        recallAtK,
        mrr,
        hitRank: firstHitRank,
        answer: agentResult.answer,
        citedRanks,
        citedChunkIds,
        citationPrecision,
        citationRecall,
        promptTokens: agentResult.promptTokens,
        completionTokens: agentResult.completionTokens,
        totalTokens: agentResult.totalTokens,
        langsmithRunUrl: agentResult.langsmithRunUrl
      })

      totalRecall += recallAtK
      totalMRR += mrr
      totalCitPrec += citationPrecision
      totalCitRec += citationRecall
      totalPromptTokens += agentResult.promptTokens
      totalCompletionTokens += agentResult.completionTokens
      totalTokens += agentResult.totalTokens
    }
  }

  const n = casesToRun.length
  const result: EvalRunResult = {
    id: randomUUID(),
    bookId,
    evalSetId: setId,
    strategyId,
    retrieverId: retrieverIdOf(retriever),
    k,
    ranAt: Date.now(),
    mode,
    meanRecallAtK: totalRecall / n,
    meanMRR: totalMRR / n,
    cases: caseResults
  }
  if (mode === 'agentic') {
    result.meanCitationPrecision = totalCitPrec / n
    result.meanCitationRecall = totalCitRec / n
    result.totalPromptTokens = totalPromptTokens
    result.totalCompletionTokens = totalCompletionTokens
    result.totalTokens = totalTokens
  }
  await writeJsonAtomic(evalRunPath(bookId, result.id), result)
  return result
}

export async function getEvalRun(bookId: string, runId: string): Promise<EvalRunResult> {
  const raw = await fs.readFile(evalRunPath(bookId, runId), 'utf8')
  return JSON.parse(raw) as EvalRunResult
}

const MIN_AUTOGEN_CHUNK_CHARS = 200
const MIN_ANSWER_SPAN_CHARS = 30
const MAX_GENERATION_ATTEMPTS = 2
const AUTOGEN_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

const generatedCaseSchema = z.object({
  question: z
    .string()
    .min(5)
    .describe('A specific natural-language question whose answer is found in the passage.'),
  searchQuery: z
    .string()
    .min(1)
    .describe(
      'A short, realistic search-style query (3-10 words) someone might type to find this passage. Paraphrase the topic in their own words; do NOT quote any 2+ word phrase that appears verbatim in the passage, and avoid distinctive proper nouns or rare terms lifted from the text. Use natural search-box vocabulary.'
    ),
  answerSpan: z
    .string()
    .min(MIN_ANSWER_SPAN_CHARS)
    .describe(
      'A VERBATIM contiguous quote copied character-for-character from the passage that fully contains the answer to the question. Pick the smallest contiguous quote that fully contains the answer (typically one to three sentences). Do NOT paraphrase, summarize, splice, or rewrite — the exact string must appear in the passage.'
    )
})

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return []
  const n = Math.min(count, items.length)
  const out: T[] = []
  for (let i = 0; i < n; i++) {
    const idx = Math.floor((i * items.length) / n)
    out.push(items[idx])
  }
  return out
}

function isFrontMatter(text: string): boolean {
  if (/project\s+gutenberg/i.test(text)) return true
  if (/\*\*\*\s*(?:start|end)\s+of\s+the/i.test(text)) return true
  // Structured book metadata header (Title : ... Author : ...)
  if (/\btitle\s*:\s*[^\n]{1,200}\bauthor\s*:/i.test(text)) return true
  return false
}

// Skip chunks that are clearly not flowing prose: front matter, table of contents,
// footnote dumps, indexes. The auto-generator produces nonsense cases on these.
function isQualityProse(text: string): boolean {
  if (text.length < MIN_AUTOGEN_CHUNK_CHARS) return false
  if (isFrontMatter(text)) return false
  const letters = (text.match(/[a-zA-Z]/g) ?? []).length
  if (letters / text.length < 0.6) return false
  const sentences = text.split(/[.!?](?:\s|$)/).filter((s) => s.trim().length > 0)
  if (sentences.length < 3) return false
  const words = (text.match(/\b\w+\b/g) ?? []).length
  if (words / sentences.length < 10) return false
  if ((text.match(/\[\d+\]/g) ?? []).length >= 4) return false
  return true
}

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an',
  'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing',
  'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 's', 'same', 'she', 'should', 'so', 'some', 'such',
  't', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your', 'yours', 'yourself', 'yourselves'
])

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2)
}

function tokenizeWithCase(s: string): string[] {
  return (s.match(/[A-Za-z0-9]+/g) ?? []).filter((t) => t.length >= 2)
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`)
  return out
}

// Build the chunk's "leakable bigrams" — only those that count as real
// surface-token leakage if they show up in a search query. We exclude:
//   - pure-stopword bigrams ("of the", "what is") — these are English, not leakage
//   - pure proper-noun bigrams ("Van Dyck", "Project Gutenberg") — legitimate
//     subjects a real searcher would type
function leakableBigrams(chunkText: string): Set<string> {
  const toks = tokenizeWithCase(chunkText)
  const out = new Set<string>()
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i]
    const b = toks[i + 1]
    const aCap = /^[A-Z]/.test(a)
    const bCap = /^[A-Z]/.test(b)
    if (aCap && bCap) continue
    const aLow = a.toLowerCase()
    const bLow = b.toLowerCase()
    if (STOPWORDS.has(aLow) && STOPWORDS.has(bLow)) continue
    out.add(`${aLow} ${bLow}`)
  }
  return out
}

// Return any 2-word phrase from the search query that overlaps the chunk's
// leakable bigrams. Surface-token overlap makes embedding retrieval trivial.
function findLeakingBigrams(searchQuery: string, chunkText: string): string[] {
  const queryGrams = bigrams(tokenize(searchQuery))
  const leakable = leakableBigrams(chunkText)
  const hits = new Set<string>()
  for (const g of queryGrams) if (leakable.has(g)) hits.add(g)
  return Array.from(hits)
}

// LLMs often clean up the boundary punctuation when copying a quote (e.g.,
// replacing a trailing comma with a period for grammatical closure). Locate
// the span tolerantly: try verbatim first; if that fails, trim leading and
// trailing punctuation+whitespace and try again. Returns the chunk-local
// offset and the substring length to use as the gold span, or null if no
// match can be found.
function locateAnswerSpan(
  chunkText: string,
  answerSpan: string
): { offset: number; length: number } | null {
  const direct = chunkText.indexOf(answerSpan)
  if (direct >= 0) return { offset: direct, length: answerSpan.length }
  const trimmed = answerSpan.replace(
    /^[\s.,;:!?'"`\-—–()\[\]{}]+|[\s.,;:!?'"`\-—–()\[\]{}]+$/g,
    ''
  )
  if (trimmed.length < MIN_ANSWER_SPAN_CHARS) return null
  const fuzzy = chunkText.indexOf(trimmed)
  if (fuzzy >= 0) return { offset: fuzzy, length: trimmed.length }
  return null
}

export async function autoGenerateCases(
  bookId: string,
  setId: string,
  strategyId: string,
  count: number
): Promise<AutoGenerateProgress> {
  if (!Number.isFinite(count) || count <= 0) throw new Error('Count must be positive.')
  if (count > 100) throw new Error('Count must be 100 or fewer.')

  const apiKey = await getOpenaiKey()
  if (!apiKey) throw new Error('OpenAI API key is not set. Add it in Settings.')

  // Validate the eval set exists before spending API calls.
  await getEvalSet(bookId, setId)

  const chunkSet = await getChunkSet(bookId, strategyId)
  const eligible: Chunk[] = chunkSet.chunks.filter((c) => isQualityProse(c.text))
  if (eligible.length === 0) {
    throw new Error(
      `Strategy "${strategyId}" has no prose-quality chunks (need >= ${MIN_AUTOGEN_CHUNK_CHARS} chars, real sentences, low footnote density).`
    )
  }

  const sampled = sampleEvenly(eligible, count)

  const library = await listLibrary()
  const book = library.find((b) => b.id === bookId)
  const bookContext = book
    ? `Book: "${book.title}"${book.author ? ` by ${book.author}` : ''}`
    : ''

  const llm = new ChatOpenAI({
    model: AUTOGEN_MODEL,
    apiKey,
    temperature: 0.7
  }).withStructuredOutput(generatedCaseSchema)

  const systemPrompt =
    'You are helping create evaluation cases for a book retrieval system. ' +
    'Given one passage from a book, produce THREE outputs: ' +
    '(1) a specific natural-language QUESTION whose answer is in the passage, ' +
    '(2) a short realistic SEARCH QUERY a person might type to find this passage (paraphrased, no distinctive phrases lifted from the text), and ' +
    '(3) a VERBATIM ANSWER SPAN: a contiguous quote copied character-for-character from the passage that fully contains the answer. ' +
    'Questions: specific (referencing concepts, names, or claims in the passage), not generic. Avoid yes/no questions and trivial definition questions. The question must be answerable from the passage alone. ' +
    'Search queries: 3-10 words; the way someone would type into a search box; paraphrase the topic. CRITICAL: do NOT use any 2+ word phrase that appears verbatim in the passage, and avoid distinctive proper nouns or rare terms lifted from the text. ' +
    'Answer span: the smallest contiguous substring of the passage (typically one to three sentences) that fully contains the answer. Copy it EXACTLY — character for character including punctuation, capitalization, and whitespace. Do not paraphrase, splice, or rewrite.'

  const progress: AutoGenerateProgress = { generated: 0, failed: 0, failures: [] }

  for (const chunk of sampled) {
    let lastError: string | null = null
    let avoidPhrases: string[] = []
    let succeeded = false
    interface AttemptRecord {
      attempt: number
      reason: string
      question?: string
      searchQuery?: string
      answerSpan?: string
    }
    const attemptHistory: AttemptRecord[] = []

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        const avoidBlock =
          avoidPhrases.length > 0
            ? `\n\nIMPORTANT: Your previous attempt used these phrases that appear verbatim in the passage. DO NOT use any of them in the search query:\n${avoidPhrases.map((p) => `- "${p}"`).join('\n')}`
            : ''
        const userMsg =
          (bookContext ? `${bookContext}\n\n` : '') +
          `Passage:\n"""\n${chunk.text}\n"""` +
          avoidBlock +
          `\n\nGenerate question, search query, and answer span.`
        const result = await llm.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(userMsg)
        ])

        const located = locateAnswerSpan(chunk.text, result.answerSpan)
        if (!located) {
          lastError = 'Answer span is not a verbatim substring of the passage.'
          attemptHistory.push({
            attempt: attempt + 1,
            reason: lastError,
            question: result.question,
            searchQuery: result.searchQuery,
            answerSpan: result.answerSpan
          })
          continue
        }

        const leaks = findLeakingBigrams(result.searchQuery, chunk.text)
        if (leaks.length > 0) {
          lastError = `Search query leaks phrases from the passage: ${leaks.map((p) => `"${p}"`).join(', ')}`
          avoidPhrases = leaks
          attemptHistory.push({
            attempt: attempt + 1,
            reason: lastError,
            question: result.question,
            searchQuery: result.searchQuery,
            answerSpan: result.answerSpan
          })
          continue
        }

        const goldStart = chunk.textStart + located.offset
        const goldSpan: GoldSpan = {
          spineHref: chunk.spineHref,
          textStart: goldStart,
          textEnd: goldStart + located.length
        }
        const matchedSpan = chunk.text.slice(located.offset, located.offset + located.length)
        const noteParts = [
          `Auto-generated from chunk ${chunk.id}.`,
          `Answer span: ${JSON.stringify(matchedSpan)}`
        ]
        await addCase(
          bookId,
          setId,
          result.question,
          result.searchQuery,
          [goldSpan],
          noteParts.join('\n\n')
        )
        progress.generated += 1
        succeeded = true
        break
      } catch (err) {
        lastError = (err as Error).message
        attemptHistory.push({ attempt: attempt + 1, reason: lastError })
      }
    }

    if (!succeeded) {
      const ipcErr = captureIpcError(
        new Error(lastError ?? 'Unknown failure'),
        'evals:autoGenerate',
        [bookId, setId, strategyId, { failedChunkId: chunk.id }],
        {
          suppressStack: true,
          extras: {
            chunkId: chunk.id,
            chunkText: chunk.text,
            attempts: attemptHistory
          }
        }
      )
      progress.failed += 1
      progress.failures.push({ id: chunk.id, error: ipcErr })
    }
  }

  return progress
}

const backfillSchema = z.object({
  searchQuery: z
    .string()
    .min(1)
    .describe(
      'A short, realistic search-style query (3-10 words) someone might type to find this passage. Paraphrase the topic; do NOT quote distinctive phrases verbatim from the passage.'
    )
})

export async function backfillSearchQueries(
  bookId: string,
  setId: string
): Promise<AutoGenerateProgress> {
  const apiKey = await getOpenaiKey()
  if (!apiKey) throw new Error('OpenAI API key is not set. Add it in Settings.')

  const set = await getEvalSet(bookId, setId)
  const missing = set.cases.filter((c) => !c.searchQuery || !c.searchQuery.trim())

  const progress: AutoGenerateProgress = { generated: 0, failed: 0, failures: [] }
  if (missing.length === 0) return progress

  const manifest = await readManifest(bookId)
  const epubPath = join(bookDir(bookId), 'book.epub')
  const spine = readSpineRaw(epubPath, manifest)
  const textByHref = new Map(spine.map((s) => [s.href, htmlToPlainText(s.rawHtml)]))

  const library = await listLibrary()
  const book = library.find((b) => b.id === bookId)
  const bookContext = book
    ? `Book: "${book.title}"${book.author ? ` by ${book.author}` : ''}`
    : ''

  const llm = new ChatOpenAI({
    model: AUTOGEN_MODEL,
    apiKey,
    temperature: 0.7
  }).withStructuredOutput(backfillSchema)

  const systemPrompt =
    'You are generating realistic search queries for a book retrieval eval. ' +
    'Given a question and the passage that answers it, produce a short SEARCH QUERY (3-10 words) ' +
    'a person might type into a search box to find this passage. ' +
    'Paraphrase: do NOT quote distinctive phrases verbatim from the passage. ' +
    'Use natural search-box vocabulary, not jargon lifted from the text.'

  for (const c of missing) {
    try {
      const passages: string[] = []
      for (const gold of c.goldSpans) {
        const text = textByHref.get(gold.spineHref)
        if (!text) continue
        passages.push(text.slice(gold.textStart, gold.textEnd))
      }
      const passage = passages.join('\n\n---\n\n')
      if (!passage.trim()) {
        throw new Error('Could not resolve gold span text from spine.')
      }

      const userMsg =
        (bookContext ? `${bookContext}\n\n` : '') +
        `Question:\n"""\n${c.question}\n"""\n\n` +
        `Passage that answers it:\n"""\n${passage}\n"""\n\n` +
        `Generate a search query.`
      const result = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userMsg)
      ])

      await updateCase(bookId, setId, c.id, { searchQuery: result.searchQuery })
      progress.generated += 1
    } catch (err) {
      const ipcErr = captureIpcError(err, 'evals:backfillSearchQueries', [
        bookId,
        setId,
        { failedCaseId: c.id }
      ])
      progress.failed += 1
      progress.failures.push({
        id: c.id,
        error: ipcErr
      })
    }
  }

  return progress
}

export async function listEvalRuns(bookId: string): Promise<EvalRunSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(evalRunsDir(bookId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const summaries: EvalRunSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(join(evalRunsDir(bookId), name), 'utf8')
      const run = JSON.parse(raw) as EvalRunResult
      summaries.push({
        id: run.id,
        evalSetId: run.evalSetId,
        strategyId: run.strategyId,
        retrieverId: run.retrieverId ?? 'vector',
        k: run.k,
        ranAt: run.ranAt,
        mode: run.mode ?? 'agentic',
        meanRecallAtK: run.meanRecallAtK,
        meanMRR: run.meanMRR,
        meanCitationPrecision: run.meanCitationPrecision,
        meanCitationRecall: run.meanCitationRecall,
        totalTokens: run.totalTokens,
        caseCount: run.cases.length
      })
    } catch {
      // skip
    }
  }
  return summaries.sort((a, b) => b.ranAt - a.ranAt)
}
