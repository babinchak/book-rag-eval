import { useState } from 'react'
import type { LoadedEpub } from '../../preload/types'

function formatAuthor(author: unknown): string | null {
  if (!author) return null
  if (typeof author === 'string') return author
  if (Array.isArray(author)) {
    return author
      .map((a) => (typeof a === 'string' ? a : (a as { name?: string })?.name))
      .filter(Boolean)
      .join(', ')
  }
  if (typeof author === 'object') return (author as { name?: string }).name ?? null
  return null
}

function App(): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [epub, setEpub] = useState<LoadedEpub | null>(null)

  async function handleLoad(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.loadEpub()
      if (result.ok === true) {
        if (result.data) setEpub(result.data)
        return
      }
      setError(result.error)
    } finally {
      setLoading(false)
    }
  }

  const author = epub ? formatAuthor(epub.manifest.metadata?.author) : null
  const spine = epub?.manifest.readingOrder ?? []
  const concatenatedHtml = epub?.spineItems.map((s) => s.html).join('\n<hr />\n') ?? ''

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, color: '#222' }}>
      <h1 style={{ margin: 0, fontSize: 22 }}>book-rag-eval</h1>
      <button
        onClick={handleLoad}
        disabled={loading}
        style={{ marginTop: 16, padding: '8px 16px', fontSize: 14, cursor: 'pointer' }}
      >
        {loading ? 'Loading...' : 'Load EPUB'}
      </button>
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
      {epub && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>
            {epub.manifest.metadata?.title ?? '(no title)'}
          </h2>
          {author && <div style={{ color: '#555' }}>{author}</div>}
          <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>{epub.path}</div>
          <div style={{ marginTop: 12 }}>Spine items: {spine.length}</div>
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer' }}>Spine</summary>
            <ol style={{ marginTop: 8 }}>
              {spine.map((item, i) => (
                <li key={i} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                  {item.href}
                </li>
              ))}
            </ol>
          </details>
          <div
            style={{
              marginTop: 24,
              padding: 24,
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: 4,
              maxHeight: '70vh',
              overflowY: 'auto',
              lineHeight: 1.6
            }}
            dangerouslySetInnerHTML={{ __html: concatenatedHtml }}
          />
        </div>
      )}
    </div>
  )
}

export default App
