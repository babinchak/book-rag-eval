#!/usr/bin/env node
// Bulk import a folder of EPUBs into the local library as a named collection.
//
// Usage:
//   node scripts/import-collection.mjs --source <folder> --id <slug> --name "<display>"
//   node scripts/import-collection.mjs --source <folder> --id philosophy --name "Philosophy"
//
// Books go to Electron's userData/library directory (per-OS). Already-imported
// EPUBs (sha256 match) are skipped, but a new collectionId is applied if the
// book had none.
//
// Requires the `readium` CLI on PATH (or READIUM_BIN env var) — same as the
// in-app importer.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const READIUM_BIN = process.env.READIUM_BIN || 'readium'
const APP_NAME = 'book-rag-eval'

function userDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, APP_NAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_NAME)
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdg, APP_NAME)
}

function libraryDir() {
  return join(userDataDir(), 'library')
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function runReadiumManifest(epubPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(READIUM_BIN, ['manifest', epubPath], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `Readium CLI binary not found (looking for "${READIUM_BIN}"). ` +
              `Install from https://github.com/readium/cli and put it on PATH, ` +
              `or set READIUM_BIN to its absolute path.`
          )
        )
        return
      }
      reject(err)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`readium manifest exited with code ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(new Error(`Failed to parse readium manifest output: ${e.message}`))
      }
    })
  })
}

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

function normalizeAuthor(author) {
  if (!author) return null
  if (typeof author === 'string') return author
  if (Array.isArray(author)) {
    const names = author.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean)
    return names.length > 0 ? names.join(', ') : null
  }
  if (typeof author === 'object') return author.name ?? null
  return null
}

function relIncludes(rel, target) {
  if (!rel) return false
  if (typeof rel === 'string') return rel === target
  return rel.includes(target)
}

function findCoverLink(manifest) {
  const candidates = [...(manifest.resources ?? []), ...(manifest.readingOrder ?? [])]
  return candidates.find((link) => relIncludes(link.rel, 'cover')) ?? null
}

async function extractCover(epubPath, manifest, outDir) {
  const cover = findCoverLink(manifest)
  if (!cover) return null
  const zip = new AdmZip(epubPath)
  const candidate = cover.href.startsWith('/') ? cover.href.slice(1) : cover.href
  const entry = zip.getEntry(candidate) ?? zip.getEntry(decodeURIComponent(candidate))
  if (!entry) return null
  let ext = EXT_BY_MIME[cover.type ?? ''] || candidate.split('.').pop()?.toLowerCase() || null
  if (!ext) return null
  if (ext === 'jpeg') ext = 'jpg'
  await fs.writeFile(join(outDir, `cover.${ext}`), entry.getData())
  return ext
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

async function writeJsonAtomic(path, data) {
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

async function importOne({ epubPath, collectionId, libDir, index }) {
  const id = await sha256File(epubPath)
  const existing = index.books.find((b) => b.id === id)
  if (existing) {
    // Apply collection only if not already set.
    if (existing.collectionId == null) existing.collectionId = collectionId
    return { id, status: 'skipped', title: existing.title }
  }

  const dir = join(libDir, id)
  await fs.mkdir(dir, { recursive: true })
  const targetEpub = join(dir, 'book.epub')
  await fs.copyFile(epubPath, targetEpub)
  const manifest = await runReadiumManifest(targetEpub)
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  const coverExt = await extractCover(targetEpub, manifest, dir)
  const stat = await fs.stat(targetEpub)

  const fallbackTitle = epubPath.split(/[\\/]/).pop()?.replace(/\.epub$/i, '') ?? 'Untitled'
  const entry = {
    id,
    title:
      typeof manifest.metadata?.title === 'string' && manifest.metadata.title.trim().length > 0
        ? manifest.metadata.title
        : fallbackTitle,
    author: normalizeAuthor(manifest.metadata?.author),
    addedAt: Date.now(),
    sizeBytes: stat.size,
    coverExt,
    collectionId
  }
  index.books.push(entry)
  return { id, status: 'imported', title: entry.title }
}

async function upsertCollection(libDir, id, name) {
  const path = join(libDir, 'collections.json')
  const file = (await readJson(path, { collections: [] }))
  const existing = file.collections.find((c) => c.id === id)
  if (existing) {
    if (existing.name !== name) existing.name = name
  } else {
    file.collections.push({ id, name, addedAt: Date.now() })
  }
  await writeJsonAtomic(path, file)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const source = args.source
  const collectionId = args.id
  const collectionName = args.name

  if (!source || !collectionId || !collectionName) {
    console.error(
      'Usage: node scripts/import-collection.mjs --source <folder> --id <slug> --name "<display>"'
    )
    process.exit(2)
  }

  const libDir = libraryDir()
  await fs.mkdir(libDir, { recursive: true })

  const indexPath = join(libDir, 'index.json')
  const index = await readJson(indexPath, { books: [] })

  const entries = await fs.readdir(source, { withFileTypes: true })
  const epubs = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.epub'))
    .map((e) => join(source, e.name))
    .sort()

  if (epubs.length === 0) {
    console.error(`No .epub files found in ${source}`)
    process.exit(1)
  }

  console.log(`Importing ${epubs.length} EPUBs into collection "${collectionName}" (${collectionId})`)
  console.log(`Library dir: ${libDir}`)
  console.log('')

  let imported = 0
  let skipped = 0
  let failed = 0
  for (let i = 0; i < epubs.length; i++) {
    const epubPath = epubs[i]
    const prefix = `[${String(i + 1).padStart(3)}/${epubs.length}]`
    try {
      const result = await importOne({ epubPath, collectionId, libDir, index })
      if (result.status === 'imported') imported++
      else skipped++
      console.log(`${prefix} ${result.status.padEnd(8)} ${result.title}`)
    } catch (err) {
      failed++
      console.error(`${prefix} FAILED   ${epubPath}: ${err.message}`)
    }
  }

  await writeJsonAtomic(indexPath, index)
  await upsertCollection(libDir, collectionId, collectionName)

  console.log('')
  console.log(`Done. imported=${imported} skipped=${skipped} failed=${failed}`)
}

// Allow this file to be imported without auto-running.
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
