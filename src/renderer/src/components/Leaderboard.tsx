import { useMemo, useState } from 'react'
import type { EvalMode, EvalRunSummary } from '../../../preload/types'
import { cv } from '../lib/theme'

type SortKey =
  | 'strategyId'
  | 'retrieverId'
  | 'k'
  | 'mode'
  | 'meanRecallAtK'
  | 'meanMRR'
  | 'meanCitationPrecision'
  | 'meanCitationRecall'
  | 'totalTokens'
  | 'ranAt'

type SortDir = 'asc' | 'desc'

interface LeaderboardProps {
  runs: EvalRunSummary[]
  onSelectRun: (runId: string) => void
}

const HIGHER_IS_BETTER: Record<string, boolean> = {
  meanRecallAtK: true,
  meanMRR: true,
  meanCitationPrecision: true,
  meanCitationRecall: true,
  totalTokens: false, // lower is better
  ranAt: true
}

// Dedupe to most recent run per (strategyId, retrieverId, k, mode)
function dedupeLatest(runs: EvalRunSummary[]): EvalRunSummary[] {
  const byKey = new Map<string, EvalRunSummary>()
  for (const r of runs) {
    const key = `${r.strategyId}|${r.retrieverId ?? 'vector'}|${r.k}|${r.mode ?? 'agentic'}`
    const prev = byKey.get(key)
    if (!prev || r.ranAt > prev.ranAt) byKey.set(key, r)
  }
  return Array.from(byKey.values())
}

function compareNullable(a: number | undefined, b: number | undefined, dir: SortDir): number {
  // Push undefined to the bottom regardless of direction
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return dir === 'asc' ? a - b : b - a
}

function compareString(a: string, b: string, dir: SortDir): number {
  const cmp = a.localeCompare(b)
  return dir === 'asc' ? cmp : -cmp
}

function formatTokens(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n < 1000) return n.toString()
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function Leaderboard({ runs, onSelectRun }: LeaderboardProps): React.JSX.Element {
  const [chunkingFilter, setChunkingFilter] = useState<string>('all')
  const [retrieverFilter, setRetrieverFilter] = useState<string>('all')
  const [modeFilter, setModeFilter] = useState<EvalMode | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('meanRecallAtK')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const chunkingOptions = useMemo(
    () => Array.from(new Set(runs.map((r) => r.strategyId))).sort(),
    [runs]
  )
  const retrieverOptions = useMemo(
    () => Array.from(new Set(runs.map((r) => r.retrieverId ?? 'vector'))).sort(),
    [runs]
  )

  const rows = useMemo(() => {
    const filtered = runs.filter((r) => {
      const ret = r.retrieverId ?? 'vector'
      const mode = r.mode ?? 'agentic'
      if (chunkingFilter !== 'all' && r.strategyId !== chunkingFilter) return false
      if (retrieverFilter !== 'all' && ret !== retrieverFilter) return false
      if (modeFilter !== 'all' && mode !== modeFilter) return false
      return true
    })
    const latest = dedupeLatest(filtered)
    const sorted = [...latest].sort((a, b) => {
      switch (sortKey) {
        case 'strategyId':
          return compareString(a.strategyId, b.strategyId, sortDir)
        case 'retrieverId':
          return compareString(a.retrieverId ?? 'vector', b.retrieverId ?? 'vector', sortDir)
        case 'mode':
          return compareString(a.mode ?? 'agentic', b.mode ?? 'agentic', sortDir)
        case 'k':
          return sortDir === 'asc' ? a.k - b.k : b.k - a.k
        case 'meanRecallAtK':
          return sortDir === 'asc'
            ? a.meanRecallAtK - b.meanRecallAtK
            : b.meanRecallAtK - a.meanRecallAtK
        case 'meanMRR':
          return sortDir === 'asc' ? a.meanMRR - b.meanMRR : b.meanMRR - a.meanMRR
        case 'meanCitationPrecision':
          return compareNullable(a.meanCitationPrecision, b.meanCitationPrecision, sortDir)
        case 'meanCitationRecall':
          return compareNullable(a.meanCitationRecall, b.meanCitationRecall, sortDir)
        case 'totalTokens':
          return compareNullable(a.totalTokens, b.totalTokens, sortDir)
        case 'ranAt':
          return sortDir === 'asc' ? a.ranAt - b.ranAt : b.ranAt - a.ranAt
      }
    })
    return sorted
  }, [runs, chunkingFilter, retrieverFilter, modeFilter, sortKey, sortDir])

  // For "best per axis" highlighting — index of the leader by each metric.
  const leaders = useMemo(() => {
    function bestId(
      pick: (r: EvalRunSummary) => number | undefined,
      higherBetter: boolean
    ): string | null {
      let bestRun: EvalRunSummary | null = null
      let bestVal: number | null = null
      for (const r of rows) {
        const v = pick(r)
        if (v === undefined) continue
        if (
          bestVal === null ||
          (higherBetter ? v > bestVal : v < bestVal)
        ) {
          bestVal = v
          bestRun = r
        }
      }
      return bestRun?.id ?? null
    }
    return {
      recall: bestId((r) => r.meanRecallAtK, true),
      mrr: bestId((r) => r.meanMRR, true),
      citP: bestId((r) => r.meanCitationPrecision, true),
      citR: bestId((r) => r.meanCitationRecall, true),
      tokens: bestId((r) => r.totalTokens, false)
    }
  }, [rows])

  function toggleSort(key: SortKey): void {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(HIGHER_IS_BETTER[key] === false ? 'asc' : 'desc')
    }
  }

  if (runs.length === 0) {
    return (
      <div style={{ fontSize: 12, color: cv.text4 }}>
        No runs for this eval set yet. Run a strategy to populate the leaderboard.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <FilterSelect
          label="Chunking"
          value={chunkingFilter}
          onChange={setChunkingFilter}
          options={[{ value: 'all', label: 'All' }, ...chunkingOptions.map((s) => ({ value: s, label: s }))]}
        />
        <FilterSelect
          label="Retriever"
          value={retrieverFilter}
          onChange={setRetrieverFilter}
          options={[{ value: 'all', label: 'All' }, ...retrieverOptions.map((s) => ({ value: s, label: s }))]}
        />
        <FilterSelect
          label="Mode"
          value={modeFilter}
          onChange={(v) => setModeFilter(v as EvalMode | 'all')}
          options={[
            { value: 'all', label: 'All' },
            { value: 'retrieval', label: 'retrieval' },
            { value: 'agentic', label: 'agentic' }
          ]}
        />
        <div style={{ marginLeft: 'auto', fontSize: 11, color: cv.text4 }}>
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          {rows.length !== runs.length && ` (${runs.length} total)`}
        </div>
      </div>

      <div style={{ overflowX: 'auto', border: `1px solid ${cv.border}`, borderRadius: 6 }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
            color: cv.text1,
            background: cv.bg
          }}
        >
          <thead>
            <tr style={{ background: cv.surface2, color: cv.text2 }}>
              <HeaderCell active={sortKey === 'strategyId'} dir={sortDir} onClick={() => toggleSort('strategyId')} align="left">
                Chunking
              </HeaderCell>
              <HeaderCell active={sortKey === 'retrieverId'} dir={sortDir} onClick={() => toggleSort('retrieverId')} align="left">
                Retriever
              </HeaderCell>
              <HeaderCell active={sortKey === 'k'} dir={sortDir} onClick={() => toggleSort('k')} align="right">
                k
              </HeaderCell>
              <HeaderCell active={sortKey === 'mode'} dir={sortDir} onClick={() => toggleSort('mode')} align="left">
                Mode
              </HeaderCell>
              <HeaderCell active={sortKey === 'meanRecallAtK'} dir={sortDir} onClick={() => toggleSort('meanRecallAtK')} align="right" title="Mean recall at k">
                R@k
              </HeaderCell>
              <HeaderCell active={sortKey === 'meanMRR'} dir={sortDir} onClick={() => toggleSort('meanMRR')} align="right" title="Mean reciprocal rank">
                MRR
              </HeaderCell>
              <HeaderCell active={sortKey === 'meanCitationPrecision'} dir={sortDir} onClick={() => toggleSort('meanCitationPrecision')} align="right" title="Mean citation precision (agentic only)">
                Cit. P
              </HeaderCell>
              <HeaderCell active={sortKey === 'meanCitationRecall'} dir={sortDir} onClick={() => toggleSort('meanCitationRecall')} align="right" title="Mean citation recall (agentic only)">
                Cit. R
              </HeaderCell>
              <HeaderCell active={sortKey === 'totalTokens'} dir={sortDir} onClick={() => toggleSort('totalTokens')} align="right" title="Total tokens consumed (lower is better)">
                Tokens
              </HeaderCell>
              <HeaderCell active={sortKey === 'ranAt'} dir={sortDir} onClick={() => toggleSort('ranAt')} align="right">
                Ran at
              </HeaderCell>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mode = r.mode ?? 'agentic'
              const ret = r.retrieverId ?? 'vector'
              return (
                <tr
                  key={r.id}
                  onClick={() => onSelectRun(r.id)}
                  style={{
                    borderTop: `1px solid ${cv.border}`,
                    cursor: 'pointer'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = cv.surface
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = ''
                  }}
                >
                  <Cell align="left" mono>{r.strategyId}</Cell>
                  <Cell align="left" mono>{ret}</Cell>
                  <Cell align="right">{r.k}</Cell>
                  <Cell align="left">{mode}</Cell>
                  <Cell align="right" leader={r.id === leaders.recall}>
                    {r.meanRecallAtK.toFixed(2)}
                  </Cell>
                  <Cell align="right" leader={r.id === leaders.mrr}>
                    {r.meanMRR.toFixed(2)}
                  </Cell>
                  <Cell align="right" leader={r.id === leaders.citP}>
                    {r.meanCitationPrecision !== undefined
                      ? r.meanCitationPrecision.toFixed(2)
                      : '—'}
                  </Cell>
                  <Cell align="right" leader={r.id === leaders.citR}>
                    {r.meanCitationRecall !== undefined
                      ? r.meanCitationRecall.toFixed(2)
                      : '—'}
                  </Cell>
                  <Cell align="right" leader={r.id === leaders.tokens}>
                    {formatTokens(r.totalTokens)}
                  </Cell>
                  <Cell align="right">
                    <span style={{ color: cv.text4, whiteSpace: 'nowrap' }}>
                      {new Date(r.ranAt).toLocaleString()}
                    </span>
                  </Cell>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  style={{ padding: 16, textAlign: 'center', color: cv.text4, fontSize: 12 }}
                >
                  No runs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface HeaderCellProps {
  active: boolean
  dir: SortDir
  onClick: () => void
  align: 'left' | 'right'
  title?: string
  children: React.ReactNode
}

function HeaderCell({
  active,
  dir,
  onClick,
  align,
  title,
  children
}: HeaderCellProps): React.JSX.Element {
  return (
    <th
      onClick={onClick}
      title={title}
      style={{
        textAlign: align,
        padding: '6px 10px',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        color: active ? cv.text1 : cv.text3
      }}
    >
      {children}
      <span style={{ marginLeft: 4, fontSize: 9, color: active ? cv.accent : cv.text5 }}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '·'}
      </span>
    </th>
  )
}

interface CellProps {
  align: 'left' | 'right'
  mono?: boolean
  leader?: boolean
  children: React.ReactNode
}

function Cell({ align, mono, leader, children }: CellProps): React.JSX.Element {
  return (
    <td
      style={{
        textAlign: align,
        padding: '6px 10px',
        fontFamily: mono ? 'monospace' : undefined,
        fontWeight: leader ? 700 : 400,
        color: leader ? cv.successStrong : undefined,
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </td>
  )
}

interface FilterSelectProps {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}

function FilterSelect({ label, value, onChange, options }: FilterSelectProps): React.JSX.Element {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: cv.text3
      }}
    >
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '3px 6px',
          fontSize: 11,
          fontFamily: 'monospace',
          border: `1px solid ${cv.border2}`,
          borderRadius: 3,
          background: cv.bg,
          color: cv.text1
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export default Leaderboard
