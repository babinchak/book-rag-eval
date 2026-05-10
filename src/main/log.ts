import type { LogEntry, LogLevel, LogSource } from '../preload/types'
import { pushLog } from './logBuffer'

function emit(source: LogSource, level: LogLevel, tag: string, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, source, tag, msg, data }
  pushLog(entry)
  const line = `[${source}] [${tag}] ${msg}`
  if (level === 'error') console.error(line, data ?? '')
  else if (level === 'warn') console.warn(line, data ?? '')
  else console.log(line, data ?? '')
}

export const log = {
  debug: (tag: string, msg: string, data?: unknown) => emit('main', 'debug', tag, msg, data),
  info: (tag: string, msg: string, data?: unknown) => emit('main', 'info', tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => emit('main', 'warn', tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => emit('main', 'error', tag, msg, data)
}

export function ingestRendererLog(entry: LogEntry): void {
  pushLog({ ...entry, source: 'renderer' })
}

export function ingestSidecarLine(line: string, level: LogLevel = 'info'): void {
  if (!line.trim()) return
  pushLog({ ts: Date.now(), level, source: 'sidecar', tag: 'sidecar', msg: line })
}
