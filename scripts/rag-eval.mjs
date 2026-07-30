import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(scriptDir, '..')
const cliPath = resolve(projectDir, 'src', 'headless', 'cli.ts')
const child = spawn(electronPath, ['--import', 'tsx', cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BOOK_RAG_EVAL_APP_DIR: projectDir
  },
  stdio: 'inherit',
  windowsHide: true
})

child.on('error', (error) => {
  process.stderr.write(`Failed to start headless runner: ${error.message}\n`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
