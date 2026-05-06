import { useState } from 'react'
import type { GoldSpan, LocateQuoteHit } from '../../../preload/types'

interface AddCaseModalProps {
  bookId: string
  setId: string
  onClose: () => void
  onAdded: () => void
}

function AddCaseModal({ bookId, setId, onClose, onAdded }: AddCaseModalProps): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [quote, setQuote] = useState('')
  const [located, setLocated] = useState<LocateQuoteHit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleLocate(): Promise<void> {
    setBusy(true)
    setError(null)
    setLocated(null)
    try {
      const r = await window.api.evals.locate(bookId, quote)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setLocated(r.data)
    } finally {
      setBusy(false)
    }
  }

  async function handleSave(): Promise<void> {
    if (!located || !question.trim()) return
    setBusy(true)
    setError(null)
    try {
      const goldSpans: GoldSpan[] = [located.goldSpan]
      const r = await window.api.evals.addCase(bookId, setId, question, goldSpans)
      if (!r.ok) {
        setError(r.error)
        return
      }
      onAdded()
      onClose()
    } finally {
      setBusy(false)
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
          width: 560,
          maxWidth: '92vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Add eval case</h2>
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

        <p style={{ margin: '6px 0 16px', fontSize: 12, color: '#666', lineHeight: 1.5 }}>
          A case is a question + the gold passage that contains its answer. Paste a quote
          from the book; the app will locate it and capture its position.
        </p>

        <label style={{ display: 'block', fontSize: 11, color: '#666', marginBottom: 4 }}>
          Question
        </label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="What is the relationship between Jekyll and Hyde?"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 13,
            fontFamily: 'inherit',
            border: '1px solid #d4d4d4',
            borderRadius: 4,
            boxSizing: 'border-box',
            resize: 'vertical'
          }}
          disabled={busy}
        />

        <label style={{ display: 'block', fontSize: 11, color: '#666', marginTop: 14, marginBottom: 4 }}>
          Gold passage (paste a quote)
        </label>
        <textarea
          value={quote}
          onChange={(e) => {
            setQuote(e.target.value)
            setLocated(null)
          }}
          rows={4}
          placeholder='"That is the very fellow." said Mr. Utterson...'
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 13,
            fontFamily: 'inherit',
            border: '1px solid #d4d4d4',
            borderRadius: 4,
            boxSizing: 'border-box',
            resize: 'vertical'
          }}
          disabled={busy}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            onClick={handleLocate}
            disabled={busy || !quote.trim()}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              cursor: busy ? 'wait' : 'pointer',
              background: '#fff',
              border: '1px solid #d4d4d4',
              borderRadius: 4
            }}
          >
            {busy ? 'Locating…' : 'Locate in book'}
          </button>
          {located && (
            <button
              onClick={handleSave}
              disabled={busy || !question.trim()}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                cursor: 'pointer',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4
              }}
            >
              Save case
            </button>
          )}
        </div>

        {located && (
          <div
            style={{
              marginTop: 12,
              background: '#ecfdf5',
              border: '1px solid #6ee7b7',
              borderRadius: 4,
              padding: 10,
              fontSize: 12,
              color: '#065f46'
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Located in {located.goldSpan.spineHref}
            </div>
            <div style={{ color: '#444', fontStyle: 'italic' }}>"{located.preview}"</div>
            <div style={{ color: '#666', marginTop: 4, fontSize: 11 }}>
              span: {located.goldSpan.textStart}–{located.goldSpan.textEnd}
            </div>
          </div>
        )}

        {error && (
          <pre
            style={{
              color: '#b00',
              whiteSpace: 'pre-wrap',
              marginTop: 12,
              background: '#fee',
              padding: 10,
              border: '1px solid #fbb',
              borderRadius: 4,
              fontSize: 11
            }}
          >
            {error}
          </pre>
        )}
      </div>
    </div>
  )
}

export default AddCaseModal
