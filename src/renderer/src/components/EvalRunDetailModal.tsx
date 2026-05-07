import { useEffect, useState } from 'react'
import type {
  EvalCaseResult,
  EvalRunResult,
  EvalSet,
  GoldSpan
} from '../../../preload/types'

interface EvalRunDetailModalProps {
  bookId: string
  runId: string
  evalSet: EvalSet | null
  onClose: () => void
  onSelectChunk?: (strategyId: string, chunkId: string) => void
}

function EvalRunDetailModal({
  bookId,
  runId,
  evalSet,
  onClose,
  onSelectChunk
}: EvalRunDetailModalProps): React.JSX.Element {
  const [run, setRun] = useState<EvalRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.evals.getRun(bookId, runId).then((r) => {
      if (cancelled) return
      if (r.ok) {
        setRun(r.data)
        if (r.data.cases[0]) setExpandedCaseId(r.data.cases[0].caseId)
      } else setError(r.error)
    })
    return () => {
      cancelled = true
    }
  }, [bookId, runId])

  function caseGoldSpans(caseId: string): GoldSpan[] {
    const c = evalSet?.cases.find((x) => x.id === caseId)
    return c?.goldSpans ?? []
  }

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
          padding: 0,
          width: 900,
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
          <h2 style={{ margin: 0, fontSize: 16 }}>Run detail</h2>
          {run && (
            <span style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
              {run.strategyId} · k={run.k} ·{' '}
              {new Date(run.ranAt).toLocaleString()}
            </span>
          )}
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

        {run && (
          <>
            <div
              style={{
                padding: '12px 20px',
                background: '#fafafa',
                borderBottom: '1px solid #eee',
                display: 'flex',
                gap: 24,
                fontSize: 12
              }}
            >
              <Metric label={`R@${run.k}`} value={run.meanRecallAtK.toFixed(2)} />
              <Metric label="MRR" value={run.meanMRR.toFixed(2)} />
              {run.meanCitationPrecision !== undefined && (
                <Metric
                  label="Cit. precision"
                  value={run.meanCitationPrecision.toFixed(2)}
                />
              )}
              {run.meanCitationRecall !== undefined && (
                <Metric label="Cit. recall" value={run.meanCitationRecall.toFixed(2)} />
              )}
              {run.totalTokens !== undefined && (
                <Metric label="Tokens" value={run.totalTokens.toLocaleString()} />
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
              {run.cases.map((caseResult) => (
                <CaseCard
                  key={caseResult.caseId}
                  caseResult={caseResult}
                  expanded={expandedCaseId === caseResult.caseId}
                  onToggle={() =>
                    setExpandedCaseId(
                      expandedCaseId === caseResult.caseId ? null : caseResult.caseId
                    )
                  }
                  goldSpans={caseGoldSpans(caseResult.caseId)}
                  strategyId={run.strategyId}
                  onSelectChunk={
                    onSelectChunk
                      ? (chunkId) => {
                          onSelectChunk(run.strategyId, chunkId)
                          onClose()
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({
  label,
  value
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div>
      <div style={{ color: '#888', fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: '#222' }}>{value}</div>
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

function CaseCard({
  caseResult,
  expanded,
  onToggle,
  goldSpans,
  onSelectChunk
}: CaseCardProps): React.JSX.Element {
  const r = caseResult
  const recallColor = r.recallAtK ? '#10b981' : '#ef4444'
  const citedSet = new Set(r.citedChunkIds ?? [])

  return (
    <div
      style={{
        border: '1px solid #e5e5e5',
        borderRadius: 6,
        marginBottom: 10,
        overflow: 'hidden'
      }}
    >
      <div
        onClick={onToggle}
        style={{
          padding: '10px 14px',
          background: expanded ? '#f9fafb' : '#fff',
          cursor: 'pointer',
          display: 'flex',
          gap: 10,
          alignItems: 'center'
        }}
      >
        <span style={{ fontSize: 12, color: '#666', fontFamily: 'monospace' }}>
          {expanded ? '▼' : '▶'}
        </span>
        <span style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>{r.question}</span>
        {r.langsmithRunUrl && (
          <a
            href={r.langsmithRunUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 10, color: '#2563eb', textDecoration: 'underline' }}
            title="Open LangSmith trace"
          >
            trace ↗
          </a>
        )}
        <span
          style={{
            fontSize: 11,
            background: recallColor,
            color: '#fff',
            padding: '2px 6px',
            borderRadius: 3
          }}
        >
          {r.recallAtK ? `hit @ ${r.hitRank}` : 'miss'}
        </span>
        {r.citationPrecision !== undefined && (
          <span style={{ fontSize: 11, color: '#666', fontFamily: 'monospace' }}>
            cit P/R: {r.citationPrecision.toFixed(2)}/{r.citationRecall?.toFixed(2)}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '12px 14px', background: '#fff', borderTop: '1px solid #f0f0f0' }}>
          {r.answer && (
            <section style={{ marginBottom: 14 }}>
              <SectionLabel>Answer</SectionLabel>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.5,
                  background: '#fafafa',
                  border: '1px solid #e5e5e5',
                  borderRadius: 4,
                  padding: 10,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {r.answer}
              </div>
              {r.citedRanks && r.citedRanks.length > 0 && (
                <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                  cited: [{r.citedRanks.join(', ')}]
                </div>
              )}
            </section>
          )}

          {goldSpans.length > 0 && (
            <section style={{ marginBottom: 14 }}>
              <SectionLabel>Gold spans</SectionLabel>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {goldSpans.map((g, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: 11,
                      fontFamily: 'monospace',
                      background: '#fef3c7',
                      border: '1px solid #fde68a',
                      borderRadius: 4,
                      padding: '4px 8px'
                    }}
                  >
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
                      background: d.hit ? '#ecfdf5' : '#fff',
                      border:
                        '1px solid ' + (d.hit ? '#6ee7b7' : '#e5e5e5'),
                      borderRadius: 4,
                      padding: '6px 8px'
                    }}
                  >
                    <span style={{ fontWeight: 600, color: '#444' }}>#{d.rank}</span>
                    <span
                      style={{
                        color: d.hit ? '#065f46' : '#888',
                        fontFamily: 'monospace'
                      }}
                    >
                      d={d.distance.toFixed(2)}
                    </span>
                    {d.hit && (
                      <span
                        style={{
                          fontSize: 10,
                          background: '#10b981',
                          color: '#fff',
                          padding: '1px 5px',
                          borderRadius: 2
                        }}
                      >
                        hit · {d.overlap}c
                      </span>
                    )}
                    {isCited && (
                      <span
                        style={{
                          fontSize: 10,
                          background: '#3b82f6',
                          color: '#fff',
                          padding: '1px 5px',
                          borderRadius: 2
                        }}
                      >
                        cited
                      </span>
                    )}
                    <span
                      style={{
                        flex: 1,
                        color: '#444',
                        fontFamily: 'monospace',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                      title={d.chunkId}
                    >
                      {d.chunkId.split('::')[1] ?? d.chunkId}
                    </span>
                  </li>
                )
              })}
            </ul>
            {onSelectChunk && r.retrieved.length > 0 && (
              <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                Click a chunk to highlight it in the book.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: '#666',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 4
      }}
    >
      {children}
    </div>
  )
}

export default EvalRunDetailModal
