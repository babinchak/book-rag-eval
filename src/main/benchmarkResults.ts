import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { HeadlessRun, HeadlessResultRow } from '../headless/experimentRunner'
import type {
  BenchmarkResultCell,
  BenchmarkRunResults,
  BenchmarkRunSummary
} from '../shared/benchmarkResults'
import type { ExperimentQueryMode } from '../shared/experimentSchema'
import { contentHash } from '../shared/artifactIdentity'

function artifactsRoot(override?: string): string {
  return resolve(
    override ?? process.env.BOOK_RAG_EVAL_ARTIFACTS_DIR ?? join(process.cwd(), '.rag-eval')
  )
}

function runsDir(override?: string): string {
  return join(artifactsRoot(override), 'runs')
}

function assertAllowedRunPath(runPath: string, override?: string): string {
  const root = runsDir(override)
  const absolute = resolve(runPath)
  const child = relative(root, absolute)
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`Experiment run must be inside ${root}`)
  }
  return absolute
}

async function readRun(runPath: string, override?: string): Promise<HeadlessRun> {
  const absolute = assertAllowedRunPath(runPath, override)
  const run = JSON.parse(await fs.readFile(absolute, 'utf8')) as HeadlessRun
  if (!run.fingerprint || !run.plan?.name || !Array.isArray(run.results)) {
    throw new Error(`${absolute} is not a headless experiment run`)
  }
  return run
}

function queryModeOf(row: HeadlessResultRow): ExperimentQueryMode {
  return row.queryMode ?? 'reference'
}

function summaryOf(runPath: string, run: HeadlessRun): BenchmarkRunSummary {
  const caseKeys = [...new Set(run.results.map((row) => `${row.bookId}|${row.caseId}`))].sort()
  const queryModes = [...new Set(run.results.map(queryModeOf))]
  const configuredModes =
    run.results.length === 0
      ? (run.plan as unknown as { queryModes?: ExperimentQueryMode[] }).queryModes
      : undefined
  return {
    runPath,
    fingerprint: run.fingerprint,
    caseSetFingerprint: contentHash(caseKeys),
    name: run.plan.name,
    status: run.status,
    updatedAt: run.updatedAt,
    actualCostUsd: run.ledger.actualCostUsd,
    resultCells: run.results.length,
    uniqueCases: caseKeys.length,
    contextBudgets: [...new Set(run.results.map((row) => row.contextBudget))].sort((a, b) => a - b),
    queryModes: queryModes.length > 0 ? queryModes : (configuredModes ?? ['reference'])
  }
}

export async function listBenchmarkRuns(override?: string): Promise<BenchmarkRunSummary[]> {
  const root = runsDir(override)
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const summaries: BenchmarkRunSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const runPath = join(root, name)
    try {
      summaries.push(summaryOf(runPath, await readRun(runPath, override)))
    } catch {
      // Ignore exports and auxiliary JSON that share the artifact directory.
    }
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function getBenchmarkRunResults(
  runPath: string,
  override?: string
): Promise<BenchmarkRunResults> {
  const absolute = assertAllowedRunPath(runPath, override)
  const run = await readRun(absolute, override)
  const cells: BenchmarkResultCell[] = run.results.map((row) => ({
    bookId: row.bookId,
    caseId: row.caseId,
    strategyId: row.strategyId,
    retriever: row.retriever,
    queryMode: queryModeOf(row),
    retrievalQuery: row.retrievalQuery ?? '',
    contextPolicy: row.contextPolicy ?? { kind: 'chunks' },
    contextBudget: row.contextBudget,
    retrievedChunkIds: row.retrievedChunkIds,
    retrievedTokens: row.retrievedTokens,
    metrics: row.metrics
  }))
  return { run: summaryOf(absolute, run), cells }
}
