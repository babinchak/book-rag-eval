import type { IpcError } from '../preload/types'

export function toIpcError(err: unknown): IpcError {
  const e = err instanceof Error ? err : new Error(String(err))
  return {
    message: e.message,
    stack: e.stack,
    cause: e.cause !== undefined ? String(e.cause) : undefined
  }
}
