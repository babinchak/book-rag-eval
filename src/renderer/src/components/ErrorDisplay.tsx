import type { IpcError } from '../../../preload/types'
import { cv } from '../lib/theme'

interface ErrorDisplayProps {
  error: IpcError | string | null | undefined
  marginTop?: number | string
}

function ErrorDisplay({ error, marginTop }: ErrorDisplayProps): React.JSX.Element | null {
  if (!error) return null
  const e = typeof error === 'string' ? { message: error } : error
  const hasDetails = Boolean(e.stack || e.cause)
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
      <div style={{ fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {e.message}
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
