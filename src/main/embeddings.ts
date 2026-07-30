import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { bookDir } from './library'
import { getChunkSet } from './chunking'
import { sidecar } from './sidecar'
import { getOpenaiKey } from './settings'
import { embeddingArtifactIdentity, resolvedChunkArtifactId } from './artifactConfig'
import type { EmbeddingSetSummary } from '../preload/types'

const EMBEDDING_MODEL = 'text-embedding-3-large'
const EMBEDDING_DIMS = 3072
const EMBED_BATCH = 64

function vectorsDir(bookId: string): string {
  return join(bookDir(bookId), 'vectors')
}

function vectorsDbPath(bookId: string, artifactId: string): string {
  return join(vectorsDir(bookId), `${artifactId}.db`)
}

function openDb(path: string): Database.Database {
  const db = new Database(path)
  sqliteVec.load(db)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIMS}]
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  return db
}

function vectorToBuffer(vec: number[]): Buffer {
  const arr = new Float32Array(vec)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function readTokensTotal(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'tokens_total'").get() as
    | { value: string }
    | undefined
  const n = row ? parseInt(row.value, 10) : 0
  return Number.isFinite(n) ? n : 0
}

export interface EmbedResult {
  artifactId: string
  chunkArtifactId: string
  embedded: number
  skipped: number
  totalTokens: number
  model: string
}

export async function runEmbedding(bookId: string, strategyId: string): Promise<EmbedResult> {
  const apiKey = await getOpenaiKey()
  if (!apiKey) {
    throw new Error('OpenAI API key is not set. Add it in Settings before embedding.')
  }
  await sidecar.ensureStarted(apiKey)

  const set = await getChunkSet(bookId, strategyId)
  const artifact = embeddingArtifactIdentity(set, EMBEDDING_MODEL, EMBEDDING_DIMS)
  const chunkArtifactId = resolvedChunkArtifactId(set)
  await fs.mkdir(vectorsDir(bookId), { recursive: true })

  const db = openDb(vectorsDbPath(bookId, artifact.id))
  try {
    const existingIds = new Set(
      db
        .prepare('SELECT id FROM vec_chunks')
        .all()
        .map((r: unknown) => (r as { id: string }).id)
    )

    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('model', EMBEDDING_MODEL)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'artifact_id',
      artifact.id
    )
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'chunk_artifact_id',
      chunkArtifactId
    )
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'strategy_id',
      strategyId
    )
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'dims',
      String(EMBEDDING_DIMS)
    )

    const toEmbed = set.chunks.filter((c) => !existingIds.has(c.id))
    const skipped = set.chunks.length - toEmbed.length

    if (toEmbed.length === 0) {
      return {
        artifactId: artifact.id,
        chunkArtifactId,
        embedded: 0,
        skipped,
        totalTokens: 0,
        model: EMBEDDING_MODEL
      }
    }

    let totalTokens = 0
    const insert = db.prepare('INSERT OR REPLACE INTO vec_chunks(id, embedding) VALUES (?, ?)')

    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH)
      const result = await sidecar.embed(
        batch.map((c) => c.text),
        EMBEDDING_MODEL
      )
      if (result.embeddings.length !== batch.length) {
        throw new Error(
          `embedding count mismatch: expected ${batch.length}, got ${result.embeddings.length}`
        )
      }
      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          insert.run(batch[j].id, vectorToBuffer(result.embeddings[j]))
        }
      })
      tx()
      totalTokens += result.tokens
    }

    const priorTokens = readTokensTotal(db)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'tokens_total',
      String(priorTokens + totalTokens)
    )

    return {
      artifactId: artifact.id,
      chunkArtifactId,
      embedded: toEmbed.length,
      skipped,
      totalTokens,
      model: EMBEDDING_MODEL
    }
  } finally {
    db.close()
  }
}

export async function listEmbeddingSets(bookId: string): Promise<EmbeddingSetSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(vectorsDir(bookId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const result: EmbeddingSetSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.db')) continue
    const filenameId = name.slice(0, -3)
    const path = join(vectorsDir(bookId), name)
    try {
      const db = openDb(path)
      const countRow = db.prepare('SELECT COUNT(*) AS c FROM vec_chunks').get() as { c: number }
      const modelRow = db.prepare("SELECT value FROM meta WHERE key = 'model'").get() as
        | { value: string }
        | undefined
      const tokensRow = db.prepare("SELECT value FROM meta WHERE key = 'tokens_total'").get() as
        | { value: string }
        | undefined
      const artifactRow = db.prepare("SELECT value FROM meta WHERE key = 'artifact_id'").get() as
        | { value: string }
        | undefined
      const chunkArtifactRow = db
        .prepare("SELECT value FROM meta WHERE key = 'chunk_artifact_id'")
        .get() as { value: string } | undefined
      const strategyRow = db.prepare("SELECT value FROM meta WHERE key = 'strategy_id'").get() as
        | { value: string }
        | undefined
      const stat = await fs.stat(path)
      db.close()
      const tokensTotal = tokensRow ? parseInt(tokensRow.value, 10) : NaN
      result.push({
        artifactId: artifactRow?.value ?? filenameId,
        chunkArtifactId: chunkArtifactRow?.value,
        strategyId: strategyRow?.value ?? filenameId,
        count: countRow.c,
        model: modelRow?.value ?? 'unknown',
        updatedAt: stat.mtimeMs,
        totalTokens: Number.isFinite(tokensTotal) ? tokensTotal : undefined
      })
    } catch (err) {
      console.error('failed to read embedding db', path, err)
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function removeEmbeddings(bookId: string, strategyId: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(vectorsDir(bookId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.db')) continue
    const path = join(vectorsDir(bookId), name)
    let matches = name === `${strategyId}.db`
    if (!matches) {
      try {
        const db = openDb(path)
        const row = db.prepare("SELECT value FROM meta WHERE key = 'strategy_id'").get() as
          | { value: string }
          | undefined
        db.close()
        matches = row?.value === strategyId
      } catch {
        matches = false
      }
    }
    if (matches) await fs.rm(path, { force: true })
  }
}
