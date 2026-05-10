import type { IpcError } from '../preload/types'

function flattenCause(cause: unknown, depth = 0): string | undefined {
  if (cause === undefined || cause === null) return undefined
  if (depth >= 5) return '... (cause chain too deep)'
  if (cause instanceof Error) {
    const inner = flattenCause((cause as { cause?: unknown }).cause, depth + 1)
    const stack = cause.stack ?? cause.message
    return inner ? `${stack}\n  caused by: ${inner}` : stack
  }
  return String(cause)
}

export function toIpcError(err: unknown): IpcError {
  const e = err instanceof Error ? err : new Error(String(err))
  return {
    message: e.message,
    stack: e.stack,
    cause: flattenCause((e as { cause?: unknown }).cause)
  }
}
