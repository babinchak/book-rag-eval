import { randomUUID } from 'crypto'
import type {
  ErrorOrigin,
  ErrorRecordSummary,
  IpcError,
  RendererErrorReport
} from '../preload/types'
import { toIpcError } from './ipcError'

export interface RecordedError {
  id: string
  ts: number
  origin: ErrorOrigin
  error: IpcError
  ipcHandler?: string
  ipcArgs?: unknown[]
  componentStack?: string
  url?: string
  langsmithRunUrl?: string
  count: number
  // When true, the diagnostic bundle omits the stack trace (useful for soft
  // validation failures whose stack just points at our throw site).
  suppressStack?: boolean
  // Free-form context the producer wants to surface in the bundle (chunk text,
  // rejected LLM output, etc.). Rendered in a "## Context" section.
  extras?: Record<string, unknown>
}

const records: RecordedError[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      // listener errors are not our problem
    }
  }
}

function tryDedupe(
  origin: ErrorOrigin,
  message: string,
  ipcHandler?: string
): RecordedError | null {
  const last = records[records.length - 1]
  if (!last) return null
  if (last.origin === origin && last.error.message === message && last.ipcHandler === ipcHandler) {
    last.count += 1
    last.ts = Date.now()
    return last
  }
  return null
}

export interface RecordIpcOpts {
  ipcHandler: string
  ipcArgs: unknown[]
  langsmithRunUrl?: string
  suppressStack?: boolean
  extras?: Record<string, unknown>
}

export function recordIpcError(err: unknown, opts: RecordIpcOpts): RecordedError {
  const ipcError = toIpcError(err)
  const dedup = tryDedupe('ipc', ipcError.message, opts.ipcHandler)
  if (dedup) {
    // Refresh extras to the most recent occurrence so the bundle reflects the
    // latest failure context, not the first one we happened to see.
    if (opts.extras) dedup.extras = opts.extras
    if (opts.ipcArgs) dedup.ipcArgs = opts.ipcArgs
    notify()
    return dedup
  }
  const rec: RecordedError = {
    id: randomUUID(),
    ts: Date.now(),
    origin: 'ipc',
    error: ipcError,
    ipcHandler: opts.ipcHandler,
    ipcArgs: opts.ipcArgs,
    langsmithRunUrl: opts.langsmithRunUrl,
    suppressStack: opts.suppressStack,
    extras: opts.extras,
    count: 1
  }
  ipcError.errorId = rec.id
  records.push(rec)
  notify()
  return rec
}

export function recordSidecarError(err: unknown): RecordedError {
  const ipcError = toIpcError(err)
  const dedup = tryDedupe('sidecar', ipcError.message)
  if (dedup) {
    notify()
    return dedup
  }
  const rec: RecordedError = {
    id: randomUUID(),
    ts: Date.now(),
    origin: 'sidecar',
    error: ipcError,
    count: 1
  }
  ipcError.errorId = rec.id
  records.push(rec)
  notify()
  return rec
}

export function recordRendererReport(report: RendererErrorReport): RecordedError {
  const dedup = tryDedupe(report.origin, report.message)
  if (dedup) {
    notify()
    return dedup
  }
  const rec: RecordedError = {
    id: randomUUID(),
    ts: Date.now(),
    origin: report.origin,
    error: { message: report.message, stack: report.stack },
    componentStack: report.componentStack,
    url: report.url,
    count: 1
  }
  rec.error.errorId = rec.id
  records.push(rec)
  notify()
  return rec
}

export function listErrors(): ErrorRecordSummary[] {
  return records.map((r) => ({
    id: r.id,
    ts: r.ts,
    origin: r.origin,
    message: r.error.message,
    ipcHandler: r.ipcHandler,
    count: r.count
  }))
}

export function getError(id: string): RecordedError | undefined {
  return records.find((r) => r.id === id)
}

export function attachLangsmithUrl(id: string, url: string): void {
  const r = getError(id)
  if (r) r.langsmithRunUrl = url
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
