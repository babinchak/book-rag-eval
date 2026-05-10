import { useState } from 'react'
import type { IpcError } from '../../../preload/types'
import { cv } from '../lib/theme'

interface ErrorDisplayProps {
  error: IpcError | string | null | undefined
  marginTop?: number | string
}

function ErrorDisplay({ error, marginTop }: ErrorDisplayProps): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  if (!error) return null
  const e: IpcError = typeof error === 'string' ? { message: error } : error
  const hasDetails = Boolean(e.stack || e.cause)
  const errorId = e.errorId
  const onCopy = async (): Promise<void> => {
    if (!errorId) return
    const res = await window.api.errors.bundle(errorId)
    if (res.ok) {
      await navigator.clipboard.writeText(res.markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }
  return (
    <div
      style={{
        background: cv.errorBg,
        border: `1px solid ${cv.errorBorder}`,
        borderRadius: 4,
        padding: 10,
        fontSize: 11,
        color: cv.errorText,
        marginTop
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8
        }}
      >
        <div
          style={{
            fontWeight: 600,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            flex: 1
          }}
        >
          {e.message}
        </div>
        {errorId && (
          <button onClick={() => void onCopy()} style={{ fontSize: 11, flexShrink: 0 }}>
            {copied ? 'Copied!' : 'Copy diagnostic'}
          </button>
        )}
      </div>
      {hasDetails && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', color: cv.text3 }}>stack</summary>
          {e.cause && (
            <div
              style={{
                marginTop: 4,
                fontFamily: 'monospace',
                fontSize: 10,
                color: cv.text2,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              cause: {e.cause}
            </div>
          )}
          {e.stack && (
            <pre
              style={{
                marginTop: 4,
                fontFamily: 'monospace',
                fontSize: 10,
                color: cv.text2,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0
              }}
            >
              {e.stack}
            </pre>
          )}
        </details>
      )}
    </div>
  )
}

export default ErrorDisplay
