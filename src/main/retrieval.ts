import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { bookDir } from './library'
import { getChunkSet } from './chunking'
import { sidecar } from './sidecar'
import { getOpenaiKey } from './settings'
import type { AskResultPayload, RetrievedChunkPayload } from '../preload/types'

const EMBEDDING_MODEL = 'text-embedding-3-large'
const CHAT_MODEL = 'gpt-4o-mini'

function vectorsDbPath(bookId: string, sid: string): string {
  return join(bookDir(bookId), 'vectors', `${sid}.db`)
}

export async function retrieve(
  bookId: string,
  strategyId: string,
  query: string,
  k: number
): Promise<RetrievedChunkPayload[]> {
  const apiKey = await getOpenaiKey()
  if (!apiKey) {
    throw new Error('OpenAI API key is not set. Add it in Settings before retrieving.')
  }

  const dbPath = vectorsDbPath(bookId, strategyId)
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(
      `No embeddings for "${strategyId}". Run "Embed" on this chunk set first.`
    )
  }

  await sidecar.ensureStarted(apiKey)
  const queryResult = await sidecar.embed([query], EMBEDDING_MODEL)
  const queryVec = queryResult.embeddings[0]

  const db = new Database(dbPath)
  sqliteVec.load(db)

  try {
    const buf = Buffer.from(new Float32Array(queryVec).buffer)
    const rows = db
      .prepare(
        `SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      )
      .all(buf, k) as Array<{ id: string; distance: number }>

    if (rows.length === 0) return []

    const set = await getChunkSet(bookId, strategyId)
    const chunkById = new Map(set.chunks.map((c) => [c.id, c]))

    const result: RetrievedChunkPayload[] = []
    rows.forEach((row, i) => {
      const chunk = chunkById.get(row.id)
      if (chunk) result.push({ chunk, distance: row.distance, rank: i + 1 })
    })
    return result
  } finally {
    db.close()
  }
}

export async function ask(
  bookId: string,
  strategyId: string,
  query: string,
  k: number
): Promise<AskResultPayload> {
  const retrieved = await retrieve(bookId, strategyId, query, k)

  if (retrieved.length === 0) {
    return {
      answer: '(No relevant passages found in the book.)',
      retrieved: [],
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: CHAT_MODEL
    }
  }

  const passages = retrieved.map((r, i) => `[${i + 1}] ${r.chunk.text}`).join('\n\n')

  const result = await sidecar.chat(
    [
      {
        role: 'system',
        content:
          'You are answering questions about a book using only the passages provided. ' +
          'If the answer is not in the passages, say so plainly. ' +
          'Cite passage numbers in brackets like [1] or [1, 3] after relevant claims.'
      },
      {
        role: 'user',
        content: `Passages:\n\n${passages}\n\nQuestion: ${query}`
      }
    ],
    CHAT_MODEL
  )

  return {
    answer: result.content,
    retrieved,
    promptTokens: result.tokens.prompt,
    completionTokens: result.tokens.completion,
    totalTokens: result.tokens.total,
    model: result.model
  }
}
