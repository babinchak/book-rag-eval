import { useEffect, useState } from 'react'
import type {
  AutoGenerateFailure,
  ChunkSetSummary,
  EmbeddingSetSummary,
  EvalCase,
  EvalMode,
  EvalRunSummary,
  EvalSet,
  EvalSetSummary,
  IpcError
} from '../../../preload/types'
import { cv } from '../lib/theme'
import { chatCostUsd, embeddingCostUsd, formatUsd } from '../../../shared/pricing'
import AddCaseModal from './AddCaseModal'
import EvalRunDetailModal from './EvalRunDetailModal'
import EvalCompareModal from './EvalCompareModal'
import AutoGenPanel from './AutoGenPanel'
import ErrorDisplay from './ErrorDisplay'

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
  const [editingCase, setEditingCase] = useState<EvalCase | null>(null)
  const [casePickerForCaseId, setCasePickerForCaseId] = useState<string | null>(null)
  const [runningCase, setRunningCase] = useState<string | null>(null)
  const [runMode, setRunMode] = useState<EvalMode>('retrieval')
  const [running, setRunning] = useState<string | null>(null)
  const [k, setK] = useState(DEFAULT_K)
  const [error, setError] = useState<IpcError | null>(null)
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [autoGenOpen, setAutoGenOpen] = useState(false)
  const [autoGenStrategy, setAutoGenStrategy] = useState<string>('')
  const [autoGenCount, setAutoGenCount] = useState(10)
  const [autoGenRunning, setAutoGenRunning] = useState(false)
  const [autoGenStatus, setAutoGenStatus] = useState<string | null>(null)
  const [autoGenFailures, setAutoGenFailures] = useState<AutoGenerateFailure[]>([])
  const [backfilling, setBackfilling] = useState(false)

  const missingSearchQueryCount = activeSet
    ? activeSet.cases.filter((c) => !c.searchQuery || !c.searchQuery.trim()).length
    : 0

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

  useEffect(() => {
    if (chunkSets.length === 0) {
      setAutoGenStrategy('')
      return
    }
    if (!chunkSets.find((c) => c.strategyId === autoGenStrategy)) {
      setAutoGenStrategy(chunkSets[0].strategyId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkSets])

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
      const r = await window.api.evals.run(bookId, selectedEvalSetId, strategyId, k, runMode)
      if (!r.ok) { setError(r.error); return }
      await refreshRuns()
    } finally {
      setRunning(null)
    }
  }

  async function handleAutoGenerate(): Promise<void> {
    if (!selectedEvalSetId || !autoGenStrategy) return
    setAutoGenRunning(true)
    setAutoGenStatus(null)
    setAutoGenFailures([])
    setError(null)
    try {
      const r = await window.api.evals.autoGenerate(
        bookId,
        selectedEvalSetId,
        autoGenStrategy,
        autoGenCount
      )
      if (!r.ok) {
        setError(r.error)
        return
      }
      const { generated, failed, failures, model, promptTokens, completionTokens } = r.data
      const costStr =
        model && promptTokens !== undefined && completionTokens !== undefined
          ? ` · ${formatUsd(chatCostUsd(model, promptTokens, completionTokens))}`
          : ''
      setAutoGenStatus(
        `Generated ${generated} case${generated === 1 ? '' : 's'}` +
          (failed > 0 ? ` · ${failed} failed` : '') +
          costStr
      )
      setAutoGenFailures(failures)
      if (failures.length > 0) {
        console.warn('[autoGenerate] failures:', failures)
      }
      await refreshActiveSet(selectedEvalSetId)
      await refreshSets()
    } finally {
      setAutoGenRunning(false)
    }
  }

  async function handleBackfill(): Promise<void> {
    if (!selectedEvalSetId) return
    setBackfilling(true)
    setAutoGenStatus(null)
    setAutoGenFailures([])
    setError(null)
    try {
      const r = await window.api.evals.backfillSearchQueries(bookId, selectedEvalSetId)
      if (!r.ok) {
        setError(r.error)
        return
      }
      const { generated, failed, failures, model, promptTokens, completionTokens } = r.data
      const costStr =
        model && promptTokens !== undefined && completionTokens !== undefined
          ? ` · ${formatUsd(chatCostUsd(model, promptTokens, completionTokens))}`
          : ''
      setAutoGenStatus(
        `Backfilled ${generated} search ${generated === 1 ? 'query' : 'queries'}` +
          (failed > 0 ? ` · ${failed} failed` : '') +
          costStr
      )
      setAutoGenFailures(failures)
      if (failures.length > 0) {
        console.warn('[backfillSearchQueries] failures:', failures)
      }
      await refreshActiveSet(selectedEvalSetId)
    } finally {
      setBackfilling(false)
    }
  }

  async function handleRunCase(caseId: string, strategyId: string): Promise<void> {
    if (!selectedEvalSetId) return
    setRunningCase(`${caseId}::${strategyId}`)
    setCasePickerForCaseId(null)
    setError(null)
    try {
      const r = await window.api.evals.run(bookId, selectedEvalSetId, strategyId, k, runMode, [caseId])
      if (!r.ok) { setError(r.error); return }
      await refreshRuns()
      setDetailRunId(r.data.id)
    } finally {
      setRunningCase(null)
    }
  }

  function latestRun(setId: string, strategyId: string): EvalRunSummary | undefined {
    return runs.find(
      (r) =>
        r.evalSetId === setId &&
        r.strategyId === strategyId &&
        (r.mode ?? 'agentic') === runMode
    )
  }

  const compareRunIds = activeSet
    ? fullyEmbedded
        .map((e) => latestRun(activeSet.id, e.strategyId)?.id)
        .filter((id): id is string => id !== undefined)
    : []

  const modals = (
    <>
      {(showAddCase || editingCase) && selectedEvalSetId && (
        <AddCaseModal
          bookId={bookId}
          setId={selectedEvalSetId}
          editCase={editingCase ?? undefined}
          onClose={() => { setShowAddCase(false); setEditingCase(null) }}
          onSaved={() => {
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

  const inputStyle: React.CSSProperties = {
    flex: 1,
    padding: '5px 7px',
    fontSize: 12,
    fontFamily: 'monospace',
    border: `1px solid ${cv.border2}`,
    borderRadius: 4,
    background: cv.bg,
    color: cv.text1
  }

  const primaryBtn: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer',
    background: cv.accent,
    color: cv.accentText,
    border: 'none',
    borderRadius: 4
  }

  const ghostBtn: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer',
    background: cv.bg,
    color: cv.text2,
    border: `1px solid ${cv.border3}`,
    borderRadius: 4
  }

  const newSetBtn: React.CSSProperties = {
    width: '100%',
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    background: cv.bg,
    color: cv.text3,
    border: `1px dashed ${cv.border2}`,
    borderRadius: 4,
    marginBottom: 8
  }

  if (layout === 'full') {
    return (
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
        {/* Col 1: Eval sets */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            borderRight: `1px solid ${cv.border}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${cv.border}`, flexShrink: 0 }}>
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
                  style={inputStyle}
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
              <div style={{ fontSize: 11, color: cv.text4 }}>No eval sets yet</div>
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
                        background: selected ? cv.selectedBg : cv.bg,
                        border: `1px solid ${selected ? cv.selectedBorder : cv.border}`,
                        borderRadius: 4,
                        cursor: 'pointer'
                      }}
                    >
                      <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, color: cv.text1 }}>{s.id}</span>
                      <span style={{ color: cv.text4, fontSize: 11 }}>{s.caseCount}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDelete(s.id) }}
                        style={{ padding: '0 5px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: cv.text5, border: 'none' }}
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
            borderRight: `1px solid ${cv.border}`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${cv.border}`, flexShrink: 0 }}>
            <ColHeader>
              {activeSet ? `Cases (${activeSet.cases.length})` : 'Cases'}
            </ColHeader>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
            {!activeSet ? (
              <div style={{ fontSize: 12, color: cv.text5 }}>Select an eval set</div>
            ) : activeSet.cases.length === 0 ? (
              <div style={{ fontSize: 12, color: cv.text4, marginBottom: 8 }}>No cases yet.</div>
            ) : (
              <ul style={{ margin: '0 0 8px', padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {activeSet.cases.map((c) => (
                  <li
                    key={c.id}
                    style={{
                      fontSize: 12,
                      background: cv.bg,
                      border: `1px solid ${cv.border}`,
                      borderRadius: 4,
                      padding: '6px 8px',
                      color: cv.text1
                    }}
                  >
                    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
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
                      onClick={() => setCasePickerForCaseId((p) => p === c.id ? null : c.id)}
                      title="Run this case"
                      style={{ padding: '0 5px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: casePickerForCaseId === c.id ? cv.accent : cv.text4, border: 'none', flexShrink: 0 }}
                    >
                      ▶
                    </button>
                    <button
                      onClick={() => setEditingCase(c)}
                      title="Edit case"
                      style={{ padding: '0 5px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: cv.text4, border: 'none', flexShrink: 0 }}
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => void handleRemoveCase(c.id)}
                      title="Remove case"
                      style={{ padding: '0 4px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: cv.text5, border: 'none', flexShrink: 0 }}
                    >
                      ×
                    </button>
                    </div>
                    {casePickerForCaseId === c.id && (
                      <CaseRunPicker
                        caseId={c.id}
                        fullyEmbedded={fullyEmbedded}
                        runningCase={runningCase}
                        onRun={handleRunCase}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {activeSet && (
              <button onClick={() => setShowAddCase(true)} style={newSetBtn}>
                + Add case
              </button>
            )}
            {activeSet && (
              <AutoGenPanel
                open={autoGenOpen}
                onOpenToggle={() => setAutoGenOpen((v) => !v)}
                chunkSets={chunkSets}
                strategyId={autoGenStrategy}
                onStrategyChange={setAutoGenStrategy}
                count={autoGenCount}
                onCountChange={setAutoGenCount}
                running={autoGenRunning}
                status={autoGenStatus}
                failures={autoGenFailures}
                onGenerate={handleAutoGenerate}
                missingSearchQueryCount={missingSearchQueryCount}
                backfilling={backfilling}
                onBackfill={handleBackfill}
              />
            )}
          </div>
        </div>

        {/* Col 3: Run + Results */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px 10px', borderBottom: `1px solid ${cv.border}`, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <ColHeader>Results</ColHeader>
            <ModeTabs mode={runMode} onChange={setRunMode} />
            {activeSet && activeSet.cases.length > 0 && (
              <label style={{ fontSize: 12, color: cv.text3, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                k =
                <input
                  type="number"
                  value={k}
                  min={1}
                  max={20}
                  onChange={(e) => setK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  style={{ width: 40, padding: '3px 5px', fontSize: 12, border: `1px solid ${cv.border2}`, borderRadius: 3, background: cv.bg, color: cv.text1 }}
                />
              </label>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
            <ErrorDisplay error={error} marginTop={0} />

            {!activeSet ? (
              <div style={{ fontSize: 12, color: cv.text5 }}>Select an eval set to run</div>
            ) : activeSet.cases.length === 0 ? (
              <div style={{ fontSize: 12, color: cv.text5 }}>Add cases to run evals</div>
            ) : fullyEmbedded.length === 0 ? (
              <div style={{ fontSize: 12, color: cv.text4 }}>
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
                        style={{ background: cv.bg, border: `1px solid ${cv.border}`, borderRadius: 6, padding: '12px 14px' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: last ? 8 : 0 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontFamily: 'monospace', fontSize: 12, color: cv.text1 }}>
                              {e.strategyId}
                            </span>
                            <SetupCostLabel embedding={e} />
                          </div>
                          <button
                            onClick={() => void handleRun(e.strategyId)}
                            disabled={running !== null}
                            style={{
                              padding: '5px 14px',
                              fontSize: 12,
                              cursor: running !== null ? 'wait' : 'pointer',
                              background: last ? cv.bg : cv.accent,
                              color: last ? cv.text2 : cv.accentText,
                              border: last ? `1px solid ${cv.border2}` : 'none',
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
                              {last.agentModel &&
                                last.totalPromptTokens !== undefined &&
                                last.totalCompletionTokens !== undefined && (
                                  <Metric
                                    label="Cost"
                                    value={formatUsd(
                                      chatCostUsd(
                                        last.agentModel,
                                        last.totalPromptTokens,
                                        last.totalCompletionTokens
                                      )
                                    )}
                                  />
                                )}
                            </div>
                            <div style={{ fontSize: 11, color: cv.text4, display: 'flex', gap: 10, alignItems: 'center' }}>
                              <button
                                onClick={() => setDetailRunId(last.id)}
                                style={{ padding: 0, fontSize: 11, cursor: 'pointer', background: 'transparent', border: 'none', color: cv.accent, textDecoration: 'underline' }}
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
                    style={{ width: '100%', marginTop: 10, padding: '8px 14px', fontSize: 12, cursor: 'pointer', background: cv.bg, color: cv.text2, border: `1px solid ${cv.border2}`, borderRadius: 5 }}
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

  // Sidebar layout
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
            style={{ flex: 1, padding: '6px 8px', fontSize: 12, fontFamily: 'monospace', border: `1px solid ${cv.border2}`, borderRadius: 4, background: cv.bg, color: cv.text1 }}
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
        <div style={{ fontSize: 11, color: cv.text4 }}>No eval sets yet</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
          {sets.map((s) => {
            const selected = selectedEvalSetId === s.id
            return (
              <li
                key={s.id}
                onClick={() => onSelectEvalSet(s.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 12, background: selected ? cv.selectedBg : cv.bg, border: `1px solid ${selected ? cv.selectedBorder : cv.border}`, borderRadius: 4, cursor: 'pointer' }}
              >
                <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, color: cv.text1 }}>{s.id}</span>
                <span style={{ color: cv.text4, fontSize: 11 }}>{s.caseCount}</span>
                <button onClick={(e) => { e.stopPropagation(); void handleDelete(s.id) }} style={{ padding: '0 6px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: cv.text5, border: 'none' }}>×</button>
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
              <div style={{ fontSize: 11, color: cv.text4, marginBottom: 6 }}>No cases yet.</div>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4, marginBottom: 6 }}>
                {activeSet.cases.map((c) => (
                  <li key={c.id} style={{ fontSize: 11, background: cv.bg, border: `1px solid ${cv.border}`, borderRadius: 4, padding: '4px 8px', color: cv.text1 }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                      <span style={{ flex: 1, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.question}</span>
                      <button onClick={() => setCasePickerForCaseId((p) => p === c.id ? null : c.id)} title="Run this case" style={{ padding: '0 4px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: casePickerForCaseId === c.id ? cv.accent : cv.text4, border: 'none' }}>▶</button>
                      <button onClick={() => setEditingCase(c)} title="Edit case" style={{ padding: '0 4px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: cv.text4, border: 'none' }}>✎</button>
                      <button onClick={() => void handleRemoveCase(c.id)} title="Remove case" style={{ padding: '0 4px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: cv.text5, border: 'none' }}>×</button>
                    </div>
                    {casePickerForCaseId === c.id && (
                      <CaseRunPicker
                        caseId={c.id}
                        fullyEmbedded={fullyEmbedded}
                        runningCase={runningCase}
                        onRun={handleRunCase}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => setShowAddCase(true)} style={newSetBtn}>
              + Add case
            </button>
          </div>

          {activeSet.cases.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: cv.text2, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                Run @
                <input type="number" value={k} min={1} max={20} onChange={(e) => setK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))} style={{ width: 36, padding: '2px 4px', fontSize: 11, border: `1px solid ${cv.border2}`, borderRadius: 3, background: cv.bg, color: cv.text1 }} />
                <ModeTabs mode={runMode} onChange={setRunMode} />
              </div>
              {fullyEmbedded.length === 0 ? (
                <div style={{ fontSize: 11, color: cv.text4 }}>No fully-embedded strategies.</div>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                  {fullyEmbedded.map((e) => {
                    const last = latestRun(activeSet.id, e.strategyId)
                    const isRunning = running === e.strategyId
                    return (
                      <li key={e.strategyId} style={{ background: cv.bg, border: `1px solid ${cv.border}`, borderRadius: 4, padding: '6px 8px', fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <span style={{ fontFamily: 'monospace', fontSize: 11, color: cv.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.strategyId}>{e.strategyId}</span>
                            <SetupCostLabel embedding={e} />
                          </div>
                          <button onClick={() => void handleRun(e.strategyId)} disabled={running !== null} style={{ padding: '3px 8px', fontSize: 11, cursor: running !== null ? 'wait' : 'pointer', background: cv.bg, color: cv.text2, border: `1px solid ${cv.border2}`, borderRadius: 3 }}>
                            {isRunning ? '…' : last ? 'Re-run' : 'Run'}
                          </button>
                        </div>
                        {last && (
                          <>
                            <div style={{ marginTop: 4, color: cv.text2, fontSize: 11 }}>
                              R@{last.k}={last.meanRecallAtK.toFixed(2)} · MRR={last.meanMRR.toFixed(2)}
                              {last.meanCitationPrecision !== undefined && <> · CitP={last.meanCitationPrecision.toFixed(2)} · CitR={last.meanCitationRecall?.toFixed(2)}</>}
                              {last.agentModel && last.totalPromptTokens !== undefined && last.totalCompletionTokens !== undefined && (
                                <> · {formatUsd(chatCostUsd(last.agentModel, last.totalPromptTokens, last.totalCompletionTokens))}</>
                              )}
                            </div>
                            <div style={{ marginTop: 2, fontSize: 10, color: cv.text4 }}>
                              <button onClick={() => setDetailRunId(last.id)} style={{ padding: 0, fontSize: 10, cursor: 'pointer', background: 'transparent', border: 'none', color: cv.accent, textDecoration: 'underline' }}>View details</button>
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
                <button onClick={() => setCompareOpen(true)} style={{ width: '100%', marginTop: 8, padding: '6px 10px', fontSize: 11, cursor: 'pointer', background: cv.bg, color: cv.text2, border: `1px solid ${cv.border2}`, borderRadius: 4 }}>
                  Compare {compareRunIds.length} runs
                </button>
              )}
            </div>
          )}
        </>
      )}

      <ErrorDisplay error={error} marginTop={12} />

      {modals}
    </div>
  )
}

function ModeTabs({ mode, onChange }: { mode: EvalMode; onChange: (m: EvalMode) => void }): React.JSX.Element {
  return (
    <div style={{ display: 'inline-flex', background: cv.surface2, border: `1px solid ${cv.border}`, borderRadius: 4, padding: 1 }}>
      {(['retrieval', 'agentic'] as EvalMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          title={m === 'retrieval' ? 'Retrieval-only: free, fast, deterministic' : 'Full agentic: LLM + retrieve as tool + citations'}
          style={{
            padding: '2px 8px',
            fontSize: 10,
            cursor: 'pointer',
            background: mode === m ? cv.bg : 'transparent',
            color: mode === m ? cv.text1 : cv.text4,
            border: `1px solid ${mode === m ? cv.border2 : 'transparent'}`,
            borderRadius: 3,
            fontWeight: mode === m ? 600 : 500,
            textTransform: 'capitalize'
          }}
        >
          {m}
        </button>
      ))}
    </div>
  )
}

function CaseRunPicker({
  caseId,
  fullyEmbedded,
  runningCase,
  onRun
}: {
  caseId: string
  fullyEmbedded: EmbeddingSetSummary[]
  runningCase: string | null
  onRun: (caseId: string, strategyId: string) => Promise<void>
}): React.JSX.Element {
  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${cv.border}` }}>
      <div style={{ fontSize: 10, color: cv.text4, marginBottom: 4 }}>Run case against:</div>
      {fullyEmbedded.length === 0 ? (
        <div style={{ fontSize: 10, color: cv.text4 }}>No fully-embedded strategies.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {fullyEmbedded.map((e) => {
            const isRunning = runningCase === `${caseId}::${e.strategyId}`
            return (
              <button
                key={e.strategyId}
                onClick={() => void onRun(caseId, e.strategyId)}
                disabled={runningCase !== null}
                style={{
                  padding: '3px 8px',
                  fontSize: 10,
                  cursor: runningCase !== null ? 'wait' : 'pointer',
                  background: cv.bg,
                  color: cv.text2,
                  border: `1px solid ${cv.border2}`,
                  borderRadius: 3,
                  fontFamily: 'monospace'
                }}
              >
                {isRunning ? '…' : e.strategyId}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SetupCostLabel({
  embedding
}: {
  embedding: EmbeddingSetSummary
}): React.JSX.Element | null {
  if (embedding.totalTokens === undefined) return null
  const cost = embeddingCostUsd(embedding.model, embedding.totalTokens)
  if (cost === null) return null
  return (
    <span
      style={{ fontSize: 10, color: cv.text4, fontFamily: 'monospace', marginTop: 2 }}
      title={`Setup: ${embedding.totalTokens.toLocaleString()} embedding tokens @ ${embedding.model}`}
    >
      setup {formatUsd(cost)}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 10, color: cv.text4, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: cv.text1 }}>{value}</div>
    </div>
  )
}

function ColHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 style={{ margin: 0, fontSize: 11, fontWeight: 700, color: cv.text2, textTransform: 'uppercase', letterSpacing: 0.6 }}>
      {children}
    </h3>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: cv.text2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {children}
    </h3>
  )
}

export default EvalRunnerPanel
