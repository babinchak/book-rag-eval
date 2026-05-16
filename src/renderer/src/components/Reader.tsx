import { memo, useEffect, useRef, useState } from 'react'
import type {
  Bm25IndexSummary,
  BookSummary,
  Chunk,
  ChunkParams,
  ChunkSetSummary,
  EmbeddingSetSummary,
  IpcError,
  LoadedEpub,
  SpineItem
} from '../../../preload/types'
import { applyChunkOverlay, buildRangeForChunk, clearChunkOverlay } from '../lib/overlay'
import { DEFAULT_STRATEGIES, strategyIdOf, strategyLabel } from '../../../shared/strategy'
import { cv } from '../lib/theme'
import AssistantPane from './AssistantPane'
import EvalRunnerPanel from './EvalRunnerPanel'
import ErrorDisplay from './ErrorDisplay'
import ErrorInbox from './ErrorInbox'

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
  const [error, setError] = useState<IpcError | null>(null)
  const [chunkSets, setChunkSets] = useState<ChunkSetSummary[]>([])
  const [embeddingSets, setEmbeddingSets] = useState<EmbeddingSetSummary[]>([])
  const [bm25Sets, setBm25Sets] = useState<Bm25IndexSummary[]>([])
  const [runningStrategyId, setRunningStrategyId] = useState<string | null>(null)
  const [embeddingStrategyId, setEmbeddingStrategyId] = useState<string | null>(null)
  const [bm25StrategyId, setBm25StrategyId] = useState<string | null>(null)
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
    void refreshBm25Sets()
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

  async function refreshBm25Sets(): Promise<void> {
    const result = await window.api.bm25.list(book.id)
    if (result.ok) setBm25Sets(result.sets)
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

  async function handleIndexBm25(strategyId: string): Promise<void> {
    setBm25StrategyId(strategyId)
    setError(null)
    try {
      const result = await window.api.bm25.run(book.id, strategyId)
      if (!result.ok) { setError(result.error); return }
      await refreshBm25Sets()
    } finally {
      setBm25StrategyId(null)
    }
  }

  async function handleClearBm25(strategyId: string): Promise<void> {
    const result = await window.api.bm25.remove(book.id, strategyId)
    if (!result.ok) { setError(result.error); return }
    await refreshBm25Sets()
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
  const bm25ByStrategy = new Map(bm25Sets.map((b) => [b.strategyId, b]))
  const existingStrategyIds = new Set(chunkSets.map((s) => s.strategyId))
  const highlightedChunkId = selectedChunk?.chunkId ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: cv.text1, background: cv.bg }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 20px',
          borderBottom: `1px solid ${cv.border}`,
          height: 48,
          flexShrink: 0,
          background: cv.bg
        }}
      >
        <button
          onClick={onBack}
          style={{
            padding: '5px 10px',
            fontSize: 12,
            cursor: 'pointer',
            background: cv.bg,
            color: cv.text2,
            border: `1px solid ${cv.border2}`,
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
              textOverflow: 'ellipsis',
              color: cv.text1
            }}
          >
            {book.title}
          </div>
          {book.author && (
            <div style={{ fontSize: 11, color: cv.text4, marginTop: 1 }}>{book.author}</div>
          )}
        </div>
        <nav style={{ display: 'flex', gap: 2, flexShrink: 0, alignItems: 'center' }}>
          <NavTab active={view === 'strategies'} onClick={() => setView('strategies')}>
            Strategies
          </NavTab>
          <NavTab active={view === 'reader'} onClick={() => setView('reader')}>
            Reader
          </NavTab>
          <NavTab active={view === 'evals'} onClick={() => setView('evals')}>
            Evals
          </NavTab>
          <div style={{ marginLeft: 8 }}>
            <ErrorInbox />
          </div>
        </nav>
      </header>

      {error && (
        <div style={{ padding: '8px 20px', flexShrink: 0 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {view === 'strategies' && (
          <StrategiesFullView
            chunkSets={chunkSets}
            embeddingByStrategy={embeddingByStrategy}
            bm25ByStrategy={bm25ByStrategy}
            runningStrategyId={runningStrategyId}
            embeddingStrategyId={embeddingStrategyId}
            bm25StrategyId={bm25StrategyId}
            existingStrategyIds={existingStrategyIds}
            onRun={handleRun}
            onEmbed={handleEmbed}
            onClearEmbeddings={handleClearEmbeddings}
            onIndexBm25={handleIndexBm25}
            onClearBm25={handleClearBm25}
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
            bm25Sets={bm25Sets}
            onSelectChunk={selectChunk}
          />
        )}

        {view === 'reader' && (
          <ReaderPane
            loaded={loaded}
            chunkSets={chunkSets}
            book={book}
            embeddingSets={embeddingSets}
            bm25Sets={bm25Sets}
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
  bm25Sets: Bm25IndexSummary[]
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

interface HighlightsHost {
  highlights?: Map<string, Highlight>
}

function getHighlights(): Map<string, Highlight> | null {
  return (CSS as unknown as HighlightsHost).highlights ?? null
}

function findTextMatches(container: Element, query: string): Range[] {
  const ranges: Range[] = []
  const q = query.toLowerCase()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const tag = node.parentElement?.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE') continue
    const text = (node.nodeValue ?? '').toLowerCase()
    let pos = 0
    let idx: number
    while ((idx = text.indexOf(q, pos)) !== -1) {
      const r = document.createRange()
      r.setStart(node, idx)
      r.setEnd(node, idx + q.length)
      ranges.push(r)
      pos = idx + q.length
    }
  }
  return ranges
}

function ReaderPane({
  loaded,
  chunkSets,
  book,
  embeddingSets,
  bm25Sets,
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
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatches, setFindMatches] = useState<Range[]>([])
  const [findIndex, setFindIndex] = useState(0)
  const [findPositions, setFindPositions] = useState<number[]>([])
  const findInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setFindOpen(true)
        setTimeout(() => findInputRef.current?.select(), 0)
      }
      if (e.key === 'Escape') setFindOpen((v) => { if (v) { getHighlights()?.delete('find-match'); getHighlights()?.delete('find-current') } return false })
      if (e.key === 'F3' || (e.key === 'Enter' && (document.activeElement === findInputRef.current))) {
        e.preventDefault()
        if (findMatches.length === 0) return
        setFindIndex((i) => e.shiftKey ? (i - 1 + findMatches.length) % findMatches.length : (i + 1) % findMatches.length)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findMatches])

  useEffect(() => {
    const host = getHighlights()
    const container = spineContainerRef.current
    if (!host || !container || !findQuery.trim()) {
      host?.delete('find-match')
      host?.delete('find-current')
      setFindMatches([])
      return
    }
    const ranges = findTextMatches(container, findQuery)
    setFindMatches(ranges)
    setFindIndex(0)
    if (ranges.length > 0) {
      const h = new Highlight(...ranges)
      h.priority = 5
      host.set('find-match', h)
    } else {
      host.delete('find-match')
    }
    host.delete('find-current')
  }, [findQuery, spineContainerRef, loaded])

  useEffect(() => {
    const host = getHighlights()
    if (!host || findMatches.length === 0) { host?.delete('find-current'); return }
    const current = findMatches[findIndex]
    const h = new Highlight(current)
    h.priority = 6
    host.set('find-current', h)
    const container = spineContainerRef.current
    if (!container) return
    const rect = current.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const containerRect = container.getBoundingClientRect()
    const matchAbsTop = rect.top - containerRect.top + container.scrollTop
    const targetTop = matchAbsTop - container.clientHeight / 2 + rect.height / 2
    container.scrollTo({
      top: Math.max(0, Math.min(targetTop, container.scrollHeight - container.clientHeight)),
      behavior: 'smooth'
    })
  }, [findIndex, findMatches, spineContainerRef])

  useEffect(() => {
    if (!findOpen) {
      setFindQuery('')
      setFindMatches([])
      const host = getHighlights()
      host?.delete('find-match')
      host?.delete('find-current')
    }
  }, [findOpen])

  useEffect(() => () => { getHighlights()?.delete('find-match'); getHighlights()?.delete('find-current') }, [])

  useEffect(() => {
    if (findMatches.length === 0) { setFindPositions([]); return }
    const container = spineContainerRef.current
    if (!container) return
    const { top: containerTop } = container.getBoundingClientRect()
    const { scrollHeight, scrollTop } = container
    if (scrollHeight === 0) return
    setFindPositions(findMatches.map((range) => {
      const { top } = range.getBoundingClientRect()
      return Math.max(0, Math.min(1, (top - containerTop + scrollTop) / scrollHeight))
    }))
  }, [findMatches, spineContainerRef, loaded])

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left rail: full strategy management */}
      <aside
        style={{
          width: leftRailOpen ? 280 : 36,
          flexShrink: 0,
          background: cv.surface,
          borderRight: `1px solid ${cv.border}`,
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
            borderBottom: `1px solid ${cv.border}`,
            minHeight: 36,
            flexShrink: 0
          }}
        >
          {leftRailOpen && (
            <span style={{ fontSize: 10, fontWeight: 600, color: cv.text3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Tools
            </span>
          )}
          <button
            onClick={() => setLeftRailOpen((v) => !v)}
            style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: cv.text3 }}
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
        {findOpen && (
          <FindBar
            inputRef={findInputRef}
            query={findQuery}
            matchCount={findMatches.length}
            matchIndex={findIndex}
            onQueryChange={(q) => setFindQuery(q)}
            onNext={() => setFindIndex((i) => (i + 1) % Math.max(findMatches.length, 1))}
            onPrev={() => setFindIndex((i) => (i - 1 + Math.max(findMatches.length, 1)) % Math.max(findMatches.length, 1))}
            onClose={() => setFindOpen(false)}
          />
        )}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          {loaded ? (
            <SpineRenderer items={loaded.spineItems} containerRef={spineContainerRef} />
          ) : (
            <div style={{ padding: 24, color: cv.text4, fontSize: 13 }}>Loading…</div>
          )}
          {findOpen && findPositions.length > 0 && (
            <FindScrollMap
              positions={findPositions}
              currentIndex={findIndex}
              onJump={setFindIndex}
            />
          )}
        </div>
      </main>

      {/* Right rail: Ask / Eval tabs */}
      <aside
        style={{
          width: rightRailOpen ? 320 : 36,
          flexShrink: 0,
          background: cv.surface,
          borderLeft: `1px solid ${cv.border}`,
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
            borderBottom: `1px solid ${cv.border}`,
            minHeight: 36,
            flexShrink: 0
          }}
        >
          <button
            onClick={() => setRightRailOpen((v) => !v)}
            style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: cv.text3, flexShrink: 0 }}
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
                bm25Sets={bm25Sets}
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
                bm25Sets={bm25Sets}
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
          color: cv.text2,
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
                background: cv.bg,
                color: cv.text2,
                border: `1px solid ${cv.border2}`,
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
              {exists && !isRunning && <span style={{ color: cv.successStrong, fontSize: 11 }}>✓</span>}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: cv.text2,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 6
          }}
        >
          Chunk sets
        </div>
        <div style={{ fontSize: 11, color: cv.text4, marginBottom: 6 }}>
          {chunkSets.length === 0 ? 'None generated yet' : `${chunkSets.length} generated`}
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {chunkSets.map((s) => {
            const active = overlayStrategyId === s.strategyId
            return (
              <li
                key={s.strategyId}
                style={{
                  background: active ? cv.warningBg : cv.bg,
                  border: `1px solid ${active ? cv.warningBorder : cv.border}`,
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
                        color: cv.text2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                      title={new Date(s.generatedAt).toLocaleString()}
                    >
                      {s.strategyId}
                    </div>
                    <div style={{ color: cv.text4, fontSize: 11, marginTop: 2 }}>
                      {s.count} chunk{s.count === 1 ? '' : 's'}
                      {active && overlayApplied !== null && overlayApplied !== s.count && (
                        <span style={{ color: cv.warningText }}> · {overlayApplied} shown</span>
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
                      background: active ? cv.warningBorder : cv.bg,
                      color: active ? cv.accentText : cv.text2,
                      border: `1px solid ${active ? cv.warningBorder : cv.border3}`,
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
        borderTop: `1px solid ${cv.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6
      }}
    >
      <div style={{ fontSize: 10, color: cv.text4, minWidth: 0, flex: 1 }}>
        {isEmbedding ? (
          <span style={{ color: cv.accent }}>Embedding…</span>
        ) : fullyEmbedded ? (
          <span style={{ color: cv.successStrong }}>✓ {embedding.count}/{chunkCount} embedded</span>
        ) : partiallyEmbedded ? (
          <span style={{ color: cv.warningText }}>{embedding!.count}/{chunkCount} embedded</span>
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
          background: cv.bg,
          color: cv.text2,
          border: `1px solid ${cv.border3}`,
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
            background: cv.bg,
            color: cv.danger,
            border: `1px solid ${cv.dangerBorder}`,
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
        background: active ? cv.bg : 'transparent',
        color: active ? cv.text1 : cv.text3,
        border: `1px solid ${active ? cv.border2 : 'transparent'}`,
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
  bm25ByStrategy: Map<string, Bm25IndexSummary>
  runningStrategyId: string | null
  embeddingStrategyId: string | null
  bm25StrategyId: string | null
  existingStrategyIds: Set<string>
  onRun: (params: ChunkParams) => void
  onEmbed: (strategyId: string) => void
  onClearEmbeddings: (strategyId: string) => void
  onIndexBm25: (strategyId: string) => void
  onClearBm25: (strategyId: string) => void
  overlayStrategyId: string | null
  overlayApplied: number | null
  onToggleOverlay: (strategyId: string) => void
  onViewInReader: () => void
}

function StrategiesFullView({
  chunkSets,
  embeddingByStrategy,
  bm25ByStrategy,
  runningStrategyId,
  embeddingStrategyId,
  bm25StrategyId,
  existingStrategyIds,
  onRun,
  onEmbed,
  onClearEmbeddings,
  onIndexBm25,
  onClearBm25,
  overlayStrategyId,
  overlayApplied,
  onToggleOverlay,
  onViewInReader
}: StrategiesFullViewProps): React.JSX.Element {
  const anyRunning = runningStrategyId !== null
  const anyEmbedding = embeddingStrategyId !== null
  const anyBm25 = bm25StrategyId !== null

  return (
    <div style={{ overflowY: 'auto', height: '100%', padding: 24 }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: cv.text1 }}>
          Chunking strategies
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 12, color: cv.text4 }}>
          Run a strategy to chunk the book, then embed it to enable retrieval and evals.
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {DEFAULT_STRATEGIES.map((params) => {
            const sid = strategyIdOf(params)
            const isRunning = runningStrategyId === sid
            const isEmbedding = embeddingStrategyId === sid
            const isBm25Indexing = bm25StrategyId === sid
            const exists = existingStrategyIds.has(sid)
            const set = chunkSets.find((s) => s.strategyId === sid)
            const embedding = embeddingByStrategy.get(sid)
            const bm25 = bm25ByStrategy.get(sid)
            const fullyEmbedded = embedding !== undefined && set !== undefined && embedding.count >= set.count
            const partialEmbedded = embedding !== undefined && set !== undefined && embedding.count > 0 && embedding.count < set.count
            const bm25Current = bm25 !== undefined && set !== undefined && bm25.count === set.count
            const isOverlay = overlayStrategyId === sid

            return (
              <div
                key={sid}
                style={{
                  background: cv.bg,
                  border: `1px solid ${cv.border}`,
                  borderRadius: 8,
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20
                }}
              >
                {/* Identity */}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: cv.text1 }}>
                    {strategyLabel(params)}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: cv.text4, marginTop: 2 }}>
                    {sid}
                  </div>
                </div>

                {/* Chunk status */}
                <div style={{ minWidth: 100, fontSize: 12 }}>
                  {isRunning ? (
                    <span style={{ color: cv.accent }}>Chunking…</span>
                  ) : exists && set ? (
                    <span style={{ color: cv.successStrong, fontWeight: 500 }}>{set.count.toLocaleString()} chunks</span>
                  ) : (
                    <span style={{ color: cv.text5 }}>not run</span>
                  )}
                </div>

                {/* Embedding status */}
                <div style={{ minWidth: 120, fontSize: 12 }}>
                  {isEmbedding ? (
                    <span style={{ color: cv.accent }}>Embedding…</span>
                  ) : fullyEmbedded ? (
                    <span style={{ color: cv.successStrong, fontWeight: 500 }}>embedded ✓</span>
                  ) : partialEmbedded ? (
                    <span style={{ color: cv.warningText }}>{embedding!.count}/{set!.count} embedded</span>
                  ) : (
                    <span style={{ color: cv.text5 }}>not embedded</span>
                  )}
                </div>

                {/* BM25 status */}
                <div style={{ minWidth: 110, fontSize: 12 }}>
                  {isBm25Indexing ? (
                    <span style={{ color: cv.accent }}>Indexing…</span>
                  ) : bm25Current ? (
                    <span style={{ color: cv.successStrong, fontWeight: 500 }}>BM25 ✓</span>
                  ) : bm25 ? (
                    <span style={{ color: cv.warningText }}>BM25 stale ({bm25.count}/{set?.count ?? '?'})</span>
                  ) : (
                    <span style={{ color: cv.text5 }}>no BM25</span>
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
                      background: exists ? cv.bg : cv.accent,
                      color: exists ? cv.text2 : cv.accentText,
                      border: exists ? `1px solid ${cv.border2}` : 'none',
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
                        background: fullyEmbedded ? cv.bg : cv.accent,
                        color: fullyEmbedded ? cv.text2 : cv.accentText,
                        border: fullyEmbedded ? `1px solid ${cv.border2}` : 'none',
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
                        background: cv.bg,
                        color: cv.danger,
                        border: `1px solid ${cv.dangerBorder}`,
                        borderRadius: 5
                      }}
                      title="Delete embeddings"
                    >
                      Clear
                    </button>
                  )}

                  {exists && (
                    <button
                      onClick={() => onIndexBm25(sid)}
                      disabled={anyBm25}
                      style={{
                        padding: '6px 14px',
                        fontSize: 12,
                        cursor: anyBm25 ? 'wait' : 'pointer',
                        background: bm25Current ? cv.bg : cv.accent,
                        color: bm25Current ? cv.text2 : cv.accentText,
                        border: bm25Current ? `1px solid ${cv.border2}` : 'none',
                        borderRadius: 5,
                        fontWeight: bm25Current ? 400 : 500
                      }}
                      title="Build BM25 lexical index (free, fast)"
                    >
                      {isBm25Indexing ? '…' : bm25Current ? 'Re-index BM25' : 'Index BM25'}
                    </button>
                  )}

                  {bm25 && !isBm25Indexing && (
                    <button
                      onClick={() => onClearBm25(sid)}
                      disabled={anyBm25}
                      style={{
                        padding: '6px 10px',
                        fontSize: 12,
                        cursor: anyBm25 ? 'wait' : 'pointer',
                        background: cv.bg,
                        color: cv.danger,
                        border: `1px solid ${cv.dangerBorder}`,
                        borderRadius: 5
                      }}
                      title="Delete BM25 index"
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
                        background: isOverlay ? cv.warningBg : cv.bg,
                        color: isOverlay ? cv.warningText : cv.text2,
                        border: `1px solid ${isOverlay ? cv.warningBorder : cv.border2}`,
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

interface FindBarProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  matchCount: number
  matchIndex: number
  onQueryChange: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

function FindBar({ inputRef, query, matchCount, matchIndex, onQueryChange, onNext, onPrev, onClose }: FindBarProps): React.JSX.Element {
  const noMatch = query.trim().length > 0 && matchCount === 0

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        background: cv.surface,
        borderBottom: `1px solid ${cv.border}`,
        flexShrink: 0
      }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in book…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext() }
          if (e.key === 'Escape') onClose()
        }}
        style={{
          width: 220,
          padding: '4px 8px',
          fontSize: 12,
          border: `1px solid ${noMatch ? cv.dangerBorder : cv.border2}`,
          borderRadius: 4,
          background: noMatch ? cv.errorBg : cv.bg,
          color: noMatch ? cv.errorText : cv.text1,
          outline: 'none'
        }}
      />
      <span style={{ fontSize: 11, color: cv.text4, minWidth: 60 }}>
        {query.trim() ? (matchCount === 0 ? 'no matches' : `${matchIndex + 1} / ${matchCount}`) : ''}
      </span>
      <button onClick={onPrev} disabled={matchCount === 0} style={{ padding: '3px 8px', fontSize: 12, cursor: 'pointer', background: cv.bg, color: cv.text2, border: `1px solid ${cv.border2}`, borderRadius: 3 }}>↑</button>
      <button onClick={onNext} disabled={matchCount === 0} style={{ padding: '3px 8px', fontSize: 12, cursor: 'pointer', background: cv.bg, color: cv.text2, border: `1px solid ${cv.border2}`, borderRadius: 3 }}>↓</button>
      <button onClick={onClose} style={{ marginLeft: 4, padding: '3px 8px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: cv.text3, border: 'none' }}>✕</button>
    </div>
  )
}

function FindScrollMap({ positions, currentIndex, onJump }: {
  positions: number[]
  currentIndex: number
  onJump: (i: number) => void
}): React.JSX.Element {
  return (
    <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, pointerEvents: 'none', zIndex: 5 }}>
      {positions.map((pos, i) => (
        <div
          key={i}
          onClick={() => onJump(i)}
          title={`Match ${i + 1} of ${positions.length}`}
          style={{
            position: 'absolute',
            right: 1,
            top: `calc(${pos * 100}% - 2px)`,
            width: 8,
            height: 4,
            background: i === currentIndex ? 'rgba(234, 88, 12, 0.95)' : 'rgba(234, 179, 8, 0.75)',
            borderRadius: 1,
            pointerEvents: 'auto',
            cursor: 'pointer'
          }}
        />
      ))}
    </div>
  )
}

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
        background: active ? cv.text1 : 'transparent',
        color: active ? cv.accentText : cv.text3,
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
