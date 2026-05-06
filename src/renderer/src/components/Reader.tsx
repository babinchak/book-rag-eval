import { useEffect, useState } from 'react'
import type { BookSummary, LoadedEpub } from '../../../preload/types'

interface ReaderProps {
  book: BookSummary
  onBack: () => void
}

function Reader({ book, onBack }: ReaderProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<LoadedEpub | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    void window.api.library.open(book.id).then((result) => {
      if (cancelled) return
      if (result.ok) setLoaded(result.data)
      else setError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [book.id])

  const concatenatedHtml = loaded?.spineItems.map((s) => s.html).join('\n<hr />\n') ?? ''
  const spineCount = loaded?.manifest.readingOrder?.length ?? 0

  return (
    <div style={{ padding: 24, color: '#222' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          paddingBottom: 12,
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
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{book.title}</h2>
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
            marginTop: 16,
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
            marginTop: 16,
            padding: 24,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 4,
            maxHeight: 'calc(100vh - 140px)',
            overflowY: 'auto',
            lineHeight: 1.6
          }}
          dangerouslySetInnerHTML={{ __html: concatenatedHtml }}
        />
      )}
    </div>
  )
}

export default Reader
