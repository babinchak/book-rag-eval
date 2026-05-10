import type { LogEntry, LogLevel } from '../../../preload/types'

function emit(level: LogLevel, tag: string, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, source: 'renderer', tag, msg, data }
  const line = `[renderer] [${tag}] ${msg}`
  if (level === 'error') console.error(line, data ?? '')
  else if (level === 'warn') console.warn(line, data ?? '')
  else console.log(line, data ?? '')
  if (level !== 'debug') {
    try {
      window.api.log.forward(entry)
    } catch {
      // preload may not be ready during very early boot
    }
  }
}

export const log = {
  debug: (tag: string, msg: string, data?: unknown): void => emit('debug', tag, msg, data),
  info: (tag: string, msg: string, data?: unknown): void => emit('info', tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown): void => emit('warn', tag, msg, data),
  error: (tag: string, msg: string, data?: unknown): void => emit('error', tag, msg, data)
}

export function installGlobalErrorReporters(): void {
  window.addEventListener('error', (event) => {
    const err = event.error instanceof Error ? event.error : new Error(event.message)
    void window.api.errors.report({
      origin: 'renderer-window',
      message: err.message,
      stack: err.stack,
      url: window.location.href
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const err = reason instanceof Error ? reason : new Error(String(reason))
    void window.api.errors.report({
      origin: 'renderer-unhandled',
      message: err.message,
      stack: err.stack,
      url: window.location.href
    })
  })
}
