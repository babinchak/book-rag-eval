import { execSync } from 'child_process'
import { app } from 'electron'
import os from 'os'

interface EnvSnapshot {
  appName: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  osRelease: string
  gitSha: string | null
  gitDirty: boolean | null
  gitBranch: string | null
}

let cached: EnvSnapshot | null = null

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd: app.getAppPath(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 1000
    }).trim()
  } catch {
    return null
  }
}

export function envSnapshot(): EnvSnapshot {
  if (cached) return cached
  const sha = git('rev-parse --short HEAD')
  const branch = git('rev-parse --abbrev-ref HEAD')
  const status = git('status --porcelain')
  cached = {
    appName: app.getName(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: `${os.type()} ${os.release()}`,
    osRelease: os.version(),
    gitSha: sha,
    gitBranch: branch,
    gitDirty: status === null ? null : status.length > 0
  }
  return cached
}
