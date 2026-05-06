#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const projectRoot = process.cwd()
const venvDir = join(projectRoot, 'python', '.venv')
const venvBinDir = join(venvDir, isWin ? 'Scripts' : 'bin')
const venvPython = join(venvBinDir, isWin ? 'python.exe' : 'python')
const requirements = join(projectRoot, 'python', 'requirements.txt')

function which(cmd) {
  // Try common Python invocations and return the first that prints a version.
  for (const candidate of cmd) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // try next
    }
  }
  return null
}

if (!existsSync(venvDir)) {
  const systemPython = which(isWin ? ['python', 'py'] : ['python3', 'python'])
  if (!systemPython) {
    console.error(
      'No Python found on PATH. Install Python 3.10+ from https://www.python.org/downloads/ and re-run.'
    )
    process.exit(1)
  }
  console.log(`Creating venv at ${venvDir} (using ${systemPython})`)
  execFileSync(systemPython, ['-m', 'venv', venvDir], { stdio: 'inherit' })
} else {
  console.log(`Reusing existing venv at ${venvDir}`)
}

console.log('Installing/updating Python requirements')
execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' })
execFileSync(venvPython, ['-m', 'pip', 'install', '-r', requirements], { stdio: 'inherit' })

console.log('\nPython sidecar is ready. The Electron main process will auto-detect this venv.')
