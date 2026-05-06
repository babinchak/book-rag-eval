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

interface EvaluationSectionProps {
  bookId: string
  chunkSets: ChunkSetSummary[]
  embeddingSets: EmbeddingSetSummary[]
  onSelectChunk?: (strategyId: string, chunkId: string) => void
}

const DEFAULT_K = 5

function EvaluationSection({
  bookId,
  chunkSets,
  embeddingSets,
  onSelectChunk
}: EvaluationSectionProps): React.JSX.Element {
  const [sets, setSets] = useState<EvalSetSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
      if (!selectedId && r.sets.length > 0) setSelectedId(r.sets[0].id)
      if (selectedId && !r.sets.find((s) => s.id === selectedId)) {
        setSelectedId(r.sets[0]?.id ?? null)
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
    if (selectedId) void refreshActiveSet(selectedId)
    else setActiveSet(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, bookId])

  async function handleCreate(): Promise<void> {
    const id = newSetId.trim()
    if (!id) return
    const r = await window.api.evals.create(bookId, id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setNewSetId('')
    setCreating(false)
    setSelectedId(r.data.id)
    await refreshSets()
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`Delete eval set "${id}"?`)) return
    const r = await window.api.evals.delete(bookId, id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    if (selectedId === id) setSelectedId(null)
    await refreshSets()
  }

  async function handleRemoveCase(caseId: string): Promise<void> {
    if (!selectedId) return
    const r = await window.api.evals.removeCase(bookId, selectedId, caseId)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await refreshActiveSet(selectedId)
    await refreshSets()
  }

  async function handleRun(strategyId: string): Promise<void> {
    if (!selectedId) return
    setRunning(strategyId)
    setError(null)
    try {
      const r = await window.api.evals.run(bookId, selectedId, strategyId, k)
      if (!r.ok) {
        setError(r.error)
        return
      }
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

  return (
    <section style={{ marginTop: 20 }}>
      <h3
        style={{
          margin: '0 0 8px',
          fontSize: 12,
          fontWeight: 600,
          color: '#444',
          textTransform: 'uppercase',
          letterSpacing: 0.5
        }}
      >
        Evaluation
      </h3>

      {creating ? (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="set-id (no spaces)"
            value={newSetId}
            onChange={(e) => setNewSetId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
            autoFocus
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'monospace',
              border: '1px solid #d4d4d4',
              borderRadius: 4
            }}
          />
          <button
            onClick={handleCreate}
            disabled={!newSetId.trim()}
            style={{
              padding: '6px 10px',
              fontSize: 11,
              cursor: 'pointer',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 4
            }}
          >
            ✓
          </button>
          <button
            onClick={() => setCreating(false)}
            style={{
              padding: '6px 10px',
              fontSize: 11,
              cursor: 'pointer',
              background: '#fff',
              border: '1px solid #ccc',
              borderRadius: 4
            }}
          >
            ×
          </button>
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: 12,
            cursor: 'pointer',
            background: '#fff',
            border: '1px dashed #d4d4d4',
            borderRadius: 4,
            marginBottom: 8
          }}
        >
          + New eval set
        </button>
      )}

      {sets.length === 0 ? (
        <div style={{ fontSize: 11, color: '#888' }}>No eval sets yet</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
          {sets.map((s) => (
            <li
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 8px',
                fontSize: 12,
                background: selectedId === s.id ? '#eef2ff' : '#fff',
                border:
                  selectedId === s.id ? '1px solid #818cf8' : '1px solid #e5e5e5',
                borderRadius: 4,
                cursor: 'pointer'
              }}
              onClick={() => setSelectedId(s.id)}
            >
              <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}>{s.id}</span>
              <span style={{ color: '#888', fontSize: 11 }}>{s.caseCount}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void handleDelete(s.id)
                }}
                title="Delete"
                style={{
                  padding: '0 6px',
                  fontSize: 12,
                  cursor: 'pointer',
                  background: 'transparent',
                  color: '#999',
                  border: 'none'
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeSet && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#444',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginBottom: 6
            }}
          >
            Cases ({activeSet.cases.length})
          </div>
          {activeSet.cases.length === 0 ? (
            <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
              No cases yet. Add one below.
            </div>
          ) : (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: 4,
                marginBottom: 6
              }}
            >
              {activeSet.cases.map((c) => (
                <li
                  key={c.id}
                  style={{
                    fontSize: 11,
                    background: '#fff',
                    border: '1px solid #e5e5e5',
                    borderRadius: 4,
                    padding: '4px 8px',
                    display: 'flex',
                    gap: 4,
                    alignItems: 'flex-start'
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      lineHeight: 1.3,
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
                    title="Remove"
                    style={{
                      padding: '0 4px',
                      fontSize: 11,
                      cursor: 'pointer',
                      background: 'transparent',
                      color: '#999',
                      border: 'none'
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => setShowAddCase(true)}
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: 11,
              cursor: 'pointer',
              background: '#fff',
              border: '1px dashed #d4d4d4',
              borderRadius: 4
            }}
          >
            + Add case
          </button>

          {activeSet.cases.length > 0 && fullyEmbedded.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#444',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginTop: 14,
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
              >
                Run @
                <input
                  type="number"
                  value={k}
                  min={1}
                  max={20}
                  onChange={(e) =>
                    setK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))
                  }
                  style={{
                    width: 36,
                    padding: '2px 4px',
                    fontSize: 11,
                    border: '1px solid #d4d4d4',
                    borderRadius: 3
                  }}
                />
              </div>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {fullyEmbedded.map((e) => {
                  const last = latestRun(activeSet.id, e.strategyId)
                  const isRunning = running === e.strategyId
                  return (
                    <li
                      key={e.strategyId}
                      style={{
                        background: '#fff',
                        border: '1px solid #e5e5e5',
                        borderRadius: 4,
                        padding: '6px 8px',
                        fontSize: 11
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 6
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontSize: 11,
                            color: '#444',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                          title={e.strategyId}
                        >
                          {e.strategyId}
                        </span>
                        <button
                          onClick={() => void handleRun(e.strategyId)}
                          disabled={running !== null}
                          style={{
                            padding: '3px 8px',
                            fontSize: 11,
                            cursor: running !== null ? 'wait' : 'pointer',
                            background: '#fff',
                            border: '1px solid #d4d4d4',
                            borderRadius: 3
                          }}
                        >
                          {isRunning ? '…' : last ? 'Re-run' : 'Run'}
                        </button>
                      </div>
                      {last && (
                        <>
                          <div style={{ marginTop: 4, color: '#444', fontSize: 11 }}>
                            R@{last.k}={last.meanRecallAtK.toFixed(2)} · MRR=
                            {last.meanMRR.toFixed(2)}
                            {last.meanCitationPrecision !== undefined && (
                              <>
                                {' '}
                                · CitP={last.meanCitationPrecision.toFixed(2)} · CitR=
                                {last.meanCitationRecall?.toFixed(2)}
                              </>
                            )}
                          </div>
                          <div style={{ marginTop: 2, fontSize: 10, color: '#888' }}>
                            <button
                              onClick={() => setDetailRunId(last.id)}
                              style={{
                                padding: 0,
                                fontSize: 10,
                                cursor: 'pointer',
                                background: 'transparent',
                                border: 'none',
                                color: '#2563eb',
                                textDecoration: 'underline'
                              }}
                            >
                              View details
                            </button>
                            <span style={{ marginLeft: 6 }}>
                              {new Date(last.ranAt).toLocaleString()}
                            </span>
                          </div>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
              {compareRunIds.length >= 2 && (
                <button
                  onClick={() => setCompareOpen(true)}
                  style={{
                    width: '100%',
                    marginTop: 8,
                    padding: '6px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                    background: '#fff',
                    border: '1px solid #d4d4d4',
                    borderRadius: 4
                  }}
                >
                  Compare {compareRunIds.length} runs
                </button>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <pre
          style={{
            color: '#b00',
            whiteSpace: 'pre-wrap',
            marginTop: 12,
            background: '#fee',
            padding: 8,
            border: '1px solid #fbb',
            borderRadius: 4,
            fontSize: 10
          }}
        >
          {error}
        </pre>
      )}

      {showAddCase && selectedId && (
        <AddCaseModal
          bookId={bookId}
          setId={selectedId}
          onClose={() => setShowAddCase(false)}
          onAdded={() => {
            void refreshActiveSet(selectedId)
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
    </section>
  )
}

export default EvaluationSection
