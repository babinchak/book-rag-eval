import { useEffect, useState } from 'react'
import type { IpcError } from '../../../preload/types'
import ErrorDisplay from './ErrorDisplay'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

function SettingsModal({ open, onClose }: SettingsModalProps): React.JSX.Element | null {
  const [hasOpenaiKey, setHasOpenaiKey] = useState<boolean | null>(null)
  const [openaiInput, setOpenaiInput] = useState('')

  const [hasLsKey, setHasLsKey] = useState<boolean | null>(null)
  const [lsInput, setLsInput] = useState('')
  const [lsProject, setLsProject] = useState('')

  const [error, setError] = useState<IpcError | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setOpenaiInput('')
    setLsInput('')

    void window.api.settings.hasOpenaiKey().then((r) => {
      if (r.ok) setHasOpenaiKey(r.hasKey)
      else setError(r.error)
    })
    void window.api.settings.hasLangsmithKey().then((r) => {
      if (r.ok) setHasLsKey(r.hasKey)
      else setError(r.error)
    })
    void window.api.settings.getLangsmithProject().then((r) => {
      if (r.ok) setLsProject(r.value ?? '')
      else setError(r.error)
    })
  }, [open])

  if (!open) return null

  async function handleSaveOpenai(): Promise<void> {
    if (!openaiInput.trim()) {
      setError({ message: 'Please paste an API key' })
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.setOpenaiKey(openaiInput.trim())
      if (!result.ok) {
        setError(result.error)
        return
      }
      setHasOpenaiKey(true)
      setOpenaiInput('')
    } finally {
      setSaving(false)
    }
  }

  async function handleClearOpenai(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.clearOpenaiKey()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setHasOpenaiKey(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveLs(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      if (lsInput.trim()) {
        const r = await window.api.settings.setLangsmithKey(lsInput.trim())
        if (!r.ok) {
          setError(r.error)
          return
        }
        setHasLsKey(true)
        setLsInput('')
      }
      const projectResult = await window.api.settings.setLangsmithProject(lsProject)
      if (!projectResult.ok) {
        setError(projectResult.error)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleClearLs(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.clearLangsmithKey()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setHasLsKey(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 8,
          padding: 24,
          width: 520,
          maxWidth: '92vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Settings</h2>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              cursor: 'pointer',
              color: '#666'
            }}
          >
            ×
          </button>
        </div>

        <section style={{ marginTop: 20 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>OpenAI API key</h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#666', lineHeight: 1.5 }}>
            Used for embeddings and chat completions. Stored encrypted via your operating
            system&apos;s secure storage. Never written to disk in plaintext.
          </p>

          {hasOpenaiKey === true && (
            <StatusBadge color="emerald">
              Set. Paste a new one below to replace, or clear it.
            </StatusBadge>
          )}

          <input
            type="password"
            placeholder="sk-..."
            value={openaiInput}
            onChange={(e) => setOpenaiInput(e.target.value)}
            disabled={saving}
            style={inputStyle}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              onClick={handleSaveOpenai}
              disabled={saving || !openaiInput.trim()}
              style={primaryBtn}
            >
              {saving ? 'Saving…' : hasOpenaiKey ? 'Replace key' : 'Save key'}
            </button>
            {hasOpenaiKey && (
              <button onClick={handleClearOpenai} disabled={saving} style={destructiveBtn}>
                Clear
              </button>
            )}
          </div>
        </section>

        <section style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid #eee' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>
            LangSmith tracing (optional)
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#666', lineHeight: 1.5 }}>
            When set, agent runs (Ask flow) are traced to your LangSmith project. Get an API key
            from{' '}
            <a
              href="https://smith.langchain.com/settings"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#2563eb' }}
            >
              smith.langchain.com/settings
            </a>
            . Tracing is disabled if no key is set.
          </p>

          {hasLsKey === true && <StatusBadge color="emerald">API key is set.</StatusBadge>}

          <label style={labelStyle}>API key</label>
          <input
            type="password"
            placeholder={hasLsKey ? 'Paste a new key to replace' : 'lsv2_...'}
            value={lsInput}
            onChange={(e) => setLsInput(e.target.value)}
            disabled={saving}
            style={inputStyle}
          />

          <label style={{ ...labelStyle, marginTop: 10 }}>Project name</label>
          <input
            type="text"
            placeholder="book-rag-eval"
            value={lsProject}
            onChange={(e) => setLsProject(e.target.value)}
            disabled={saving}
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={handleSaveLs} disabled={saving} style={primaryBtn}>
              {saving ? 'Saving…' : 'Save LangSmith config'}
            </button>
            {hasLsKey && (
              <button onClick={handleClearLs} disabled={saving} style={destructiveBtn}>
                Clear key
              </button>
            )}
          </div>
        </section>

        <ErrorDisplay error={error} marginTop={16} />
      </div>
    </div>
  )
}

function StatusBadge({
  color,
  children
}: {
  color: 'emerald'
  children: React.ReactNode
}): React.JSX.Element {
  const palette = {
    emerald: { bg: '#ecfdf5', border: '#6ee7b7', text: '#065f46' }
  }[color]
  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,
        padding: '8px 12px',
        fontSize: 13,
        color: palette.text,
        marginBottom: 12
      }}
    >
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'monospace',
  border: '1px solid #d4d4d4',
  borderRadius: 4,
  boxSizing: 'border-box'
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: '#666',
  marginBottom: 4
}

const primaryBtn: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 13,
  cursor: 'pointer',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 4
}

const destructiveBtn: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 13,
  cursor: 'pointer',
  background: '#fff',
  color: '#b91c1c',
  border: '1px solid #fca5a5',
  borderRadius: 4
}

export default SettingsModal
