import { useEffect, useMemo, useState } from 'react'
import type {
  AutoGenerateFailure,
  Bm25IndexSummary,
  ChunkSetSummary,
  EmbeddingSetSummary,
  EvalCase,
  EvalMode,
  EvalRunSummary,
  EvalSet,
  EvalSetSummary,
  IpcError,
  SavedStrategy
} from '../../../preload/types'
import { strategyIdOf } from '../../../shared/strategy'
import { retrieverIdOf } from '../../../shared/retriever'
import { cv } from '../lib/theme'
import { chatCostUsd, embeddingCostUsd, formatUsd } from '../../../shared/pricing'
import AddCaseModal from './AddCaseModal'
import EvalRunDetailModal from './EvalRunDetailModal'
import EvalCompareModal from './EvalCompareModal'
import AutoGenPanel from './AutoGenPanel'
import ErrorDisplay from './ErrorDisplay'
import Leaderboard from './Leaderboard'

interface EvalRunnerPanelProps {
  bookId: string
  selectedEvalSetId: string | null
  onSelectEvalSet: (setId: string | null) => void
  chunkSets: ChunkSetSummary[]
  embeddingSets: EmbeddingSetSummary[]
  bm25Sets: Bm25IndexSummary[]
  onSelectChunk?: (strategyId: string, chunkId: string) => void
  layout?: 'sidebar' | 'full'
}

function isStrategyRunnable(
  strategy: SavedStrategy,
  embeddedChunkerIds: Set<string>,
  bm25ChunkerIds: Set<string>
): { runnable: boolean; missing: string | null } {
  const chunkerId = strategyIdOf(strategy.config.chunker)
  const retriever = strategy.config.retriever.kind
  const hasEmbed = embeddedChunkerIds.has(chunkerId)
  const hasBm25 = bm25ChunkerIds.has(chunkerId)
  if (retriever === 'vector') {
    return hasEmbed
      ? { runnable: true, missing: null }
      : { runnable: false, missing: 'needs embedding' }
  }
  if (retriever === 'bm25') {
    return hasBm25
      ? { runnable: true, missing: null }
      : { runnable: false, missing: 'needs BM25 index' }
  }
  // hybrid-rrf
  if (hasEmbed && hasBm25) return { runnable: true, missing: null }
  if (!hasEmbed && !hasBm25) return { runnable: false, missing: 'needs embedding + BM25' }
  return { runnable: false, missing: hasEmbed ? 'needs BM25 index' : 'needs embedding' }
}

function EvalRunnerPanel({
  bookId,
  selectedEvalSetId,
  onSelectEvalSet,
  chunkSets,
  embeddingSets,
  bm25Sets,
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
  const [error, setError] = useState<IpcError | null>(null)
  const [savedStrategies, setSavedStrategies] = useState<SavedStrategy[]>([])
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [autoGenOpen, setAutoGenOpen] = useState(false)
  const [autoGenStrategy, setAutoGenStrategy] = useState<string>('')
  const [autoGenCount, setAutoGenCount] = useState(10)
  const [autoGenRunning, setAutoGenRunning] = useState(false)
  const [autoGenStatus, setAutoGenStatus] = useState<string | null>(null)
  const [autoGenFailures, setAutoGenFailures] = useState<AutoGenerateFailure[]>([])
  const [backfilling, setBackfilling] = useState(false)
  const [resultsTab, setResultsTab] = useState<'runs' | 'leaderboard'>('runs')

  const missingSearchQueryCount = activeSet
    ? activeSet.cases.filter((c) => !c.searchQuery || !c.searchQuery.trim()).length
    : 0

  const fullyEmbedded = useMemo(
    () =>
      embeddingSets.filter((e) => {
        const set = chunkSets.find((s) => s.strategyId === e.strategyId)
        return set !== undefined && e.count >= set.count
      }),
    [embeddingSets, chunkSets]
  )

  const bm25Indexed = useMemo(
    () =>
      bm25Sets.filter((b) => {
        const set = chunkSets.find((s) => s.strategyId === b.strategyId)
        return set !== undefined && b.count === set.count
      }),
    [bm25Sets, chunkSets]
  )

  const embeddedChunkerIds = useMemo(
    () => new Set(fullyEmbedded.map((e) => e.strategyId)),
    [fullyEmbedded]
  )
  const bm25ChunkerIds = useMemo(
    () => new Set(bm25Indexed.map((b) => b.strategyId)),
    [bm25Indexed]
  )

  // Per-strategy chunk set, useful for showing counts in the run rows.
  const chunkCountByStrategy = useMemo(
    () => new Map(chunkSets.map((s) => [s.strategyId, s.count])),
    [chunkSets]
  )

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

  async function refreshSavedStrategies(): Promise<void> {
    const r = await window.api.strategies.list()
    if (r.ok) setSavedStrategies(r.strategies)
    else setError(r.error)
  }

  useEffect(() => {
    void refreshSets()
    void refreshRuns()
    void refreshSavedStrategies()
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

  async function handleRun(strategy: SavedStrategy): Promise<void> {
    if (!selectedEvalSetId) return
    setRunning(strategy.id)
    setError(null)
    try {
      const r = await window.api.evals.run(
        bookId,
        selectedEvalSetId,
        strategyIdOf(strategy.config.chunker),
        strategy.config.retriever,
        strategy.config.generation.topK,
        runMode
      )
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

  async function handleRunCase(caseId: string, strategy: SavedStrategy): Promise<void> {
    if (!selectedEvalSetId) return
    setRunningCase(`${caseId}::${strategy.id}`)
    setCasePickerForCaseId(null)
    setError(null)
    try {
      const r = await window.api.evals.run(
        bookId,
        selectedEvalSetId,
        strategyIdOf(strategy.config.chunker),
        strategy.config.retriever,
        strategy.config.generation.topK,
        runMode,
        [caseId]
      )
      if (!r.ok) { setError(r.error); return }
      await refreshRuns()
      setDetailRunId(r.data.id)
    } finally {
      setRunningCase(null)
    }
  }

  function latestRunFor(setId: string, strategy: SavedStrategy): EvalRunSummary | undefined {
    const chunkerId = strategyIdOf(strategy.config.chunker)
    const retrId = retrieverIdOf(strategy.config.retriever)
    return runs.find(
      (r) =>
        r.evalSetId === setId &&
        r.strategyId === chunkerId &&
        (r.mode ?? 'agentic') === runMode &&
        (r.retrieverId ?? 'vector') === retrId
    )
  }

  const runnableSavedStrategies = useMemo(
    () =>
      savedStrategies
        .map((s) => ({
          strategy: s,
          status: isStrategyRunnable(s, embeddedChunkerIds, bm25ChunkerIds)
        }))
        .filter((x) => x.status.runnable),
    [savedStrategies, embeddedChunkerIds, bm25ChunkerIds]
  )

  const compareRunIds = activeSet
    ? runnableSavedStrategies
        .map(({ strategy }) => latestRunFor(activeSet.id, strategy)?.id)
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
                        strategies={runnableSavedStrategies.map((x) => x.strategy)}
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
          <div style={{ padding: '14px 20px 10px', borderBottom: `1px solid ${cv.border}`, display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, flexWrap: 'wrap' }}>
            <ResultsTabs tab={resultsTab} onChange={setResultsTab} />
            {resultsTab === 'runs' && <ModeTabs mode={runMode} onChange={setRunMode} />}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
            <ErrorDisplay error={error} marginTop={0} />

            {resultsTab === 'leaderboard' ? (
              !activeSet ? (
                <div style={{ fontSize: 12, color: cv.text5 }}>Select an eval set</div>
              ) : (
                <Leaderboard
                  runs={runs.filter((r) => r.evalSetId === activeSet.id)}
                  onSelectRun={setDetailRunId}
                />
              )
            ) : !activeSet ? (
              <div style={{ fontSize: 12, color: cv.text5 }}>Select an eval set to run</div>
            ) : activeSet.cases.length === 0 ? (
              <div style={{ fontSize: 12, color: cv.text5 }}>Add cases to run evals</div>
            ) : savedStrategies.length === 0 ? (
              <div style={{ fontSize: 12, color: cv.text4 }}>
                No saved strategies yet. Create one in the Strategies view (top-level nav).
              </div>
            ) : runnableSavedStrategies.length === 0 ? (
              <div style={{ fontSize: 12, color: cv.text4 }}>
                No strategies are runnable on this book. Each strategy needs its chunker
                chunked + embedded / BM25 indexed (see the Strategies sub-tab inside this book).
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8 }}>
                  {runnableSavedStrategies.map(({ strategy: s }) => {
                    const chunkerId = strategyIdOf(s.config.chunker)
                    const last = latestRunFor(activeSet.id, s)
                    const isRunning = running === s.id
                    const count = chunkCountByStrategy.get(chunkerId)
                    return (
                      <div
                        key={s.id}
                        style={{ background: cv.bg, border: `1px solid ${cv.border}`, borderRadius: 6, padding: '12px 14px' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: last ? 8 : 0 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: cv.text1 }}>{s.name}</span>
                            <span style={{ fontFamily: 'monospace', fontSize: 11, color: cv.text4, marginTop: 2 }} title={count !== undefined ? `${count} chunks` : undefined}>
                              {chunkerId} · {retrieverIdOf(s.config.retriever)} · k={s.config.generation.topK}
                            </span>
                            <SetupCostLabel embedding={fullyEmbedded.find((x) => x.strategyId === chunkerId)} />
                          </div>

                          <button
                            onClick={() => void handleRun(s)}
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
                              <Metric label={`Hit@${last.k}`} value={last.meanRecallAtK.toFixed(2)} />
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
                        strategies={runnableSavedStrategies.map((x) => x.strategy)}
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
              <div style={{ fontSize: 11, fontWeight: 600, color: cv.text2, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                Strategies
                <ModeTabs mode={runMode} onChange={setRunMode} />
              </div>
              {savedStrategies.length === 0 ? (
                <div style={{ fontSize: 11, color: cv.text4 }}>
                  No saved strategies yet. Create one in the top-level Strategies view.
                </div>
              ) : runnableSavedStrategies.length === 0 ? (
                <div style={{ fontSize: 11, color: cv.text4 }}>
                  No strategies are runnable on this book. Embed/index a chunker first.
                </div>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                  {runnableSavedStrategies.map(({ strategy: s }) => {
                    const chunkerId = strategyIdOf(s.config.chunker)
                    const last = latestRunFor(activeSet.id, s)
                    const isRunning = running === s.id
                    return (
                      <li key={s.id} style={{ background: cv.bg, border: `1px solid ${cv.border}`, borderRadius: 4, padding: '6px 8px', fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: cv.text1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                            <span style={{ fontFamily: 'monospace', fontSize: 10, color: cv.text4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${chunkerId} · ${retrieverIdOf(s.config.retriever)}`}>
                              {chunkerId} · {retrieverIdOf(s.config.retriever)} · k={s.config.generation.topK}
                            </span>
                            <SetupCostLabel embedding={fullyEmbedded.find((x) => x.strategyId === chunkerId)} />
                          </div>
                          <button onClick={() => void handleRun(s)} disabled={running !== null} style={{ padding: '3px 8px', fontSize: 11, cursor: running !== null ? 'wait' : 'pointer', background: cv.bg, color: cv.text2, border: `1px solid ${cv.border2}`, borderRadius: 3 }}>
                            {isRunning ? '…' : last ? 'Re-run' : 'Run'}
                          </button>
                        </div>
                        {last && (
                          <>
                            <div style={{ marginTop: 4, color: cv.text2, fontSize: 11 }}>
                              Hit@{last.k}={last.meanRecallAtK.toFixed(2)} · MRR={last.meanMRR.toFixed(2)}
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

function ResultsTabs({
  tab,
  onChange
}: {
  tab: 'runs' | 'leaderboard'
  onChange: (t: 'runs' | 'leaderboard') => void
}): React.JSX.Element {
  const tabs: { id: 'runs' | 'leaderboard'; label: string }[] = [
    { id: 'runs', label: 'Runs' },
    { id: 'leaderboard', label: 'Leaderboard' }
  ]
  return (
    <div style={{ display: 'inline-flex', background: cv.surface2, border: `1px solid ${cv.border}`, borderRadius: 4, padding: 1 }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: '3px 10px',
            fontSize: 11,
            cursor: 'pointer',
            background: tab === t.id ? cv.bg : 'transparent',
            color: tab === t.id ? cv.text1 : cv.text4,
            border: `1px solid ${tab === t.id ? cv.border2 : 'transparent'}`,
            borderRadius: 3,
            fontWeight: tab === t.id ? 700 : 500,
            letterSpacing: 0.3,
            textTransform: 'uppercase'
          }}
        >
          {t.label}
        </button>
      ))}
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
  strategies,
  runningCase,
  onRun
}: {
  caseId: string
  strategies: SavedStrategy[]
  runningCase: string | null
  onRun: (caseId: string, strategy: SavedStrategy) => Promise<void>
}): React.JSX.Element {
  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${cv.border}` }}>
      <div style={{ fontSize: 10, color: cv.text4, marginBottom: 4 }}>Run case against:</div>
      {strategies.length === 0 ? (
        <div style={{ fontSize: 10, color: cv.text4 }}>
          No runnable strategies. Embed/index a chunker that matches one of your saved strategies.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {strategies.map((s) => {
            const isRunning = runningCase === `${caseId}::${s.id}`
            return (
              <button
                key={s.id}
                onClick={() => void onRun(caseId, s)}
                disabled={runningCase !== null}
                title={`${strategyIdOf(s.config.chunker)} · ${retrieverIdOf(s.config.retriever)} · k=${s.config.generation.topK}`}
                style={{
                  padding: '3px 8px',
                  fontSize: 10,
                  cursor: runningCase !== null ? 'wait' : 'pointer',
                  background: cv.bg,
                  color: cv.text2,
                  border: `1px solid ${cv.border2}`,
                  borderRadius: 3
                }}
              >
                {isRunning ? '…' : s.name}
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
  embedding: EmbeddingSetSummary | undefined
}): React.JSX.Element | null {
  if (!embedding || embedding.totalTokens === undefined) return null
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
