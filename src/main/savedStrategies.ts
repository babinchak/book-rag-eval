import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  defaultSeedStrategies,
  isValidSavedStrategy,
  newSavedStrategyId,
  type SavedStrategy,
  type StrategyConfig
} from '../shared/savedStrategy'

function strategiesPath(): string {
  return join(app.getPath('userData'), 'library', 'strategies.json')
}

async function ensureLibraryDir(): Promise<void> {
  await fs.mkdir(join(app.getPath('userData'), 'library'), { recursive: true })
}

interface StrategiesFile {
  version?: number
  strategies: SavedStrategy[]
}

const STRATEGIES_FILE_VERSION = 2

let cache: SavedStrategy[] | null = null

async function readFile(): Promise<SavedStrategy[]> {
  if (cache) return cache
  await ensureLibraryDir()
  let raw: string
  try {
    raw = await fs.readFile(strategiesPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const seeded = defaultSeedStrategies()
      await writeFile(seeded)
      cache = seeded
      return seeded
    }
    throw err
  }
  const parsed = JSON.parse(raw) as StrategiesFile
  let list = Array.isArray(parsed.strategies) ? parsed.strategies.filter(isValidSavedStrategy) : []

  if ((parsed.version ?? 1) < STRATEGIES_FILE_VERSION) {
    list = migrateToTokenBaseline(list)
    await writeFile(list)
  }

  cache = list
  return list
}

function migrateToTokenBaseline(strategies: SavedStrategy[]): SavedStrategy[] {
  const renamed = strategies.map((strategy) => {
    if (!strategy.id.startsWith('seed-fixed-1200-200-')) return strategy
    return {
      ...strategy,
      name: strategy.name.replace(/^Fixed 1200\/200/, 'Chars 1200/200 (legacy)')
    }
  })
  const existingIds = new Set(renamed.map((strategy) => strategy.id))
  const missingDefaults = defaultSeedStrategies().filter(
    (strategy) => strategy.config.chunker.kind === 'fixed-token' && !existingIds.has(strategy.id)
  )
  return [...renamed, ...missingDefaults]
}

async function writeFile(strategies: SavedStrategy[]): Promise<void> {
  await ensureLibraryDir()
  const tmp = strategiesPath() + '.tmp'
  const payload: StrategiesFile = { version: STRATEGIES_FILE_VERSION, strategies }
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tmp, strategiesPath())
  cache = strategies
}

export async function listSavedStrategies(): Promise<SavedStrategy[]> {
  const list = await readFile()
  // Sort newest-created first; seeded entries cluster together at the bottom.
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSavedStrategy(id: string): Promise<SavedStrategy | null> {
  const list = await readFile()
  return list.find((s) => s.id === id) ?? null
}

export async function createSavedStrategy(
  name: string,
  config: StrategyConfig
): Promise<SavedStrategy> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Strategy name is required')
  const list = await readFile()
  const now = Date.now()
  const entry: SavedStrategy = {
    id: newSavedStrategyId(trimmed),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    config
  }
  await writeFile([...list, entry])
  return entry
}

export async function updateSavedStrategy(
  id: string,
  patch: { name?: string; config?: StrategyConfig }
): Promise<SavedStrategy> {
  const list = await readFile()
  const idx = list.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error(`Strategy "${id}" not found`)
  const current = list[idx]
  const next: SavedStrategy = {
    ...current,
    name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
    config: patch.config ?? current.config,
    updatedAt: Date.now()
  }
  const updated = [...list]
  updated[idx] = next
  await writeFile(updated)
  return next
}

export async function deleteSavedStrategy(id: string): Promise<void> {
  const list = await readFile()
  const next = list.filter((s) => s.id !== id)
  if (next.length === list.length) throw new Error(`Strategy "${id}" not found`)
  await writeFile(next)
}

export async function duplicateSavedStrategy(id: string): Promise<SavedStrategy> {
  const src = await getSavedStrategy(id)
  if (!src) throw new Error(`Strategy "${id}" not found`)
  return createSavedStrategy(`${src.name} (copy)`, src.config)
}
