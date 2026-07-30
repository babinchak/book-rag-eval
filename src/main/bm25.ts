import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { bookDir } from './library'
import { getChunkSet } from './chunking'
import { BM25_TOKENIZER, bm25ArtifactIdentity, resolvedChunkArtifactId } from './artifactConfig'
import type { Bm25IndexSummary, Bm25RunResult, ChunkSet } from '../preload/types'

function bm25Dir(bookId: string): string {
  return join(bookDir(bookId), 'bm25')
}

function bm25DbPath(bookId: string, artifactId: string): string {
  return join(bm25Dir(bookId), `${artifactId}.db`)
}

function openDb(path: string): Database.Database {
  const db = new Database(path)
  // UNINDEXED `id` so it isn't tokenized; `text` is the only searchable column.
  // Tokenizer is porter+unicode61: case-folds, splits on non-alphanumeric,
  // and stems English morphology so "running" matches "ran".
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      id UNINDEXED,
      text,
      tokenize = '${BM25_TOKENIZER}'
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  return db
}

export async function runBm25Indexing(bookId: string, strategyId: string): Promise<Bm25RunResult> {
  const set = await getChunkSet(bookId, strategyId)
  const artifact = bm25ArtifactIdentity(set)
  const chunkArtifactId = resolvedChunkArtifactId(set)
  await fs.mkdir(bm25Dir(bookId), { recursive: true })

  const db = openDb(bm25DbPath(bookId, artifact.id))
  try {
    // Rebuild from scratch. FTS5 upserts are awkward (id is UNINDEXED so we
    // can't WHERE on it cheaply), indexing is fast (~1s for a book), and a
    // rebuild guarantees the index reflects the current chunk set exactly.
    db.exec('DELETE FROM fts_chunks;')
    const insert = db.prepare('INSERT INTO fts_chunks(id, text) VALUES (?, ?)')
    const tx = db.transaction((chunks: { id: string; text: string }[]) => {
      for (const c of chunks) insert.run(c.id, c.text)
    })
    tx(set.chunks)
    const writeMeta = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
    writeMeta.run('artifact_id', artifact.id)
    writeMeta.run('chunk_artifact_id', chunkArtifactId)
    writeMeta.run('strategy_id', strategyId)
    writeMeta.run('tokenizer', BM25_TOKENIZER)
    return {
      artifactId: artifact.id,
      chunkArtifactId,
      indexed: set.chunks.length,
      skipped: 0
    }
  } finally {
    db.close()
  }
}

export async function listBm25Indexes(bookId: string): Promise<Bm25IndexSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(bm25Dir(bookId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const result: Bm25IndexSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.db')) continue
    const filenameId = name.slice(0, -3)
    const path = join(bm25Dir(bookId), name)
    try {
      const db = openDb(path)
      const countRow = db.prepare('SELECT COUNT(*) AS c FROM fts_chunks').get() as { c: number }
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
      result.push({
        artifactId: artifactRow?.value ?? filenameId,
        chunkArtifactId: chunkArtifactRow?.value,
        strategyId: strategyRow?.value ?? filenameId,
        count: countRow.c,
        updatedAt: stat.mtimeMs
      })
    } catch (err) {
      console.error('failed to read bm25 db', path, err)
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function removeBm25Index(bookId: string, strategyId: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(bm25Dir(bookId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    if (!name.endsWith('.db')) continue
    const path = join(bm25Dir(bookId), name)
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

export interface Bm25Hit {
  id: string
  score: number // FTS5 bm25(): more-negative = more-relevant. Used as "distance".
  rank: number
}

// Build a safe FTS5 MATCH expression: extract alphanumeric tokens, drop
// short ones, quote each (to neutralize FTS5 operators like AND/OR/NEAR/*),
// then OR-join. OR + BM25 ranking is the standard "find any matching chunk
// then rank by relevance" pattern.
function buildMatchExpression(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

export async function queryBm25(
  bookId: string,
  strategyId: string,
  query: string,
  k: number,
  suppliedSet?: ChunkSet
): Promise<Bm25Hit[]> {
  const set = suppliedSet ?? (await getChunkSet(bookId, strategyId))
  const artifact = bm25ArtifactIdentity(set)
  const dbPath = bm25DbPath(bookId, artifact.id)
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(`No BM25 index for "${strategyId}". Run "Index BM25" on this chunk set first.`)
  }

  const matchExpr = buildMatchExpression(query)
  if (!matchExpr) return []

  const db = openDb(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT id, bm25(fts_chunks) AS score
         FROM fts_chunks
         WHERE fts_chunks MATCH ?
         ORDER BY score
         LIMIT ?`
      )
      .all(matchExpr, k) as Array<{ id: string; score: number }>
    return rows.map((r, i) => ({ id: r.id, score: r.score, rank: i + 1 }))
  } finally {
    db.close()
  }
}
