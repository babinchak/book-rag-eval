import { useEffect, useMemo, useState } from 'react'
import type {
  BenchmarkResultCell,
  DraftCaseBrowserData,
  DraftCaseBrowserItem,
  DraftCaseReviewUpdate,
  DraftReviewStatus,
  DraftRunBrowserSummary,
  IpcError
} from '../../../preload/types'
import { cv } from '../lib/theme'
import ErrorDisplay from './ErrorDisplay'
import BenchmarkMatrix from './BenchmarkMatrix'

interface BenchmarkCasesProps {
  onBack: () => void
}

type CaseTab = 'definition' | 'results'
type WorkspaceTab = 'cases' | 'matrix'
type StatusFilter = 'all' | DraftReviewStatus

interface EditorValue {
  question: string
  canonicalSearchQuery: string
  answerSpan: string
  referenceAnswer: string
  tags: string
  difficulty: 'easy' | 'medium' | 'hard'
  reviewerNotes: string
}

function editorValue(item: DraftCaseBrowserItem): EditorValue {
  return {
    question: item.question,
    canonicalSearchQuery: item.canonicalSearchQuery,
    answerSpan: item.answerSpan,
    referenceAnswer: item.referenceAnswer,
    tags: item.tags.join(', '),
    difficulty: item.difficulty,
    reviewerNotes: item.reviewerNotes
  }
}

function statusLabel(status: DraftReviewStatus): string {
  if (status === 'needs_revision') return 'Needs changes'
  return status[0].toUpperCase() + status.slice(1)
}

function statusColors(status: DraftReviewStatus): {
  background: string
  color: string
  border: string
} {
  if (status === 'approved') {
    return { background: cv.successBg, color: cv.successText, border: cv.successBorder }
  }
  if (status === 'rejected') {
    return { background: cv.errorBg, color: cv.errorText, border: cv.errorBorder }
  }
  if (status === 'needs_revision') {
    return { background: cv.warningBg, color: cv.warningText, border: cv.warningBorder }
  }
  return { background: cv.surface2, color: cv.text3, border: cv.border2 }
}

function StatusBadge({ status }: { status: DraftReviewStatus }): React.JSX.Element {
  const colors = statusColors(status)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: `1px solid ${colors.border}`,
        background: colors.background,
        color: colors.color,
        padding: '2px 7px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 650,
        whiteSpace: 'nowrap'
      }}
    >
      {statusLabel(status)}
    </span>
  )
}

function EvidenceExcerpt({ text, answer }: { text: string; answer: string }): React.JSX.Element {
  const index = text.indexOf(answer)
  return (
    <div
      style={{
        background: cv.surface2,
        border: `1px solid ${cv.border}`,
        borderRadius: 6,
        padding: 14,
        fontFamily: 'Georgia, serif',
        fontSize: 14,
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        maxHeight: 340,
        overflow: 'auto'
      }}
    >
      {index < 0 ? (
        text
      ) : (
        <>
          {text.slice(0, index)}
          <mark
            style={{
              background: cv.goldBg,
              color: cv.text1,
              borderBottom: `2px solid ${cv.goldBorder}`,
              padding: '1px 0'
            }}
          >
            {text.slice(index, index + answer.length)}
          </mark>
          {text.slice(index + answer.length)}
        </>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: cv.bg,
  color: cv.text1,
  border: `1px solid ${cv.border2}`,
  borderRadius: 5,
  padding: '8px 10px',
  fontSize: 13,
  lineHeight: 1.45
}

function Field({
  label,
  children,
  hint
}: {
  label: string
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 5 }}>
      <span style={{ color: cv.text3, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
        {label}
      </span>
      {children}
      {hint && <span style={{ color: cv.text4, fontSize: 10 }}>{hint}</span>}
    </label>
  )
}

function BenchmarkCases({ onBack }: BenchmarkCasesProps): React.JSX.Element {
  const [runs, setRuns] = useState<DraftRunBrowserSummary[]>([])
  const [selectedRunPath, setSelectedRunPath] = useState('')
  const [data, setData] = useState<DraftCaseBrowserData | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState('')
  const [search, setSearch] = useState('')
  const [bookFilter, setBookFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [tab, setTab] = useState<CaseTab>('definition')
  const [workspace, setWorkspace] = useState<WorkspaceTab>('matrix')
  const [selectedResult, setSelectedResult] = useState<BenchmarkResultCell | null>(null)
  const [editor, setEditor] = useState<EditorValue | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<IpcError | null>(null)

  async function loadRun(runPath: string, preferredCandidateId?: string): Promise<void> {
    setLoading(true)
    const result = await window.api.benchmarkCases.get(runPath)
    if (!result.ok) {
      setError(result.error)
      setLoading(false)
      return
    }
    setData(result.data)
    const preferred = result.data.cases.find((item) => item.candidateId === preferredCandidateId)
    const firstPending = result.data.cases.find((item) => item.reviewStatus === 'pending')
    const selected = preferred ?? firstPending ?? result.data.cases[0]
    setSelectedCandidateId(selected?.candidateId ?? '')
    setEditor(selected ? editorValue(selected) : null)
    setError(null)
    setLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    void window.api.benchmarkCases.listRuns().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setError(result.error)
        setLoading(false)
        return
      }
      setRuns(result.runs)
      const first = result.runs[0]
      if (!first) {
        setLoading(false)
        return
      }
      setSelectedRunPath(first.runPath)
      void loadRun(first.runPath)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const filteredCases = useMemo(() => {
    if (!data) return []
    const needle = search.trim().toLocaleLowerCase()
    return data.cases.filter((item) => {
      if (bookFilter !== 'all' && item.bookId !== bookFilter) return false
      if (statusFilter !== 'all' && item.reviewStatus !== statusFilter) return false
      if (kindFilter !== 'all' && item.evidenceKind !== kindFilter) return false
      if (flaggedOnly && item.auditFlags.length === 0) return false
      if (!needle) return true
      return [
        item.question,
        item.canonicalSearchQuery,
        item.answerSpan,
        item.referenceAnswer,
        item.excerpt,
        item.bookTitle,
        item.tags.join(' ')
      ].some((value) => value.toLocaleLowerCase().includes(needle))
    })
  }, [data, search, bookFilter, statusFilter, kindFilter, flaggedOnly])

  const selectedCase = data?.cases.find((item) => item.candidateId === selectedCandidateId)

  async function save(
    reviewStatus: DraftReviewStatus | undefined,
    advance: boolean
  ): Promise<void> {
    if (!selectedCase || !editor || !data) return
    setSaving(true)
    setError(null)
    const currentIndex = filteredCases.findIndex(
      (item) => item.candidateId === selectedCase.candidateId
    )
    const nextCandidateId = advance
      ? (filteredCases[currentIndex + 1]?.candidateId ?? filteredCases[0]?.candidateId)
      : selectedCase.candidateId
    const update: DraftCaseReviewUpdate = {
      candidateId: selectedCase.candidateId,
      reviewStatus,
      question: editor.question.trim(),
      canonicalSearchQuery: editor.canonicalSearchQuery.trim(),
      answerSpan: editor.answerSpan.trim(),
      referenceAnswer: editor.referenceAnswer.trim(),
      tags: editor.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      difficulty: editor.difficulty,
      reviewerNotes: editor.reviewerNotes.trim()
    }
    try {
      const result = await window.api.benchmarkCases.update(data.run.runPath, update)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setData(result.data)
      setRuns((current) =>
        current.map((run) => (run.runPath === result.data.run.runPath ? result.data.run : run))
      )
      const next =
        result.data.cases.find((item) => item.candidateId === nextCandidateId) ??
        result.data.cases.find((item) => item.candidateId === selectedCase.candidateId)
      if (next) {
        setSelectedCandidateId(next.candidateId)
        setEditor(editorValue(next))
      }
    } finally {
      setSaving(false)
    }
  }

  const reviewed = data
    ? data.run.totalCases - data.run.counts.pending - data.run.counts.needs_revision
    : 0

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: cv.bg }}>
      <header
        style={{
          minHeight: 62,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 22px',
          borderBottom: `1px solid ${cv.border}`,
          background: cv.surface
        }}
      >
        <button onClick={onBack} style={headerButtonStyle}>
          ← Library
        </button>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, color: cv.text1 }}>RAG benchmark</h1>
          <div style={{ color: cv.text4, fontSize: 11 }}>
            Explore provisional cases and compare retrieval strategies
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 14 }}>
          <TabButton active={workspace === 'matrix'} onClick={() => setWorkspace('matrix')}>
            Results matrix
          </TabButton>
          <TabButton active={workspace === 'cases'} onClick={() => setWorkspace('cases')}>
            Case browser
          </TabButton>
        </div>
        <div style={{ marginLeft: 'auto', minWidth: 340 }}>
          {workspace === 'cases' && (
            <select
              value={selectedRunPath}
              onChange={(event) => {
                const path = event.target.value
                setSelectedRunPath(path)
                void loadRun(path)
              }}
              style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11 }}
            >
              {runs.map((run) => (
                <option key={run.runPath} value={run.runPath}>
                  {run.name} · {run.totalCases} cases · {run.model}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {data && workspace === 'cases' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(100px, 1fr))',
            gap: 1,
            background: cv.border,
            borderBottom: `1px solid ${cv.border}`
          }}
        >
          <SummaryCell label="Progress" value={`${reviewed} / ${data.run.totalCases}`} />
          <SummaryCell label="Approved" value={data.run.counts.approved} tone="success" />
          <SummaryCell
            label="Needs changes"
            value={data.run.counts.needs_revision}
            tone="warning"
          />
          <SummaryCell label="Rejected" value={data.run.counts.rejected} tone="danger" />
          <SummaryCell label="Pending" value={data.run.counts.pending} />
        </div>
      )}

      <ErrorDisplay error={error} marginTop={0} />

      {loading ? (
        <div style={{ padding: 32, color: cv.text4 }}>Loading benchmark artifacts…</div>
      ) : !data ? (
        <div style={{ padding: 32, color: cv.text3 }}>
          No draft-generation runs were found in <code>.rag-eval/eval-drafts</code>.
        </div>
      ) : workspace === 'matrix' ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <BenchmarkMatrix
            cases={data.cases}
            onOpenCase={(item, cell) => {
              setSelectedCandidateId(item.candidateId)
              setEditor(editorValue(item))
              setSelectedResult(cell)
              setTab('results')
              setWorkspace('cases')
            }}
          />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '380px 1fr' }}>
          <aside
            style={{
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRight: `1px solid ${cv.border}`,
              background: cv.surface
            }}
          >
            <div
              style={{
                padding: 12,
                display: 'grid',
                gap: 8,
                borderBottom: `1px solid ${cv.border}`
              }}
            >
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search questions, evidence, answers…"
                style={inputStyle}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                <select
                  value={bookFilter}
                  onChange={(event) => setBookFilter(event.target.value)}
                  style={inputStyle}
                >
                  <option value="all">All books</option>
                  {data.books.map((book) => (
                    <option key={book.bookId} value={book.bookId}>
                      {book.title} ({book.cases})
                    </option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                  style={inputStyle}
                >
                  <option value="all">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="needs_revision">Needs changes</option>
                  <option value="rejected">Rejected</option>
                </select>
                <select
                  value={kindFilter}
                  onChange={(event) => setKindFilter(event.target.value)}
                  style={inputStyle}
                >
                  <option value="all">All evidence</option>
                  <option value="text">Text</option>
                  <option value="table">Table</option>
                  <option value="image">Image</option>
                </select>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    border: `1px solid ${cv.border2}`,
                    borderRadius: 5,
                    padding: '0 9px',
                    color: cv.text2,
                    fontSize: 12
                  }}
                >
                  <input
                    type="checkbox"
                    checked={flaggedOnly}
                    onChange={(event) => setFlaggedOnly(event.target.checked)}
                  />
                  Audit flags only
                </label>
              </div>
              <div style={{ color: cv.text4, fontSize: 10 }}>
                {filteredCases.length} matching cases
              </div>
            </div>

            <div style={{ overflow: 'auto', flex: 1 }}>
              {filteredCases.map((item) => {
                const selected = item.candidateId === selectedCandidateId
                return (
                  <button
                    key={item.candidateId}
                    onClick={() => {
                      setSelectedCandidateId(item.candidateId)
                      setEditor(editorValue(item))
                    }}
                    style={{
                      width: '100%',
                      display: 'grid',
                      gap: 6,
                      padding: '11px 12px',
                      textAlign: 'left',
                      background: selected ? cv.selectedBg : 'transparent',
                      color: cv.text1,
                      border: 'none',
                      borderBottom: `1px solid ${cv.border}`,
                      borderLeft: `3px solid ${selected ? cv.accent : 'transparent'}`,
                      cursor: 'pointer'
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <StatusBadge status={item.reviewStatus} />
                      <span style={{ color: cv.text4, fontSize: 10 }}>{item.evidenceKind}</span>
                      {item.auditFlags.length > 0 && (
                        <span style={{ marginLeft: 'auto', color: cv.warningText, fontSize: 10 }}>
                          ⚑ {item.auditFlags.length}
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 12, lineHeight: 1.4 }}>{item.question}</span>
                    <span style={{ fontSize: 10, color: cv.text4 }}>{item.bookTitle}</span>
                  </button>
                )
              })}
            </div>
          </aside>

          <main style={{ minWidth: 0, overflow: 'auto' }}>
            {!selectedCase || !editor ? (
              <div style={{ padding: 32, color: cv.text4 }}>No case matches these filters.</div>
            ) : (
              <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 28px 60px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginBottom: 6 }}>
                      <StatusBadge status={selectedCase.reviewStatus} />
                      <span style={{ color: cv.text4, fontSize: 11 }}>
                        {selectedCase.evidenceKind} · within book
                      </span>
                    </div>
                    <h2 style={{ margin: 0, fontSize: 20 }}>{selectedCase.bookTitle}</h2>
                    <div style={{ marginTop: 3, color: cv.text4, fontSize: 12 }}>
                      {selectedCase.bookAuthor}
                    </div>
                  </div>
                  <div
                    style={{
                      color: cv.text5,
                      fontSize: 10,
                      fontFamily: 'monospace',
                      textAlign: 'right'
                    }}
                  >
                    {selectedCase.candidateId}
                    <br />
                    {selectedCase.model}
                  </div>
                </div>

                {selectedCase.auditFlags.length > 0 && (
                  <div
                    style={{
                      marginTop: 16,
                      padding: '10px 12px',
                      borderRadius: 6,
                      background:
                        selectedCase.auditDisposition === 'reject' ? cv.errorBg : cv.warningBg,
                      border: `1px solid ${
                        selectedCase.auditDisposition === 'reject'
                          ? cv.errorBorder
                          : cv.warningBorder
                      }`,
                      color:
                        selectedCase.auditDisposition === 'reject' ? cv.errorText : cv.warningText,
                      fontSize: 12
                    }}
                  >
                    Automated recommendation: <strong>{selectedCase.auditDisposition}</strong> ·{' '}
                    {selectedCase.auditFlags.join(', ')}
                    <div style={{ marginTop: 3, fontSize: 10, opacity: 0.8 }}>
                      This is triage only. Your review decision remains independent.
                    </div>
                  </div>
                )}

                <div
                  style={{
                    display: 'flex',
                    gap: 4,
                    marginTop: 18,
                    borderBottom: `1px solid ${cv.border}`
                  }}
                >
                  <TabButton active={tab === 'definition'} onClick={() => setTab('definition')}>
                    Definition & evidence
                  </TabButton>
                  <TabButton active={tab === 'results'} onClick={() => setTab('results')}>
                    Strategy results
                  </TabButton>
                </div>

                {tab === 'results' ? (
                  selectedResult && selectedResult.caseId === selectedCase.caseId ? (
                    <div
                      style={{
                        marginTop: 18,
                        padding: 24,
                        border: `1px solid ${cv.border2}`,
                        borderRadius: 7,
                        color: cv.text3,
                        lineHeight: 1.5
                      }}
                    >
                      <strong style={{ color: cv.text1 }}>
                        {strategyLabelForResult(selectedResult.strategyId)} ·{' '}
                        {selectedResult.retriever.kind}
                      </strong>
                      <ResultLine label="Query mode" value={selectedResult.queryMode} />
                      <ResultLine label="Actual query" value={selectedResult.retrievalQuery} />
                      <ResultLine
                        label="Context budget"
                        value={`${selectedResult.contextBudget.toLocaleString()} tokens`}
                      />
                      <ResultLine
                        label="Retrieved"
                        value={`${selectedResult.retrievedTokens.toLocaleString()} tokens`}
                      />
                      <ResultLine
                        label="Hit / rank"
                        value={`${selectedResult.metrics.hitAtK === 1 ? 'hit' : 'miss'} / ${selectedResult.metrics.firstHitRank ?? '—'}`}
                      />
                      <ResultLine
                        label="Evidence recall"
                        value={formatResultMetric(selectedResult.metrics.evidenceRecall)}
                      />
                      <ResultLine
                        label="MRR"
                        value={formatResultMetric(selectedResult.metrics.mrr)}
                      />
                      <div
                        style={{
                          marginTop: 14,
                          color: cv.text4,
                          fontSize: 10,
                          fontFamily: 'monospace',
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {selectedResult.retrievedChunkIds.join('\n')}
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        marginTop: 18,
                        padding: 24,
                        border: `1px dashed ${cv.border2}`,
                        borderRadius: 7,
                        color: cv.text3,
                        lineHeight: 1.6
                      }}
                    >
                      Open <strong style={{ color: cv.text1 }}>Results matrix</strong> and click a
                      cell to inspect its query, metrics, and retrieved chunk IDs.
                    </div>
                  )
                ) : (
                  <>
                    <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
                      <Field label="Question">
                        <textarea
                          value={editor.question}
                          onChange={(event) =>
                            setEditor({ ...editor, question: event.target.value })
                          }
                          rows={2}
                          style={{ ...inputStyle, resize: 'vertical' }}
                        />
                      </Field>
                      <Field
                        label="Reference search query"
                        hint="Fixed diagnostic query. Future query-rewrite strategies will generate their own queries from the question."
                      >
                        <input
                          value={editor.canonicalSearchQuery}
                          onChange={(event) =>
                            setEditor({ ...editor, canonicalSearchQuery: event.target.value })
                          }
                          style={inputStyle}
                        />
                      </Field>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                        <Field label="Exact answer span">
                          <textarea
                            value={editor.answerSpan}
                            onChange={(event) =>
                              setEditor({ ...editor, answerSpan: event.target.value })
                            }
                            rows={3}
                            style={{
                              ...inputStyle,
                              resize: 'vertical',
                              fontFamily: 'monospace',
                              fontSize: 12
                            }}
                          />
                        </Field>
                        <Field label="Reference answer">
                          <textarea
                            value={editor.referenceAnswer}
                            onChange={(event) =>
                              setEditor({ ...editor, referenceAnswer: event.target.value })
                            }
                            rows={3}
                            style={{ ...inputStyle, resize: 'vertical' }}
                          />
                        </Field>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 170px', gap: 14 }}>
                        <Field label="Tags" hint="Comma-separated">
                          <input
                            value={editor.tags}
                            onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
                            style={inputStyle}
                          />
                        </Field>
                        <Field label="Difficulty">
                          <select
                            value={editor.difficulty}
                            onChange={(event) =>
                              setEditor({
                                ...editor,
                                difficulty: event.target.value as EditorValue['difficulty']
                              })
                            }
                            style={inputStyle}
                          >
                            <option value="easy">Easy</option>
                            <option value="medium">Medium</option>
                            <option value="hard">Hard</option>
                          </select>
                        </Field>
                      </div>
                    </div>

                    <section style={{ marginTop: 24 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}
                      >
                        <h3 style={{ margin: 0, fontSize: 13 }}>Canonical evidence</h3>
                        <span style={{ color: cv.text4, fontSize: 10 }}>
                          {selectedCase.headingPath.join(' › ') || 'No heading'}
                        </span>
                      </div>
                      <EvidenceExcerpt text={selectedCase.excerpt} answer={editor.answerSpan} />
                      <div
                        style={{
                          marginTop: 7,
                          color: cv.text5,
                          fontSize: 10,
                          fontFamily: 'monospace'
                        }}
                      >
                        {selectedCase.spineHref}
                        {selectedCase.assets.length > 0
                          ? ` · assets: ${selectedCase.assets.join(', ')}`
                          : ''}
                      </div>
                    </section>

                    <div style={{ marginTop: 20 }}>
                      <Field label="Reviewer notes">
                        <textarea
                          value={editor.reviewerNotes}
                          onChange={(event) =>
                            setEditor({ ...editor, reviewerNotes: event.target.value })
                          }
                          placeholder="Why you changed or rejected this case…"
                          rows={3}
                          style={{ ...inputStyle, resize: 'vertical' }}
                        />
                      </Field>
                    </div>

                    <div
                      style={{
                        position: 'sticky',
                        bottom: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginTop: 24,
                        padding: '12px 0',
                        background: cv.bg,
                        borderTop: `1px solid ${cv.border}`
                      }}
                    >
                      <button
                        disabled={saving}
                        onClick={() => void save(undefined, false)}
                        style={secondaryButtonStyle}
                      >
                        Save edits
                      </button>
                      <span style={{ flex: 1 }} />
                      <button
                        disabled={saving}
                        onClick={() => void save('rejected', true)}
                        style={{
                          ...reviewButtonStyle,
                          color: cv.errorText,
                          borderColor: cv.errorBorder
                        }}
                      >
                        Reject
                      </button>
                      {selectedCase.reviewStatus !== 'pending' && (
                        <button
                          disabled={saving}
                          onClick={() => void save('pending', false)}
                          style={reviewButtonStyle}
                        >
                          Mark pending
                        </button>
                      )}
                      <button
                        disabled={saving}
                        onClick={() => void save('needs_revision', true)}
                        style={{
                          ...reviewButtonStyle,
                          color: cv.warningText,
                          borderColor: cv.warningBorder
                        }}
                      >
                        Needs changes
                      </button>
                      <button
                        disabled={saving}
                        onClick={() => void save('approved', true)}
                        style={{
                          ...reviewButtonStyle,
                          background: cv.accent,
                          color: cv.accentText,
                          borderColor: cv.accent
                        }}
                      >
                        {saving ? 'Saving…' : 'Approve & next'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}

function strategyLabelForResult(strategyId: string): string {
  return strategyId
    .replace('fixed-token-cl100k_base-', 'fixed tokens ')
    .replace('structural-token-cl100k_base-', 'structural tokens ')
}

function formatResultMetric(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`
}

function ResultLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, marginTop: 10 }}>
      <span style={{ color: cv.text4 }}>{label}</span>
      <span style={{ color: cv.text1 }}>{value}</span>
    </div>
  )
}

function SummaryCell({
  label,
  value,
  tone
}: {
  label: string
  value: string | number
  tone?: 'success' | 'warning' | 'danger'
}): React.JSX.Element {
  const color =
    tone === 'success'
      ? cv.successText
      : tone === 'warning'
        ? cv.warningText
        : tone === 'danger'
          ? cv.errorText
          : cv.text1
  return (
    <div style={{ padding: '9px 14px', background: cv.bg }}>
      <div style={{ color: cv.text4, fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ color, fontSize: 16, fontWeight: 650, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none',
        borderBottom: `2px solid ${active ? cv.accent : 'transparent'}`,
        background: 'transparent',
        color: active ? cv.text1 : cv.text4,
        padding: '8px 11px',
        fontSize: 12,
        cursor: 'pointer'
      }}
    >
      {children}
    </button>
  )
}

const headerButtonStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: `1px solid ${cv.border2}`,
  borderRadius: 5,
  background: cv.bg,
  color: cv.text2,
  cursor: 'pointer',
  fontSize: 12
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: `1px solid ${cv.border2}`,
  borderRadius: 5,
  background: cv.bg,
  color: cv.text2,
  cursor: 'pointer',
  fontSize: 12
}

const reviewButtonStyle: React.CSSProperties = {
  padding: '8px 13px',
  border: `1px solid ${cv.border2}`,
  borderRadius: 5,
  background: cv.bg,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 650
}

export default BenchmarkCases
