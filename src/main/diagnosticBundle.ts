import type { LogEntry } from '../preload/types'
import { envSnapshot } from './env'
import { getError } from './errorRegistry'
import { logsBefore } from './logBuffer'

const SECRET_KEY_RE = /key|token|secret|password|authorization/i
const TRUNCATE_AT = 500
const TRUNCATE_KEEP = 200

function truncate(s: string): string {
  if (s.length <= TRUNCATE_AT) return s
  const head = s.slice(0, TRUNCATE_KEEP)
  const tail = s.slice(s.length - TRUNCATE_KEEP)
  return `${head}… [truncated ${s.length - TRUNCATE_KEEP * 2} chars] …${tail}`
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

export function buildBundle(errorId: string): string {
  const rec = getError(errorId)
  if (!rec) return `Error ${errorId} not found in registry.`

  const env = envSnapshot()
  const ts = new Date(rec.ts).toISOString()
  const sections: string[] = []

  // Header
  const headerTitle = rec.origin === 'ipc' ? `[ipc] ${rec.ipcHandler ?? '?'}` : `[${rec.origin}]`
  sections.push(`## Error\n**${headerTitle}** failed at ${ts}`)
  if (rec.count > 1) sections[0] += ` (×${rec.count})`

  const errBlock: string[] = ['```', rec.error.message]
  if (rec.error.stack) errBlock.push(rec.error.stack)
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

  // Recent logs (last 20 before the error)
  const logs = logsBefore(rec.ts + 100, 20)
  if (logs.length > 0) {
    sections.push(
      `## Recent logs (${logs.length} entries)\n\`\`\`\n${logs.map(fmtLog).join('\n')}\n\`\`\``
    )
  }

  // LangSmith
  if (rec.langsmithRunUrl) sections.push(`## LangSmith\n${rec.langsmithRunUrl}`)

  // Env
  const envLines: string[] = [
    `- App: ${env.appName}@${env.appVersion}` +
      (env.gitSha
        ? ` · git ${env.gitSha}${env.gitDirty ? ' (dirty)' : ''}${env.gitBranch ? ` on ${env.gitBranch}` : ''}`
        : ''),
    `- Electron ${env.electronVersion} · Node ${env.nodeVersion}`,
    `- ${env.platform}`
  ]
  sections.push(`## Env\n${envLines.join('\n')}`)

  return sections.join('\n\n') + '\n'
}
