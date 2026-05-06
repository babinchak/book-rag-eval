import { memo, useEffect, useRef, useState } from 'react'
import type {
  BookSummary,
  ChunkParams,
  ChunkSetSummary,
  LoadedEpub,
  SpineItem
} from '../../../preload/types'
import { applyChunkOverlay, clearChunkOverlay } from '../lib/overlay'
import { DEFAULT_STRATEGIES, strategyIdOf, strategyLabel } from '../../../shared/strategy'

interface ReaderProps {
  book: BookSummary
  onBack: () => void
}

const RAIL_EXPANDED_WIDTH = 280
const RAIL_COLLAPSED_WIDTH = 40

function Reader({ book, onBack }: ReaderProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedEpub | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chunkSets, setChunkSets] = useState<ChunkSetSummary[]>([])
  const [runningStrategyId, setRunningStrategyId] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(true)
  const [overlayStrategyId, setOverlayStrategyId] = useState<string | null>(null)
  const [overlayApplied, setOverlayApplied] = useState<number | null>(null)

  const spineContainerRef = useRef<HTMLDivElement>(null)
  const overlayTokenRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    void window.api.library.open(book.id).then((result) => {
      if (cancelled) return
      if (result.ok) setLoaded(result.data)
      else setError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [book.id])

  useEffect(() => {
    void refreshChunkSets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  useEffect(() => {
    if (!overlayStrategyId || !loaded) {
      clearChunkOverlay()
      setOverlayApplied(null)
      overlayTokenRef.current++
      return
    }
    const token = ++overlayTokenRef.current
    void window.api.chunks.get(book.id, overlayStrategyId).then((result) => {
      if (token !== overlayTokenRef.current) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      const container = spineContainerRef.current
      if (!container) return
      const rootsByHref = new Map<string, Element>()
      container
        .querySelectorAll<HTMLElement>('[data-spine-href]')
        .forEach((el) => rootsByHref.set(el.dataset.spineHref ?? '', el))
      const status = applyChunkOverlay(rootsByHref, result.data.chunks)
      setOverlayApplied(status.applied)
    })
  }, [overlayStrategyId, loaded, book.id])

  useEffect(() => {
    return () => {
      clearChunkOverlay()
    }
  }, [])

  async function refreshChunkSets(): Promise<void> {
    const result = await window.api.chunks.list(book.id)
    if (result.ok) setChunkSets(result.sets)
    else setError(result.error)
  }

  async function handleRun(params: ChunkParams): Promise<void> {
    const sid = strategyIdOf(params)
    setRunningStrategyId(sid)
    setError(null)
    try {
      const result = await window.api.chunks.run(book.id, params)
      if (!result.ok) {
        setError(result.error)
        return
      }
      await refreshChunkSets()
    } finally {
      setRunningStrategyId(null)
    }
  }

  function toggleOverlay(strategyId: string): void {
    setOverlayStrategyId((prev) => (prev === strategyId ? null : strategyId))
  }

  const spineCount = loaded?.manifest.readingOrder?.length ?? 0
  const existingStrategyIds = new Set(chunkSets.map((s) => s.strategyId))

  return (
    <div style={{ display: 'flex', height: '100vh', color: '#222' }}>
      <aside
        style={{
          width: railOpen ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH,
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
            justifyContent: railOpen ? 'space-between' : 'center',
            padding: '8px 8px 8px 12px',
            borderBottom: '1px solid #e5e5e5',
            minHeight: 40
          }}
        >
          {railOpen && (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#666', letterSpacing: 0.5 }}>
              TOOLS
            </span>
          )}
          <button
            onClick={() => setRailOpen((v) => !v)}
            title={railOpen ? 'Collapse' : 'Expand'}
            style={{
              width: 24,
              height: 24,
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 14,
              color: '#666'
            }}
          >
            {railOpen ? '⟨' : '⟩'}
          </button>
        </div>

        {railOpen && (
          <div style={{ overflowY: 'auto', padding: 12 }}>
            <ChunkingSection
              chunkSets={chunkSets}
              runningStrategyId={runningStrategyId}
              existingStrategyIds={existingStrategyIds}
              onRun={handleRun}
              overlayStrategyId={overlayStrategyId}
              overlayApplied={overlayApplied}
              onToggleOverlay={toggleOverlay}
            />
          </div>
        )}
      </aside>

      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 16,
            padding: '12px 24px',
            borderBottom: '1px solid #eee'
          }}
        >
          <button
            onClick={onBack}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              cursor: 'pointer',
              background: '#fff',
              border: '1px solid #ccc',
              borderRadius: 4
            }}
          >
            ← Library
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {book.title}
            </h2>
            {book.author && <span style={{ color: '#666', fontSize: 13 }}>{book.author}</span>}
          </div>
          <span style={{ color: '#888', fontSize: 12, marginLeft: 'auto' }}>
            {loaded ? `${spineCount} spine items` : 'loading…'}
          </span>
        </header>

        {error && (
          <pre
            style={{
              color: '#b00',
              whiteSpace: 'pre-wrap',
              margin: 16,
              background: '#fee',
              padding: 12,
              border: '1px solid #fbb',
              borderRadius: 4
            }}
          >
            {error}
          </pre>
        )}

        {loaded && <SpineRenderer items={loaded.spineItems} containerRef={spineContainerRef} />}
      </main>
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
    <div
      ref={containerRef}
      style={{
        flex: 1,
        padding: 24,
        overflowY: 'auto',
        lineHeight: 1.6
      }}
    >
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

interface ChunkingSectionProps {
  chunkSets: ChunkSetSummary[]
  runningStrategyId: string | null
  existingStrategyIds: Set<string>
  onRun: (params: ChunkParams) => void
  overlayStrategyId: string | null
  overlayApplied: number | null
  onToggleOverlay: (strategyId: string) => void
}

function ChunkingSection({
  chunkSets,
  runningStrategyId,
  existingStrategyIds,
  onRun,
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
          {chunkSets.length === 0
            ? 'None generated yet'
            : `${chunkSets.length} generated`}
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
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6
                  }}
                >
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
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

export default Reader
