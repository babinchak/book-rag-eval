import { Component, type ErrorInfo, type ReactNode } from 'react'
import { cv } from '../lib/theme'

interface Props {
  view: string
  onReset?: () => void
  children: ReactNode
}

interface State {
  errorId: string | null
  message: string | null
}

export default class ViewErrorBoundary extends Component<Props, State> {
  state: State = { errorId: null, message: null }

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { message: err.message }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    void window.api.errors
      .report({
        origin: 'renderer-boundary',
        message: `[${this.props.view}] ${err.message}`,
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

  private reset(): void {
    this.setState({ errorId: null, message: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children
    return (
      <div style={{ padding: 20 }}>
        <div
          style={{
            background: cv.errorBg,
            border: `1px solid ${cv.errorBorder}`,
            borderRadius: 6,
            padding: 16,
            color: cv.errorText,
            maxWidth: 720
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{this.props.view} crashed</div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 10 }}>
            {this.state.message}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void this.copyDiagnostic()} disabled={!this.state.errorId}>
              Copy diagnostic
            </button>
            <button onClick={() => this.reset()}>Reload view</button>
          </div>
        </div>
      </div>
    )
  }
}
