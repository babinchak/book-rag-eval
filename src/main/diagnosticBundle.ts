import type { LogEntry } from '../preload/types'
import { envSnapshot } from './env'
import { getError, listErrors } from './errorRegistry'
import { logsBefore, recentLogs } from './logBuffer'

const SECRET_KEY_RE = /key|token|secret|password|authorization/i
const TRUNCATE_AT = 500
const TRUNCATE_KEEP = 200
const EXTRAS_STRING_LIMIT = 4000

function truncate(s: string): string {
  if (s.length <= TRUNCATE_AT) return s
  const head = s.slice(0, TRUNCATE_KEEP)
  const tail = s.slice(s.length - TRUNCATE_KEEP)
  return `${head}… [truncated ${s.length - TRUNCATE_KEEP * 2} chars] …${tail}`
}

function truncateLong(s: string): string {
  if (s.length <= EXTRAS_STRING_LIMIT) return s
  return `${s.slice(0, EXTRAS_STRING_LIMIT)}\n…[truncated ${s.length - EXTRAS_STRING_LIMIT} chars]`
}

function renderExtras(extras: Record<string, unknown>): string | null {
  const lines: string[] = ['## Context']
  let any = false
  for (const [key, value] of Object.entries(extras)) {
    if (value === undefined || value === null) continue
    any = true
    if (SECRET_KEY_RE.test(key)) {
      lines.push(`### ${key}`)
      lines.push('<redacted>')
      continue
    }
    lines.push(`### ${key}`)
    if (typeof value === 'string') {
      lines.push('```')
      lines.push(truncateLong(value))
      lines.push('```')
    } else {
      lines.push('```json')
      lines.push(truncateLong(JSON.stringify(value, null, 2)))
      lines.push('```')
    }
  }
  return any ? lines.join('\n') : null
}

function envSection(): string {
  const env = envSnapshot()
  const lines: string[] = [
    `- App: ${env.appName}@${env.appVersion}` +
      (env.gitSha
        ? ` · git ${env.gitSha}${env.gitDirty ? ' (dirty)' : ''}${env.gitBranch ? ` on ${env.gitBranch}` : ''}`
        : ''),
    `- Electron ${env.electronVersion} · Node ${env.nodeVersion}`,
    `- ${env.platform}`
  ]
  return `## Env\n${lines.join('\n')}`
}

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY_RE.test(key)) return '<redacted>'
  if (typeof value === 'string') return truncate(value)
  if (Array.isArray(value)) {
    if (value.length > 20) {
      return [...value.slice(0, 10).map((v) => redact(v)), `… [${value.length - 10} more]`]
    }
    return value.map((v) => redact(v))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k)
    }
    return out
  }
  return value
}

function fmtLog(entry: LogEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 23)
  const tag = entry.tag ? ` [${entry.tag}]` : ''
  const data = entry.data === undefined ? '' : ` ${JSON.stringify(redact(entry.data))}`
  return `${time} [${entry.source}]${tag} ${truncate(entry.msg)}${data}`
}

export interface BundleOptions {
  includeLogs?: boolean
  includeEnv?: boolean
}

export function buildBundle(errorId: string, opts: BundleOptions = {}): string {
  const includeLogs = opts.includeLogs ?? true
  const includeEnv = opts.includeEnv ?? true
  const rec = getError(errorId)
  if (!rec) return `Error ${errorId} not found in registry.`

  const ts = new Date(rec.ts).toISOString()
  const sections: string[] = []

  // Header
  const headerTitle = rec.origin === 'ipc' ? `[ipc] ${rec.ipcHandler ?? '?'}` : `[${rec.origin}]`
  sections.push(`## Error\n**${headerTitle}** failed at ${ts}`)
  if (rec.count > 1) sections[0] += ` (×${rec.count})`

  const errBlock: string[] = ['```', rec.error.message]
  if (!rec.suppressStack && rec.error.stack) errBlock.push(rec.error.stack)
  errBlock.push('```')
  sections.push(errBlock.join('\n'))
  if (rec.error.cause) sections.push(`**Cause:**\n\n\`\`\`\n${rec.error.cause}\n\`\`\``)

  // Source-specific
  if (rec.origin === 'ipc') {
    const argsJson = JSON.stringify(redact(rec.ipcArgs ?? []), null, 2)
    sections.push(
      `## IPC call\n- Handler: \`${rec.ipcHandler}\`\n- Args:\n\`\`\`json\n${argsJson}\n\`\`\``
    )
  } else {
    const lines: string[] = [`- Origin: \`${rec.origin}\``]
    if (rec.url) lines.push(`- URL: \`${rec.url}\``)
    if (rec.componentStack)
      lines.push(`- Component stack:\n\`\`\`\n${rec.componentStack.trim()}\n\`\`\``)
    sections.push(`## Source\n${lines.join('\n')}`)
  }

  // Free-form context attached by the producer (chunk text, LLM output, etc.)
  if (rec.extras) {
    const rendered = renderExtras(rec.extras)
    if (rendered) sections.push(rendered)
  }

  if (includeLogs) {
    const logs = logsBefore(rec.ts + 100, 20)
    if (logs.length > 0) {
      sections.push(
        `## Recent logs (${logs.length} entries)\n\`\`\`\n${logs.map(fmtLog).join('\n')}\n\`\`\``
      )
    }
  }

  if (rec.langsmithRunUrl) sections.push(`## LangSmith\n${rec.langsmithRunUrl}`)

  if (includeEnv) sections.push(envSection())

  return sections.join('\n\n') + '\n'
}

export function buildBundleAll(): string {
  const sorted = [...listErrors()].sort((a, b) => b.ts - a.ts)
  if (sorted.length === 0) return '_No errors recorded this session._\n'
  const totalCount = sorted.reduce((acc, s) => acc + s.count, 0)
  const header = `# Diagnostic bundle — ${sorted.length} error${sorted.length === 1 ? '' : 's'}${totalCount !== sorted.length ? ` (${totalCount} occurrences)` : ''}`
  const errorsBlock = sorted
    .map((s) => buildBundle(s.id, { includeLogs: false, includeEnv: false }))
    .join('\n---\n\n')

  const trailing: string[] = []
  const allLogs = recentLogs(50)
  if (allLogs.length > 0) {
    trailing.push(
      `## Session logs (${allLogs.length} entries)\n\`\`\`\n${allLogs.map(fmtLog).join('\n')}\n\`\`\``
    )
  }
  trailing.push(envSection())

  return header + '\n\n' + errorsBlock + '\n---\n\n' + trailing.join('\n\n') + '\n'
}
