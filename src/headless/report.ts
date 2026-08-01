import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { contentHash } from '../shared/artifactIdentity'
import type {
  ExperimentContextPolicy,
  ExperimentQueryMode,
  ExperimentRetriever
} from '../shared/experimentSchema'
import type { EmbeddingModel } from '../preload/types'
import type { VoyageRerankModel } from '../main/reranking'
import type { HeadlessResultRow, HeadlessRun } from './experimentRunner'

type ReportMetric =
  | 'hitAtK'
  | 'mrr'
  | 'ndcgAtK'
  | 'evidenceRecall'
  | 'evidenceEfficiency'
  | 'payloadEvidenceEfficiency'
  | 'contextPrecision'
  | 'exactEvidenceDensity'
  | 'goldSpanCoverage'
  | 'tokensBeforeFirstEvidence'
  | 'tokensToFirstEvidence'
  | 'tokensToFullEvidence'

const REPORT_METRICS: ReportMetric[] = [
  'hitAtK',
  'mrr',
  'ndcgAtK',
  'evidenceRecall',
  'evidenceEfficiency',
  'payloadEvidenceEfficiency',
  'contextPrecision',
  'exactEvidenceDensity',
  'goldSpanCoverage',
  'tokensBeforeFirstEvidence',
  'tokensToFirstEvidence',
  'tokensToFullEvidence'
]

export interface ConfidenceEstimate {
  mean: number | null
  lower95: number | null
  upper95: number | null
  samples: number
}

export interface ReportGroup {
  id: string
  strategyId: string
  retriever: string
  queryMode: ExperimentQueryMode
  contextPolicy: string
  contextBudget: number
  cases: number
  isBaseline: boolean
  metrics: Record<ReportMetric, ConfidenceEstimate>
  evidenceRecallDeltaFromBaseline: ConfidenceEstimate
}

export interface ExperimentReport {
  schemaVersion: 1
  runFingerprint: string
  runStatus: HeadlessRun['status']
  gitCommit: string | null
  workingTreeDiffHash: string | null
  actualCostUsd: number
  resultCells: number
  uniqueCases: number
  bootstrapIterations: number
  embeddingModelCosts: Array<{
    model: EmbeddingModel
    indexTokens: number
    indexCostUsd: number
    queryTokens: number
    queryCostUsd: number
    totalCostUsd: number
  }>
  embeddingIndexCosts: Array<{
    bookId: string
    bookTitle?: string
    strategyId: string
    model: EmbeddingModel
    tokens: number
    costUsd: number
  }>
  rerankerCosts: Array<{
    model: VoyageRerankModel
    tokens: number
    costUsd: number
  }>
  localIndexes: HeadlessRun['ledger']['localIndexes']
  groups: ReportGroup[]
}

function retrieverLabel(retriever: ExperimentRetriever): string {
  const reranker = retriever.reranker ? `+${retriever.reranker.model}` : ''
  switch (retriever.kind) {
    case 'random':
      return `random:seed${retriever.seed}${reranker}`
    case 'bm25':
      return `bm25${reranker}`
    case 'vector':
      return `vector:${retriever.embeddingModel}${reranker}`
    case 'hybrid-rrf':
      return `hybrid-rrf:${retriever.embeddingModel}:k${retriever.rrfK}:v${retriever.vectorWeight ?? 1}:b${retriever.bm25Weight ?? 1}${reranker}`
    case 'colbertv2':
      return `colbertv2:${retriever.model}${reranker}`
    case 'bge-m3':
      return `bge-m3:${retriever.mode}${retriever.mode === 'colbert-dense-shortlist' ? `:top${retriever.shortlist}` : ''}${reranker}`
  }
}

function groupId(row: HeadlessResultRow): string {
  return `${row.strategyId}|${retrieverLabel(row.retriever)}|${row.queryMode ?? 'reference'}|${contextPolicyLabel(row.contextPolicy)}|${row.contextBudget}`
}

function contextPolicyLabel(policy?: ExperimentContextPolicy): string {
  if (!policy || policy.kind === 'chunks') return 'chunks'
  return `neighbors:${policy.window}`
}

function caseId(row: HeadlessResultRow): string {
  return `${row.bookId}|${row.caseId}`
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function seededRandom(seedText: string): () => number {
  let state = Number.parseInt(contentHash(seedText).slice(0, 8), 16) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)))
  return sorted[index]
}

export function bootstrapMean(
  values: number[],
  iterations: number,
  seed: string
): ConfidenceEstimate {
  const point = mean(values)
  if (point === null) {
    return { mean: null, lower95: null, upper95: null, samples: 0 }
  }
  if (values.length === 1 || iterations === 0) {
    return { mean: point, lower95: point, upper95: point, samples: values.length }
  }
  const random = seededRandom(seed)
  const estimates: number[] = []
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0
    for (let sample = 0; sample < values.length; sample++) {
      total += values[Math.floor(random() * values.length)]
    }
    estimates.push(total / values.length)
  }
  estimates.sort((left, right) => left - right)
  return {
    mean: point,
    lower95: percentile(estimates, 0.025),
    upper95: percentile(estimates, 0.975),
    samples: values.length
  }
}

function numericMetric(row: HeadlessResultRow, metric: ReportMetric): number | null {
  const value = row.metrics[metric]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function summarizeRun(run: HeadlessRun, bootstrapIterations = 2000): ExperimentReport {
  if (!Number.isInteger(bootstrapIterations) || bootstrapIterations < 0) {
    throw new Error('bootstrapIterations must be a non-negative integer')
  }
  const rowsByGroup = new Map<string, HeadlessResultRow[]>()
  for (const row of run.results) {
    const id = groupId(row)
    const rows = rowsByGroup.get(id) ?? []
    rows.push(row)
    rowsByGroup.set(id, rows)
  }

  const baselineByRetrieverBudgetAndQuery = new Map<string, HeadlessResultRow[]>()
  for (const row of run.results) {
    const baselineKey = `${retrieverLabel(row.retriever)}|${row.contextBudget}|${row.queryMode ?? 'reference'}|${contextPolicyLabel(row.contextPolicy)}`
    if (!baselineByRetrieverBudgetAndQuery.has(baselineKey)) {
      baselineByRetrieverBudgetAndQuery.set(baselineKey, rowsByGroup.get(groupId(row))!)
    }
  }

  const groups: ReportGroup[] = []
  for (const [id, rows] of rowsByGroup) {
    const first = rows[0]
    const metrics = Object.fromEntries(
      REPORT_METRICS.map((metric) => {
        const values = rows
          .map((row) => numericMetric(row, metric))
          .filter((value): value is number => value !== null)
        return [
          metric,
          bootstrapMean(values, bootstrapIterations, `${run.fingerprint}|${id}|${metric}`)
        ]
      })
    ) as Record<ReportMetric, ConfidenceEstimate>

    const baselineRows =
      baselineByRetrieverBudgetAndQuery.get(
        `${retrieverLabel(first.retriever)}|${first.contextBudget}|${first.queryMode ?? 'reference'}|${contextPolicyLabel(first.contextPolicy)}`
      ) ?? []
    const baseline = new Map(
      baselineRows.flatMap((row) => {
        const value = numericMetric(row, 'evidenceRecall')
        return value === null ? [] : ([[caseId(row), value]] as const)
      })
    )
    const pairedDeltas = rows.flatMap((row) => {
      const value = numericMetric(row, 'evidenceRecall')
      const baselineValue = baseline.get(caseId(row))
      return value === null || baselineValue === undefined ? [] : [value - baselineValue]
    })

    groups.push({
      id,
      strategyId: first.strategyId,
      retriever: retrieverLabel(first.retriever),
      queryMode: first.queryMode ?? 'reference',
      contextPolicy: contextPolicyLabel(first.contextPolicy),
      contextBudget: first.contextBudget,
      cases: new Set(rows.map(caseId)).size,
      isBaseline: baselineRows.length > 0 && groupId(first) === groupId(baselineRows[0]),
      metrics,
      evidenceRecallDeltaFromBaseline: bootstrapMean(
        pairedDeltas,
        bootstrapIterations,
        `${run.fingerprint}|${id}|paired-evidence-recall`
      )
    })
  }

  const embeddingIndexCosts = (run.ledger.indexingByArtifact ?? [])
    .map(({ bookId, strategyId, model, tokens, costUsd }) => ({
      bookId,
      strategyId,
      model,
      tokens,
      costUsd
    }))
    .sort(
      (left, right) =>
        left.model.localeCompare(right.model) ||
        left.bookId.localeCompare(right.bookId) ||
        left.strategyId.localeCompare(right.strategyId)
    )
  const embeddingModelCosts = Object.entries(run.ledger.byModel).map(([model, usage]) => {
    const indexCostUsd = embeddingIndexCosts
      .filter((item) => item.model === model)
      .reduce((total, item) => total + item.costUsd, 0)
    return {
      model: model as EmbeddingModel,
      indexTokens: usage!.indexTokens,
      indexCostUsd,
      queryTokens: usage!.queryTokens,
      queryCostUsd: usage!.costUsd - indexCostUsd,
      totalCostUsd: usage!.costUsd
    }
  })
  const rerankerCosts = Object.entries(run.ledger.byReranker ?? {}).map(([model, usage]) => ({
    model: model as VoyageRerankModel,
    tokens: usage!.tokens,
    costUsd: usage!.costUsd
  }))
  return {
    schemaVersion: 1,
    runFingerprint: run.fingerprint,
    runStatus: run.status,
    gitCommit: run.plan.sourceControl.gitCommit,
    workingTreeDiffHash: run.plan.sourceControl.workingTreeDiffHash,
    actualCostUsd: run.ledger.actualCostUsd,
    resultCells: run.results.length,
    uniqueCases: new Set(run.results.map(caseId)).size,
    bootstrapIterations,
    embeddingModelCosts,
    embeddingIndexCosts,
    rerankerCosts,
    localIndexes: run.ledger.localIndexes ?? [],
    groups: groups.sort(
      (left, right) =>
        left.contextBudget - right.contextBudget ||
        left.queryMode.localeCompare(right.queryMode) ||
        left.contextPolicy.localeCompare(right.contextPolicy) ||
        left.retriever.localeCompare(right.retriever) ||
        left.strategyId.localeCompare(right.strategyId)
    )
  }
}

function fixed(value: number | null, digits = 3): string {
  return value === null ? 'N/A' : value.toFixed(digits)
}

function estimateCell(estimate: ConfidenceEstimate): string {
  if (estimate.mean === null) return 'N/A'
  return `${fixed(estimate.mean)} [${fixed(estimate.lower95)}, ${fixed(estimate.upper95)}]`
}

export function reportMarkdown(report: ExperimentReport): string {
  const lines = [
    '# Retrieval experiment report',
    '',
    `- Run: \`${report.runFingerprint}\` (${report.runStatus})`,
    `- Git commit: ${report.gitCommit ? `\`${report.gitCommit}\`` : 'unavailable'}`,
    `- Tracked diff: ${report.workingTreeDiffHash ? `\`${report.workingTreeDiffHash}\`` : 'none'}`,
    `- Cases: ${report.uniqueCases}; result cells: ${report.resultCells}`,
    `- Metered API cost (tokens × pinned rate): $${report.actualCostUsd.toFixed(6)}`,
    `- Intervals: deterministic paired/nonparametric bootstrap, ${report.bootstrapIterations} iterations`,
    ''
  ]
  if (report.embeddingIndexCosts.length > 0) {
    lines.push(
      '## Embedding cost summary',
      '',
      '| Model | Document tokens | Document cost | Query tokens | Query cost | Total |',
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    )
    for (const item of report.embeddingModelCosts) {
      lines.push(
        `| ${item.model} | ${item.indexTokens.toLocaleString('en-US')} | $${item.indexCostUsd.toFixed(6)} | ${item.queryTokens.toLocaleString('en-US')} | $${item.queryCostUsd.toFixed(6)} | $${item.totalCostUsd.toFixed(6)} |`
      )
    }
    lines.push(
      '',
      '## Document embedding cost by artifact',
      '',
      '| Book | Chunking strategy | Model | Tokens | Nominal cost |',
      '| --- | --- | --- | ---: | ---: |'
    )
    for (const item of report.embeddingIndexCosts) {
      lines.push(
        `| ${item.bookTitle ?? item.bookId} | ${item.strategyId} | ${item.model} | ${item.tokens.toLocaleString('en-US')} | $${item.costUsd.toFixed(6)} |`
      )
    }
    lines.push('')
  }
  if (report.rerankerCosts.length > 0) {
    lines.push(
      '## Reranking cost summary',
      '',
      '| Model | Processed tokens | Nominal cost |',
      '| --- | ---: | ---: |'
    )
    for (const item of report.rerankerCosts) {
      lines.push(
        `| ${item.model} | ${item.tokens.toLocaleString('en-US')} | $${item.costUsd.toFixed(6)} |`
      )
    }
    lines.push('')
  }
  if (report.localIndexes.length > 0) {
    lines.push(
      '## Local index summary',
      '',
      '| Family | Model | Book | Chunking strategy | Build time | Storage |',
      '| --- | --- | --- | --- | ---: | ---: |'
    )
    for (const item of report.localIndexes) {
      lines.push(
        `| ${item.kind} | ${item.model} | ${item.bookId} | ${item.strategyId} | ${(item.indexingLatencyMs / 1000).toFixed(2)}s | ${(item.storageBytes / 1024 / 1024).toFixed(2)} MiB |`
      )
    }
    lines.push('')
  }
  lines.push(
    'Values are means with 95% bootstrap intervals. Δ recall is paired against the first configured strategy at the same context budget and query mode.',
    '',
    '| Budget | Query | Context | Strategy | Retriever | Evidence efficiency | Payload efficiency | Hit | MRR | nDCG | Evidence recall | Δ recall | Evidence density | Item precision | Tokens to first | Tokens to full |',
    '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  )
  for (const group of report.groups) {
    const strategy = group.isBaseline ? `${group.strategyId} (baseline)` : group.strategyId
    lines.push(
      `| ${group.contextBudget} | ${group.queryMode} | ${group.contextPolicy} | \`${strategy}\` | \`${group.retriever}\` | ${estimateCell(group.metrics.evidenceEfficiency)} | ${estimateCell(group.metrics.payloadEvidenceEfficiency)} | ${estimateCell(group.metrics.hitAtK)} | ${estimateCell(group.metrics.mrr)} | ${estimateCell(group.metrics.ndcgAtK)} | ${estimateCell(group.metrics.evidenceRecall)} | ${estimateCell(group.evidenceRecallDeltaFromBaseline)} | ${estimateCell(group.metrics.exactEvidenceDensity)} | ${estimateCell(group.metrics.contextPrecision)} | ${estimateCell(group.metrics.tokensToFirstEvidence)} | ${estimateCell(group.metrics.tokensToFullEvidence)} |`
    )
  }
  return `${lines.join('\n')}\n`
}

export async function writeRunReport(
  runPath: string,
  outputPath?: string,
  bootstrapIterations = 2000
): Promise<{ markdownPath: string; summaryPath: string }> {
  const absoluteRunPath = resolve(runPath)
  const run = JSON.parse(await fs.readFile(absoluteRunPath, 'utf8')) as HeadlessRun
  const report = summarizeRun(run, bootstrapIterations)
  const titles = new Map<string, string>()
  await Promise.all(
    [...new Set(report.embeddingIndexCosts.map((item) => item.bookId))].map(async (bookId) => {
      try {
        const manifest = JSON.parse(
          await fs.readFile(join(run.plan.libraryDir, bookId, 'manifest.json'), 'utf8')
        ) as { metadata?: { title?: string } }
        if (manifest.metadata?.title) titles.set(bookId, manifest.metadata.title)
      } catch {
        // A portable run may be reported without its original library.
      }
    })
  )
  for (const item of report.embeddingIndexCosts) item.bookTitle = titles.get(item.bookId)
  const markdownPath = resolve(outputPath ?? absoluteRunPath.replace(/\.json$/i, '.report.md'))
  const summaryPath = markdownPath.replace(/\.md$/i, '.json')
  await fs.mkdir(dirname(markdownPath), { recursive: true })
  await Promise.all([
    fs.writeFile(markdownPath, reportMarkdown(report), 'utf8'),
    fs.writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  ])
  return { markdownPath, summaryPath }
}
