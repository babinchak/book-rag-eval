import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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

export interface LocalDocument {
  id: string
  text: string
}

export interface LocalIndexResult {
  schemaVersion: 1
  kind: string
  model: string
  documents: number
  createdAt: number
  indexingLatencyMs: number
  [key: string]: unknown
}

export interface LocalQueryResult {
  hits: Array<{ id: string; score: number; rank: number }>
  queryLatencyMs: number
}

class LocalRetrievalSidecar {
  private proc: ChildProcess | null = null
  private pending = new Map<string, PendingRequest>()
  private nextId = 1
  private buffer = ''
  private startPromise: Promise<void> | null = null

  private projectRoot(): string {
    return process.env.BOOK_RAG_EVAL_APP_DIR ?? process.cwd()
  }

  private pythonBin(): string {
    if (process.env.RETRIEVAL_PYTHON_BIN) return process.env.RETRIEVAL_PYTHON_BIN
    const isWindows = process.platform === 'win32'
    return join(
      this.projectRoot(),
      'python',
      '.retrieval-venv',
      isWindows ? 'Scripts' : 'bin',
      isWindows ? 'python.exe' : 'python'
    )
  }

  async ensureStarted(): Promise<void> {
    if (this.proc) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async start(): Promise<void> {
    const python = this.pythonBin()
    if (!existsSync(python)) {
      throw new Error('Local retrieval environment is missing. Run npm run setup:retrieval-python.')
    }
    const script = join(this.projectRoot(), 'python', 'retrieval_sidecar.py')
    const proc = spawn(python, [script], {
      cwd: this.projectRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    proc.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    proc.on('error', (error) => {
      this.failAll(error)
      this.proc = null
    })
    proc.on('exit', (code, signal) => {
      this.failAll(new Error(`Local retrieval sidecar exited (code=${code}, signal=${signal})`))
      this.proc = null
    })
    this.proc = proc
    const health = await this.call<{ cuda: boolean; device?: string }>('ping', {})
    if (!health.cuda) {
      this.stop()
      throw new Error('Local retrieval sidecar started without CUDA support')
    }
  }

  stop(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    proc.kill()
    this.failAll(new Error('Local retrieval sidecar stopped'))
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (!line.trim()) continue
      const response = JSON.parse(line) as RpcResponse
      if (response.id === undefined) continue
      const pending = this.pending.get(response.id)
      if (!pending) continue
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
    }
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    if (!this.proc?.stdin) return Promise.reject(new Error('Local retrieval sidecar is not running'))
    const id = String(this.nextId++)
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    })
    this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return promise
  }

  async indexColbert(
    artifactDir: string,
    documents: LocalDocument[],
    model: string,
    batchSize = 16
  ): Promise<LocalIndexResult> {
    await this.ensureStarted()
    return this.call('colbert_index', { artifactDir, documents, model, batchSize })
  }

  async queryColbert(artifactDir: string, query: string, k: number): Promise<LocalQueryResult> {
    await this.ensureStarted()
    return this.call('colbert_query', { artifactDir, query, k })
  }

  async indexBge(
    artifactDir: string,
    documents: LocalDocument[],
    model: string,
    batchSize = 8,
    maxLength = 512
  ): Promise<LocalIndexResult> {
    await this.ensureStarted()
    return this.call('bge_index', {
      artifactDir,
      documents,
      model,
      batchSize,
      maxLength
    })
  }

  async queryBge(
    artifactDir: string,
    query: string,
    k: number,
    mode: 'dense' | 'sparse' | 'colbert-dense-shortlist',
    shortlist: number
  ): Promise<LocalQueryResult> {
    await this.ensureStarted()
    return this.call('bge_query', { artifactDir, query, k, mode, shortlist })
  }
}

export const localRetrievalSidecar = new LocalRetrievalSidecar()
