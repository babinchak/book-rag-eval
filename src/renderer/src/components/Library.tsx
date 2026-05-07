import { useEffect, useState } from 'react'
import type { BookSummary } from '../../../preload/types'
import SettingsModal from './SettingsModal'
import ThemeToggle from './ThemeToggle'
import { cv, useTheme } from '../lib/theme'

interface LibraryProps {
  onOpen: (book: BookSummary) => void
}

function Library({ onOpen }: LibraryProps): React.JSX.Element {
  const [books, setBooks] = useState<BookSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { mode, setMode } = useTheme()

  async function refresh(): Promise<void> {
    const result = await window.api.library.list()
    if (result.ok) { setBooks(result.books); setError(null) }
    else setError(result.error)
  }

  useEffect(() => { void refresh() }, [])

  async function handleImport(): Promise<void> {
    setImporting(true)
    setError(null)
    try {
      const result = await window.api.library.import()
      if (!result.ok) { setError(result.error); return }
      await refresh()
    } finally {
      setImporting(false)
    }
  }

  async function handleRemove(id: string): Promise<void> {
    const result = await window.api.library.remove(id)
    if (!result.ok) { setError(result.error); return }
    await refresh()
  }

  return (
    <div style={{ padding: 32, color: cv.text1 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Library</h1>
        <span style={{ color: cv.text4, fontSize: 13 }}>
          {books ? `${books.length} ${books.length === 1 ? 'book' : 'books'}` : 'loading…'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <ThemeToggle mode={mode} setMode={setMode} />
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              cursor: 'pointer',
              background: cv.bg,
              color: cv.text2,
              border: `1px solid ${cv.border2}`,
              borderRadius: 4
            }}
          >
            ⚙ Settings
          </button>
        </div>
      </header>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {error && (
        <pre
          style={{
            color: cv.errorText,
            whiteSpace: 'pre-wrap',
            marginTop: 16,
            background: cv.errorBg,
            padding: 12,
            border: `1px solid ${cv.errorBorder}`,
            borderRadius: 4
          }}
        >
          {error}
        </pre>
      )}

      <div
        style={{
          marginTop: 24,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 24
        }}
      >
        <button
          onClick={handleImport}
          disabled={importing}
          style={{
            aspectRatio: '2 / 3',
            border: `2px dashed ${cv.border3}`,
            borderRadius: 6,
            background: cv.surface2,
            color: cv.text3,
            fontSize: 14,
            cursor: importing ? 'wait' : 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8
          }}
        >
          <span style={{ fontSize: 32, lineHeight: 1 }}>+</span>
          <span>{importing ? 'Importing…' : 'Add EPUB'}</span>
        </button>

        {books?.map((book) => (
          <BookCard key={book.id} book={book} onOpen={onOpen} onRemove={handleRemove} />
        ))}
      </div>
    </div>
  )
}

interface BookCardProps {
  book: BookSummary
  onOpen: (book: BookSummary) => void
  onRemove: (id: string) => void
}

function BookCard({ book, onOpen, onRemove }: BookCardProps): React.JSX.Element {
  const [hover, setHover] = useState(false)

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <button
        onClick={() => onOpen(book)}
        style={{
          aspectRatio: '2 / 3',
          border: `1px solid ${cv.border}`,
          borderRadius: 4,
          padding: 0,
          background: book.coverDataUrl ? '#000' : cv.surface,
          cursor: 'pointer',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {book.coverDataUrl ? (
          <img src={book.coverDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ color: cv.text4, padding: 12, textAlign: 'center', fontSize: 13 }}>
            {book.title}
          </span>
        )}
      </button>
      <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.3, color: cv.text1 }}>{book.title}</div>
      {book.author && <div style={{ fontSize: 12, color: cv.text3 }}>{book.author}</div>}
      {hover && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`Remove "${book.title}" from library?`)) onRemove(book.id)
          }}
          title="Remove from library"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 24,
            height: 24,
            borderRadius: '50%',
            border: 'none',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

export default Library
