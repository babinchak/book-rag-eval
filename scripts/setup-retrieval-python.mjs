#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const projectRoot = process.cwd()
const venvDir = join(projectRoot, 'python', '.retrieval-venv')
const venvBinDir = join(venvDir, isWin ? 'Scripts' : 'bin')
const venvPython = join(venvBinDir, isWin ? 'python.exe' : 'python')
const requirements = join(projectRoot, 'python', 'requirements-retrieval.txt')

function findPython(candidates) {
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

if (!existsSync(venvDir)) {
  const systemPython = findPython(isWin ? ['python', 'py'] : ['python3', 'python'])
  if (!systemPython) {
    console.error('Python 3.10+ is required for the local retrieval environment.')
    process.exit(1)
  }
  console.log(`Creating retrieval venv at ${venvDir} (using ${systemPython})`)
  execFileSync(systemPython, ['-m', 'venv', venvDir], { stdio: 'inherit' })
} else {
  console.log(`Reusing existing retrieval venv at ${venvDir}`)
}

console.log('Installing pinned GPU retrieval requirements')
execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' })
execFileSync(venvPython, ['-m', 'pip', 'install', '-r', requirements], {
  stdio: 'inherit'
})

console.log('\nLocal ColBERTv2 and BGE-M3 environment is ready.')
