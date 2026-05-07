import { useState } from 'react'
import type { BookSummary } from '../../preload/types'
import Library from './components/Library'
import Reader from './components/Reader'
import { cv } from './lib/theme'

type View = { kind: 'library' } | { kind: 'reader'; book: BookSummary }

function App(): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' })

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: cv.bg, color: cv.text1 }}>
      {view.kind === 'library' ? (
        <Library onOpen={(book) => setView({ kind: 'reader', book })} />
      ) : (
        <Reader key={view.book.id} book={view.book} onBack={() => setView({ kind: 'library' })} />
      )}
    </div>
  )
}

export default App
