import { useEffect, useMemo, useState } from 'react'
import type {
  AskResultPayload,
  Bm25IndexSummary,
  ChunkSetSummary,
  EmbeddingSetSummary,
  IpcError,
  RetrieverParams
} from '../../../preload/types'
import { cv } from '../lib/theme'
import ErrorDisplay from './ErrorDisplay'

interface AssistantPaneProps {
  bookId: string
  chunkSets: ChunkSetSummary[]
  embeddingSets: EmbeddingSetSummary[]
  bm25Sets: Bm25IndexSummary[]
  onSelectChunk: (strategyId: string, chunkId: string) => void
  highlightedChunkId: string | null
}

const DEFAULT_K = 5

type RetrieverKind = RetrieverParams['kind']

function AssistantPane({
  bookId,
  chunkSets,
  embeddingSets,
  bm25Sets,
  onSelectChunk,
  highlightedChunkId
}: AssistantPaneProps): React.JSX.Element {
  const fullyEmbedded = useMemo(
    () =>
      embeddingSets.filter((e) => {
        const set = chunkSets.find((s) => s.strategyId === e.strategyId)
        return set !== undefined && e.count >= set.count
      }),
    [embeddingSets, chunkSets]
  )

  const bm25Indexed = useMemo(
    () =>
      bm25Sets.filter((b) => {
        const set = chunkSets.find((s) => s.strategyId === b.strategyId)
        return set !== undefined && b.count === set.count
      }),
    [bm25Sets, chunkSets]
  )

  const [retrieverKind, setRetrieverKind] = useState<RetrieverKind>('vector')

  // Strategies runnable under the selected retriever.
  const runnable = useMemo(() => {
    const embeddedIds = new Set(fullyEmbedded.map((e) => e.strategyId))
    const bm25Ids = new Set(bm25Indexed.map((b) => b.strategyId))
    if (retrieverKind === 'random') return chunkSets.map((set) => set.strategyId)
    if (retrieverKind === 'vector') return [...embeddedIds]
    if (retrieverKind === 'bm25') return [...bm25Ids]
    return [...embeddedIds].filter((id) => bm25Ids.has(id))
  }, [fullyEmbedded, bm25Indexed, chunkSets, retrieverKind])

  const [strategyId, setStrategyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [k, setK] = useState(DEFAULT_K)
  const [result, setResult] = useState<AskResultPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<IpcError | null>(null)

  useEffect(() => {
    if (runnable.length === 0) { setStrategyId(null); return }
    if (!strategyId || !runnable.includes(strategyId)) {
      setStrategyId(runnable[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnable.join(',')])

  useEffect(() => {
    setResult(null)
    setQuery('')
    setError(null)
  }, [bookId])

  async function handleSubmit(): Promise<void> {
    const trimmed = query.trim()
    if (!trimmed || !strategyId) return
    const retriever: RetrieverParams =
      retrieverKind === 'hybrid-rrf' ? { kind: 'hybrid-rrf' } : { kind: retrieverKind }
    setLoading(true)
    setError(null)
    try {
      const r = await window.api.ask.run(bookId, strategyId, retriever, trimmed, k)
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
          color: cv.text2,
          textTransform: 'uppercase',
          letterSpacing: 0.5
        }}
      >
        Assistant
      </h3>

      {chunkSets.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: cv.text4,
            background: cv.surface,
            border: `1px solid ${cv.border}`,
            borderRadius: 4,
            padding: 10,
            lineHeight: 1.5
          }}
        >
          Create a chunk set before asking questions.
        </div>
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 11, color: cv.text3, marginBottom: 4 }}>
            Retriever
          </label>
          <select
            value={retrieverKind}
            onChange={(e) => setRetrieverKind(e.target.value as RetrieverKind)}
            disabled={loading}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              border: `1px solid ${cv.border2}`,
              borderRadius: 4,
              marginBottom: 10,
              background: cv.bg,
              color: cv.text1
            }}
          >
            <option value="vector">Vector</option>
            <option value="bm25">BM25 (lexical)</option>
            <option value="hybrid-rrf">Hybrid (RRF)</option>
            <option value="random">Random control</option>
          </select>

          <label
            style={{ display: 'block', fontSize: 11, color: cv.text3, marginBottom: 4 }}
            htmlFor="strategy-select"
          >
            Chunking
          </label>
          <select
            id="strategy-select"
            value={strategyId ?? ''}
            onChange={(e) => setStrategyId(e.target.value)}
            disabled={loading || runnable.length === 0}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 12,
              fontFamily: 'monospace',
              border: `1px solid ${cv.border2}`,
              borderRadius: 4,
              marginBottom: 10,
              background: cv.bg,
              color: cv.text1
            }}
          >
            {runnable.length === 0 ? (
              <option value="">No chunking indexed for this retriever</option>
            ) : (
              runnable.map((sid) => (
                <option key={sid} value={sid}>
                  {sid}
                </option>
              ))
            )}
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
              border: `1px solid ${cv.border2}`,
              borderRadius: 4,
              boxSizing: 'border-box',
              resize: 'vertical',
              background: cv.bg,
              color: cv.text1
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
                background: cv.accent,
                color: cv.accentText,
                border: 'none',
                borderRadius: 4
              }}
            >
              {loading ? 'Asking…' : 'Ask (⌘↵)'}
            </button>
            <label
              style={{
                fontSize: 11,
                color: cv.text3,
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}
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
                  border: `1px solid ${cv.border2}`,
                  borderRadius: 3,
                  background: cv.bg,
                  color: cv.text1
                }}
              />
            </label>
          </div>

          <ErrorDisplay error={error} marginTop={12} />

          {result && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: cv.text2,
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
                  background: cv.surface2,
                  border: `1px solid ${cv.border}`,
                  borderRadius: 4,
                  padding: 10,
                  whiteSpace: 'pre-wrap',
                  color: cv.text1
                }}
              >
                {result.answer}
              </div>
              <div style={{ fontSize: 10, color: cv.text4, marginTop: 4 }}>
                {result.model} · {result.totalTokens} tokens
                {result.langsmithRunUrl && (
                  <>
                    {' '}
                    ·{' '}
                    <a
                      href={result.langsmithRunUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: cv.accent }}
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
                  color: cv.text2,
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
                        background: isHighlighted ? cv.warningBg : cv.bg,
                        border: `1px solid ${isHighlighted ? cv.warningBorder : cv.border}`,
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
                        <span style={{ fontWeight: 600, color: cv.text2 }}>[{r.rank}]</span>
                        <span
                          style={{ fontSize: 10, color: cv.text4, fontFamily: 'monospace' }}
                          title={`distance: ${r.distance.toFixed(4)}`}
                        >
                          d={r.distance.toFixed(2)}
                        </span>
                      </div>
                      <div style={{ color: cv.text3, fontSize: 11, marginBottom: 4 }}>
                        {r.chunk.spineHref}
                      </div>
                      <div
                        style={{
                          color: cv.text1,
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
