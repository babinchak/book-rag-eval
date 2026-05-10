import { Component, type ErrorInfo, type ReactNode } from 'react'
import { cv } from '../lib/theme'

interface Props {
  children: ReactNode
}

interface State {
  errorId: string | null
  message: string | null
}

export default class RootErrorBoundary extends Component<Props, State> {
  state: State = { errorId: null, message: null }

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { message: err.message }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    void window.api.errors
      .report({
        origin: 'renderer-boundary',
        message: err.message,
        stack: err.stack,
        componentStack: info.componentStack ?? undefined,
        url: window.location.href
      })
      .then((res) => {
        if (res.ok) this.setState({ errorId: res.errorId })
      })
  }

  private async copyDiagnostic(): Promise<void> {
    const id = this.state.errorId
    if (!id) return
    const res = await window.api.errors.bundle(id)
    if (res.ok) await navigator.clipboard.writeText(res.markdown)
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children
    return (
      <div
        style={{
          minHeight: '100vh',
          background: cv.bg,
          color: cv.text1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20
        }}
      >
        <div
          style={{
            maxWidth: 720,
            background: cv.errorBg,
            border: `1px solid ${cv.errorBorder}`,
            borderRadius: 6,
            padding: 20,
            color: cv.errorText
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>The app crashed.</div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 12 }}>
            {this.state.message}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => void this.copyDiagnostic()}
              disabled={!this.state.errorId}
              style={{ cursor: this.state.errorId ? 'pointer' : 'default' }}
            >
              Copy diagnostic
            </button>
            <button onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    )
  }
}
