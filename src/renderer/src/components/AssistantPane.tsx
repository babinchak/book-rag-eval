import { useEffect, useState } from 'react'
import type { AskResultPayload, ChunkSetSummary, EmbeddingSetSummary } from '../../../preload/types'

interface AssistantPaneProps {
  bookId: string
  chunkSets: ChunkSetSummary[]
  embeddingSets: EmbeddingSetSummary[]
  onSelectChunk: (strategyId: string, chunkId: string) => void
  highlightedChunkId: string | null
}

const DEFAULT_K = 5

function AssistantPane({
  bookId,
  chunkSets,
  embeddingSets,
  onSelectChunk,
  highlightedChunkId
}: AssistantPaneProps): React.JSX.Element {
  const fullyEmbedded = embeddingSets.filter((e) => {
    const set = chunkSets.find((s) => s.strategyId === e.strategyId)
    return set !== undefined && e.count >= set.count
  })

  const [strategyId, setStrategyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [k, setK] = useState(DEFAULT_K)
  const [result, setResult] = useState<AskResultPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (fullyEmbedded.length === 0) {
      setStrategyId(null)
      return
    }
    if (!strategyId || !fullyEmbedded.find((e) => e.strategyId === strategyId)) {
      setStrategyId(fullyEmbedded[0].strategyId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullyEmbedded.map((e) => e.strategyId).join(',')])

  // Clear query state when switching books
  useEffect(() => {
    setResult(null)
    setQuery('')
    setError(null)
  }, [bookId])

  async function handleSubmit(): Promise<void> {
    const trimmed = query.trim()
    if (!trimmed || !strategyId) return
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.ask.run(bookId, strategyId, trimmed, k)
      if (!r.ok) {
        setError(r.error)
        setResult(null)
        return
      }
      setResult(r.data)
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <div style={{ overflowY: 'auto', padding: 12, height: '100%' }}>
      <h3
        style={{
          margin: '0 0 8px',
          fontSize: 12,
          fontWeight: 600,
          color: '#444',
          textTransform: 'uppercase',
          letterSpacing: 0.5
        }}
      >
        Assistant
      </h3>

      {fullyEmbedded.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: '#888',
            background: '#fafafa',
            border: '1px solid #e5e5e5',
            borderRadius: 4,
            padding: 10,
            lineHeight: 1.5
          }}
        >
          Embed a chunk set in the left rail before asking questions.
        </div>
      ) : (
        <>
          <label
            style={{ display: 'block', fontSize: 11, color: '#666', marginBottom: 4 }}
            htmlFor="strategy-select"
          >
            Retrieval strategy
          </label>
          <select
            id="strategy-select"
            value={strategyId ?? ''}
            onChange={(e) => setStrategyId(e.target.value)}
            disabled={loading}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'monospace',
              border: '1px solid #d4d4d4',
              borderRadius: 4,
              marginBottom: 10
            }}
          >
            {fullyEmbedded.map((e) => (
              <option key={e.strategyId} value={e.strategyId}>
                {e.strategyId} ({e.count})
              </option>
            ))}
          </select>

          <textarea
            placeholder="Ask a question about this book…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            rows={3}
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
          />

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
            <button
              onClick={handleSubmit}
              disabled={loading || !query.trim() || !strategyId}
              style={{
                flex: 1,
                padding: '7px 10px',
                fontSize: 13,
                cursor: loading ? 'wait' : 'pointer',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4
              }}
            >
              {loading ? 'Asking…' : 'Ask (⌘↵)'}
            </button>
            <label
              style={{ fontSize: 11, color: '#666', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              k=
              <input
                type="number"
                min={1}
                max={20}
                value={k}
                onChange={(e) => setK(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                disabled={loading}
                style={{
                  width: 40,
                  padding: '4px 6px',
                  fontSize: 12,
                  border: '1px solid #d4d4d4',
                  borderRadius: 3
                }}
              />
            </label>
          </div>

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

          {result && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#444',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 6
                }}
              >
                Answer
              </div>
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: '#fafafa',
                  border: '1px solid #e5e5e5',
                  borderRadius: 4,
                  padding: 10,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {result.answer}
              </div>
              <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                {result.model} · {result.totalTokens} tokens
                {result.langsmithRunUrl && (
                  <>
                    {' · '}
                    <a
                      href={result.langsmithRunUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#2563eb' }}
                    >
                      View trace ↗
                    </a>
                  </>
                )}
              </div>

              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#444',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginTop: 16,
                  marginBottom: 6
                }}
              >
                Sources ({result.retrieved.length})
              </div>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
                {result.retrieved.map((r) => {
                  const isHighlighted = r.chunk.id === highlightedChunkId
                  return (
                    <li
                      key={r.chunk.id}
                      onClick={() => onSelectChunk(r.chunk.strategyId, r.chunk.id)}
                      style={{
                        cursor: 'pointer',
                        background: isHighlighted ? '#fff5d4' : '#fff',
                        border: isHighlighted ? '1px solid #d4b94d' : '1px solid #e5e5e5',
                        borderRadius: 4,
                        padding: '8px 10px',
                        fontSize: 12,
                        lineHeight: 1.4
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          marginBottom: 4
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#444' }}>[{r.rank}]</span>
                        <span
                          style={{
                            fontSize: 10,
                            color: '#888',
                            fontFamily: 'monospace'
                          }}
                          title={`distance: ${r.distance.toFixed(4)}`}
                        >
                          d={r.distance.toFixed(2)}
                        </span>
                      </div>
                      <div style={{ color: '#666', fontSize: 11, marginBottom: 4 }}>
                        {r.chunk.spineHref}
                      </div>
                      <div
                        style={{
                          color: '#333',
                          display: '-webkit-box',
                          WebkitLineClamp: 4,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}
                      >
                        {r.chunk.text}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default AssistantPane
