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
  goldSpans: GoldSpan[],
  notes?: string
): Promise<EvalCase> {
  const trimmed = question.trim()
  if (!trimmed) throw new Error('Question is required')
  if (goldSpans.length === 0) throw new Error('At least one gold span is required')
  const set = await getEvalSet(bookId, setId)
  const newCase: EvalCase = {
    id: randomUUID(),
    question: trimmed,
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
  updates: { question?: string; goldSpans?: GoldSpan[]; notes?: string }
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

  let goldSpans = existing.goldSpans
  if (updates.goldSpans !== undefined) {
    if (updates.goldSpans.length === 0) throw new Error('At least one gold span is required')
    goldSpans = updates.goldSpans
  }

  const updated: EvalCase = {
    ...existing,
    question,
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
      const retrieved = await retrieve(bookId, strategyId, c.question, k)
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
        retrieved: details,
        recallAtK,
        mrr,
        hitRank: firstHitRank
      })

      totalRecall += recallAtK
      totalMRR += mrr
    } else {
      const agentResult = await ask(bookId, strategyId, c.question, k)
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
const AUTOGEN_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

const generatedCaseSchema = z.object({
  question: z
    .string()
    .min(5)
    .describe('A specific question whose answer is found in the passage.'),
  answerHint: z
    .string()
    .optional()
    .describe('One short sentence summarizing or quoting where the answer appears in the passage.')
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
  const eligible: Chunk[] = chunkSet.chunks.filter(
    (c) => c.text.length >= MIN_AUTOGEN_CHUNK_CHARS
  )
  if (eligible.length === 0) {
    throw new Error(
      `Strategy "${strategyId}" has no chunks long enough (>= ${MIN_AUTOGEN_CHUNK_CHARS} chars).`
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
    'You are helping create evaluation questions for a book retrieval system. ' +
    'Given one passage from a book, generate ONE question whose answer is found in this passage. ' +
    'The question should be specific (referencing concepts, names, or claims actually in the passage), not generic. ' +
    'Avoid yes/no questions. Avoid trivial definition questions. ' +
    'The question must be answerable from the passage alone.'

  const progress: AutoGenerateProgress = { generated: 0, failed: 0, failures: [] }

  for (const chunk of sampled) {
    try {
      const userMsg =
        (bookContext ? `${bookContext}\n\n` : '') +
        `Passage:\n"""\n${chunk.text}\n"""\n\nGenerate one evaluation question.`
      const result = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userMsg)
      ])
      const goldSpan: GoldSpan = {
        spineHref: chunk.spineHref,
        textStart: chunk.textStart,
        textEnd: chunk.textEnd
      }
      const noteParts = [`Auto-generated from chunk ${chunk.id}.`]
      if (result.answerHint) noteParts.push(`Answer hint: ${result.answerHint}`)
      await addCase(bookId, setId, result.question, [goldSpan], noteParts.join('\n\n'))
      progress.generated += 1
    } catch (err) {
      progress.failed += 1
      progress.failures.push({
        chunkId: chunk.id,
        error: (err as Error).message
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
        k: run.k,
        ranAt: run.ranAt,
        mode: run.mode ?? 'agentic',
        meanRecallAtK: run.meanRecallAtK,
        meanMRR: run.meanMRR,
        meanCitationPrecision: run.meanCitationPrecision,
        meanCitationRecall: run.meanCitationRecall,
        caseCount: run.cases.length
      })
    } catch {
      // skip
    }
  }
  return summaries.sort((a, b) => b.ranAt - a.ranAt)
}
