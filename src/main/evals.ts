import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bookDir } from './library'
import { readSpineRaw } from './epub'
import { ask } from './retrieval'
import type {
  EvalCase,
  EvalCaseResult,
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
  k: number
): Promise<EvalRunResult> {
  const set = await getEvalSet(bookId, setId)
  if (set.cases.length === 0) {
    throw new Error('Eval set has no cases. Add cases before running.')
  }

  const caseResults: EvalCaseResult[] = []
  let totalRecall = 0
  let totalMRR = 0
  let totalCitPrec = 0
  let totalCitRec = 0
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalTokens = 0

  for (const c of set.cases) {
    const agentResult = await ask(bookId, strategyId, c.question, k)
    const retrieved = agentResult.retrieved

    // Retrieval metrics: based on what the agent actually retrieved (deduped across tool calls)
    let firstHitRank: number | null = null
    const details: RetrievedDetail[] = retrieved.map((r) => {
      const overlap = computeOverlap(r.chunk, c.goldSpans)
      const hit = overlap > 0
      if (hit && firstHitRank === null) firstHitRank = r.rank
      return {
        chunkId: r.chunk.id,
        distance: r.distance,
        hit,
        overlap,
        rank: r.rank
      }
    })
    const recallAtK = firstHitRank !== null ? 1 : 0
    const mrr = firstHitRank !== null ? 1 / firstHitRank : 0

    // Citation metrics: parse [N] from answer, look up retrieved[N-1]
    const citedRanks = parseCitations(agentResult.answer)
    const byRank = new Map<number, RetrievedChunkPayload>()
    for (const r of retrieved) byRank.set(r.rank, r)
    const citedDetails: RetrievedChunkPayload[] = []
    for (const rank of citedRanks) {
      const r = byRank.get(rank)
      if (r) citedDetails.push(r)
    }
    const citedChunkIds = citedDetails.map((r) => r.chunk.id)
    const citedHits = citedDetails.filter(
      (r) => computeOverlap(r.chunk, c.goldSpans) > 0
    )
    const totalGoldOverlapping = retrieved.filter(
      (r) => computeOverlap(r.chunk, c.goldSpans) > 0
    ).length
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

  const n = set.cases.length
  const result: EvalRunResult = {
    id: randomUUID(),
    bookId,
    evalSetId: setId,
    strategyId,
    k,
    ranAt: Date.now(),
    meanRecallAtK: totalRecall / n,
    meanMRR: totalMRR / n,
    meanCitationPrecision: totalCitPrec / n,
    meanCitationRecall: totalCitRec / n,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    cases: caseResults
  }
  await writeJsonAtomic(evalRunPath(bookId, result.id), result)
  return result
}

export async function getEvalRun(bookId: string, runId: string): Promise<EvalRunResult> {
  const raw = await fs.readFile(evalRunPath(bookId, runId), 'utf8')
  return JSON.parse(raw) as EvalRunResult
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
