import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { join } from 'node:path'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

interface RpcResponse {
  id?: string
  result?: unknown
  error?: { message: string }
}

export interface EmbedResult {
  embeddings: number[][]
  tokens: number
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  content: string
  tokens: { prompt: number; completion: number; total: number }
  model: string
}

class Sidecar {
  private proc: ChildProcess | null = null
  private pending = new Map<string, PendingRequest>()
  private nextId = 1
  private buffer = ''
  private startPromise: Promise<void> | null = null
  private currentApiKey: string | null = null

  private scriptPath(): string {
    return join(app.getAppPath(), 'python', 'sidecar.py')
  }

  private pythonBin(): string {
    if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN
    const isWin = process.platform === 'win32'
    const venvPython = join(
      app.getAppPath(),
      'python',
      '.venv',
      isWin ? 'Scripts' : 'bin',
      isWin ? 'python.exe' : 'python'
    )
    if (existsSync(venvPython)) return venvPython
    return isWin ? 'python' : 'python3'
  }

  async ensureStarted(apiKey: string): Promise<void> {
    if (this.proc && this.currentApiKey === apiKey) return
    if (this.proc && this.currentApiKey !== apiKey) {
      this.stop()
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start(apiKey).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async start(apiKey: string): Promise<void> {
    const proc = spawn(this.pythonBin(), [this.scriptPath()], {
      env: { ...process.env, OPENAI_API_KEY: apiKey, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    proc.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Surface Python tracebacks etc. — useful for debugging.
      console.error('[sidecar stderr]', chunk.toString())
    })
    proc.on('error', (err) => {
      console.error('[sidecar spawn error]', err)
      this.failAllPending(err)
      this.proc = null
      this.currentApiKey = null
    })
    proc.on('exit', (code, signal) => {
      console.log('[sidecar exit]', { code, signal })
      this.failAllPending(new Error(`sidecar exited (code=${code}, signal=${signal})`))
      this.proc = null
      this.currentApiKey = null
    })

    this.proc = proc
    this.currentApiKey = apiKey

    try {
      const result = await this.call('ping', {})
      if (result !== 'pong') {
        throw new Error(`unexpected ping response: ${JSON.stringify(result)}`)
      }
    } catch (err) {
      this.stop()
      throw new Error(
        `Failed to start Python sidecar (${this.pythonBin()} ${this.scriptPath()}): ${(err as Error).message}. ` +
          `Ensure Python 3.10+ is installed and "pip install -r python/requirements.txt" was run.`
      )
    }
  }

  stop(): void {
    if (!this.proc) return
    try {
      this.proc.kill()
    } catch {
      // ignore
    }
    this.proc = null
    this.currentApiKey = null
    this.failAllPending(new Error('sidecar stopped'))
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let newlineIdx: number
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx)
      this.buffer = this.buffer.slice(newlineIdx + 1)
      if (!line.trim()) continue
      let msg: RpcResponse
      try {
        msg = JSON.parse(line) as RpcResponse
      } catch (e) {
        console.error('[sidecar parse error]', e, 'line:', line.slice(0, 200))
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: RpcResponse): void {
    if (msg.id === undefined) {
      // Notification or pre-init error
      if (msg.error) console.error('[sidecar pre-init error]', msg.error.message)
      return
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.error) pending.reject(new Error(msg.error.message))
    else pending.resolve(msg.result)
  }

  private call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.proc?.stdin) return Promise.reject(new Error('sidecar not running'))
    const id = String(this.nextId++)
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
    this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return promise
  }

  async embed(texts: string[], model = 'text-embedding-3-large'): Promise<EmbedResult> {
    return this.call<EmbedResult>('embed', { texts, model })
  }

  async chat(messages: ChatMessage[], model = 'gpt-4o-mini'): Promise<ChatResult> {
    return this.call<ChatResult>('chat', { messages, model })
  }
}

export const sidecar = new Sidecar()

app.on('before-quit', () => sidecar.stop())
