import { useEffect, useState } from 'react'
import type { EvalCaseResult, EvalRunResult, EvalSet, GoldSpan } from '../../../preload/types'
import { cv } from '../lib/theme'

interface EvalRunDetailModalProps {
  bookId: string
  runId: string
  evalSet: EvalSet | null
  onClose: () => void
  onSelectChunk?: (strategyId: string, chunkId: string) => void
}

function EvalRunDetailModal({ bookId, runId, evalSet, onClose, onSelectChunk }: EvalRunDetailModalProps): React.JSX.Element {
  const [run, setRun] = useState<EvalRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.evals.getRun(bookId, runId).then((r) => {
      if (cancelled) return
      if (r.ok) { setRun(r.data); if (r.data.cases[0]) setExpandedCaseId(r.data.cases[0].caseId) }
      else setError(r.error)
    })
    return () => { cancelled = true }
  }, [bookId, runId])

  function caseGoldSpans(caseId: string): GoldSpan[] {
    return evalSet?.cases.find((x) => x.id === caseId)?.goldSpans ?? []
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: cv.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: cv.bg, borderRadius: 8, padding: 0, width: 900, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.3)', overflow: 'hidden', border: `1px solid ${cv.border}` }}
      >
        <header style={{ padding: '16px 20px', borderBottom: `1px solid ${cv.border}`, display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: cv.text1 }}>Run detail</h2>
          {run && (
            <span style={{ fontSize: 12, color: cv.text3, fontFamily: 'monospace' }}>
              {run.strategyId} · k={run.k} · {new Date(run.ranAt).toLocaleString()}
            </span>
          )}
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: cv.text3 }}>×</button>
        </header>

        {error && <pre style={{ color: cv.errorText, padding: 16, fontSize: 12 }}>{error}</pre>}

        {run && (
          <>
            <div style={{ padding: '12px 20px', background: cv.surface2, borderBottom: `1px solid ${cv.border}`, display: 'flex', gap: 24, fontSize: 12 }}>
              <Metric label={`R@${run.k}`} value={run.meanRecallAtK.toFixed(2)} />
              <Metric label="MRR" value={run.meanMRR.toFixed(2)} />
              {run.meanCitationPrecision !== undefined && <Metric label="Cit. precision" value={run.meanCitationPrecision.toFixed(2)} />}
              {run.meanCitationRecall !== undefined && <Metric label="Cit. recall" value={run.meanCitationRecall.toFixed(2)} />}
              {run.totalTokens !== undefined && <Metric label="Tokens" value={run.totalTokens.toLocaleString()} />}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
              {run.cases.map((caseResult) => (
                <CaseCard
                  key={caseResult.caseId}
                  caseResult={caseResult}
                  expanded={expandedCaseId === caseResult.caseId}
                  onToggle={() => setExpandedCaseId(expandedCaseId === caseResult.caseId ? null : caseResult.caseId)}
                  goldSpans={caseGoldSpans(caseResult.caseId)}
                  strategyId={run.strategyId}
                  onSelectChunk={onSelectChunk ? (chunkId) => { onSelectChunk(run.strategyId, chunkId); onClose() } : undefined}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div style={{ color: cv.text4, fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: cv.text1 }}>{value}</div>
    </div>
  )
}

interface CaseCardProps {
  caseResult: EvalCaseResult
  expanded: boolean
  onToggle: () => void
  goldSpans: GoldSpan[]
  strategyId: string
  onSelectChunk?: (chunkId: string) => void
}

function CaseCard({ caseResult, expanded, onToggle, goldSpans, onSelectChunk }: CaseCardProps): React.JSX.Element {
  const r = caseResult
  const recallColor = r.recallAtK ? cv.successStrong : cv.danger
  const citedSet = new Set(r.citedChunkIds ?? [])

  return (
    <div style={{ border: `1px solid ${cv.border}`, borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
      <div
        onClick={onToggle}
        style={{ padding: '10px 14px', background: expanded ? cv.surface2 : cv.bg, cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}
      >
        <span style={{ fontSize: 12, color: cv.text4, fontFamily: 'monospace' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ flex: 1, fontSize: 13, lineHeight: 1.4, color: cv.text1 }}>{r.question}</span>
        {r.langsmithRunUrl && (
          <a href={r.langsmithRunUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 10, color: cv.accent, textDecoration: 'underline' }} title="Open LangSmith trace">
            trace ↗
          </a>
        )}
        <span style={{ fontSize: 11, background: recallColor, color: '#fff', padding: '2px 6px', borderRadius: 3 }}>
          {r.recallAtK ? `hit @ ${r.hitRank}` : 'miss'}
        </span>
        {r.citationPrecision !== undefined && (
          <span style={{ fontSize: 11, color: cv.text3, fontFamily: 'monospace' }}>
            cit P/R: {r.citationPrecision.toFixed(2)}/{r.citationRecall?.toFixed(2)}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '12px 14px', background: cv.bg, borderTop: `1px solid ${cv.border}` }}>
          {r.answer && (
            <section style={{ marginBottom: 14 }}>
              <SectionLabel>Answer</SectionLabel>
              <div style={{ fontSize: 12, lineHeight: 1.5, background: cv.surface2, border: `1px solid ${cv.border}`, borderRadius: 4, padding: 10, whiteSpace: 'pre-wrap', color: cv.text1 }}>
                {r.answer}
              </div>
              {r.citedRanks && r.citedRanks.length > 0 && (
                <div style={{ fontSize: 11, color: cv.text4, marginTop: 4 }}>cited: [{r.citedRanks.join(', ')}]</div>
              )}
            </section>
          )}

          {goldSpans.length > 0 && (
            <section style={{ marginBottom: 14 }}>
              <SectionLabel>Gold spans</SectionLabel>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {goldSpans.map((g, i) => (
                  <li key={i} style={{ fontSize: 11, fontFamily: 'monospace', background: cv.goldBg, border: `1px solid ${cv.goldBorder}`, borderRadius: 4, padding: '4px 8px', color: cv.text2 }}>
                    {g.spineHref} : {g.textStart}–{g.textEnd}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <SectionLabel>Retrieved ({r.retrieved.length})</SectionLabel>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
              {r.retrieved.map((d) => {
                const isCited = citedSet.has(d.chunkId)
                return (
                  <li
                    key={d.chunkId}
                    onClick={() => onSelectChunk?.(d.chunkId)}
                    style={{
                      cursor: onSelectChunk ? 'pointer' : 'default',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      fontSize: 11,
                      background: d.hit ? cv.successBg : cv.bg,
                      border: `1px solid ${d.hit ? cv.successBorder : cv.border}`,
                      borderRadius: 4,
                      padding: '6px 8px'
                    }}
                  >
                    <span style={{ fontWeight: 600, color: cv.text2 }}>#{d.rank}</span>
                    <span style={{ color: d.hit ? cv.successText : cv.text4, fontFamily: 'monospace' }}>
                      d={d.distance.toFixed(2)}
                    </span>
                    {d.hit && (
                      <span style={{ fontSize: 10, background: cv.successStrong, color: '#fff', padding: '1px 5px', borderRadius: 2 }}>
                        hit · {d.overlap}c
                      </span>
                    )}
                    {isCited && (
                      <span style={{ fontSize: 10, background: cv.accent, color: '#fff', padding: '1px 5px', borderRadius: 2 }}>
                        cited
                      </span>
                    )}
                    <span style={{ flex: 1, color: cv.text2, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.chunkId}>
                      {d.chunkId.split('::')[1] ?? d.chunkId}
                    </span>
                  </li>
                )
              })}
            </ul>
            {onSelectChunk && r.retrieved.length > 0 && (
              <div style={{ fontSize: 10, color: cv.text4, marginTop: 4 }}>Click a chunk to highlight it in the book.</div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: cv.text3, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
      {children}
    </div>
  )
}

export default EvalRunDetailModal
