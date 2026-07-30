import { useEffect, useState } from 'react'
import type {
  ChunkParams,
  EmbeddingSlot,
  GenerationSlot,
  IpcError,
  RetrieverParams,
  SavedStrategy,
  StrategyConfig
} from '../../../preload/types'
import { cv } from '../lib/theme'
import ErrorDisplay from './ErrorDisplay'
import ErrorInbox from './ErrorInbox'

interface StrategyManagerProps {
  onBack: () => void
}

const EMBED_MODELS: EmbeddingSlot['model'][] = ['text-embedding-3-small', 'text-embedding-3-large']
const CHAT_MODELS: GenerationSlot['model'][] = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1']
const CHUNKER_KINDS: ChunkParams['kind'][] = [
  'fixed-token',
  'fixed',
  'paragraph',
  'sentence',
  'structural-token',
  'structural',
  'semantic'
]
const RETRIEVER_KINDS: RetrieverParams['kind'][] = ['vector', 'bm25', 'hybrid-rrf']

function defaultChunkerOf(kind: ChunkParams['kind']): ChunkParams {
  switch (kind) {
    case 'fixed-token':
      return { kind: 'fixed-token', size: 1024, overlap: 128, encoding: 'cl100k_base' }
    case 'fixed':
      return { kind: 'fixed', size: 1200, overlap: 200 }
    case 'paragraph':
      return { kind: 'paragraph', targetSize: 1200 }
    case 'sentence':
      return { kind: 'sentence', targetSize: 1200 }
    case 'structural-token':
      return {
        kind: 'structural-token',
        targetSize: 1024,
        maxSize: 1280,
        encoding: 'cl100k_base'
      }
    case 'structural':
      return { kind: 'structural', maxSize: 4000 }
    case 'semantic':
      return { kind: 'semantic', targetSize: 1200, breakpointPercentile: 95, bufferSize: 1 }
  }
}

function defaultRetrieverOf(kind: RetrieverParams['kind']): RetrieverParams {
  if (kind === 'hybrid-rrf') return { kind: 'hybrid-rrf', rrfK: 60 }
  return { kind }
}

function emptyConfig(): StrategyConfig {
  return {
    chunker: defaultChunkerOf('fixed-token'),
    augment: [],
    embedding: { model: 'text-embedding-3-large' },
    retriever: { kind: 'vector' },
    postRetrieve: [],
    generation: { model: 'gpt-4o-mini', topK: 5 }
  }
}

function StrategyManager({ onBack }: StrategyManagerProps): React.JSX.Element {
  const [strategies, setStrategies] = useState<SavedStrategy[]>([])
  const [editing, setEditing] = useState<SavedStrategy | null>(null)
  const [creatingDraft, setCreatingDraft] = useState<{
    name: string
    config: StrategyConfig
  } | null>(null)
  const [error, setError] = useState<IpcError | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh(): Promise<void> {
    const r = await window.api.strategies.list()
    if (r.ok) {
      setStrategies(r.strategies)
      setError(null)
    } else setError(r.error)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleSaveEdit(name: string, config: StrategyConfig): Promise<void> {
    if (!editing) return
    const r = await window.api.strategies.update(editing.id, { name, config })
    if (!r.ok) {
      setError(r.error)
      return
    }
    setEditing(null)
    await refresh()
  }

  async function handleDelete(s: SavedStrategy): Promise<void> {
    if (
      !confirm(
        `Delete strategy "${s.name}"?\n\nExisting chunks, embeddings, and run records on disk are not removed.`
      )
    )
      return
    const r = await window.api.strategies.delete(s.id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await refresh()
  }

  async function handleDuplicate(s: SavedStrategy): Promise<void> {
    const r = await window.api.strategies.duplicate(s.id)
    if (!r.ok) {
      setError(r.error)
      return
    }
    await refresh()
  }

  return (
    <div style={{ padding: 32, color: cv.text1 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <button
          onClick={onBack}
          style={{
            padding: '5px 10px',
            fontSize: 12,
            cursor: 'pointer',
            background: cv.bg,
            color: cv.text2,
            border: `1px solid ${cv.border2}`,
            borderRadius: 4
          }}
        >
          ← Library
        </button>
        <h1 style={{ margin: 0, fontSize: 24 }}>Strategies</h1>
        <span style={{ color: cv.text4, fontSize: 13 }}>
          {loading ? 'loading…' : `${strategies.length} saved`}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <ErrorInbox />
          <button
            onClick={() => setCreatingDraft({ name: '', config: emptyConfig() })}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              cursor: 'pointer',
              background: cv.accent,
              color: cv.accentText,
              border: 'none',
              borderRadius: 5,
              fontWeight: 500
            }}
          >
            + New strategy
          </button>
        </div>
      </header>

      <p style={{ margin: '8px 0 24px', fontSize: 13, color: cv.text4 }}>
        Saved strategies define a full pipeline (chunker → embedding → retriever → generation) and
        appear in every book&apos;s eval picker. The leaderboard ranks strategies by their average
        scores across runs.
      </p>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <ErrorDisplay error={error} />
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {strategies.map((s) => (
          <StrategyRow
            key={s.id}
            strategy={s}
            onEdit={() => setEditing(s)}
            onDelete={() => handleDelete(s)}
            onDuplicate={() => handleDuplicate(s)}
          />
        ))}
        {!loading && strategies.length === 0 && (
          <div
            style={{
              padding: 32,
              border: `1px dashed ${cv.border}`,
              borderRadius: 6,
              textAlign: 'center',
              color: cv.text4,
              fontSize: 13
            }}
          >
            No strategies yet. Click &quot;New strategy&quot; to define one.
          </div>
        )}
      </div>

      {creatingDraft && (
        <StrategyEditorModal
          title="New strategy"
          initialName={creatingDraft.name}
          initialConfig={creatingDraft.config}
          onCancel={() => setCreatingDraft(null)}
          onSave={async (name, config) => {
            const r = await window.api.strategies.create(name, config)
            if (!r.ok) {
              setError(r.error)
              return
            }
            setCreatingDraft(null)
            await refresh()
          }}
        />
      )}

      {editing && (
        <StrategyEditorModal
          title={`Edit "${editing.name}"`}
          initialName={editing.name}
          initialConfig={editing.config}
          onCancel={() => setEditing(null)}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  )
}

function StrategyRow({
  strategy,
  onEdit,
  onDelete,
  onDuplicate
}: {
  strategy: SavedStrategy
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
}): React.JSX.Element {
  const { config } = strategy
  return (
    <div
      style={{
        background: cv.bg,
        border: `1px solid ${cv.border}`,
        borderRadius: 8,
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 16
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: cv.text1 }}>{strategy.name}</div>
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: cv.text4, marginTop: 2 }}>
          {strategy.id}
        </div>
      </div>
      <Pill label="Chunker" value={describeChunker(config.chunker)} />
      <Pill label="Retriever" value={describeRetriever(config.retriever)} />
      <Pill label="Embed" value={config.embedding.model.replace('text-embedding-', '')} />
      <Pill label="Chat" value={`${config.generation.model} · k=${config.generation.topK}`} />
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={onEdit} style={btnStyle('default')}>
          Edit
        </button>
        <button onClick={onDuplicate} style={btnStyle('default')}>
          Duplicate
        </button>
        <button onClick={onDelete} style={btnStyle('danger')}>
          Delete
        </button>
      </div>
    </div>
  )
}

function Pill({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ minWidth: 110, fontSize: 12 }}>
      <div
        style={{ color: cv.text4, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}
      >
        {label}
      </div>
      <div style={{ color: cv.text2, fontFamily: 'monospace', marginTop: 2 }}>{value}</div>
    </div>
  )
}

function btnStyle(variant: 'default' | 'danger' | 'primary'): React.CSSProperties {
  if (variant === 'primary') {
    return {
      padding: '6px 14px',
      fontSize: 12,
      cursor: 'pointer',
      background: cv.accent,
      color: cv.accentText,
      border: 'none',
      borderRadius: 5,
      fontWeight: 500
    }
  }
  if (variant === 'danger') {
    return {
      padding: '6px 10px',
      fontSize: 12,
      cursor: 'pointer',
      background: cv.bg,
      color: cv.danger,
      border: `1px solid ${cv.dangerBorder}`,
      borderRadius: 5
    }
  }
  return {
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    background: cv.bg,
    color: cv.text2,
    border: `1px solid ${cv.border2}`,
    borderRadius: 5
  }
}

function describeChunker(c: ChunkParams): string {
  switch (c.kind) {
    case 'fixed-token':
      return `tokens ${c.size}/${c.overlap}`
    case 'fixed':
      return `chars ${c.size}/${c.overlap} legacy`
    case 'paragraph':
      return `paragraph ~${c.targetSize}`
    case 'sentence':
      return `sentence ~${c.targetSize}`
    case 'structural-token':
      return `structural tokens ~${c.targetSize} max ${c.maxSize}`
    case 'structural':
      return `structural chars ≤${c.maxSize} legacy`
    case 'semantic':
      return `semantic ~${c.targetSize} p${c.breakpointPercentile}`
  }
}

function describeRetriever(r: RetrieverParams): string {
  if (r.kind === 'hybrid-rrf') return `hybrid k=${r.rrfK ?? 60}`
  return r.kind
}

interface StrategyEditorModalProps {
  title: string
  initialName: string
  initialConfig: StrategyConfig
  onCancel: () => void
  onSave: (name: string, config: StrategyConfig) => Promise<void> | void
}

function StrategyEditorModal({
  title,
  initialName,
  initialConfig,
  onCancel,
  onSave
}: StrategyEditorModalProps): React.JSX.Element {
  const [name, setName] = useState(initialName)
  const [config, setConfig] = useState<StrategyConfig>(initialConfig)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(): Promise<void> {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(name.trim(), config)
    } finally {
      setSaving(false)
    }
  }

  function updateChunkerKind(kind: ChunkParams['kind']): void {
    setConfig((prev) => ({ ...prev, chunker: defaultChunkerOf(kind) }))
  }
  function patchChunker(patch: Partial<ChunkParams>): void {
    setConfig((prev) => ({ ...prev, chunker: { ...prev.chunker, ...patch } as ChunkParams }))
  }
  function updateRetrieverKind(kind: RetrieverParams['kind']): void {
    setConfig((prev) => ({ ...prev, retriever: defaultRetrieverOf(kind) }))
  }
  function patchRetriever(patch: Partial<RetrieverParams>): void {
    setConfig((prev) => ({
      ...prev,
      retriever: { ...prev.retriever, ...patch } as RetrieverParams
    }))
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 20
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: cv.bg,
          border: `1px solid ${cv.border2}`,
          borderRadius: 8,
          padding: 24,
          width: 640,
          maxHeight: '90vh',
          overflowY: 'auto',
          color: cv.text1
        }}
      >
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{title}</h2>

        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hybrid Paragraph 1200"
            style={inputStyle}
          />
        </Field>

        <SectionHeader>Chunker</SectionHeader>
        <Field label="Kind">
          <Select
            value={config.chunker.kind}
            onChange={(v) => updateChunkerKind(v as ChunkParams['kind'])}
            options={CHUNKER_KINDS}
          />
        </Field>
        {config.chunker.kind === 'fixed-token' && (
          <>
            <Field label="Size (tokens)">
              <NumberInput
                value={config.chunker.size}
                onChange={(v) => patchChunker({ size: v })}
                min={32}
                max={8192}
              />
            </Field>
            <Field label="Overlap (tokens)">
              <NumberInput
                value={config.chunker.overlap}
                onChange={(v) => patchChunker({ overlap: v })}
                min={0}
                max={Math.max(0, config.chunker.size - 1)}
              />
            </Field>
            <Field label="Encoding">
              <input value={config.chunker.encoding} readOnly style={inputStyle} />
            </Field>
          </>
        )}
        {config.chunker.kind === 'fixed' && (
          <>
            <Field label="Size (chars, legacy)">
              <NumberInput
                value={config.chunker.size}
                onChange={(v) => patchChunker({ size: v })}
                min={100}
                max={8000}
              />
            </Field>
            <Field label="Overlap (chars, legacy)">
              <NumberInput
                value={config.chunker.overlap}
                onChange={(v) => patchChunker({ overlap: v })}
                min={0}
                max={Math.max(0, config.chunker.size - 1)}
              />
            </Field>
          </>
        )}
        {(config.chunker.kind === 'paragraph' || config.chunker.kind === 'sentence') && (
          <Field label="Target size (chars)">
            <NumberInput
              value={config.chunker.targetSize}
              onChange={(v) => patchChunker({ targetSize: v })}
              min={100}
              max={8000}
            />
          </Field>
        )}
        {config.chunker.kind === 'structural-token' && (
          <>
            <Field label="Target size (tokens)">
              <NumberInput
                value={config.chunker.targetSize}
                onChange={(v) => patchChunker({ targetSize: v })}
                min={64}
                max={8192}
              />
            </Field>
            <Field label="Hard maximum (tokens)">
              <NumberInput
                value={config.chunker.maxSize}
                onChange={(v) => patchChunker({ maxSize: v })}
                min={config.chunker.targetSize}
                max={8192}
              />
            </Field>
            <Field label="Encoding">
              <input value={config.chunker.encoding} readOnly style={inputStyle} />
            </Field>
          </>
        )}
        {config.chunker.kind === 'structural' && (
          <Field label="Max size (chars, legacy)">
            <NumberInput
              value={config.chunker.maxSize}
              onChange={(v) => patchChunker({ maxSize: v })}
              min={200}
              max={16000}
            />
          </Field>
        )}
        {config.chunker.kind === 'semantic' && (
          <>
            <Field label="Target size (chars)">
              <NumberInput
                value={config.chunker.targetSize}
                onChange={(v) => patchChunker({ targetSize: v })}
                min={100}
                max={8000}
              />
            </Field>
            <Field label="Breakpoint percentile">
              <NumberInput
                value={config.chunker.breakpointPercentile}
                onChange={(v) => patchChunker({ breakpointPercentile: v })}
                min={50}
                max={99}
              />
            </Field>
            <Field label="Buffer size (sentences)">
              <NumberInput
                value={config.chunker.bufferSize}
                onChange={(v) => patchChunker({ bufferSize: v })}
                min={0}
                max={5}
              />
            </Field>
          </>
        )}

        <SectionHeader>Embedding</SectionHeader>
        <Field label="Model">
          <Select
            value={config.embedding.model}
            onChange={(v) =>
              setConfig((prev) => ({
                ...prev,
                embedding: { model: v as EmbeddingSlot['model'] }
              }))
            }
            options={EMBED_MODELS}
          />
        </Field>

        <SectionHeader>Retriever</SectionHeader>
        <Field label="Kind">
          <Select
            value={config.retriever.kind}
            onChange={(v) => updateRetrieverKind(v as RetrieverParams['kind'])}
            options={RETRIEVER_KINDS}
          />
        </Field>
        {config.retriever.kind === 'hybrid-rrf' && (
          <Field label="RRF k">
            <NumberInput
              value={config.retriever.rrfK ?? 60}
              onChange={(v) => patchRetriever({ rrfK: v })}
              min={1}
              max={1000}
            />
          </Field>
        )}

        <SectionHeader>Generation</SectionHeader>
        <Field label="Chat model">
          <Select
            value={config.generation.model}
            onChange={(v) =>
              setConfig((prev) => ({
                ...prev,
                generation: { ...prev.generation, model: v as GenerationSlot['model'] }
              }))
            }
            options={CHAT_MODELS}
          />
        </Field>
        <Field label="Top-K (retrieved chunks per query)">
          <NumberInput
            value={config.generation.topK}
            onChange={(v) =>
              setConfig((prev) => ({
                ...prev,
                generation: { ...prev.generation, topK: v }
              }))
            }
            min={1}
            max={50}
          />
        </Field>

        <SectionHeader>Pipeline extensions</SectionHeader>
        <div style={{ fontSize: 12, color: cv.text4, padding: '4px 0 12px' }}>
          Augmentations (e.g. breadcrumbs, section summaries) and post-retrieve steps (e.g.
          rerankers) are reserved in the data model. UI for editing them lands in a later pass.
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 16,
            paddingTop: 16,
            borderTop: `1px solid ${cv.border}`
          }}
        >
          <button onClick={onCancel} style={btnStyle('default')}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
            style={{ ...btnStyle('primary'), opacity: name.trim() && !saving ? 1 : 0.5 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 13,
  background: cv.bg,
  color: cv.text1,
  border: `1px solid ${cv.border2}`,
  borderRadius: 4,
  outline: 'none'
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: 10 }}>
      <label
        style={{
          display: 'block',
          fontSize: 11,
          color: cv.text3,
          marginBottom: 4,
          textTransform: 'uppercase',
          letterSpacing: 0.3
        }}
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: cv.text2,
        margin: '18px 0 8px',
        paddingBottom: 4,
        borderBottom: `1px solid ${cv.border}`,
        textTransform: 'uppercase',
        letterSpacing: 0.5
      }}
    >
      {children}
    </div>
  )
}

function Select<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: readonly T[]
}): React.JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} style={inputStyle}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function NumberInput({
  value,
  onChange,
  min,
  max
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}): React.JSX.Element {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10)
        if (Number.isFinite(n)) onChange(n)
      }}
      style={inputStyle}
    />
  )
}

export default StrategyManager
