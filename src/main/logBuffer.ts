import type { LogEntry } from '../preload/types'

const CAPACITY = 500

const entries: LogEntry[] = []

export function pushLog(entry: LogEntry): void {
  entries.push(entry)
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY)
}

export function recentLogs(n: number): LogEntry[] {
  return entries.slice(Math.max(0, entries.length - n))
}

export function logsBefore(ts: number, n: number): LogEntry[] {
  const cutIdx = entries.findIndex((e) => e.ts > ts)
  const upto = cutIdx === -1 ? entries.length : cutIdx
  return entries.slice(Math.max(0, upto - n), upto)
}
