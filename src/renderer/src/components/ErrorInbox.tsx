import { useEffect, useState } from 'react'
import type { ErrorRecordSummary } from '../../../preload/types'
import { cv } from '../lib/theme'

async function loadEntries(): Promise<ErrorRecordSummary[]> {
  const res = await window.api.errors.list()
  return res.ok ? res.entries : []
}

async function copyBundle(id: string): Promise<boolean> {
  const res = await window.api.errors.bundle(id)
  if (!res.ok) return false
  await navigator.clipboard.writeText(res.markdown)
  return true
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

export default function ErrorInbox(): React.JSX.Element {
  const [entries, setEntries] = useState<ErrorRecordSummary[]>([])
  const [open, setOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    void loadEntries().then(setEntries)
    return window.api.errors.onChanged(() => {
      void loadEntries().then(setEntries)
    })
  }, [])

  const total = entries.reduce((acc, e) => acc + e.count, 0)
  const sorted = [...entries].sort((a, b) => b.ts - a.ts)

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title={total === 0 ? 'No errors this session' : `${total} error${total === 1 ? '' : 's'}`}
        style={{
          background: total > 0 ? cv.errorBg : cv.bg,
          border: `1px solid ${total > 0 ? cv.errorBorder : cv.border2}`,
          color: total > 0 ? cv.errorText : cv.text3,
          borderRadius: 4,
          padding: '5px 10px',
          fontSize: 12,
          cursor: 'pointer'
        }}
      >
        ⚠ {total}
      </button>
      {open && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 480,
            maxWidth: '90vw',
            background: cv.surface,
            borderLeft: `1px solid ${cv.border}`,
            boxShadow: '-2px 0 12px rgba(0,0,0,0.2)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: `1px solid ${cv.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <div style={{ fontWeight: 600, color: cv.text1 }}>Error inbox ({total})</div>
            <button onClick={() => setOpen(false)}>Close</button>
          </div>
          <div style={{ overflowY: 'auto', flex: 1, padding: 8 }}>
            {sorted.length === 0 && (
              <div style={{ padding: 12, color: cv.text3, fontSize: 12 }}>
                No errors this session.
              </div>
            )}
            {sorted.map((e) => (
              <div
                key={e.id}
                style={{
                  background: cv.surface2,
                  border: `1px solid ${cv.border}`,
                  borderRadius: 4,
                  padding: 10,
                  marginBottom: 8,
                  fontSize: 12,
                  color: cv.text2
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8
                  }}
                >
                  <div style={{ color: cv.text3, fontSize: 11 }}>
                    {formatTime(e.ts)} · {e.ipcHandler ? `[${e.ipcHandler}]` : `[${e.origin}]`}
                    {e.count > 1 && (
                      <span style={{ marginLeft: 6, color: cv.errorText }}>×{e.count}</span>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      const ok = await copyBundle(e.id)
                      if (ok) {
                        setCopiedId(e.id)
                        setTimeout(() => setCopiedId(null), 1200)
                      }
                    }}
                    style={{ fontSize: 11 }}
                  >
                    {copiedId === e.id ? 'Copied!' : 'Copy diagnostic'}
                  </button>
                </div>
                <div
                  style={{
                    marginTop: 4,
                    color: cv.text1,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {e.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
