import type { IpcError } from '../preload/types'
import { recordIpcError } from './errorRegistry'
import { toIpcError } from './ipcError'
import { log } from './log'

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }

/**
 * Wrap an ipcMain.handle body so any thrown error is recorded in the
 * errorRegistry with handler+args context, and returned as a Result with
 * an errorId the renderer can later use to fetch a diagnostic bundle.
 *
 * Handlers that already return a non-{data} shape (e.g. {sets, books}) should
 * not use this wrapper — use captureIpcError() to record the error and let
 * the handler shape its own success path.
 */
export async function withIpcContext<T>(
  handlerName: string,
  args: unknown[],
  fn: () => Promise<T>
): Promise<Result<T>> {
  try {
    const data = await fn()
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: captureIpcError(err, handlerName, args) }
  }
}

const SECRET_HANDLERS = new Set(['settings:setOpenaiKey', 'settings:setLangsmithKey'])

function safeArgs(handlerName: string, args: unknown[]): unknown[] {
  if (SECRET_HANDLERS.has(handlerName)) return ['<redacted>']
  return args
}

/**
 * For handlers whose success shape is not `{ok, data}` (e.g. `{ok, sets}`).
 * Records the error in the registry and returns the IpcError (with errorId
 * attached) so the handler can spread it into its own result.
 *
 * `extras` attaches free-form context (chunk text, LLM output, etc.) that
 * the diagnostic bundle renders in a "## Context" section.
 *
 * `suppressStack` omits the stack trace from the bundle — use for soft
 * validation failures whose stack only points at our throw site.
 */
export function captureIpcError(
  err: unknown,
  handlerName: string,
  args: unknown[],
  opts?: { suppressStack?: boolean; extras?: Record<string, unknown> }
): IpcError {
  const rec = recordIpcError(err, {
    ipcHandler: handlerName,
    ipcArgs: safeArgs(handlerName, args),
    suppressStack: opts?.suppressStack,
    extras: opts?.extras
  })
  log.error('ipc', `${handlerName} failed: ${rec.error.message}`)
  return rec.error
}

export { toIpcError }
