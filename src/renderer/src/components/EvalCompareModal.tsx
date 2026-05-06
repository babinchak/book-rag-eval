import { useEffect, useState } from 'react'
import type { EvalRunResult, EvalSet } from '../../../preload/types'

interface EvalCompareModalProps {
  bookId: string
  evalSet: EvalSet
  runIds: string[]
  onClose: () => void
}

function EvalCompareModal({
  bookId,
  evalSet,
  runIds,
  onClose
}: EvalCompareModalProps): React.JSX.Element {
  const [runs, setRuns] = useState<EvalRunResult[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRuns([])
    setError(null)
    void Promise.all(runIds.map((id) => window.api.evals.getRun(bookId, id))).then(
      (results) => {
        if (cancelled) return
        const ok: EvalRunResult[] = []
        for (const r of results) {
          if (r.ok) ok.push(r.data)
          else setError(r.error)
        }
        setRuns(ok)
      }
    )
    return () => {
      cancelled = true
    }
  }, [bookId, runIds])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 8,
          width: 1100,
          maxWidth: '95vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          overflow: 'hidden'
        }}
      >
        <header
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #eee',
            display: 'flex',
            alignItems: 'baseline',
            gap: 16
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Compare runs</h2>
          <span style={{ fontSize: 12, color: '#666' }}>
            eval set: <span style={{ fontFamily: 'monospace' }}>{evalSet.id}</span>
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              cursor: 'pointer',
              color: '#666'
            }}
          >
            ×
          </button>
        </header>

        {error && (
          <pre style={{ color: '#b00', padding: 16, fontSize: 12 }}>{error}</pre>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          {runs.length === 0 ? (
            <div style={{ fontSize: 12, color: '#888' }}>Loading…</div>
          ) : (
            <>
              <table
                style={{
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  width: '100%',
                  marginBottom: 16
                }}
              >
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={th}>Strategy</th>
                    <th style={th}>k</th>
                    <th style={th}>R@k</th>
                    <th style={th}>MRR</th>
                    <th style={th}>Cit P</th>
                    <th style={th}>Cit R</th>
                    <th style={th}>Tokens</th>
                    <th style={th}>Ran at</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ ...td, fontFamily: 'monospace' }}>{run.strategyId}</td>
                      <td style={td}>{run.k}</td>
                      <td style={td}>{run.meanRecallAtK.toFixed(2)}</td>
                      <td style={td}>{run.meanMRR.toFixed(2)}</td>
                      <td style={td}>
                        {run.meanCitationPrecision !== undefined
                          ? run.meanCitationPrecision.toFixed(2)
                          : '—'}
                      </td>
                      <td style={td}>
                        {run.meanCitationRecall !== undefined
                          ? run.meanCitationRecall.toFixed(2)
                          : '—'}
                      </td>
                      <td style={td}>
                        {run.totalTokens !== undefined ? run.totalTokens.toLocaleString() : '—'}
                      </td>
                      <td style={{ ...td, color: '#888', fontSize: 11 }}>
                        {new Date(run.ranAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3 style={{ fontSize: 13, margin: '16px 0 8px' }}>Per-case hit-rank</h3>
              <table
                style={{
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  width: '100%'
                }}
              >
                <thead>
                  <tr style={{ background: '#fafafa', textAlign: 'left' }}>
                    <th style={{ ...th, minWidth: 320 }}>Question</th>
                    {runs.map((run) => (
                      <th
                        key={run.id}
                        style={{ ...th, fontFamily: 'monospace', fontSize: 11 }}
                      >
                        {run.strategyId}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {evalSet.cases.map((c) => (
                    <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
                      <td style={{ ...td, lineHeight: 1.4 }}>{c.question}</td>
                      {runs.map((run) => {
                        const cell = run.cases.find((x) => x.caseId === c.id)
                        if (!cell) return <td key={run.id} style={{ ...td, color: '#ccc' }}>—</td>
                        const cited = (cell.citedChunkIds?.length ?? 0) > 0
                        const hit = cell.recallAtK > 0
                        const bg = hit
                          ? cell.hitRank === 1
                            ? '#dcfce7'
                            : cell.hitRank! <= 3
                              ? '#fef9c3'
                              : '#fde68a'
                          : '#fee2e2'
                        return (
                          <td
                            key={run.id}
                            style={{
                              ...td,
                              background: bg,
                              fontFamily: 'monospace',
                              fontSize: 11
                            }}
                            title={
                              hit
                                ? `hit @ rank ${cell.hitRank}${cited ? ', cited' : ', NOT cited'}`
                                : 'miss'
                            }
                          >
                            {hit ? `#${cell.hitRank}${cited ? ' ✓' : ' ·'}` : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ fontSize: 10, color: '#888', marginTop: 8, lineHeight: 1.4 }}>
                Each cell shows hit-rank · ✓ = cited by agent · · = retrieved but not cited · — = miss.
                Background: green=top1, yellow=top3, amber=top-k, red=miss.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 600, fontSize: 11 }
const td: React.CSSProperties = { padding: '6px 8px' }

export default EvalCompareModal
