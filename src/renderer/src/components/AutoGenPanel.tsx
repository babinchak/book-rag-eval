import { useState } from 'react'
import type { AutoGenerateFailure, ChunkSetSummary } from '../../../preload/types'
import { cv } from '../lib/theme'
import ErrorDisplay from './ErrorDisplay'

interface AutoGenPanelProps {
  open: boolean
  onOpenToggle: () => void
  chunkSets: ChunkSetSummary[]
  strategyId: string
  onStrategyChange: (id: string) => void
  count: number
  onCountChange: (n: number) => void
  running: boolean
  status: string | null
  failures: AutoGenerateFailure[]
  onGenerate: () => void
  missingSearchQueryCount: number
  backfilling: boolean
  onBackfill: () => void
}

function AutoGenPanel({
  open,
  onOpenToggle,
  chunkSets,
  strategyId,
  onStrategyChange,
  count,
  onCountChange,
  running,
  status,
  failures,
  onGenerate,
  missingSearchQueryCount,
  backfilling,
  onBackfill
}: AutoGenPanelProps): React.JSX.Element {
  const [failuresOpen, setFailuresOpen] = useState(false)
  const toggleBtn: React.CSSProperties = {
    width: '100%',
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    background: cv.bg,
    color: cv.text3,
    border: `1px dashed ${cv.border2}`,
    borderRadius: 4,
    marginBottom: 8,
    textAlign: 'left'
  }

  const inputStyle: React.CSSProperties = {
    padding: '4px 6px',
    fontSize: 12,
    border: `1px solid ${cv.border2}`,
    borderRadius: 3,
    background: cv.bg,
    color: cv.text1
  }

  const noStrategies = chunkSets.length === 0
  const canRun = !running && !backfilling && !noStrategies && strategyId !== '' && count > 0
  const canBackfill = !running && !backfilling && missingSearchQueryCount > 0

  return (
    <div>
      <button onClick={onOpenToggle} style={toggleBtn}>
        {open ? '▾' : '▸'} Generate
      </button>
      {open && (
        <div
          style={{
            border: `1px solid ${cv.border}`,
            borderRadius: 4,
            padding: 8,
            background: cv.surface,
            display: 'grid',
            gap: 6,
            marginBottom: 8
          }}
        >
          {noStrategies ? (
            <div style={{ fontSize: 11, color: cv.text4 }}>
              No chunk strategies available. Create one first.
            </div>
          ) : (
            <>
              <label style={{ fontSize: 11, color: cv.text2, display: 'grid', gap: 3 }}>
                Source chunks
                <select
                  value={strategyId}
                  onChange={(e) => onStrategyChange(e.target.value)}
                  style={inputStyle}
                >
                  {chunkSets.map((c) => (
                    <option key={c.strategyId} value={c.strategyId}>
                      {c.strategyId} ({c.count})
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 11, color: cv.text2, display: 'grid', gap: 3 }}>
                Number of cases
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={count}
                  onChange={(e) =>
                    onCountChange(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))
                  }
                  style={inputStyle}
                />
              </label>
              <button
                onClick={onGenerate}
                disabled={!canRun}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  cursor: canRun ? 'pointer' : 'not-allowed',
                  background: canRun ? cv.accent : cv.bg,
                  color: canRun ? cv.accentText : cv.text4,
                  border: canRun ? 'none' : `1px solid ${cv.border2}`,
                  borderRadius: 4
                }}
              >
                {running ? 'Generating…' : 'Generate new cases'}
              </button>
              {missingSearchQueryCount > 0 && (
                <button
                  onClick={onBackfill}
                  disabled={!canBackfill}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: canBackfill ? 'pointer' : 'not-allowed',
                    background: cv.bg,
                    color: cv.text2,
                    border: `1px solid ${cv.border2}`,
                    borderRadius: 4
                  }}
                  title="Generate searchQuery for cases that don't have one yet"
                >
                  {backfilling
                    ? 'Backfilling…'
                    : `Backfill missing search queries (${missingSearchQueryCount})`}
                </button>
              )}
              {status && (
                <div style={{ fontSize: 11, color: cv.text3 }}>{status}</div>
              )}
              {failures.length > 0 && (
                <div style={{ display: 'grid', gap: 4 }}>
                  <button
                    onClick={() => setFailuresOpen((v) => !v)}
                    style={{
                      padding: '3px 6px',
                      fontSize: 11,
                      cursor: 'pointer',
                      background: 'transparent',
                      color: cv.errorText,
                      border: `1px solid ${cv.errorBorder}`,
                      borderRadius: 3,
                      textAlign: 'left'
                    }}
                  >
                    {failuresOpen ? '▾' : '▸'} {failures.length} failure
                    {failures.length === 1 ? '' : 's'}
                  </button>
                  {failuresOpen && (
                    <ul
                      style={{
                        margin: 0,
                        padding: 0,
                        listStyle: 'none',
                        display: 'grid',
                        gap: 4,
                        maxHeight: 200,
                        overflowY: 'auto'
                      }}
                    >
                      {failures.map((f, i) => (
                        <li key={`${f.id}-${i}`} style={{ display: 'grid', gap: 2 }}>
                          <div
                            style={{
                              fontFamily: 'monospace',
                              fontSize: 10,
                              color: cv.text3
                            }}
                          >
                            {f.id}
                          </div>
                          <ErrorDisplay error={f.error} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default AutoGenPanel
