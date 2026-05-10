import { useEffect, useState } from 'react'
import type { EvalSet, EvalSetSummary, IpcError } from '../../../preload/types'
import AddCaseModal from './AddCaseModal'
import ErrorDisplay from './ErrorDisplay'

interface EvalAuthoringSectionProps {
  bookId: string
  selectedEvalSetId: string | null
  onSelectEvalSet: (setId: string | null) => void
  onChange: () => void
}

function EvalAuthoringSection({
  bookId,
  selectedEvalSetId,
  onSelectEvalSet,
  onChange
}: EvalAuthoringSectionProps): React.JSX.Element {
  const [sets, setSets] = useState<EvalSetSummary[]>([])
  const [activeSet, setActiveSet] = useState<EvalSet | null>(null)
  const [creating, setCreating] = useState(false)
  const [newSetId, setNewSetId] = useState('')
  const [showAddCase, setShowAddCase] = useState(false)
  const [error, setError] = useState<IpcError | null>(null)

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

  useEffect(() => {
    void refreshSets()
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
    if (!r.ok) {
      setError(r.error)
      return
    }
    setNewSetId('')
    setCreating(false)
    onSelectEvalSet(r.data.id)
    await refreshSets()
    onChange()
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`Delete eval set "${id}"?`)) return
    const r = await window.api.evals.delete(bookId, id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    if (selectedEvalSetId === id) onSelectEvalSet(null)
    await refreshSets()
    onChange()
  }

  async function handleRemoveCase(caseId: string): Promise<void> {
    if (!selectedEvalSetId) return
    const r = await window.api.evals.removeCase(bookId, selectedEvalSetId, caseId)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await refreshActiveSet(selectedEvalSetId)
    await refreshSets()
    onChange()
  }

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
        Eval sets
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
            style={primaryBtn}
          >
            ✓
          </button>
          <button onClick={() => setCreating(false)} style={ghostBtn}>
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
                  padding: '4px 8px',
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
            )
          })}
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
        </div>
      )}

      <ErrorDisplay error={error} marginTop={12} />

      {showAddCase && selectedEvalSetId && (
        <AddCaseModal
          bookId={bookId}
          setId={selectedEvalSetId}
          onClose={() => setShowAddCase(false)}
          onSaved={() => {
            void refreshActiveSet(selectedEvalSetId)
            void refreshSets()
            onChange()
          }}
        />
      )}
    </section>
  )
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

export default EvalAuthoringSection
