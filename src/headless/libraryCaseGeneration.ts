import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { getOpenaiKey } from '../main/settings'
import { contentHash } from '../shared/artifactIdentity'
import {
  compatibilityGoldSpans,
  parseEvalSet,
  type BenchmarkEvalCase,
  type BenchmarkEvalSet,
  type GoldEvidence
} from '../shared/evalSchema'

const generatedSchema = z.object({
  question: z.string().min(15),
  canonicalSearchQuery: z.string().min(3),
  referenceAnswer: z.string().min(3),
  tags: z.array(z.string().min(1)).min(1),
  difficulty: z.enum(['easy', 'medium', 'hard'])
})

interface CorpusBook {
  bookId: string
  title: string
  author: string
}

interface SourceCase {
  book: CorpusBook
  evalCase: BenchmarkEvalCase
}

interface GenerationTask {
  id: string
  kind: 'attributed' | 'discovery' | 'comparative'
  primaryBookId: string
  sources: SourceCase[]
}

interface GeneratedRecord {
  taskId: string
  generated: z.infer<typeof generatedSchema>
  inputTokens: number
  outputTokens: number
  costUsd: number
  resolvedModel?: string
}

interface LibraryCaseGenerationRun {
  schemaVersion: 1
  status: 'running' | 'completed' | 'failed'
  name: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  maxUsd: number
  corpusPath: string
  sourceEvalDir: string
  outputEvalDir: string
  model: string
  tasks: GenerationTask[]
  records: GeneratedRecord[]
  ledger: { inputTokens: number; outputTokens: number; actualCostUsd: number; requests: number }
  error?: string
}

const SYSTEM_PROMPT = `You author natural questions for a retrieval benchmark over a six-book philosophy library.

Return one question, a short diagnostic search query, a concise reference answer, tags, and difficulty.

For an attributed task, name the supplied author or work naturally so the question makes sense when asked over the whole library.
For a discovery task, do not name the author or title. Ask which thinker or work advances the supplied position, while keeping the information need specific enough to be answerable from the supplied evidence.
For a comparative task, ask for a meaningful comparison using both supplied positions. The answer must require both sources; do not pretend the sources discuss each other.

Do not mention excerpts, source records, retrieval, benchmark machinery, or hidden context. Do not turn the diagnostic search query into a verbatim quotation. Preserve the factual meaning of every supplied source.`

function overlapScore(left: BenchmarkEvalCase, right: BenchmarkEvalCase): number {
  const rightTags = new Set(right.tags.map((tag) => tag.toLowerCase()))
  return left.tags.reduce((score, tag) => score + (rightTags.has(tag.toLowerCase()) ? 1 : 0), 0)
}

function sourceText(source: SourceCase): object {
  return {
    book: source.book.title,
    author: source.book.author,
    originalQuestion: source.evalCase.question,
    referenceAnswer: source.evalCase.referenceAnswers?.[0] ?? '',
    tags: source.evalCase.tags
  }
}

function taskPrompt(task: GenerationTask): string {
  return JSON.stringify({ task: task.kind, sources: task.sources.map(sourceText) }, null, 2)
}

function selectTasks(books: CorpusBook[], casesByBook: Map<string, BenchmarkEvalCase[]>): GenerationTask[] {
  const tasks: GenerationTask[] = []
  const used = new Map<string, Set<string>>()
  for (const book of books) {
    const candidates = [...(casesByBook.get(book.bookId) ?? [])]
      .filter((item) => item.goldEvidence.every((evidence) => evidence.kind === 'text'))
      .sort((a, b) => contentHash(a.id).localeCompare(contentHash(b.id)))
    used.set(book.bookId, new Set())
    for (let index = 0; index < 7; index++) {
      const source = candidates[index]
      if (!source) throw new Error(`Not enough text cases for ${book.title}`)
      used.get(book.bookId)!.add(source.id)
      const kind = index < 4 ? 'attributed' : 'discovery'
      tasks.push({
        id: `${kind}-${book.bookId.slice(0, 8)}-${index + 1}`,
        kind,
        primaryBookId: book.bookId,
        sources: [{ book, evalCase: source }]
      })
    }
  }

  const pairs: Array<[CorpusBook, CorpusBook]> = []
  for (let left = 0; left < books.length; left++) {
    for (let right = left + 1; right < books.length; right++) pairs.push([books[left], books[right]])
  }
  const expandedPairs = [...pairs, ...pairs.slice(0, 3)]
  expandedPairs.forEach(([leftBook, rightBook], pairIndex) => {
    const leftCases = (casesByBook.get(leftBook.bookId) ?? []).filter(
      (item) => item.goldEvidence.every((evidence) => evidence.kind === 'text') && !used.get(leftBook.bookId)!.has(item.id)
    )
    const rightCases = (casesByBook.get(rightBook.bookId) ?? []).filter(
      (item) => item.goldEvidence.every((evidence) => evidence.kind === 'text') && !used.get(rightBook.bookId)!.has(item.id)
    )
    const candidates = leftCases.flatMap((left) =>
      rightCases.map((right) => ({ left, right, score: overlapScore(left, right) }))
    )
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        contentHash(`${a.left.id}|${a.right.id}|${pairIndex}`).localeCompare(
          contentHash(`${b.left.id}|${b.right.id}|${pairIndex}`)
        )
    )
    const selected = candidates[0]
    if (!selected) throw new Error(`No comparison candidates for ${leftBook.title}/${rightBook.title}`)
    used.get(leftBook.bookId)!.add(selected.left.id)
    used.get(rightBook.bookId)!.add(selected.right.id)
    tasks.push({
      id: `comparative-${pairIndex + 1}-${leftBook.bookId.slice(0, 5)}-${rightBook.bookId.slice(0, 5)}`,
      kind: 'comparative',
      primaryBookId: leftBook.bookId,
      sources: [
        { book: leftBook, evalCase: selected.left },
        { book: rightBook, evalCase: selected.right }
      ]
    })
  })
  if (tasks.length !== 60) throw new Error(`Expected 60 tasks, got ${tasks.length}`)
  return tasks
}

function evidenceFor(task: GenerationTask): GoldEvidence[] {
  return task.sources.flatMap((source, sourceIndex) =>
    source.evalCase.goldEvidence.map((evidence, evidenceIndex) => ({
      ...evidence,
      id: `evidence-${sourceIndex + 1}-${evidenceIndex + 1}`,
      requirementId: `required-source-${sourceIndex + 1}`
    }))
  )
}

function evalCaseFor(task: GenerationTask, record: GeneratedRecord, promptHash: string): BenchmarkEvalCase {
  const goldEvidence = evidenceFor(task)
  return {
    id: `library-case-${contentHash(task.id).slice(0, 20)}`,
    question: record.generated.question,
    canonicalSearchQuery: record.generated.canonicalSearchQuery,
    scope: 'library',
    answerability: 'answerable',
    goldEvidence,
    tags: [...new Set([task.kind, ...record.generated.tags])],
    difficulty: record.generated.difficulty,
    split: 'dev',
    provenance: {
      kind: 'llm_assisted',
      source: task.sources.map((source) => source.evalCase.id).join(','),
      model: record.resolvedModel ?? 'gpt-4o-mini',
      promptHash
    },
    referenceAnswers: [record.generated.referenceAnswer],
    notes: 'PROVISIONAL UNREVIEWED six-book library-wide development case.',
    searchQuery: record.generated.canonicalSearchQuery,
    goldSpans: compatibilityGoldSpans(goldEvidence)
  }
}

export async function generateLibraryCases(options: {
  corpusPath: string
  sourceEvalDir: string
  outputEvalDir: string
  runPath: string
  maxUsd: number
}): Promise<LibraryCaseGenerationRun> {
  const corpusPath = resolve(options.corpusPath)
  const sourceEvalDir = resolve(options.sourceEvalDir)
  const outputEvalDir = resolve(options.outputEvalDir)
  const runPath = resolve(options.runPath)
  const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8')) as { books: CorpusBook[] }
  const casesByBook = new Map<string, BenchmarkEvalCase[]>()
  for (const book of corpus.books) {
    const evalSet = parseEvalSet(
      JSON.parse(await fs.readFile(join(sourceEvalDir, `${book.bookId}.json`), 'utf8')),
      book.bookId
    )
    casesByBook.set(book.bookId, evalSet.cases)
  }
  const tasks = selectTasks(corpus.books, casesByBook)
  let run: LibraryCaseGenerationRun
  try {
    run = JSON.parse(await fs.readFile(runPath, 'utf8')) as LibraryCaseGenerationRun
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    run = {
      schemaVersion: 1,
      status: 'running',
      name: 'six-book-library-cases-v1',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      maxUsd: options.maxUsd,
      corpusPath,
      sourceEvalDir,
      outputEvalDir,
      model: 'gpt-4o-mini',
      tasks,
      records: [],
      ledger: { inputTokens: 0, outputTokens: 0, actualCostUsd: 0, requests: 0 }
    }
  }
  const apiKey = await getOpenaiKey()
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')
  const model = new ChatOpenAI({ model: run.model, apiKey, maxTokens: 400 }).withStructuredOutput(
    generatedSchema,
    { name: 'library_wide_eval_case', includeRaw: true }
  )
  const promptHash = contentHash(SYSTEM_PROMPT)
  try {
    for (const task of tasks) {
      if (run.records.some((record) => record.taskId === task.id)) continue
      const response = (await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(taskPrompt(task))
      ])) as unknown as {
        parsed: unknown
        raw?: {
          usage_metadata?: { input_tokens?: number; output_tokens?: number }
          response_metadata?: { model_name?: string; model?: string }
        }
      }
      const generated = generatedSchema.parse(response.parsed)
      const inputTokens = response.raw?.usage_metadata?.input_tokens
      const outputTokens = response.raw?.usage_metadata?.output_tokens
      if (inputTokens === undefined || outputTokens === undefined) throw new Error('Unmetered model response')
      const costUsd = (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.6
      if (run.ledger.actualCostUsd + costUsd > options.maxUsd) throw new Error('Generation cost ceiling would be exceeded')
      run.records.push({
        taskId: task.id,
        generated,
        inputTokens,
        outputTokens,
        costUsd,
        resolvedModel: response.raw?.response_metadata?.model_name ?? response.raw?.response_metadata?.model
      })
      run.ledger.inputTokens += inputTokens
      run.ledger.outputTokens += outputTokens
      run.ledger.actualCostUsd += costUsd
      run.ledger.requests += 1
      run.updatedAt = Date.now()
      await fs.mkdir(dirname(runPath), { recursive: true })
      await fs.writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
    }
    const records = new Map(run.records.map((record) => [record.taskId, record]))
    const now = Date.now()
    await fs.mkdir(outputEvalDir, { recursive: true })
    for (const book of corpus.books) {
      const bookCases = tasks
        .filter((task) => task.primaryBookId === book.bookId)
        .map((task) => evalCaseFor(task, records.get(task.id)!, promptHash))
      const evalSet: BenchmarkEvalSet = {
        schemaVersion: 2,
        id: `six-book-library-v1-provisional-${book.bookId.slice(0, 12)}`,
        bookId: book.bookId,
        cases: bookCases,
        createdAt: now,
        updatedAt: now
      }
      parseEvalSet(evalSet, book.bookId)
      await fs.writeFile(join(outputEvalDir, `${book.bookId}.json`), `${JSON.stringify(evalSet, null, 2)}\n`, 'utf8')
    }
    run.status = 'completed'
    run.completedAt = Date.now()
    run.updatedAt = run.completedAt
    await fs.writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
    return run
  } catch (error) {
    run.status = 'failed'
    run.error = (error as Error).message
    run.updatedAt = Date.now()
    await fs.mkdir(dirname(runPath), { recursive: true })
    await fs.writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
    throw error
  }
}
