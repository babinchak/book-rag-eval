import { memo, useEffect, useRef, useState } from 'react'
import type {
  BookSummary,
  Chunk,
  ChunkParams,
  ChunkSetSummary,
  EmbeddingSetSummary,
  LoadedEpub,
  SpineItem
} from '../../../preload/types'
import { applyChunkOverlay, buildRangeForChunk, clearChunkOverlay } from '../lib/overlay'
import { DEFAULT_STRATEGIES, strategyIdOf, strategyLabel } from '../../../shared/strategy'
import AssistantPane from './AssistantPane'
import EvalRunnerPanel from './EvalRunnerPanel'

type BookView = 'strategies' | 'reader' | 'evals'

interface SelectedChunkState {
  strategyId: string
  chunkId: string
}

interface ReaderProps {
  book: BookSummary
  onBack: () => void
}

function Reader({ book, onBack }: ReaderProps): React.JSX.Element {
  const [view, setView] = useState<BookView>('strategies')
  const [loaded, setLoaded] = useState<LoadedEpub | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chunkSets, setChunkSets] = useState<ChunkSetSummary[]>([])
  const [embeddingSets, setEmbeddingSets] = useState<EmbeddingSetSummary[]>([])
  const [runningStrategyId, setRunningStrategyId] = useState<string | null>(null)
  const [embeddingStrategyId, setEmbeddingStrategyId] = useState<string | null>(null)
  const [selectedEvalSetId, setSelectedEvalSetId] = useState<string | null>(null)
  const [overlayStrategyId, setOverlayStrategyId] = useState<string | null>(null)
  const [selectedChunk, setSelectedChunk] = useState<SelectedChunkState | null>(null)
  const [overlayApplied, setOverlayApplied] = useState<number | null>(null)

  const spineContainerRef = useRef<HTMLDivElement>(null)
  const overlayTokenRef = useRef(0)
  const lastScrolledChunkIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.library.open(book.id).then((result) => {
      if (cancelled) return
      if (result.ok) setLoaded(result.data)
      else setError(result.error)
    })
    return () => { cancelled = true }
  }, [book.id])

  useEffect(() => {
    void refreshChunkSets()
    void refreshEmbeddingSets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  useEffect(() => {
    if (!loaded || (!overlayStrategyId && !selectedChunk)) {
      clearChunkOverlay()
      setOverlayApplied(null)
      overlayTokenRef.current++
      return
    }
    const token = ++overlayTokenRef.current
    const strategiesToFetch = new Set<string>()
    if (overlayStrategyId) strategiesToFetch.add(overlayStrategyId)
    if (selectedChunk) strategiesToFetch.add(selectedChunk.strategyId)

    void Promise.all(
      Array.from(strategiesToFetch).map((sid) =>
        window.api.chunks.get(book.id, sid).then((r) => ({ sid, r }))
      )
    ).then((results) => {
      if (token !== overlayTokenRef.current) return
      const container = spineContainerRef.current
      if (!container) return

      let allChunks: Chunk[] = []
      let selected: Chunk[] = []

      for (const { sid, r } of results) {
        if (!r.ok) { setError(r.error); continue }
        if (overlayStrategyId === sid) allChunks = r.data.chunks
        if (selectedChunk?.strategyId === sid) {
          const found = r.data.chunks.find((c) => c.id === selectedChunk.chunkId)
          if (found) selected = [found]
        }
      }

      const rootsByHref = new Map<string, Element>()
      container.querySelectorAll<HTMLElement>('[data-spine-href]').forEach((el) =>
        rootsByHref.set(el.dataset.spineHref ?? '', el)
      )

      const status = applyChunkOverlay(rootsByHref, allChunks, selected)
      setOverlayApplied(status.applied)

      if (
        selectedChunk &&
        selected.length > 0 &&
        lastScrolledChunkIdRef.current !== selectedChunk.chunkId
      ) {
        lastScrolledChunkIdRef.current = selectedChunk.chunkId
        const target = selected[0]
        const section = rootsByHref.get(target.spineHref)
        if (section) {
          const range = buildRangeForChunk(section, target.textStart, target.textEnd)
          const scrollNode =
            range?.startContainer.nodeType === Node.TEXT_NODE
              ? range.startContainer.parentElement
              : (range?.startContainer as Element | null)
          if (scrollNode) scrollNode.scrollIntoView({ behavior: 'smooth', block: 'center' })
          else (section as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }
      if (!selectedChunk) lastScrolledChunkIdRef.current = null
    })
  }, [overlayStrategyId, selectedChunk, loaded, book.id])

  useEffect(() => { return () => { clearChunkOverlay() } }, [])

  async function refreshChunkSets(): Promise<void> {
    const result = await window.api.chunks.list(book.id)
    if (result.ok) setChunkSets(result.sets)
    else setError(result.error)
  }

  async function refreshEmbeddingSets(): Promise<void> {
    const result = await window.api.embeddings.list(book.id)
    if (result.ok) setEmbeddingSets(result.sets)
    else setError(result.error)
  }

  async function handleEmbed(strategyId: string): Promise<void> {
    setEmbeddingStrategyId(strategyId)
    setError(null)
    try {
      const result = await window.api.embeddings.run(book.id, strategyId)
      if (!result.ok) { setError(result.error); return }
      await refreshEmbeddingSets()
    } finally {
      setEmbeddingStrategyId(null)
    }
  }

  async function handleClearEmbeddings(strategyId: string): Promise<void> {
    const result = await window.api.embeddings.remove(book.id, strategyId)
    if (!result.ok) { setError(result.error); return }
    await refreshEmbeddingSets()
  }

  async function handleRun(params: ChunkParams): Promise<void> {
    const sid = strategyIdOf(params)
    setRunningStrategyId(sid)
    setError(null)
    try {
      const result = await window.api.chunks.run(book.id, params)
      if (!result.ok) { setError(result.error); return }
      await refreshChunkSets()
    } finally {
      setRunningStrategyId(null)
    }
  }

  function toggleOverlay(strategyId: string): void {
    setOverlayStrategyId((prev) => (prev === strategyId ? null : strategyId))
  }

  function selectChunk(strategyId: string, chunkId: string): void {
    setSelectedChunk((prev) =>
      prev?.strategyId === strategyId && prev.chunkId === chunkId
        ? null
        : { strategyId, chunkId }
    )
    setView('reader')
  }

  const embeddingByStrategy = new Map(embeddingSets.map((e) => [e.strategyId, e]))
  const existingStrategyIds = new Set(chunkSets.map((s) => s.strategyId))
  const highlightedChunkId = selectedChunk?.chunkId ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: '#222' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 20px',
          borderBottom: '1px solid #e5e5e5',
          height: 48,
          flexShrink: 0,
          background: '#fff'
        }}
      >
        <button
          onClick={onBack}
          style={{
            padding: '5px 10px',
            fontSize: 12,
            cursor: 'pointer',
            background: '#fff',
            border: '1px solid #d4d4d4',
            borderRadius: 4,
            flexShrink: 0
          }}
        >
          ← Library
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {book.title}
          </div>
          {book.author && (
            <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>{book.author}</div>
          )}
        </div>
        <nav style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <NavTab active={view === 'strategies'} onClick={() => setView('strategies')}>
            Strategies
          </NavTab>
          <NavTab active={view === 'reader'} onClick={() => setView('reader')}>
            Reader
          </NavTab>
          <NavTab active={view === 'evals'} onClick={() => setView('evals')}>
            Evals
          </NavTab>
        </nav>
      </header>

      {error && (
        <pre
          style={{
            color: '#b00',
            whiteSpace: 'pre-wrap',
            margin: '0',
            background: '#fee',
            padding: '8px 20px',
            borderBottom: '1px solid #fbb',
            fontSize: 11,
            flexShrink: 0
          }}
        >
          {error}
        </pre>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {view === 'strategies' && (
          <StrategiesFullView
            chunkSets={chunkSets}
            embeddingByStrategy={embeddingByStrategy}
            runningStrategyId={runningStrategyId}
            embeddingStrategyId={embeddingStrategyId}
            existingStrategyIds={existingStrategyIds}
            onRun={handleRun}
            onEmbed={handleEmbed}
            onClearEmbeddings={handleClearEmbeddings}
            overlayStrategyId={overlayStrategyId}
            overlayApplied={overlayApplied}
            onToggleOverlay={toggleOverlay}
            onViewInReader={() => setView('reader')}
          />
        )}

        {view === 'evals' && (
          <EvalRunnerPanel
            layout="full"
            bookId={book.id}
            selectedEvalSetId={selectedEvalSetId}
            onSelectEvalSet={setSelectedEvalSetId}
            chunkSets={chunkSets}
            embeddingSets={embeddingSets}
            onSelectChunk={selectChunk}
          />
        )}

        {view === 'reader' && (
          <ReaderPane
            loaded={loaded}
            chunkSets={chunkSets}
            book={book}
            embeddingSets={embeddingSets}
            spineContainerRef={spineContainerRef}
            overlayStrategyId={overlayStrategyId}
            overlayApplied={overlayApplied}
            onToggleOverlay={toggleOverlay}
            onSelectChunk={selectChunk}
            highlightedChunkId={highlightedChunkId}
            selectedEvalSetId={selectedEvalSetId}
            onSelectEvalSet={setSelectedEvalSetId}
            runningStrategyId={runningStrategyId}
            embeddingStrategyId={embeddingStrategyId}
            existingStrategyIds={existingStrategyIds}
            embeddingByStrategy={embeddingByStrategy}
            onRun={handleRun}
            onEmbed={handleEmbed}
            onClearEmbeddings={handleClearEmbeddings}
          />
        )}
      </div>
    </div>
  )
}

interface ReaderPaneProps {
  loaded: LoadedEpub | null
  chunkSets: ChunkSetSummary[]
  book: BookSummary
  embeddingSets: EmbeddingSetSummary[]
  spineContainerRef: React.RefObject<HTMLDivElement | null>
  overlayStrategyId: string | null
  overlayApplied: number | null
  onToggleOverlay: (strategyId: string) => void
  onSelectChunk: (strategyId: string, chunkId: string) => void
  highlightedChunkId: string | null
  selectedEvalSetId: string | null
  onSelectEvalSet: (id: string | null) => void
  runningStrategyId: string | null
  embeddingStrategyId: string | null
  existingStrategyIds: Set<string>
  embeddingByStrategy: Map<string, EmbeddingSetSummary>
  onRun: (params: ChunkParams) => void
  onEmbed: (strategyId: string) => void
  onClearEmbeddings: (strategyId: string) => void
}

function ReaderPane({
  loaded,
  chunkSets,
  book,
  embeddingSets,
  spineContainerRef,
  overlayStrategyId,
  overlayApplied,
  onToggleOverlay,
  onSelectChunk,
  highlightedChunkId,
  selectedEvalSetId,
  onSelectEvalSet,
  runningStrategyId,
  embeddingStrategyId,
  existingStrategyIds,
  embeddingByStrategy,
  onRun,
  onEmbed,
  onClearEmbeddings
}: ReaderPaneProps): React.JSX.Element {
  const [leftRailOpen, setLeftRailOpen] = useState(true)
  const [rightRailOpen, setRightRailOpen] = useState(true)
  const [rightTab, setRightTab] = useState<'ask' | 'eval'>('ask')

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left rail: full strategy management */}
      <aside
        style={{
          width: leftRailOpen ? 280 : 36,
          flexShrink: 0,
          background: '#f7f7f8',
          borderRight: '1px solid #e5e5e5',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 120ms ease',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: leftRailOpen ? 'space-between' : 'center',
            padding: '8px 8px 8px 12px',
            borderBottom: '1px solid #e5e5e5',
            minHeight: 36,
            flexShrink: 0
          }}
        >
          {leftRailOpen && (
            <span style={{ fontSize: 10, fontWeight: 600, color: '#666', letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Tools
            </span>
          )}
          <button
            onClick={() => setLeftRailOpen((v) => !v)}
            style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: '#666' }}
          >
            {leftRailOpen ? '⟨' : '⟩'}
          </button>
        </div>

        {leftRailOpen && (
          <div style={{ overflowY: 'auto', padding: 12 }}>
            <ChunkingSection
              chunkSets={chunkSets}
              embeddingByStrategy={embeddingByStrategy}
              runningStrategyId={runningStrategyId}
              embeddingStrategyId={embeddingStrategyId}
              existingStrategyIds={existingStrategyIds}
              onRun={onRun}
              onEmbed={onEmbed}
              onClearEmbeddings={onClearEmbeddings}
              overlayStrategyId={overlayStrategyId}
              overlayApplied={overlayApplied}
              onToggleOverlay={onToggleOverlay}
            />
          </div>
        )}
      </aside>

      {/* Book */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {loaded ? (
          <SpineRenderer items={loaded.spineItems} containerRef={spineContainerRef} />
        ) : (
          <div style={{ padding: 24, color: '#888', fontSize: 13 }}>Loading…</div>
        )}
      </main>

      {/* Right rail: Ask / Eval tabs */}
      <aside
        style={{
          width: rightRailOpen ? 320 : 36,
          flexShrink: 0,
          background: '#f7f7f8',
          borderLeft: '1px solid #e5e5e5',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 120ms ease',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 8px',
            borderBottom: '1px solid #e5e5e5',
            minHeight: 36,
            flexShrink: 0
          }}
        >
          <button
            onClick={() => setRightRailOpen((v) => !v)}
            style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: '#666', flexShrink: 0 }}
          >
            {rightRailOpen ? '⟩' : '⟨'}
          </button>
          {rightRailOpen && (
            <div style={{ display: 'flex', gap: 2, flex: 1, justifyContent: 'flex-end' }}>
              <RailTab active={rightTab === 'ask'} onClick={() => setRightTab('ask')}>Ask</RailTab>
              <RailTab active={rightTab === 'eval'} onClick={() => setRightTab('eval')}>Eval</RailTab>
            </div>
          )}
        </div>

        {rightRailOpen && (
          <div style={{ flex: 1, minHeight: 0 }}>
            {rightTab === 'ask' ? (
              <AssistantPane
                bookId={book.id}
                chunkSets={chunkSets}
                embeddingSets={embeddingSets}
                onSelectChunk={onSelectChunk}
                highlightedChunkId={highlightedChunkId}
              />
            ) : (
              <EvalRunnerPanel
                bookId={book.id}
                selectedEvalSetId={selectedEvalSetId}
                onSelectEvalSet={onSelectEvalSet}
                chunkSets={chunkSets}
                embeddingSets={embeddingSets}
                onSelectChunk={onSelectChunk}
              />
            )}
          </div>
        )}
      </aside>
    </div>
  )
}

interface ChunkingSectionProps {
  chunkSets: ChunkSetSummary[]
  embeddingByStrategy: Map<string, EmbeddingSetSummary>
  runningStrategyId: string | null
  embeddingStrategyId: string | null
  existingStrategyIds: Set<string>
  onRun: (params: ChunkParams) => void
  onEmbed: (strategyId: string) => void
  onClearEmbeddings: (strategyId: string) => void
  overlayStrategyId: string | null
  overlayApplied: number | null
  onToggleOverlay: (strategyId: string) => void
}

function ChunkingSection({
  chunkSets,
  embeddingByStrategy,
  runningStrategyId,
  embeddingStrategyId,
  existingStrategyIds,
  onRun,
  onEmbed,
  onClearEmbeddings,
  overlayStrategyId,
  overlayApplied,
  onToggleOverlay
}: ChunkingSectionProps): React.JSX.Element {
  const anyRunning = runningStrategyId !== null
  return (
    <section>
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
        Strategies
      </h3>
      <div style={{ display: 'grid', gap: 6 }}>
        {DEFAULT_STRATEGIES.map((params) => {
          const sid = strategyIdOf(params)
          const isRunning = runningStrategyId === sid
          const exists = existingStrategyIds.has(sid)
          return (
            <button
              key={sid}
              onClick={() => onRun(params)}
              disabled={anyRunning}
              style={{
                width: '100%',
                padding: '7px 10px',
                fontSize: 12,
                textAlign: 'left',
                cursor: anyRunning ? 'wait' : 'pointer',
                background: '#fff',
                border: '1px solid #d4d4d4',
                borderRadius: 4,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 6
              }}
            >
              <span>
                {isRunning ? 'Running…' : exists ? 'Re-run ' : 'Run '}
                {strategyLabel(params)}
              </span>
              {exists && !isRunning && <span style={{ color: '#10b981', fontSize: 11 }}>✓</span>}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
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
          Chunk sets
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
          {chunkSets.length === 0 ? 'None generated yet' : `${chunkSets.length} generated`}
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {chunkSets.map((s) => {
            const active = overlayStrategyId === s.strategyId
            return (
              <li
                key={s.strategyId}
                style={{
                  background: active ? '#fff8d8' : '#fff',
                  border: active ? '1px solid #d4b94d' : '1px solid #e5e5e5',
                  borderRadius: 4,
                  padding: '6px 8px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: '#444',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                      title={new Date(s.generatedAt).toLocaleString()}
                    >
                      {s.strategyId}
                    </div>
                    <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
                      {s.count} chunk{s.count === 1 ? '' : 's'}
                      {active && overlayApplied !== null && overlayApplied !== s.count && (
                        <span style={{ color: '#b06400' }}> · {overlayApplied} shown</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onToggleOverlay(s.strategyId)}
                    title={active ? 'Hide overlay' : 'Show overlay'}
                    style={{
                      flexShrink: 0,
                      padding: '4px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      background: active ? '#d4b94d' : '#fff',
                      color: active ? '#fff' : '#444',
                      border: '1px solid ' + (active ? '#d4b94d' : '#ccc'),
                      borderRadius: 3
                    }}
                  >
                    {active ? 'On' : 'Off'}
                  </button>
                </div>
                <EmbeddingRow
                  chunkCount={s.count}
                  embedding={embeddingByStrategy.get(s.strategyId)}
                  isEmbedding={embeddingStrategyId === s.strategyId}
                  anyEmbedding={embeddingStrategyId !== null}
                  onEmbed={() => onEmbed(s.strategyId)}
                  onClear={() => onClearEmbeddings(s.strategyId)}
                />
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

interface EmbeddingRowProps {
  chunkCount: number
  embedding: EmbeddingSetSummary | undefined
  isEmbedding: boolean
  anyEmbedding: boolean
  onEmbed: () => void
  onClear: () => void
}

function EmbeddingRow({
  chunkCount,
  embedding,
  isEmbedding,
  anyEmbedding,
  onEmbed,
  onClear
}: EmbeddingRowProps): React.JSX.Element {
  const fullyEmbedded = embedding !== undefined && embedding.count === chunkCount
  const partiallyEmbedded =
    embedding !== undefined && embedding.count > 0 && embedding.count < chunkCount

  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 6,
        borderTop: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6
      }}
    >
      <div style={{ fontSize: 10, color: '#888', minWidth: 0, flex: 1 }}>
        {isEmbedding ? (
          <span style={{ color: '#2563eb' }}>Embedding…</span>
        ) : fullyEmbedded ? (
          <span style={{ color: '#10b981' }}>✓ {embedding.count}/{chunkCount} embedded</span>
        ) : partiallyEmbedded ? (
          <span style={{ color: '#b06400' }}>{embedding!.count}/{chunkCount} embedded</span>
        ) : (
          <span>Not embedded</span>
        )}
      </div>
      <button
        onClick={onEmbed}
        disabled={anyEmbedding}
        title={fullyEmbedded ? 'Re-run embedding' : 'Generate embeddings'}
        style={{
          flexShrink: 0,
          padding: '3px 7px',
          fontSize: 10,
          cursor: anyEmbedding ? 'wait' : 'pointer',
          background: '#fff',
          border: '1px solid #ccc',
          borderRadius: 3
        }}
      >
        {isEmbedding ? '…' : fullyEmbedded ? 'Re-embed' : 'Embed'}
      </button>
      {embedding && !isEmbedding && (
        <button
          onClick={onClear}
          disabled={anyEmbedding}
          title="Delete embeddings"
          style={{
            flexShrink: 0,
            padding: '3px 7px',
            fontSize: 10,
            cursor: anyEmbedding ? 'wait' : 'pointer',
            background: '#fff',
            color: '#b91c1c',
            border: '1px solid #fca5a5',
            borderRadius: 3
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

function RailTab({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px',
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        background: active ? '#fff' : 'transparent',
        color: active ? '#222' : '#666',
        border: '1px solid ' + (active ? '#d4d4d4' : 'transparent'),
        borderRadius: 4,
        letterSpacing: 0.3
      }}
    >
      {children}
    </button>
  )
}

interface StrategiesFullViewProps {
  chunkSets: ChunkSetSummary[]
  embeddingByStrategy: Map<string, EmbeddingSetSummary>
  runningStrategyId: string | null
  embeddingStrategyId: string | null
  existingStrategyIds: Set<string>
  onRun: (params: ChunkParams) => void
  onEmbed: (strategyId: string) => void
  onClearEmbeddings: (strategyId: string) => void
  overlayStrategyId: string | null
  overlayApplied: number | null
  onToggleOverlay: (strategyId: string) => void
  onViewInReader: () => void
}

function StrategiesFullView({
  chunkSets,
  embeddingByStrategy,
  runningStrategyId,
  embeddingStrategyId,
  existingStrategyIds,
  onRun,
  onEmbed,
  onClearEmbeddings,
  overlayStrategyId,
  overlayApplied,
  onToggleOverlay,
  onViewInReader
}: StrategiesFullViewProps): React.JSX.Element {
  const anyRunning = runningStrategyId !== null
  const anyEmbedding = embeddingStrategyId !== null

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: 24 }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <h2
          style={{
            margin: '0 0 4px',
            fontSize: 16,
            fontWeight: 600,
            color: '#111'
          }}
        >
          Chunking strategies
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 12, color: '#888' }}>
          Run a strategy to chunk the book, then embed it to enable retrieval and evals.
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {DEFAULT_STRATEGIES.map((params) => {
            const sid = strategyIdOf(params)
            const isRunning = runningStrategyId === sid
            const isEmbedding = embeddingStrategyId === sid
            const exists = existingStrategyIds.has(sid)
            const set = chunkSets.find((s) => s.strategyId === sid)
            const embedding = embeddingByStrategy.get(sid)
            const fullyEmbedded = embedding !== undefined && set !== undefined && embedding.count >= set.count
            const partialEmbedded = embedding !== undefined && set !== undefined && embedding.count > 0 && embedding.count < set.count
            const isOverlay = overlayStrategyId === sid

            return (
              <div
                key={sid}
                style={{
                  background: '#fff',
                  border: '1px solid #e5e5e5',
                  borderRadius: 8,
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20
                }}
              >
                {/* Identity */}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#111' }}>
                    {strategyLabel(params)}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#999', marginTop: 2 }}>
                    {sid}
                  </div>
                </div>

                {/* Chunk status */}
                <div style={{ minWidth: 100, fontSize: 12 }}>
                  {isRunning ? (
                    <span style={{ color: '#2563eb' }}>Chunking…</span>
                  ) : exists && set ? (
                    <span style={{ color: '#10b981', fontWeight: 500 }}>{set.count.toLocaleString()} chunks</span>
                  ) : (
                    <span style={{ color: '#aaa' }}>not run</span>
                  )}
                </div>

                {/* Embedding status */}
                <div style={{ minWidth: 120, fontSize: 12 }}>
                  {isEmbedding ? (
                    <span style={{ color: '#2563eb' }}>Embedding…</span>
                  ) : fullyEmbedded ? (
                    <span style={{ color: '#10b981', fontWeight: 500 }}>embedded ✓</span>
                  ) : partialEmbedded ? (
                    <span style={{ color: '#b06400' }}>{embedding!.count}/{set!.count} embedded</span>
                  ) : (
                    <span style={{ color: '#aaa' }}>not embedded</span>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                  <button
                    onClick={() => onRun(params)}
                    disabled={anyRunning}
                    style={{
                      padding: '6px 14px',
                      fontSize: 12,
                      cursor: anyRunning ? 'wait' : 'pointer',
                      background: exists ? '#fff' : '#2563eb',
                      color: exists ? '#444' : '#fff',
                      border: exists ? '1px solid #d4d4d4' : 'none',
                      borderRadius: 5,
                      fontWeight: exists ? 400 : 500
                    }}
                  >
                    {isRunning ? 'Running…' : exists ? 'Re-run' : 'Run'}
                  </button>

                  {exists && (
                    <button
                      onClick={() => onEmbed(sid)}
                      disabled={anyEmbedding}
                      style={{
                        padding: '6px 14px',
                        fontSize: 12,
                        cursor: anyEmbedding ? 'wait' : 'pointer',
                        background: fullyEmbedded ? '#fff' : '#2563eb',
                        color: fullyEmbedded ? '#444' : '#fff',
                        border: fullyEmbedded ? '1px solid #d4d4d4' : 'none',
                        borderRadius: 5,
                        fontWeight: fullyEmbedded ? 400 : 500
                      }}
                    >
                      {isEmbedding ? '…' : fullyEmbedded ? 'Re-embed' : 'Embed'}
                    </button>
                  )}

                  {embedding && !isEmbedding && (
                    <button
                      onClick={() => onClearEmbeddings(sid)}
                      disabled={anyEmbedding}
                      style={{
                        padding: '6px 10px',
                        fontSize: 12,
                        cursor: anyEmbedding ? 'wait' : 'pointer',
                        background: '#fff',
                        color: '#b91c1c',
                        border: '1px solid #fca5a5',
                        borderRadius: 5
                      }}
                      title="Delete embeddings"
                    >
                      Clear
                    </button>
                  )}

                  {exists && (
                    <button
                      onClick={() => {
                        onToggleOverlay(sid)
                        if (!isOverlay) onViewInReader()
                      }}
                      style={{
                        padding: '6px 12px',
                        fontSize: 12,
                        cursor: 'pointer',
                        background: isOverlay ? '#fff8d8' : '#fff',
                        color: isOverlay ? '#92650a' : '#555',
                        border: isOverlay ? '1px solid #d4b94d' : '1px solid #d4d4d4',
                        borderRadius: 5
                      }}
                      title={isOverlay ? 'Hide chunk overlay in reader' : 'Show chunk overlay in reader'}
                    >
                      {isOverlay
                        ? `Overlay on${overlayApplied !== null && overlayApplied !== set?.count ? ` (${overlayApplied})` : ''}`
                        : 'Overlay'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface SpineRendererProps {
  items: SpineItem[]
  containerRef: React.RefObject<HTMLDivElement | null>
}

const SpineRenderer = memo(function SpineRenderer({
  items,
  containerRef
}: SpineRendererProps): React.JSX.Element {
  return (
    <div ref={containerRef} style={{ flex: 1, padding: 24, overflowY: 'auto', lineHeight: 1.6 }}>
      {items.map((item, i) => (
        <section
          key={`${item.href}-${i}`}
          data-spine-href={item.href}
          dangerouslySetInnerHTML={{ __html: item.html }}
        />
      ))}
    </div>
  )
})

function NavTab({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 16px',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        background: active ? '#111' : 'transparent',
        color: active ? '#fff' : '#666',
        border: active ? 'none' : '1px solid transparent',
        borderRadius: 5,
        letterSpacing: 0.2
      }}
    >
      {children}
    </button>
  )
}

export default Reader
