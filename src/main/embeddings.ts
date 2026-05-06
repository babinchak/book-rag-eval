import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { bookDir } from './library'
import { getChunkSet } from './chunking'
import { sidecar } from './sidecar'
import { getOpenaiKey } from './settings'
import type { EmbeddingSetSummary } from '../preload/types'

const EMBEDDING_MODEL = 'text-embedding-3-large'
const EMBEDDING_DIMS = 3072
const EMBED_BATCH = 64

function vectorsDir(bookId: string): string {
  return join(bookDir(bookId), 'vectors')
}

function vectorsDbPath(bookId: string, sid: string): string {
  return join(vectorsDir(bookId), `${sid}.db`)
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

export interface EmbedResult {
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
  await fs.mkdir(vectorsDir(bookId), { recursive: true })

  const db = openDb(vectorsDbPath(bookId, strategyId))
  try {
    const existingIds = new Set(
      db
        .prepare('SELECT id FROM vec_chunks')
        .all()
        .map((r: unknown) => (r as { id: string }).id)
    )

    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('model', EMBEDDING_MODEL)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'dims',
      String(EMBEDDING_DIMS)
    )

    const toEmbed = set.chunks.filter((c) => !existingIds.has(c.id))
    const skipped = set.chunks.length - toEmbed.length

    if (toEmbed.length === 0) {
      return { embedded: 0, skipped, totalTokens: 0, model: EMBEDDING_MODEL }
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

    return { embedded: toEmbed.length, skipped, totalTokens, model: EMBEDDING_MODEL }
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
    const sid = name.slice(0, -3)
    const path = join(vectorsDir(bookId), name)
    try {
      const db = openDb(path)
      const countRow = db.prepare('SELECT COUNT(*) AS c FROM vec_chunks').get() as { c: number }
      const modelRow = db.prepare("SELECT value FROM meta WHERE key = 'model'").get() as
        | { value: string }
        | undefined
      const stat = await fs.stat(path)
      db.close()
      result.push({
        strategyId: sid,
        count: countRow.c,
        model: modelRow?.value ?? 'unknown',
        updatedAt: stat.mtimeMs
      })
    } catch (err) {
      console.error('failed to read embedding db', path, err)
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function removeEmbeddings(bookId: string, strategyId: string): Promise<void> {
  await fs.rm(vectorsDbPath(bookId, strategyId), { force: true })
}
