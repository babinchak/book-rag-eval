import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RetrievalMetrics } from '../shared/evalMetrics'
import type { ExperimentContextPolicy, ExperimentRetriever } from '../shared/experimentSchema'
import type { HeadlessResultRow, HeadlessRun } from './experimentRunner'

interface TournamentPoint {
  budget: number
  cases: number
  evidenceEfficiency: number | null
  payloadEvidenceEfficiency: number | null
  evidenceRecall: number | null
  mrr: number | null
  tokensToFirstEvidence: number | null
}

interface TournamentStrategy {
  id: string
  label: string
  strategyId: string
  retriever: ExperimentRetriever
  queryMode: string
  contextPolicy: ExperimentContextPolicy
  sourceRun: string
  curve: TournamentPoint[]
}

export interface TournamentReport {
  schemaVersion: 1
  provisional: true
  metricVersion: number
  caseSet: string[]
  headlineBudget: number
  compatibleRuns: Array<{
    path: string
    name: string
    costUsd: number
    resultCells: number
  }>
  totalMeteredCostUsd: number
  runDirectoryMeteredCostUsd: number
  strategies: TournamentStrategy[]
}

function contextPolicy(row: HeadlessResultRow): ExperimentContextPolicy {
  return row.contextPolicy ?? { kind: 'chunks' }
}

function retrieverLabel(retriever: ExperimentRetriever): string {
  const reranker = retriever.reranker ? ` + ${retriever.reranker.model}` : ''
  if (retriever.kind === 'random') return `Random seed ${retriever.seed}${reranker}`
  if (retriever.kind === 'bm25') return `BM25${reranker}`
  if (retriever.kind === 'vector') return `Vector ${retriever.embeddingModel}${reranker}`
  if (retriever.kind === 'hybrid-rrf') {
    return `Hybrid ${retriever.embeddingModel} v${retriever.vectorWeight ?? 1}:b${retriever.bm25Weight ?? 1}${reranker}`
  }
  if (retriever.kind === 'colbertv2') return `ColBERTv2${reranker}`
  return `BGE-M3 ${retriever.mode}${reranker}`
}

function contextLabel(policy: ExperimentContextPolicy): string {
  return policy.kind === 'chunks' ? '' : ` + ±${policy.window} neighbor`
}

function strategyKey(row: HeadlessResultRow): string {
  return JSON.stringify({
    strategyId: row.strategyId,
    retriever: row.retriever,
    queryMode: row.queryMode ?? 'reference',
    contextPolicy: contextPolicy(row)
  })
}

function finiteMean(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value)
  )
  return finite.length === 0
    ? null
    : finite.reduce((total, value) => total + value, 0) / finite.length
}

function point(rows: HeadlessResultRow[], budget: number): TournamentPoint {
  const selected = rows.filter((row) => row.contextBudget === budget)
  const metric = <K extends keyof Omit<RetrievalMetrics, 'candidateRelevance'>>(name: K) =>
    finiteMean(selected.map((row) => row.metrics[name] as number | null | undefined))
  return {
    budget,
    cases: new Set(selected.map((row) => `${row.bookId}|${row.caseId}`)).size,
    evidenceEfficiency: metric('evidenceEfficiency'),
    payloadEvidenceEfficiency: metric('payloadEvidenceEfficiency'),
    evidenceRecall: metric('evidenceRecall'),
    mrr: metric('mrr'),
    tokensToFirstEvidence: metric('tokensToFirstEvidence')
  }
}

async function readRuns(targetPath: string): Promise<{
  compatible: Array<{ path: string; run: HeadlessRun }>
  allCompleted: Array<{ path: string; run: HeadlessRun }>
}> {
  const target = JSON.parse(await fs.readFile(targetPath, 'utf8')) as HeadlessRun
  const targetCases = [...new Set(target.results.map((row) => `${row.bookId}|${row.caseId}`))].sort()
  const targetCaseKey = JSON.stringify(targetCases)
  const names = await fs.readdir(dirname(targetPath))
  const compatible: Array<{ path: string; run: HeadlessRun }> = []
  const allCompleted: Array<{ path: string; run: HeadlessRun }> = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.report.json')) continue
    const path = join(dirname(targetPath), name)
    try {
      const run = JSON.parse(await fs.readFile(path, 'utf8')) as HeadlessRun
      if (
        run.status !== 'completed' ||
        !Array.isArray(run.results)
      ) {
        continue
      }
      allCompleted.push({ path, run })
      if ((run.metricVersion ?? 1) !== (target.metricVersion ?? 1)) continue
      const cases = [...new Set(run.results.map((row) => `${row.bookId}|${row.caseId}`))].sort()
      if (JSON.stringify(cases) === targetCaseKey) compatible.push({ path, run })
    } catch {
      // Auxiliary JSON files may share the runs directory.
    }
  }
  return {
    compatible: compatible.sort((left, right) => left.run.updatedAt - right.run.updatedAt),
    allCompleted
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;'
    }
    return replacements[character]
  })
}

function svgFor(strategies: TournamentStrategy[], headlineBudget: number): string {
  const width = 1200
  const height = 680
  const left = 72
  const top = 36
  const plotWidth = 760
  const plotHeight = 560
  const budgets = [...new Set(strategies.flatMap((strategy) => strategy.curve.map((p) => p.budget)))].sort(
    (a, b) => a - b
  )
  const colors = ['#0b6e4f', '#1976d2', '#b55d00', '#8e44ad', '#c62828', '#00838f', '#5d6d1d', '#6d4c41', '#455a64', '#ad1457', '#2e7d32', '#283593']
  const x = (budget: number) => left + (budgets.indexOf(budget) / Math.max(1, budgets.length - 1)) * plotWidth
  const y = (value: number) => top + (1 - value) * plotHeight
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<text x="${left}" y="22" font-family="sans-serif" font-size="16" font-weight="700">Evidence Efficiency curve (headline ${headlineBudget.toLocaleString()} tokens)</text>`
  ]
  for (let tick = 0; tick <= 10; tick++) {
    const value = tick / 10
    const py = y(value)
    lines.push(
      `<line x1="${left}" y1="${py}" x2="${left + plotWidth}" y2="${py}" stroke="#e7e7e7"/>`,
      `<text x="${left - 10}" y="${py + 4}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#555">${value.toFixed(1)}</text>`
    )
  }
  budgets.forEach((budget) => {
    const px = x(budget)
    lines.push(
      `<line x1="${px}" y1="${top}" x2="${px}" y2="${top + plotHeight}" stroke="#f1f1f1"/>`,
      `<text x="${px}" y="${top + plotHeight + 22}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">${budget.toLocaleString()}</text>`
    )
  })
  strategies.forEach((strategy, index) => {
    const color = colors[index % colors.length]
    const points = strategy.curve
      .filter((item): item is TournamentPoint & { evidenceEfficiency: number } => item.evidenceEfficiency !== null)
      .map((item) => `${x(item.budget)},${y(item.evidenceEfficiency)}`)
      .join(' ')
    lines.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5"/>`)
    strategy.curve.forEach((item) => {
      if (item.evidenceEfficiency !== null) {
        lines.push(`<circle cx="${x(item.budget)}" cy="${y(item.evidenceEfficiency)}" r="3" fill="${color}"/>`)
      }
    })
    const legendY = top + index * 43
    lines.push(
      `<line x1="860" y1="${legendY}" x2="886" y2="${legendY}" stroke="${color}" stroke-width="3"/>`,
      `<text x="894" y="${legendY + 4}" font-family="sans-serif" font-size="11" fill="#222">${escapeXml(strategy.label.slice(0, 54))}</text>`
    )
  })
  lines.push('</svg>')
  return `${lines.join('\n')}\n`
}

function fixed(value: number | null, digits = 4): string {
  return value === null ? 'N/A' : value.toFixed(digits)
}

function markdownFor(report: TournamentReport, topStrategies: TournamentStrategy[], svgName: string): string {
  const lines = [
    '# Six-book retrieval tournament',
    '',
    '> Development result: the questions and evidence are provisional and unreviewed. Do not present these values as a locked benchmark.',
    '',
    `- Cases: ${report.caseSet.length}`,
    `- Headline: Evidence Efficiency @ ${report.headlineBudget.toLocaleString()} tokens`,
    `- Compatible completed runs: ${report.compatibleRuns.length}`,
    `- Metered API cost in compatible scoring runs: $${report.totalMeteredCostUsd.toFixed(6)}`,
    `- Cumulative metered API cost in the run directory (including earlier artifact-building runs): $${report.runDirectoryMeteredCostUsd.toFixed(6)}`,
    '',
    `![Evidence Efficiency curves](${svgName})`,
    '',
    '## Headline leaderboard',
    '',
    '| Rank | Chunking | Retrieval pipeline | EE | Payload EE | Recall | MRR | Tokens to first | Source run |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  ]
  topStrategies.forEach((strategy, index) => {
    const headline = strategy.curve.find((item) => item.budget === report.headlineBudget)!
    lines.push(
      `| ${index + 1} | ${strategy.strategyId} | ${strategy.label} | ${fixed(headline.evidenceEfficiency)} | ${fixed(headline.payloadEvidenceEfficiency)} | ${fixed(headline.evidenceRecall)} | ${fixed(headline.mrr)} | ${fixed(headline.tokensToFirstEvidence, 1)} | ${basename(strategy.sourceRun)} |`
    )
  })
  lines.push(
    '',
    '## Cost ledger by run',
    '',
    '| Run | Result cells | Metered API cost |',
    '| --- | ---: | ---: |'
  )
  for (const run of report.compatibleRuns) {
    lines.push(`| ${run.name} | ${run.resultCells.toLocaleString()} | $${run.costUsd.toFixed(6)} |`)
  }
  lines.push(
    '',
    'Evidence Efficiency rewards finding all required evidence early within a token budget. Payload EE additionally penalizes unused/noisy context after the evidence. Recall and MRR remain visible so the composite score never hides basic retrieval behavior.',
    ''
  )
  return `${lines.join('\n')}\n`
}

export async function writeTournamentReport(
  targetRunPath: string,
  outputPath?: string,
  headlineBudget = 8192,
  top = 12
): Promise<{ markdownPath: string; jsonPath: string; svgPath: string; strategies: number }> {
  if (!Number.isInteger(headlineBudget) || headlineBudget <= 0) throw new Error('--budget must be positive')
  if (!Number.isInteger(top) || top <= 0) throw new Error('--top must be positive')
  const target = resolve(targetRunPath)
  const { compatible, allCompleted } = await readRuns(target)
  const targetRun = compatible.find((item) => item.path === target)?.run
  if (!targetRun) throw new Error('Target run is not a compatible completed run')

  const latestRows = new Map<string, { row: HeadlessResultRow; runPath: string }>()
  for (const { path, run } of compatible) {
    for (const row of run.results) {
      const key = `${strategyKey(row)}|${row.contextBudget}|${row.bookId}|${row.caseId}`
      latestRows.set(key, { row, runPath: path })
    }
  }
  const byStrategy = new Map<string, Array<{ row: HeadlessResultRow; runPath: string }>>()
  for (const item of latestRows.values()) {
    const key = strategyKey(item.row)
    const rows = byStrategy.get(key) ?? []
    rows.push(item)
    byStrategy.set(key, rows)
  }
  const strategies = [...byStrategy.entries()].map(([id, items]) => {
    const first = items[0].row
    const policy = contextPolicy(first)
    const budgets = [...new Set(items.map((item) => item.row.contextBudget))].sort((a, b) => a - b)
    return {
      id,
      label: `${retrieverLabel(first.retriever)}${contextLabel(policy)}`,
      strategyId: first.strategyId,
      retriever: first.retriever,
      queryMode: first.queryMode ?? 'reference',
      contextPolicy: policy,
      sourceRun: items.sort((a, b) => b.row.contextBudget - a.row.contextBudget)[0].runPath,
      curve: budgets.map((budget) => point(items.map((item) => item.row), budget))
    }
  })
  const ranked = strategies
    .filter((strategy) => strategy.curve.some((item) => item.budget === headlineBudget))
    .sort((left, right) => {
      const l = left.curve.find((item) => item.budget === headlineBudget)!.evidenceEfficiency ?? -1
      const r = right.curve.find((item) => item.budget === headlineBudget)!.evidenceEfficiency ?? -1
      return r - l || left.label.localeCompare(right.label)
    })
  const report: TournamentReport = {
    schemaVersion: 1,
    provisional: true,
    metricVersion: targetRun.metricVersion ?? 1,
    caseSet: [...new Set(targetRun.results.map((row) => `${row.bookId}|${row.caseId}`))].sort(),
    headlineBudget,
    compatibleRuns: compatible.map(({ path, run }) => ({
      path,
      name: run.plan.name,
      costUsd: run.ledger.actualCostUsd,
      resultCells: run.results.length
    })),
    totalMeteredCostUsd: compatible.reduce((total, item) => total + item.run.ledger.actualCostUsd, 0),
    runDirectoryMeteredCostUsd: allCompleted.reduce(
      (total, item) => total + item.run.ledger.actualCostUsd,
      0
    ),
    strategies: ranked
  }
  const markdownPath = resolve(outputPath ?? target.replace(/\.json$/i, '.tournament.md'))
  const jsonPath = markdownPath.replace(/\.md$/i, '.json')
  const svgPath = markdownPath.replace(/\.md$/i, '.evidence-efficiency.svg')
  const topStrategies = ranked.slice(0, top)
  await fs.mkdir(dirname(markdownPath), { recursive: true })
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    fs.writeFile(svgPath, svgFor(topStrategies, headlineBudget), 'utf8'),
    fs.writeFile(markdownPath, markdownFor(report, topStrategies, basename(svgPath)), 'utf8')
  ])
  return { markdownPath, jsonPath, svgPath, strategies: ranked.length }
}
