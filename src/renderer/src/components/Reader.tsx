import { useEffect, useState } from 'react'
import type { BookSummary, ChunkSetSummary, LoadedEpub } from '../../../preload/types'

interface ReaderProps {
  book: BookSummary
  onBack: () => void
}

const DEFAULT_CHUNK_PARAMS = { size: 1200, overlap: 200 }
const RAIL_EXPANDED_WIDTH = 280
const RAIL_COLLAPSED_WIDTH = 40

function Reader({ book, onBack }: ReaderProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedEpub | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chunkSets, setChunkSets] = useState<ChunkSetSummary[]>([])
  const [running, setRunning] = useState(false)
  const [railOpen, setRailOpen] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    setChunkSets([])
    void window.api.library.open(book.id).then((result) => {
      if (cancelled) return
      if (result.ok) setLoaded(result.data)
      else setError(result.error)
    })
    void refreshChunkSets()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  async function refreshChunkSets(): Promise<void> {
    const result = await window.api.chunks.list(book.id)
    if (result.ok) setChunkSets(result.sets)
    else setError(result.error)
  }

  async function handleRunFixed(): Promise<void> {
    setRunning(true)
    setError(null)
    try {
      const result = await window.api.chunks.run(book.id, DEFAULT_CHUNK_PARAMS)
      if (!result.ok) {
        setError(result.error)
        return
      }
      await refreshChunkSets()
    } finally {
      setRunning(false)
    }
  }

  const concatenatedHtml = loaded?.spineItems.map((s) => s.html).join('\n<hr />\n') ?? ''
  const spineCount = loaded?.manifest.readingOrder?.length ?? 0
  const hasFixedDefault = chunkSets.some(
    (s) =>
      s.params.size === DEFAULT_CHUNK_PARAMS.size &&
      s.params.overlap === DEFAULT_CHUNK_PARAMS.overlap
  )

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
              running={running}
              hasFixedDefault={hasFixedDefault}
              onRun={handleRunFixed}
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

        {loaded && (
          <div
            style={{
              flex: 1,
              padding: 24,
              overflowY: 'auto',
              lineHeight: 1.6
            }}
            dangerouslySetInnerHTML={{ __html: concatenatedHtml }}
          />
        )}
      </main>
    </div>
  )
}

interface ChunkingSectionProps {
  chunkSets: ChunkSetSummary[]
  running: boolean
  hasFixedDefault: boolean
  onRun: () => void
}

function ChunkingSection({
  chunkSets,
  running,
  hasFixedDefault,
  onRun
}: ChunkingSectionProps): React.JSX.Element {
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
        Chunking
      </h3>
      <button
        onClick={onRun}
        disabled={running}
        style={{
          width: '100%',
          padding: '8px 10px',
          fontSize: 13,
          textAlign: 'left',
          cursor: running ? 'wait' : 'pointer',
          background: '#fff',
          border: '1px solid #d4d4d4',
          borderRadius: 4
        }}
      >
        {running
          ? 'Running…'
          : hasFixedDefault
            ? 'Re-run fixed-1200-200'
            : 'Run fixed-1200-200'}
      </button>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
          {chunkSets.length === 0
            ? 'No chunk sets yet'
            : `${chunkSets.length} chunk set${chunkSets.length === 1 ? '' : 's'}`}
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {chunkSets.map((s) => (
            <li
              key={s.strategyId}
              title={new Date(s.generatedAt).toLocaleString()}
              style={{
                fontSize: 12,
                background: '#fff',
                border: '1px solid #e5e5e5',
                borderRadius: 4,
                padding: '6px 8px'
              }}
            >
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#444' }}>
                {s.strategyId}
              </div>
              <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
                {s.count} chunk{s.count === 1 ? '' : 's'}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export default Reader
