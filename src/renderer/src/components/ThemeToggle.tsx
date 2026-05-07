import type { ThemeMode } from '../lib/theme'
import { cv } from '../lib/theme'

interface ThemeToggleProps {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
}

function ThemeToggle({ mode, setMode }: ThemeToggleProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        background: cv.surface,
        border: `1px solid ${cv.border}`,
        borderRadius: 5,
        padding: 2
      }}
    >
      {(['light', 'dark', 'system'] as ThemeMode[]).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          style={{
            padding: '3px 8px',
            fontSize: 11,
            cursor: 'pointer',
            background: mode === m ? cv.bg : 'transparent',
            color: mode === m ? cv.text1 : cv.text4,
            border: `1px solid ${mode === m ? cv.border2 : 'transparent'}`,
            borderRadius: 3
          }}
        >
          {m === 'light' ? '☀' : m === 'dark' ? '☾' : '⊙'}
        </button>
      ))}
    </div>
  )
}

export default ThemeToggle
