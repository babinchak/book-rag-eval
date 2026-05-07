import { useEffect, useState } from 'react'
import type {
  ChunkSetSummary,
  EmbeddingSetSummary,
  EvalRunSummary,
  EvalSet,
  EvalSetSummary
} from '../../../preload/types'
import AddCaseModal from './AddCaseModal'
import EvalRunDetailModal from './EvalRunDetailModal'
import EvalCompareModal from './EvalCompareModal'

interface EvalRunnerPanelProps {
  bookId: string
  selectedEvalSetId: string | null
  onSelectEvalSet: (setId: string | null) => void
  chunkSets: ChunkSetSummary[]
  embeddingSets: EmbeddingSetSummary[]
  onSelectChunk?: (strategyId: string, chunkId: string) => void
  layout?: 'sidebar' | 'full'
}

const DEFAULT_K = 5

function EvalRunnerPanel({
  bookId,
  selectedEvalSetId,
  onSelectEvalSet,
  chunkSets,
  embeddingSets,
  onSelectChunk,
  layout = 'sidebar'
}: EvalRunnerPanelProps): React.JSX.Element {
  const [sets, setSets] = useState<EvalSetSummary[]>([])
  const [activeSet, setActiveSet] = useState<EvalSet | null>(null)
  const [runs, setRuns] = useState<EvalRunSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [newSetId, setNewSetId] = useState('')
  const [showAddCase, setShowAddCase] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [k, setK] = useState(DEFAULT_K)
  const [error, setError] = useState<string | null>(null)
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)

  const fullyEmbedded = embeddingSets.filter((e) => {
    const set = chunkSets.find((s) => s.strategyId === e.strategyId)
    return set !== undefined && e.count >= set.count
  })

  async function refreshSets(): Promise<void> {
    const r = await window.api.evals.list(bookId)
    if (r.ok) {
      setSets(r.sets)
      if (!selectedEvalSetId && r.sets.length > 0) onSelectEvalSet(r.sets[0].id)
      if (selectedEvalSetId && !r.sets.find((s) => s.id === selectedEvalSetId)) {
        onSelectEvalSet(r.sets[0]?.id ?? null)
      }
    } else {
      setError(r.error)
    }
  }

  async function refreshActiveSet(id: string): Promise<void> {
    const r = await window.api.evals.get(bookId, id)
    if (r.ok) setActiveSet(r.data)
    else setError(r.error)
  }

  async function refreshRuns(): Promise<void> {
    const r = await window.api.evals.listRuns(bookId)
    if (r.ok) setRuns(r.runs)
    else setError(r.error)
  }

  useEffect(() => {
    void refreshSets()
    void refreshRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  useEffect(() => {
    if (selectedEvalSetId) void refreshActiveSet(selectedEvalSetId)
    else setActiveSet(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvalSetId, bookId])

  async function handleCreate(): Promise<void> {
    const id = newSetId.trim()
    if (!id) return
    const r = await window.api.evals.create(bookId, id)
    if (!r.ok) { setError(r.error); return }
    setNewSetId('')
    setCreating(false)
    onSelectEvalSet(r.data.id)
    await refreshSets()
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`Delete eval set "${id}"?`)) return
    const r = await window.api.evals.delete(bookId, id)
    if (!r.ok) { setError(r.error); return }
    if (selectedEvalSetId === id) onSelectEvalSet(null)
    await refreshSets()
  }

  async function handleRemoveCase(caseId: string): Promise<void> {
    if (!selectedEvalSetId) return
    const r = await window.api.evals.removeCase(bookId, selectedEvalSetId, caseId)
    if (!r.ok) { setError(r.error); return }
    await refreshActiveSet(selectedEvalSetId)
    await refreshSets()
  }

  async function handleRun(strategyId: string): Promise<void> {
    if (!selectedEvalSetId) return
    setRunning(strategyId)
    setError(null)
    try {
      const r = await window.api.evals.run(bookId, selectedEvalSetId, strategyId, k)
      if (!r.ok) { setError(r.error); return }
      await refreshRuns()
    } finally {
      setRunning(null)
    }
  }

  function latestRun(setId: string, strategyId: string): EvalRunSummary | undefined {
    return runs.find((r) => r.evalSetId === setId && r.strategyId === strategyId)
  }

  const compareRunIds = activeSet
    ? fullyEmbedded
        .map((e) => latestRun(activeSet.id, e.strategyId)?.id)
        .filter((id): id is string => id !== undefined)
    : []

  const modals = (
    <>
      {showAddCase && selectedEvalSetId && (
        <AddCaseModal
          bookId={bookId}
          setId={selectedEvalSetId}
          onClose={() => setShowAddCase(false)}
          onAdded={() => {
            void refreshActiveSet(selectedEvalSetId)
            void refreshSets()
          }}
        />
      )}
      {detailRunId && (
        <EvalRunDetailModal
          bookId={bookId}
          runId={detailRunId}
          evalSet={activeSet}
          onClose={() => setDetailRunId(null)}
          onSelectChunk={onSelectChunk}
        />
      )}
      {compareOpen && activeSet && (
        <EvalCompareModal
          bookId={bookId}
          evalSet={activeSet}
          runIds={compareRunIds}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </>
  )

  if (layout === 'full') {
    return (
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        {/* Col 1: Eval sets */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            borderRight: '1px solid #e5e5e5',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            <ColHeader>Eval sets</ColHeader>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
            {creating ? (
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder="set-id"
                  value={newSetId}
                  onChange={(e) => setNewSetId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  autoFocus
                  style={{
                    flex: 1,
                    padding: '5px 7px',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    border: '1px solid #d4d4d4',
                    borderRadius: 4
                  }}
                />
                <button onClick={handleCreate} disabled={!newSetId.trim()} style={primaryBtn}>✓</button>
                <button onClick={() => setCreating(false)} style={ghostBtn}>×</button>
              </div>
            ) : (
              <button onClick={() => setCreating(true)} style={newSetBtn}>
                + New eval set
              </button>
            )}

            {sets.length === 0 ? (
              <div style={{ fontSize: 11, color: '#888' }}>No eval sets yet</div>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {sets.map((s) => {
                  const selected = selectedEvalSetId === s.id
                  return (
                    <li
                      key={s.id}
                      onClick={() => onSelectEvalSet(s.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '6px 8px',
                        fontSize: 12,
                        background: selected ? '#eef2ff' : '#fff',
                        border: selected ? '1px solid #818cf8' : '1px solid #e5e5e5',
                        borderRadius: 4,
                        cursor: 'pointer'
                      }}
                    >
                      <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}>{s.id}</span>
                      <span style={{ color: '#888', fontSize: 11 }}>{s.caseCount}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDelete(s.id) }}
                        style={{ padding: '0 5px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: '#bbb', border: 'none' }}
                      >
                        ×
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Col 2: Cases */}
        <div
          style={{
            width: 300,
            flexShrink: 0,
            borderRight: '1px solid #e5e5e5',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            <ColHeader>
              {activeSet ? `Cases (${activeSet.cases.length})` : 'Cases'}
            </ColHeader>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
            {!activeSet ? (
              <div style={{ fontSize: 12, color: '#aaa' }}>Select an eval set</div>
            ) : activeSet.cases.length === 0 ? (
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>No cases yet.</div>
            ) : (
              <ul style={{ margin: '0 0 8px', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {activeSet.cases.map((c) => (
                  <li
                    key={c.id}
                    style={{
                      fontSize: 12,
                      background: '#fff',
                      border: '1px solid #e5e5e5',
                      borderRadius: 4,
                      padding: '6px 8px',
                      display: 'flex',
                      gap: 4,
                      alignItems: 'flex-start'
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        lineHeight: 1.4,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden'
                      }}
                    >
                      {c.question}
                    </span>
                    <button
                      onClick={() => void handleRemoveCase(c.id)}
                      style={{ padding: '0 4px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: '#bbb', border: 'none', flexShrink: 0 }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {activeSet && (
              <button onClick={() => setShowAddCase(true)} style={newSetBtn}>
                + Add case
              </button>
            )}
          </div>
        </div>

        {/* Col 3: Run + Results */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <ColHeader>Results</ColHeader>
            {activeSet && activeSet.cases.length > 0 && (
              <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                k =
                <input
                  type="number"
                  value={k}
                  min={1}
                  max={20}
                  onChange={(e) => setK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  style={{ width: 40, padding: '3px 5px', fontSize: 12, border: '1px solid #d4d4d4', borderRadius: 3 }}
                />
              </label>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
            {error && (
              <pre style={{ color: '#b00', whiteSpace: 'pre-wrap', background: '#fee', padding: 8, border: '1px solid #fbb', borderRadius: 4, fontSize: 10, marginBottom: 12 }}>
                {error}
              </pre>
            )}

            {!activeSet ? (
              <div style={{ fontSize: 12, color: '#aaa' }}>Select an eval set to run</div>
            ) : activeSet.cases.length === 0 ? (
              <div style={{ fontSize: 12, color: '#aaa' }}>Add cases to run evals</div>
            ) : fullyEmbedded.length === 0 ? (
              <div style={{ fontSize: 12, color: '#888' }}>
                No fully-embedded strategies. Go to the Strategies tab to embed one.
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8 }}>
                  {fullyEmbedded.map((e) => {
                    const last = latestRun(activeSet.id, e.strategyId)
                    const isRunning = running === e.strategyId
                    return (
                      <div
                        key={e.strategyId}
                        style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: 6, padding: '12px 14px' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: last ? 8 : 0 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#333' }}>
                            {e.strategyId}
                          </span>
                          <button
                            onClick={() => void handleRun(e.strategyId)}
                            disabled={running !== null}
                            style={{
                              padding: '5px 14px',
                              fontSize: 12,
                              cursor: running !== null ? 'wait' : 'pointer',
                              background: last ? '#fff' : '#2563eb',
                              color: last ? '#444' : '#fff',
                              border: last ? '1px solid #d4d4d4' : 'none',
                              borderRadius: 5,
                              flexShrink: 0
                            }}
                          >
                            {isRunning ? 'Running…' : last ? 'Re-run' : 'Run'}
                          </button>
                        </div>
                        {last && (
                          <div>
                            <div style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
                              <Metric label={`R@${last.k}`} value={last.meanRecallAtK.toFixed(2)} />
                              <Metric label="MRR" value={last.meanMRR.toFixed(2)} />
                              {last.meanCitationPrecision !== undefined && (
                                <>
                                  <Metric label="Cit. P" value={last.meanCitationPrecision.toFixed(2)} />
                                  <Metric label="Cit. R" value={(last.meanCitationRecall ?? 0).toFixed(2)} />
                                </>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: '#888', display: 'flex', gap: 10, alignItems: 'center' }}>
                              <button
                                onClick={() => setDetailRunId(last.id)}
                                style={{ padding: 0, fontSize: 11, cursor: 'pointer', background: 'transparent', border: 'none', color: '#2563eb', textDecoration: 'underline' }}
                              >
                                View details
                              </button>
                              <span>{new Date(last.ranAt).toLocaleString()}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {compareRunIds.length >= 2 && (
                  <button
                    onClick={() => setCompareOpen(true)}
                    style={{ width: '100%', marginTop: 10, padding: '8px 14px', fontSize: 12, cursor: 'pointer', background: '#fff', border: '1px solid #d4d4d4', borderRadius: 5 }}
                  >
                    Compare {compareRunIds.length} runs
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {modals}
      </div>
    )
  }

  // Sidebar layout (original)
  return (
    <div style={{ overflowY: 'auto', padding: 12, height: '100%' }}>
      <SectionHeader>Eval sets</SectionHeader>

      {creating ? (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="set-id"
            value={newSetId}
            onChange={(e) => setNewSetId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
            autoFocus
            style={{ flex: 1, padding: '6px 8px', fontSize: 12, fontFamily: 'monospace', border: '1px solid #d4d4d4', borderRadius: 4 }}
          />
          <button onClick={handleCreate} disabled={!newSetId.trim()} style={primaryBtn}>✓</button>
          <button onClick={() => setCreating(false)} style={ghostBtn}>×</button>
        </div>
      ) : (
        <button onClick={() => setCreating(true)} style={{ width: '100%', padding: '6px 10px', fontSize: 12, cursor: 'pointer', background: '#fff', border: '1px dashed #d4d4d4', borderRadius: 4, marginBottom: 8 }}>
          + New eval set
        </button>
      )}

      {sets.length === 0 ? (
        <div style={{ fontSize: 11, color: '#888' }}>No eval sets yet</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
          {sets.map((s) => {
            const selected = selectedEvalSetId === s.id
            return (
              <li
                key={s.id}
                onClick={() => onSelectEvalSet(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 12, background: selected ? '#eef2ff' : '#fff', border: selected ? '1px solid #818cf8' : '1px solid #e5e5e5', borderRadius: 4, cursor: 'pointer' }}
              >
                <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}>{s.id}</span>
                <span style={{ color: '#888', fontSize: 11 }}>{s.caseCount}</span>
                <button onClick={(e) => { e.stopPropagation(); void handleDelete(s.id) }} style={{ padding: '0 6px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: '#999', border: 'none' }}>×</button>
              </li>
            )
          })}
        </ul>
      )}

      {activeSet && (
        <>
          <div style={{ marginTop: 16 }}>
            <SectionHeader>Cases ({activeSet.cases.length})</SectionHeader>
            {activeSet.cases.length === 0 ? (
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>No cases yet.</div>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4, marginBottom: 6 }}>
                {activeSet.cases.map((c) => (
                  <li key={c.id} style={{ fontSize: 11, background: '#fff', border: '1px solid #e5e5e5', borderRadius: 4, padding: '4px 8px', display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                    <span style={{ flex: 1, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.question}</span>
                    <button onClick={() => void handleRemoveCase(c.id)} style={{ padding: '0 4px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: '#999', border: 'none' }}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => setShowAddCase(true)} style={{ width: '100%', padding: '6px 10px', fontSize: 11, cursor: 'pointer', background: '#fff', border: '1px dashed #d4d4d4', borderRadius: 4 }}>
              + Add case
            </button>
          </div>

          {activeSet.cases.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#444', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Run @
                <input type="number" value={k} min={1} max={20} onChange={(e) => setK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))} style={{ width: 36, padding: '2px 4px', fontSize: 11, border: '1px solid #d4d4d4', borderRadius: 3 }} />
              </div>
              {fullyEmbedded.length === 0 ? (
                <div style={{ fontSize: 11, color: '#888' }}>No fully-embedded strategies.</div>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                  {fullyEmbedded.map((e) => {
                    const last = latestRun(activeSet.id, e.strategyId)
                    const isRunning = running === e.strategyId
                    return (
                      <li key={e.strategyId} style={{ background: '#fff', border: '1px solid #e5e5e5', borderRadius: 4, padding: '6px 8px', fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.strategyId}>{e.strategyId}</span>
                          <button onClick={() => void handleRun(e.strategyId)} disabled={running !== null} style={{ padding: '3px 8px', fontSize: 11, cursor: running !== null ? 'wait' : 'pointer', background: '#fff', border: '1px solid #d4d4d4', borderRadius: 3 }}>
                            {isRunning ? '…' : last ? 'Re-run' : 'Run'}
                          </button>
                        </div>
                        {last && (
                          <>
                            <div style={{ marginTop: 4, color: '#444', fontSize: 11 }}>
                              R@{last.k}={last.meanRecallAtK.toFixed(2)} · MRR={last.meanMRR.toFixed(2)}
                              {last.meanCitationPrecision !== undefined && <> · CitP={last.meanCitationPrecision.toFixed(2)} · CitR={last.meanCitationRecall?.toFixed(2)}</>}
                            </div>
                            <div style={{ marginTop: 2, fontSize: 10, color: '#888' }}>
                              <button onClick={() => setDetailRunId(last.id)} style={{ padding: 0, fontSize: 10, cursor: 'pointer', background: 'transparent', border: 'none', color: '#2563eb', textDecoration: 'underline' }}>View details</button>
                              <span style={{ marginLeft: 6 }}>{new Date(last.ranAt).toLocaleString()}</span>
                            </div>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {compareRunIds.length >= 2 && (
                <button onClick={() => setCompareOpen(true)} style={{ width: '100%', marginTop: 8, padding: '6px 10px', fontSize: 11, cursor: 'pointer', background: '#fff', border: '1px solid #d4d4d4', borderRadius: 4 }}>
                  Compare {compareRunIds.length} runs
                </button>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <pre style={{ color: '#b00', whiteSpace: 'pre-wrap', marginTop: 12, background: '#fee', padding: 8, border: '1px solid #fbb', borderRadius: 4, fontSize: 10 }}>
          {error}
        </pre>
      )}

      {modals}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: '#222' }}>{value}</div>
    </div>
  )
}

function ColHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 style={{ margin: 0, fontSize: 11, fontWeight: 700, color: '#444', textTransform: 'uppercase', letterSpacing: 0.6 }}>
      {children}
    </h3>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#444', textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {children}
    </h3>
  )
}

const newSetBtn: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
  background: '#fff',
  border: '1px dashed #d4d4d4',
  borderRadius: 4,
  marginBottom: 8
}

const primaryBtn: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  cursor: 'pointer',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 4
}

const ghostBtn: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 11,
  cursor: 'pointer',
  background: '#fff',
  border: '1px solid #ccc',
  borderRadius: 4
}

export default EvalRunnerPanel
