import { useEffect, useMemo, useState } from 'react'
import type { BookSummary, CollectionSummary, IpcError } from '../../../preload/types'
import SettingsModal from './SettingsModal'
import ThemeToggle from './ThemeToggle'
import ErrorDisplay from './ErrorDisplay'
import ErrorInbox from './ErrorInbox'
import { cv, useTheme } from '../lib/theme'

interface LibraryProps {
  onOpen: (book: BookSummary) => void
}

const UNCATEGORIZED_ID = '__uncategorized__'
const UNCATEGORIZED_NAME = 'Uncategorized'

type ViewMode = 'collections' | 'books'
type SortKey = 'lastOpened' | 'lastAdded' | 'title'

const VIEW_MODE_STORAGE_KEY = 'library:viewMode'
const SORT_KEY_STORAGE_KEY = 'library:booksSortKey'

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback
  const v = window.localStorage.getItem(key)
  return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback
}

function sortBooks(books: BookSummary[], key: SortKey): BookSummary[] {
  const copy = books.slice()
  if (key === 'title') {
    copy.sort((a, b) => a.title.localeCompare(b.title))
  } else if (key === 'lastAdded') {
    copy.sort((a, b) => b.addedAt - a.addedAt)
  } else {
    // lastOpened: most recently opened first; never-opened books fall back to addedAt
    copy.sort((a, b) => {
      const av = a.lastOpenedAt ?? a.addedAt
      const bv = b.lastOpenedAt ?? b.addedAt
      return bv - av
    })
  }
  return copy
}

interface GroupedSection {
  id: string
  name: string
  books: BookSummary[]
}

function groupByCollection(
  books: BookSummary[],
  collections: CollectionSummary[]
): GroupedSection[] {
  const byId = new Map<string, BookSummary[]>()
  for (const b of books) {
    const key = b.collectionId ?? UNCATEGORIZED_ID
    let bucket = byId.get(key)
    if (!bucket) {
      bucket = []
      byId.set(key, bucket)
    }
    bucket.push(b)
  }
  const sections: GroupedSection[] = []
  for (const c of collections) {
    const bucket = byId.get(c.id)
    if (!bucket || bucket.length === 0) continue
    sections.push({ id: c.id, name: c.name, books: bucket })
    byId.delete(c.id)
  }
  // Any collectionId on a book that isn't in the registry — list them under a
  // synthetic section so they don't silently vanish.
  for (const [id, bucket] of byId) {
    if (id === UNCATEGORIZED_ID) continue
    sections.push({ id, name: id, books: bucket })
  }
  const orphans = byId.get(UNCATEGORIZED_ID)
  if (orphans && orphans.length > 0) {
    sections.push({ id: UNCATEGORIZED_ID, name: UNCATEGORIZED_NAME, books: orphans })
  }
  return sections
}

function Library({ onOpen }: LibraryProps): React.JSX.Element {
  const [books, setBooks] = useState<BookSummary[] | null>(null)
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [error, setError] = useState<IpcError | null>(null)
  const [importing, setImporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [viewMode, setViewModeState] = useState<ViewMode>(() =>
    readStored<ViewMode>(VIEW_MODE_STORAGE_KEY, ['collections', 'books'], 'books')
  )
  const [sortKey, setSortKeyState] = useState<SortKey>(() =>
    readStored<SortKey>(SORT_KEY_STORAGE_KEY, ['lastOpened', 'lastAdded', 'title'], 'lastOpened')
  )
  const { mode, setMode } = useTheme()

  function setViewMode(next: ViewMode): void {
    setViewModeState(next)
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next)
  }

  function setSortKey(next: SortKey): void {
    setSortKeyState(next)
    window.localStorage.setItem(SORT_KEY_STORAGE_KEY, next)
  }

  async function refresh(): Promise<void> {
    const [booksResult, collectionsResult] = await Promise.all([
      window.api.library.list(),
      window.api.collections.list()
    ])
    if (!booksResult.ok) {
      setError(booksResult.error)
      return
    }
    if (!collectionsResult.ok) {
      setError(collectionsResult.error)
      return
    }
    setBooks(booksResult.books)
    setCollections(collectionsResult.collections)
    setError(null)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleImport(): Promise<void> {
    setImporting(true)
    setError(null)
    try {
      const result = await window.api.library.import()
      if (!result.ok) {
        setError(result.error)
        return
      }
      await refresh()
    } finally {
      setImporting(false)
    }
  }

  async function handleRemove(id: string): Promise<void> {
    const result = await window.api.library.remove(id)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await refresh()
  }

  function toggleCollapsed(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const sections = useMemo(
    () => (books ? groupByCollection(books, collections) : []),
    [books, collections]
  )

  const sortedBooks = useMemo(
    () => (books ? sortBooks(books, sortKey) : []),
    [books, sortKey]
  )

  return (
    <div style={{ padding: 32, color: cv.text1 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Library</h1>
        <span style={{ color: cv.text4, fontSize: 13 }}>
          {books ? `${books.length} ${books.length === 1 ? 'book' : 'books'}` : 'loading…'}
          {books && sections.length > 1
            ? ` · ${sections.length} collections`
            : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
          {viewMode === 'books' && <SortPicker sortKey={sortKey} setSortKey={setSortKey} />}
          <ErrorInbox />
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

      <ErrorDisplay error={error} marginTop={16} />

      <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 32 }}>
        <ImportTile importing={importing} onImport={handleImport} />

        {viewMode === 'books' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 24
            }}
          >
            {sortedBooks.map((book) => (
              <BookCard key={book.id} book={book} onOpen={onOpen} onRemove={handleRemove} />
            ))}
          </div>
        ) : (
          sections.map((section) => {
            const isCollapsed = collapsed.has(section.id)
            return (
              <section key={section.id}>
                <button
                  onClick={() => toggleCollapsed(section.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `1px solid ${cv.border2}`,
                    padding: '6px 0',
                    marginBottom: 16,
                    cursor: 'pointer',
                    color: cv.text1
                  }}
                >
                  <span style={{ fontSize: 12, color: cv.text4, width: 12 }}>
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{section.name}</h2>
                  <span style={{ fontSize: 12, color: cv.text4 }}>
                    {section.books.length} {section.books.length === 1 ? 'book' : 'books'}
                  </span>
                </button>
                {!isCollapsed && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                      gap: 24
                    }}
                  >
                    {section.books.map((book) => (
                      <BookCard
                        key={book.id}
                        book={book}
                        onOpen={onOpen}
                        onRemove={handleRemove}
                      />
                    ))}
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}

interface ViewToggleProps {
  viewMode: ViewMode
  setViewMode: (next: ViewMode) => void
}

function ViewToggle({ viewMode, setViewMode }: ViewToggleProps): React.JSX.Element {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        border: `1px solid ${cv.border2}`,
        borderRadius: 4,
        overflow: 'hidden'
      }}
    >
      {(['books', 'collections'] as const).map((m) => {
        const active = viewMode === m
        return (
          <button
            key={m}
            role="tab"
            aria-selected={active}
            onClick={() => setViewMode(m)}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              cursor: 'pointer',
              background: active ? cv.surface2 : cv.bg,
              color: active ? cv.text1 : cv.text3,
              border: 'none',
              borderRight: m === 'books' ? `1px solid ${cv.border2}` : 'none'
            }}
          >
            {m === 'books' ? 'Books' : 'Collections'}
          </button>
        )
      })}
    </div>
  )
}

interface SortPickerProps {
  sortKey: SortKey
  setSortKey: (next: SortKey) => void
}

function SortPicker({ sortKey, setSortKey }: SortPickerProps): React.JSX.Element {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: cv.text3 }}>
      Sort
      <select
        value={sortKey}
        onChange={(e) => setSortKey(e.target.value as SortKey)}
        style={{
          padding: '4px 8px',
          fontSize: 12,
          background: cv.bg,
          color: cv.text2,
          border: `1px solid ${cv.border2}`,
          borderRadius: 4,
          cursor: 'pointer'
        }}
      >
        <option value="lastOpened">Last opened</option>
        <option value="lastAdded">Last added</option>
        <option value="title">Title</option>
      </select>
    </label>
  )
}

interface ImportTileProps {
  importing: boolean
  onImport: () => void
}

function ImportTile({ importing, onImport }: ImportTileProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 24
      }}
    >
      <button
        onClick={onImport}
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
