import { useEffect, useState } from 'react'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

function SettingsModal({ open, onClose }: SettingsModalProps): React.JSX.Element | null {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setKeyInput('')
    void window.api.settings.hasOpenaiKey().then((r) => {
      if (r.ok) setHasKey(r.hasKey)
      else setError(r.error)
    })
  }, [open])

  if (!open) return null

  async function handleSave(): Promise<void> {
    if (!keyInput.trim()) {
      setError('Please paste an API key')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.setOpenaiKey(keyInput.trim())
      if (!result.ok) {
        setError(result.error)
        return
      }
      setHasKey(true)
      setKeyInput('')
    } finally {
      setSaving(false)
    }
  }

  async function handleClear(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.clearOpenaiKey()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setHasKey(false)
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
          width: 480,
          maxWidth: '92vw',
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
            system&apos;s secure storage (Keychain / DPAPI). Never written to disk in plaintext.
          </p>

          {hasKey === null && <div style={{ fontSize: 13, color: '#888' }}>Loading…</div>}

          {hasKey === true && (
            <div
              style={{
                background: '#ecfdf5',
                border: '1px solid #6ee7b7',
                borderRadius: 4,
                padding: '8px 12px',
                fontSize: 13,
                color: '#065f46',
                marginBottom: 12
              }}
            >
              API key is set. Paste a new one below to replace it, or clear it.
            </div>
          )}

          <input
            type="password"
            placeholder="sk-..."
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            disabled={saving}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              fontFamily: 'monospace',
              border: '1px solid #d4d4d4',
              borderRadius: 4,
              boxSizing: 'border-box'
            }}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              onClick={handleSave}
              disabled={saving || !keyInput.trim()}
              style={{
                padding: '7px 14px',
                fontSize: 13,
                cursor: saving ? 'wait' : 'pointer',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4
              }}
            >
              {saving ? 'Saving…' : hasKey ? 'Replace key' : 'Save key'}
            </button>
            {hasKey && (
              <button
                onClick={handleClear}
                disabled={saving}
                style={{
                  padding: '7px 14px',
                  fontSize: 13,
                  cursor: saving ? 'wait' : 'pointer',
                  background: '#fff',
                  color: '#b91c1c',
                  border: '1px solid #fca5a5',
                  borderRadius: 4
                }}
              >
                Clear
              </button>
            )}
          </div>
        </section>

        {error && (
          <pre
            style={{
              color: '#b00',
              whiteSpace: 'pre-wrap',
              marginTop: 16,
              background: '#fee',
              padding: 10,
              border: '1px solid #fbb',
              borderRadius: 4,
              fontSize: 12
            }}
          >
            {error}
          </pre>
        )}
      </div>
    </div>
  )
}

export default SettingsModal
