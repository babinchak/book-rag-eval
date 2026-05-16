import { useEffect, useState } from 'react'
import type {
  Chunk,
  EvalCaseResult,
  EvalRunResult,
  EvalSet,
  GoldSpan,
  IpcError
} from '../../../preload/types'
import { cv } from '../lib/theme'
import { chatCostUsd, formatUsd } from '../../../shared/pricing'
import ErrorDisplay from './ErrorDisplay'

interface EvalRunDetailModalProps {
  bookId: string
  runId: string
  evalSet: EvalSet | null
  onClose: () => void
  onSelectChunk?: (strategyId: string, chunkId: string) => void
}

function buildTraceMarkdown(
  run: EvalRunResult,
  caseResult: EvalCaseResult,
  goldSpans: GoldSpan[],
  chunks: Chunk[],
  caseNotes?: string
): string {
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const goldChunks = chunks.filter((c) =>
    goldSpans.some((g) => c.spineHref === g.spineHref && c.textStart < g.textEnd && c.textEnd > g.textStart)
  )
  const cited = new Set(caseResult.citedChunkIds ?? [])
  const retrievedByChunkId = new Map(caseResult.retrieved.map((r) => [r.chunkId, r]))

  const sourceChunkId = caseNotes?.match(/Auto-generated from chunk (.+?)\.(?:\s|$)/)?.[1]

  const corpusSize = chunks.length
  const goldHrefs = new Set(goldSpans.map((g) => g.spineHref))
  const chunksInGoldDoc = goldHrefs.size === 0
    ? 0
    : chunks.filter((c) => goldHrefs.has(c.spineHref)).length

  const r0 = caseResult.retrieved[0]
  const r1 = caseResult.retrieved[1]
  const margin = r0 && r1 ? r1.distance - r0.distance : null

  const out: string[] = []
  out.push(`# Eval trace`)
  out.push('')
  out.push(`**Strategy**: \`${run.strategyId}\` · retriever=\`${run.retrieverId ?? 'vector'}\` · k=${run.k} · mode=${run.mode ?? 'agentic'}`)
  out.push(`**Score** (\`d\` column): for vector = L2 distance over text-embedding-3-large (lower better); for bm25 = FTS5 bm25() (more negative better); for hybrid-rrf = negated RRF score (lower better)`)
  const goldDocSuffix =
    goldHrefs.size === 1 ? ` (\`${Array.from(goldHrefs)[0]}\`)` : goldHrefs.size > 1 ? ` (across ${goldHrefs.size} files)` : ''
  out.push(`**Corpus**: ${corpusSize.toLocaleString()} chunks · ${chunksInGoldDoc.toLocaleString()} in gold doc${goldDocSuffix}`)
  out.push(`**Question**: ${caseResult.question}`)
  if (caseResult.searchQuery && caseResult.searchQuery !== caseResult.question) {
    out.push(`**Search query**: ${caseResult.searchQuery}`)
  }
  if (sourceChunkId) {
    const selfRetrieval = caseResult.retrieved[0]?.chunkId === sourceChunkId
    out.push(
      `**Source**: auto-generated from chunk \`${sourceChunkId}\`${selfRetrieval ? ' ⚠️ self-retrieval (gold = source chunk)' : ''}`
    )
  }
  const hit = caseResult.recallAtK > 0
  const bits: string[] = [hit ? `HIT @ rank ${caseResult.hitRank}` : 'MISS']
  bits.push(`R@${run.k}=${caseResult.recallAtK.toFixed(2)}`)
  bits.push(`MRR=${caseResult.mrr.toFixed(2)}`)
  if (margin !== null) bits.push(`margin=${margin.toFixed(2)}`)
  if (caseResult.citationPrecision !== undefined) {
    bits.push(`Cit P=${caseResult.citationPrecision.toFixed(2)}`)
    bits.push(`Cit R=${(caseResult.citationRecall ?? 0).toFixed(2)}`)
  }
  if (caseResult.totalTokens !== undefined) bits.push(`${caseResult.totalTokens} tokens`)
  if (
    caseResult.model &&
    caseResult.promptTokens !== undefined &&
    caseResult.completionTokens !== undefined
  ) {
    bits.push(
      formatUsd(chatCostUsd(caseResult.model, caseResult.promptTokens, caseResult.completionTokens))
    )
  }
  out.push(`**Result**: ${bits.join(' · ')}`)
  out.push('')
  out.push(`## Gold span(s)`)
  for (const g of goldSpans) out.push(`- \`${g.spineHref}\` chars ${g.textStart}–${g.textEnd}`)
  out.push('')
  out.push(`## Expected chunks (overlap gold)`)
  if (goldChunks.length === 0) {
    out.push(`*None — no chunk in this strategy overlaps the gold span.*`)
  } else {
    const goldInfo = goldChunks.map((c) => ({ chunk: c, retrieved: retrievedByChunkId.get(c.id) ?? null }))
    const allHit = goldInfo.every((g) => g.retrieved?.hit)
    if (allHit) {
      for (const { chunk, retrieved } of goldInfo) {
        out.push(`- \`${chunk.id}\` → retrieved #${retrieved!.rank} (hit)`)
      }
    } else {
      for (const { chunk, retrieved } of goldInfo) {
        const status = retrieved
          ? retrieved.hit
            ? `retrieved #${retrieved.rank} (hit)`
            : `retrieved #${retrieved.rank} (overlap below hit threshold)`
          : 'NOT retrieved'
        out.push(`### \`${chunk.id}\` — ${status}`)
        out.push('```')
        out.push(chunk.text)
        out.push('```')
      }
    }
  }
  out.push('')
  if (caseResult.answer) {
    out.push(`## Generated answer`)
    out.push(caseResult.answer)
    if (caseResult.citedRanks && caseResult.citedRanks.length > 0) {
      out.push('')
      out.push(`*Cited: [${caseResult.citedRanks.join(', ')}]*`)
    }
    out.push('')
  }
  out.push(`## Retrieved (${caseResult.retrieved.length})`)
  for (const r of caseResult.retrieved) {
    const chunk = byId.get(r.chunkId)
    const chunkSize = chunk ? chunk.text.length : null
    const tags: string[] = []
    if (r.hit) {
      if (chunkSize && chunkSize > 0) {
        const pct = Math.round((r.overlap / chunkSize) * 100)
        tags.push(`HIT (${r.overlap}/${chunkSize}c, ${pct}%)`)
      } else {
        tags.push(`HIT (${r.overlap}c overlap)`)
      }
    }
    if (cited.has(r.chunkId)) tags.push('CITED')
    const sizeTag = chunkSize !== null ? ` · ${chunkSize}c` : ''
    out.push(`### #${r.rank} · d=${r.distance.toFixed(2)}${sizeTag}${tags.length ? ` · ${tags.join(' · ')}` : ''}`)
    out.push(`\`${r.chunkId}\``)
    if (chunk) {
      out.push('```')
      out.push(chunk.text)
      out.push('```')
    } else {
      out.push(`*chunk text unavailable*`)
    }
    out.push('')
  }
  return out.join('\n').trim()
}

function EvalRunDetailModal({ bookId, runId, evalSet, onClose, onSelectChunk }: EvalRunDetailModalProps): React.JSX.Element {
  const [run, setRun] = useState<EvalRunResult | null>(null)
  const [error, setError] = useState<IpcError | null>(null)
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null)
  const [copiedCaseId, setCopiedCaseId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.evals.getRun(bookId, runId).then((r) => {
      if (cancelled) return
      if (r.ok) { setRun(r.data); if (r.data.cases[0]) setExpandedCaseId(r.data.cases[0].caseId) }
      else setError(r.error)
    })
    return () => { cancelled = true }
  }, [bookId, runId])

  function caseGoldSpans(caseId: string): GoldSpan[] {
    return evalSet?.cases.find((x) => x.id === caseId)?.goldSpans ?? []
  }

  function caseNotes(caseId: string): string | undefined {
    return evalSet?.cases.find((x) => x.id === caseId)?.notes
  }

  async function handleCopyTrace(caseResult: EvalCaseResult): Promise<void> {
    if (!run) return
    const r = await window.api.chunks.get(bookId, run.strategyId)
    if (!r.ok) { setError(r.error); return }
    const md = buildTraceMarkdown(run, caseResult, caseGoldSpans(caseResult.caseId), r.data.chunks, caseNotes(caseResult.caseId))
    await navigator.clipboard.writeText(md)
    setCopiedCaseId(caseResult.caseId)
    setTimeout(() => setCopiedCaseId((c) => (c === caseResult.caseId ? null : c)), 1500)
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: cv.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: cv.bg, borderRadius: 8, padding: 0, width: 900, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.3)', overflow: 'hidden', border: `1px solid ${cv.border}` }}
      >
        <header style={{ padding: '16px 20px', borderBottom: `1px solid ${cv.border}`, display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: cv.text1 }}>Run detail</h2>
          {run && (
            <span style={{ fontSize: 12, color: cv.text3, fontFamily: 'monospace' }}>
              {run.strategyId} · {run.retrieverId ?? 'vector'} · k={run.k} · {new Date(run.ranAt).toLocaleString()}
            </span>
          )}
          {run && (
            <span
              style={{
                fontSize: 10,
                padding: '2px 7px',
                borderRadius: 3,
                background: (run.mode ?? 'agentic') === 'retrieval' ? cv.selectedBg : cv.warningBg,
                color: (run.mode ?? 'agentic') === 'retrieval' ? cv.selectedBorder : cv.warningText,
                border: `1px solid ${(run.mode ?? 'agentic') === 'retrieval' ? cv.selectedBorder : cv.warningBorder}`,
                textTransform: 'uppercase',
                fontWeight: 600,
                letterSpacing: 0.5
              }}
            >
              {run.mode ?? 'agentic'}
            </span>
          )}
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer', color: cv.text3 }}>×</button>
        </header>

        {error && (
          <div style={{ padding: 16 }}>
            <ErrorDisplay error={error} />
          </div>
        )}

        {run && (
          <>
            <div style={{ padding: '12px 20px', background: cv.surface2, borderBottom: `1px solid ${cv.border}`, display: 'flex', gap: 24, fontSize: 12 }}>
              <Metric label={`R@${run.k}`} value={run.meanRecallAtK.toFixed(2)} />
              <Metric label="MRR" value={run.meanMRR.toFixed(2)} />
              {run.meanCitationPrecision !== undefined && <Metric label="Cit. precision" value={run.meanCitationPrecision.toFixed(2)} />}
              {run.meanCitationRecall !== undefined && <Metric label="Cit. recall" value={run.meanCitationRecall.toFixed(2)} />}
              {run.totalTokens !== undefined && <Metric label="Tokens" value={run.totalTokens.toLocaleString()} />}
              {run.agentModel && run.totalPromptTokens !== undefined && run.totalCompletionTokens !== undefined && (
                <Metric
                  label="Cost"
                  value={formatUsd(
                    chatCostUsd(run.agentModel, run.totalPromptTokens, run.totalCompletionTokens)
                  )}
                />
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
              {run.cases.map((caseResult) => (
                <CaseCard
                  key={caseResult.caseId}
                  caseResult={caseResult}
                  expanded={expandedCaseId === caseResult.caseId}
                  onToggle={() => setExpandedCaseId(expandedCaseId === caseResult.caseId ? null : caseResult.caseId)}
                  goldSpans={caseGoldSpans(caseResult.caseId)}
                  strategyId={run.strategyId}
                  onSelectChunk={onSelectChunk ? (chunkId) => { onSelectChunk(run.strategyId, chunkId); onClose() } : undefined}
                  onCopyTrace={() => handleCopyTrace(caseResult)}
                  copied={copiedCaseId === caseResult.caseId}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div style={{ color: cv.text4, fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: cv.text1 }}>{value}</div>
    </div>
  )
}

interface CaseCardProps {
  caseResult: EvalCaseResult
  expanded: boolean
  onToggle: () => void
  goldSpans: GoldSpan[]
  strategyId: string
  onSelectChunk?: (chunkId: string) => void
  onCopyTrace: () => void
  copied: boolean
}

function CaseCard({ caseResult, expanded, onToggle, goldSpans, onSelectChunk, onCopyTrace, copied }: CaseCardProps): React.JSX.Element {
  const r = caseResult
  const recallColor = r.recallAtK ? cv.successStrong : cv.danger
  const citedSet = new Set(r.citedChunkIds ?? [])

  return (
    <div style={{ border: `1px solid ${cv.border}`, borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
      <div
        onClick={onToggle}
        style={{ padding: '10px 14px', background: expanded ? cv.surface2 : cv.bg, cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}
      >
        <span style={{ fontSize: 12, color: cv.text4, fontFamily: 'monospace' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ flex: 1, fontSize: 13, lineHeight: 1.4, color: cv.text1 }}>{r.question}</span>
        {r.langsmithRunUrl && (
          <a href={r.langsmithRunUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 10, color: cv.accent, textDecoration: 'underline' }} title="Open LangSmith trace">
            trace ↗
          </a>
        )}
        <span style={{ fontSize: 11, background: recallColor, color: '#fff', padding: '2px 6px', borderRadius: 3 }}>
          {r.recallAtK ? `hit @ ${r.hitRank}` : 'miss'}
        </span>
        {r.citationPrecision !== undefined && (
          <span style={{ fontSize: 11, color: cv.text3, fontFamily: 'monospace' }}>
            cit P/R: {r.citationPrecision.toFixed(2)}/{r.citationRecall?.toFixed(2)}
          </span>
        )}
        {r.model && r.promptTokens !== undefined && r.completionTokens !== undefined && (
          <span
            style={{ fontSize: 11, color: cv.text3, fontFamily: 'monospace' }}
            title={`${r.promptTokens} in / ${r.completionTokens} out @ ${r.model}`}
          >
            {formatUsd(chatCostUsd(r.model, r.promptTokens, r.completionTokens))}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '12px 14px', background: cv.bg, borderTop: `1px solid ${cv.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <button
              onClick={(e) => { e.stopPropagation(); void onCopyTrace() }}
              title="Copy a markdown trace of this case (question, gold, retrieved chunks with text)"
              style={{
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
                background: copied ? cv.successBg : cv.bg,
                color: copied ? cv.successText : cv.text2,
                border: `1px solid ${copied ? cv.successBorder : cv.border2}`,
                borderRadius: 4
              }}
            >
              {copied ? '✓ Copied' : '⎘ Copy trace'}
            </button>
          </div>
          {r.answer && (
            <section style={{ marginBottom: 14 }}>
              <SectionLabel>Answer</SectionLabel>
              <div style={{ fontSize: 12, lineHeight: 1.5, background: cv.surface2, border: `1px solid ${cv.border}`, borderRadius: 4, padding: 10, whiteSpace: 'pre-wrap', color: cv.text1 }}>
                {r.answer}
              </div>
              {r.citedRanks && r.citedRanks.length > 0 && (
                <div style={{ fontSize: 11, color: cv.text4, marginTop: 4 }}>cited: [{r.citedRanks.join(', ')}]</div>
              )}
            </section>
          )}

          {goldSpans.length > 0 && (
            <section style={{ marginBottom: 14 }}>
              <SectionLabel>Gold spans</SectionLabel>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                {goldSpans.map((g, i) => (
                  <li key={i} style={{ fontSize: 11, fontFamily: 'monospace', background: cv.goldBg, border: `1px solid ${cv.goldBorder}`, borderRadius: 4, padding: '4px 8px', color: cv.text2 }}>
                    {g.spineHref} : {g.textStart}–{g.textEnd}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <SectionLabel>Retrieved ({r.retrieved.length})</SectionLabel>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
              {r.retrieved.map((d) => {
                const isCited = citedSet.has(d.chunkId)
                return (
                  <li
                    key={d.chunkId}
                    onClick={() => onSelectChunk?.(d.chunkId)}
                    style={{
                      cursor: onSelectChunk ? 'pointer' : 'default',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      fontSize: 11,
                      background: d.hit ? cv.successBg : cv.bg,
                      border: `1px solid ${d.hit ? cv.successBorder : cv.border}`,
                      borderRadius: 4,
                      padding: '6px 8px'
                    }}
                  >
                    <span style={{ fontWeight: 600, color: cv.text2 }}>#{d.rank}</span>
                    <span style={{ color: d.hit ? cv.successText : cv.text4, fontFamily: 'monospace' }}>
                      d={d.distance.toFixed(2)}
                    </span>
                    {d.hit && (
                      <span style={{ fontSize: 10, background: cv.successStrong, color: '#fff', padding: '1px 5px', borderRadius: 2 }}>
                        hit · {d.overlap}c
                      </span>
                    )}
                    {isCited && (
                      <span style={{ fontSize: 10, background: cv.accent, color: '#fff', padding: '1px 5px', borderRadius: 2 }}>
                        cited
                      </span>
                    )}
                    <span style={{ flex: 1, color: cv.text2, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.chunkId}>
                      {d.chunkId.split('::')[1] ?? d.chunkId}
                    </span>
                  </li>
                )
              })}
            </ul>
            {onSelectChunk && r.retrieved.length > 0 && (
              <div style={{ fontSize: 10, color: cv.text4, marginTop: 4 }}>Click a chunk to highlight it in the book.</div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: cv.text3, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
      {children}
    </div>
  )
}

export default EvalRunDetailModal
