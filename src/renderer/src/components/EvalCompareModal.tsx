import { useEffect, useState } from 'react'
import type { EvalRunResult, EvalSet } from '../../../preload/types'
import { cv } from '../lib/theme'

interface EvalCompareModalProps {
  bookId: string
  evalSet: EvalSet
  runIds: string[]
  onClose: () => void
}

function EvalCompareModal({ bookId, evalSet, runIds, onClose }: EvalCompareModalProps): React.JSX.Element {
  const [runs, setRuns] = useState<EvalRunResult[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRuns([])
    setError(null)
    void Promise.all(runIds.map((id) => window.api.evals.getRun(bookId, id))).then((results) => {
      if (cancelled) return
      const ok: EvalRunResult[] = []
      for (const r of results) {
        if (r.ok) ok.push(r.data)
        else setError(r.error)
      }
      setRuns(ok)
    })
    return () => { cancelled = true }
  }, [bookId, runIds])

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: cv.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: cv.bg, borderRadius: 8, width: 1100, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.3)', overflow: 'hidden', border: `1px solid ${cv.border}` }}
      >
        <header style={{ padding: '16px 20px', borderBottom: `1px solid ${cv.border}`, display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: cv.text1 }}>Compare runs</h2>
          <span style={{ fontSize: 12, color: cv.text3 }}>
            eval set: <span style={{ fontFamily: 'monospace' }}>{evalSet.id}</span>
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: cv.text3 }}>×</button>
        </header>

        {error && <pre style={{ color: cv.errorText, padding: 16, fontSize: 12 }}>{error}</pre>}

        <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
          {runs.length === 0 ? (
            <div style={{ fontSize: 12, color: cv.text4 }}>Loading…</div>
          ) : (
            <>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', marginBottom: 16 }}>
                <thead>
                  <tr style={{ background: cv.surface2, textAlign: 'left' }}>
                    <th style={th(cv)}>Strategy</th>
                    <th style={th(cv)}>Mode</th>
                    <th style={th(cv)}>k</th>
                    <th style={th(cv)}>R@k</th>
                    <th style={th(cv)}>MRR</th>
                    <th style={th(cv)}>Cit P</th>
                    <th style={th(cv)}>Cit R</th>
                    <th style={th(cv)}>Tokens</th>
                    <th style={th(cv)}>Ran at</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} style={{ borderTop: `1px solid ${cv.border}` }}>
                      <td style={{ ...tdStyle(cv), fontFamily: 'monospace' }}>{run.strategyId}</td>
                      <td style={{ ...tdStyle(cv), fontSize: 10, textTransform: 'uppercase', color: cv.text3 }}>{run.mode ?? 'agentic'}</td>
                      <td style={tdStyle(cv)}>{run.k}</td>
                      <td style={tdStyle(cv)}>{run.meanRecallAtK.toFixed(2)}</td>
                      <td style={tdStyle(cv)}>{run.meanMRR.toFixed(2)}</td>
                      <td style={tdStyle(cv)}>{run.meanCitationPrecision !== undefined ? run.meanCitationPrecision.toFixed(2) : '—'}</td>
                      <td style={tdStyle(cv)}>{run.meanCitationRecall !== undefined ? run.meanCitationRecall.toFixed(2) : '—'}</td>
                      <td style={tdStyle(cv)}>{run.totalTokens !== undefined ? run.totalTokens.toLocaleString() : '—'}</td>
                      <td style={{ ...tdStyle(cv), color: cv.text4, fontSize: 11 }}>{new Date(run.ranAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h3 style={{ fontSize: 13, margin: '16px 0 8px', color: cv.text1 }}>Per-case hit-rank</h3>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                <thead>
                  <tr style={{ background: cv.surface2, textAlign: 'left' }}>
                    <th style={{ ...th(cv), minWidth: 320 }}>Question</th>
                    {runs.map((run) => (
                      <th key={run.id} style={{ ...th(cv), fontFamily: 'monospace', fontSize: 11 }}>{run.strategyId}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {evalSet.cases.map((c) => (
                    <tr key={c.id} style={{ borderTop: `1px solid ${cv.border}` }}>
                      <td style={{ ...tdStyle(cv), lineHeight: 1.4 }}>{c.question}</td>
                      {runs.map((run) => {
                        const cell = run.cases.find((x) => x.caseId === c.id)
                        if (!cell) return <td key={run.id} style={{ ...tdStyle(cv), color: cv.text5 }}>—</td>
                        const cited = (cell.citedChunkIds?.length ?? 0) > 0
                        const hit = cell.recallAtK > 0
                        const bg = hit
                          ? cell.hitRank === 1 ? cv.hit1
                            : cell.hitRank! <= 3 ? cv.hit3
                            : cv.hitK
                          : cv.miss
                        return (
                          <td
                            key={run.id}
                            style={{ ...tdStyle(cv), background: bg, fontFamily: 'monospace', fontSize: 11 }}
                            title={hit ? `hit @ rank ${cell.hitRank}${cited ? ', cited' : ', NOT cited'}` : 'miss'}
                          >
                            {hit ? `#${cell.hitRank}${cited ? ' ✓' : ' ·'}` : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ fontSize: 10, color: cv.text4, marginTop: 8, lineHeight: 1.4 }}>
                Each cell shows hit-rank · ✓ = cited by agent · · = retrieved but not cited · — = miss.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function th(c: typeof cv): React.CSSProperties {
  return { padding: '6px 8px', fontWeight: 600, fontSize: 11, color: c.text2 }
}
function tdStyle(c: typeof cv): React.CSSProperties {
  return { padding: '6px 8px', color: c.text1 }
}

export default EvalCompareModal
