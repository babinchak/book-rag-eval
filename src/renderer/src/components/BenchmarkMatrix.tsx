import { useEffect, useMemo, useState } from 'react'
import type {
  BenchmarkResultCell,
  BenchmarkRunResults,
  BenchmarkRunSummary,
  DraftCaseBrowserItem,
  IpcError
} from '../../../preload/types'
import { cv } from '../lib/theme'
import ErrorDisplay from './ErrorDisplay'

type MatrixMetric = 'hitAtK' | 'mrr' | 'evidenceRecall' | 'ndcgAtK'

interface BenchmarkMatrixProps {
  cases: DraftCaseBrowserItem[]
  onOpenCase: (item: DraftCaseBrowserItem, cell: BenchmarkResultCell) => void
}

function retrieverKey(cell: BenchmarkResultCell): string {
  return JSON.stringify(cell.retriever)
}

function columnKey(cell: BenchmarkResultCell): string {
  return `${cell.strategyId}|${retrieverKey(cell)}`
}

function retrieverLabel(cell: BenchmarkResultCell): string {
  if (cell.retriever.kind === 'random') return `Random (seed ${cell.retriever.seed})`
  if (cell.retriever.kind === 'bm25') return 'BM25'
  if (cell.retriever.kind === 'vector') return `Vector · ${cell.retriever.embeddingModel}`
  return `Hybrid RRF · ${cell.retriever.embeddingModel}`
}

function strategyLabel(strategyId: string): string {
  const fixed = /^fixed-token-cl100k_base-(\d+)-(\d+)$/.exec(strategyId)
  if (fixed) return `Fixed ${fixed[1]}/${fixed[2]}`
  const structural = /^structural-token-cl100k_base-(\d+)-(\d+)$/.exec(strategyId)
  if (structural) return `Structural ${structural[1]}/${structural[2]}`
  return strategyId
}

function metricValue(cell: BenchmarkResultCell, metric: MatrixMetric): number | null {
  return cell.metrics[metric]
}

function metricLabel(metric: MatrixMetric): string {
  if (metric === 'hitAtK') return 'Hit@budget'
  if (metric === 'evidenceRecall') return 'Evidence recall'
  if (metric === 'ndcgAtK') return 'nDCG'
  return 'MRR'
}

function displayMetric(value: number | null, metric: MatrixMetric): string {
  if (value === null) return 'n/a'
  if (metric === 'hitAtK') return value === 1 ? 'Hit' : 'Miss'
  return `${Math.round(value * 100)}%`
}

function cellColors(value: number | null): { background: string; color: string } {
  if (value === null) return { background: cv.surface2, color: cv.text4 }
  if (value <= 0) return { background: cv.errorBg, color: cv.errorText }
  if (value >= 0.999) return { background: cv.successBg, color: cv.successText }
  return { background: cv.warningBg, color: cv.warningText }
}

const controlStyle: React.CSSProperties = {
  minWidth: 150,
  background: cv.bg,
  color: cv.text1,
  border: `1px solid ${cv.border2}`,
  borderRadius: 5,
  padding: '7px 9px',
  fontSize: 12
}

function BenchmarkMatrix({ cases, onOpenCase }: BenchmarkMatrixProps): React.JSX.Element {
  const [runs, setRuns] = useState<BenchmarkRunSummary[]>([])
  const [selectedRunPath, setSelectedRunPath] = useState('')
  const [results, setResults] = useState<BenchmarkRunResults | null>(null)
  const [queryMode, setQueryMode] = useState<'question' | 'reference'>('question')
  const [budget, setBudget] = useState(4096)
  const [metric, setMetric] = useState<MatrixMetric>('hitAtK')
  const [bookId, setBookId] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<IpcError | null>(null)

  async function loadRun(runPath: string): Promise<void> {
    setLoading(true)
    const response = await window.api.benchmarkResults.get(runPath)
    if (!response.ok) {
      setError(response.error)
      setLoading(false)
      return
    }
    setResults(response.data)
    setQueryMode(
      response.data.run.queryModes.includes('question')
        ? 'question'
        : (response.data.run.queryModes[0] ?? 'reference')
    )
    setBudget(
      response.data.run.contextBudgets.includes(4096)
        ? 4096
        : (response.data.run.contextBudgets[0] ?? 0)
    )
    setError(null)
    setLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    void window.api.benchmarkResults.listRuns().then((response) => {
      if (cancelled) return
      if (!response.ok) {
        setError(response.error)
        setLoading(false)
        return
      }
      setRuns(response.runs)
      const preferred = response.runs.find((run) => run.status === 'completed') ?? response.runs[0]
      if (!preferred) {
        setLoading(false)
        return
      }
      setSelectedRunPath(preferred.runPath)
      void loadRun(preferred.runPath)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const visibleCells = useMemo(
    () =>
      results?.cells.filter(
        (cell) => cell.queryMode === queryMode && cell.contextBudget === budget
      ) ?? [],
    [results, queryMode, budget]
  )
  const columns = useMemo(() => {
    const byKey = new Map<string, BenchmarkResultCell>()
    for (const cell of visibleCells) byKey.set(columnKey(cell), cell)
    return [...byKey.entries()].map(([key, sample]) => ({ key, sample }))
  }, [visibleCells])
  const cellByKey = useMemo(
    () => new Map(visibleCells.map((cell) => [`${cell.caseId}|${columnKey(cell)}`, cell])),
    [visibleCells]
  )
  const books = useMemo(() => {
    const byId = new Map<string, string>()
    for (const item of cases) byId.set(item.bookId, item.bookTitle)
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [cases])
  const visibleCases = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return cases.filter((item) => {
      if (bookId !== 'all' && item.bookId !== bookId) return false
      if (!needle) return true
      return `${item.question} ${item.bookTitle} ${item.tags.join(' ')}`
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [cases, bookId, search])

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          padding: '12px 16px',
          borderBottom: `1px solid ${cv.border}`,
          background: cv.surface
        }}
      >
        <select
          value={selectedRunPath}
          onChange={(event) => {
            setSelectedRunPath(event.target.value)
            void loadRun(event.target.value)
          }}
          style={{ ...controlStyle, minWidth: 300 }}
        >
          {runs.map((run) => (
            <option key={run.runPath} value={run.runPath}>
              {run.name} · {run.resultCells.toLocaleString()} cells · {run.status}
            </option>
          ))}
        </select>
        <select
          value={queryMode}
          onChange={(event) => setQueryMode(event.target.value as typeof queryMode)}
          style={controlStyle}
        >
          {results?.run.queryModes.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'question' ? 'Raw question' : 'Reference query'}
            </option>
          ))}
        </select>
        <select
          value={budget}
          onChange={(event) => setBudget(Number(event.target.value))}
          style={controlStyle}
        >
          {results?.run.contextBudgets.map((value) => (
            <option key={value} value={value}>
              {value.toLocaleString()} token budget
            </option>
          ))}
        </select>
        <select
          value={metric}
          onChange={(event) => setMetric(event.target.value as MatrixMetric)}
          style={controlStyle}
        >
          <option value="hitAtK">Hit@budget</option>
          <option value="mrr">MRR</option>
          <option value="evidenceRecall">Evidence recall</option>
          <option value="ndcgAtK">nDCG</option>
        </select>
        <select
          value={bookId}
          onChange={(event) => setBookId(event.target.value)}
          style={controlStyle}
        >
          <option value="all">All books</option>
          {books.map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter cases…"
          style={{ ...controlStyle, flex: 1 }}
        />
      </div>

      <ErrorDisplay error={error} marginTop={0} />
      {loading ? (
        <div style={{ padding: 28, color: cv.text4 }}>Loading experiment results…</div>
      ) : !results ? (
        <div style={{ padding: 28, color: cv.text3, lineHeight: 1.6 }}>
          <strong style={{ color: cv.text1 }}>No experiment runs yet.</strong>
          <br />
          Run a headless experiment and its case-by-strategy results will appear here automatically.
        </div>
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table
            style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: '100%', fontSize: 11 }}
          >
            <thead style={{ position: 'sticky', top: 0, zIndex: 3 }}>
              <tr>
                <th
                  style={{
                    ...headerCellStyle,
                    left: 0,
                    zIndex: 4,
                    minWidth: 330,
                    textAlign: 'left'
                  }}
                >
                  {visibleCases.length} cases · {metricLabel(metric)}
                </th>
                {columns.map(({ key, sample }) => {
                  const values = visibleCases
                    .map((item) => cellByKey.get(`${item.caseId}|${key}`))
                    .filter((cell): cell is BenchmarkResultCell => Boolean(cell))
                    .map((cell) => metricValue(cell, metric))
                    .filter((value): value is number => value !== null)
                  const mean =
                    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
                  return (
                    <th key={key} style={{ ...headerCellStyle, minWidth: 126 }}>
                      <div>{strategyLabel(sample.strategyId)}</div>
                      <div style={{ color: cv.text4, fontWeight: 400, marginTop: 3 }}>
                        {retrieverLabel(sample)}
                      </div>
                      <div style={{ color: cv.accent, marginTop: 5 }}>
                        {mean === null ? 'n/a' : `${Math.round(mean * 100)}% avg`}
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleCases.map((item) => (
                <tr key={item.caseId}>
                  <td style={{ ...caseCellStyle, position: 'sticky', left: 0, zIndex: 1 }}>
                    <div style={{ color: cv.text1, lineHeight: 1.35 }}>{item.question}</div>
                    <div style={{ color: cv.text4, fontSize: 9, marginTop: 4 }}>
                      {item.bookTitle}
                    </div>
                  </td>
                  {columns.map(({ key }) => {
                    const cell = cellByKey.get(`${item.caseId}|${key}`)
                    const value = cell ? metricValue(cell, metric) : null
                    const colors = cellColors(value)
                    return (
                      <td
                        key={key}
                        style={{
                          padding: 0,
                          borderRight: `1px solid ${cv.border}`,
                          borderBottom: `1px solid ${cv.border}`
                        }}
                      >
                        <button
                          disabled={!cell}
                          title={
                            cell
                              ? `${cell.retrievalQuery}\n${cell.retrievedTokens} retrieved tokens`
                              : 'No result'
                          }
                          onClick={() => cell && onOpenCase(item, cell)}
                          style={{
                            width: '100%',
                            minHeight: 54,
                            border: 'none',
                            background: colors.background,
                            color: colors.color,
                            cursor: cell ? 'pointer' : 'default',
                            fontWeight: 700
                          }}
                        >
                          {displayMetric(value, metric)}
                          {cell?.metrics.firstHitRank && (
                            <div style={{ fontSize: 9, fontWeight: 400 }}>
                              rank {cell.metrics.firstHitRank}
                            </div>
                          )}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const headerCellStyle: React.CSSProperties = {
  padding: '10px 11px',
  background: cv.surface,
  color: cv.text2,
  borderRight: `1px solid ${cv.border}`,
  borderBottom: `1px solid ${cv.border2}`,
  fontWeight: 650,
  verticalAlign: 'bottom'
}

const caseCellStyle: React.CSSProperties = {
  padding: '9px 12px',
  background: cv.surface,
  borderRight: `1px solid ${cv.border2}`,
  borderBottom: `1px solid ${cv.border}`
}

export default BenchmarkMatrix
