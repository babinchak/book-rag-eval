import { useState } from 'react'
import type { BookSummary } from '../../preload/types'
import Library from './components/Library'
import Reader from './components/Reader'
import StrategyManager from './components/StrategyManager'
import ViewErrorBoundary from './components/ViewErrorBoundary'
import { cv } from './lib/theme'

type View =
  | { kind: 'library' }
  | { kind: 'reader'; book: BookSummary }
  | { kind: 'strategies' }

function App(): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' })

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        minHeight: '100vh',
        background: cv.bg,
        color: cv.text1
      }}
    >
      {view.kind === 'library' && (
        <ViewErrorBoundary view="library" onReset={() => setView({ kind: 'library' })}>
          <Library
            onOpen={(book) => setView({ kind: 'reader', book })}
            onOpenStrategies={() => setView({ kind: 'strategies' })}
          />
        </ViewErrorBoundary>
      )}
      {view.kind === 'reader' && (
        <ViewErrorBoundary view="reader" onReset={() => setView({ kind: 'library' })}>
          <Reader key={view.book.id} book={view.book} onBack={() => setView({ kind: 'library' })} />
        </ViewErrorBoundary>
      )}
      {view.kind === 'strategies' && (
        <ViewErrorBoundary view="strategies" onReset={() => setView({ kind: 'library' })}>
          <StrategyManager onBack={() => setView({ kind: 'library' })} />
        </ViewErrorBoundary>
      )}
    </div>
  )
}

export default App
