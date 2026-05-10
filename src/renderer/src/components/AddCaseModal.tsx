import { useState } from 'react'
import type { EvalCase, GoldSpan, IpcError, LocateQuoteHit } from '../../../preload/types'
import { cv } from '../lib/theme'
import ErrorDisplay from './ErrorDisplay'

interface AddCaseModalProps {
  bookId: string
  setId: string
  editCase?: EvalCase
  onClose: () => void
  onSaved: () => void
}

function AddCaseModal({ bookId, setId, editCase, onClose, onSaved }: AddCaseModalProps): React.JSX.Element {
  const isEdit = editCase !== undefined
  const [question, setQuestion] = useState(editCase?.question ?? '')
  const [searchQuery, setSearchQuery] = useState(editCase?.searchQuery ?? '')
  const [quote, setQuote] = useState('')
  const [located, setLocated] = useState<LocateQuoteHit | null>(null)
  const [error, setError] = useState<IpcError | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleLocate(): Promise<void> {
    setBusy(true)
    setError(null)
    setLocated(null)
    try {
      const r = await window.api.evals.locate(bookId, quote)
      if (!r.ok) { setError(r.error); return }
      setLocated(r.data)
    } finally {
      setBusy(false)
    }
  }

  const questionChanged = isEdit && question.trim() !== editCase!.question
  const searchQueryChanged = isEdit && searchQuery.trim() !== editCase!.searchQuery
  const goldChanged = located !== null
  const canSave = isEdit
    ? question.trim().length > 0 &&
      searchQuery.trim().length > 0 &&
      (questionChanged || searchQueryChanged || goldChanged)
    : question.trim().length > 0 && searchQuery.trim().length > 0 && located !== null

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (isEdit) {
        const updates: {
          question?: string
          searchQuery?: string
          goldSpans?: GoldSpan[]
        } = {}
        if (questionChanged) updates.question = question
        if (searchQueryChanged) updates.searchQuery = searchQuery
        if (goldChanged) updates.goldSpans = [located!.goldSpan]
        const r = await window.api.evals.updateCase(bookId, setId, editCase!.id, updates)
        if (!r.ok) { setError(r.error); return }
      } else {
        const goldSpans: GoldSpan[] = [located!.goldSpan]
        const r = await window.api.evals.addCase(
          bookId,
          setId,
          question,
          searchQuery,
          goldSpans
        )
        if (!r.ok) { setError(r.error); return }
      }
      onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    fontFamily: 'inherit',
    border: `1px solid ${cv.border2}`,
    borderRadius: 4,
    boxSizing: 'border-box',
    resize: 'vertical',
    background: cv.bg,
    color: cv.text1
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: cv.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: cv.bg,
          borderRadius: 8,
          padding: 24,
          width: 560,
          maxWidth: '92vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          border: `1px solid ${cv.border}`
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: cv.text1 }}>
            {isEdit ? 'Edit eval case' : 'Add eval case'}
          </h2>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: cv.text3 }}
          >
            ×
          </button>
        </div>

        <p style={{ margin: '6px 0 16px', fontSize: 12, color: cv.text3, lineHeight: 1.5 }}>
          {isEdit
            ? 'Edit the question and/or replace the gold passage by pasting a new quote.'
            : 'A case is a question + the gold passage that contains its answer. Paste a quote from the book; the app will locate it and capture its position.'}
        </p>

        <label style={{ display: 'block', fontSize: 11, color: cv.text3, marginBottom: 4 }}>
          Question (used by agent evals)
        </label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="What is the relationship between Jekyll and Hyde?"
          style={inputStyle}
          disabled={busy}
        />

        <label
          style={{
            display: 'block',
            fontSize: 11,
            color: cv.text3,
            marginTop: 14,
            marginBottom: 4
          }}
        >
          Search query (used by retrieval evals)
        </label>
        <textarea
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          rows={1}
          placeholder="jekyll hyde relationship"
          style={inputStyle}
          disabled={busy}
        />

        {isEdit && !located && (
          <div
            style={{
              marginTop: 14,
              background: cv.surface2,
              border: `1px solid ${cv.border}`,
              borderRadius: 4,
              padding: 10,
              fontSize: 11,
              color: cv.text3,
              lineHeight: 1.5
            }}
          >
            <div style={{ fontWeight: 600, color: cv.text2, marginBottom: 4 }}>Current gold span</div>
            {editCase!.goldSpans.map((g, i) => (
              <div key={i} style={{ fontFamily: 'monospace' }}>
                {g.spineHref} : {g.textStart}–{g.textEnd}
              </div>
            ))}
            <div style={{ marginTop: 6, color: cv.text4 }}>
              Paste a new quote below to replace it, or leave empty to keep as-is.
            </div>
          </div>
        )}

        <label style={{ display: 'block', fontSize: 11, color: cv.text3, marginTop: 14, marginBottom: 4 }}>
          {isEdit ? 'New gold passage (optional)' : 'Gold passage (paste a quote)'}
        </label>
        <textarea
          value={quote}
          onChange={(e) => { setQuote(e.target.value); setLocated(null) }}
          rows={4}
          placeholder='"That is the very fellow." said Mr. Utterson...'
          style={inputStyle}
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
              background: cv.surface,
              color: cv.text2,
              border: `1px solid ${cv.border2}`,
              borderRadius: 4
            }}
          >
            {busy ? 'Locating…' : 'Locate in book'}
          </button>
          <button
            onClick={handleSave}
            disabled={busy || !canSave}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              cursor: busy || !canSave ? 'not-allowed' : 'pointer',
              background: canSave ? cv.accent : cv.surface,
              color: canSave ? cv.accentText : cv.text4,
              border: 'none',
              borderRadius: 4,
              opacity: canSave ? 1 : 0.6
            }}
          >
            {isEdit ? 'Save changes' : 'Save case'}
          </button>
        </div>

        {located && (
          <div
            style={{
              marginTop: 12,
              background: cv.successBg,
              border: `1px solid ${cv.successBorder}`,
              borderRadius: 4,
              padding: 10,
              fontSize: 12,
              color: cv.successText
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {isEdit ? 'New span located in ' : 'Located in '}{located.goldSpan.spineHref}
            </div>
            <div style={{ color: cv.text2, fontStyle: 'italic' }}>"{located.preview}"</div>
            <div style={{ color: cv.text3, marginTop: 4, fontSize: 11 }}>
              span: {located.goldSpan.textStart}–{located.goldSpan.textEnd}
            </div>
          </div>
        )}

        <ErrorDisplay error={error} marginTop={12} />
      </div>
    </div>
  )
}

export default AddCaseModal
