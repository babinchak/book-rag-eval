import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

interface SettingsBlob {
  openaiKeyEncrypted?: string
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function read(): Promise<SettingsBlob> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    return JSON.parse(raw) as SettingsBlob
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function write(blob: SettingsBlob): Promise<void> {
  const tmp = settingsPath() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(blob, null, 2), 'utf8')
  await fs.rename(tmp, settingsPath())
}

export async function setOpenaiKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encrypted storage is not available on this system; refusing to persist key in plaintext'
    )
  }
  const trimmed = key.trim()
  if (!trimmed) throw new Error('API key is empty')
  const encrypted = safeStorage.encryptString(trimmed)
  const blob = await read()
  blob.openaiKeyEncrypted = encrypted.toString('base64')
  await write(blob)
}

export async function getOpenaiKey(): Promise<string | null> {
  const blob = await read()
  if (!blob.openaiKeyEncrypted) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const buf = Buffer.from(blob.openaiKeyEncrypted, 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export async function clearOpenaiKey(): Promise<void> {
  const blob = await read()
  delete blob.openaiKeyEncrypted
  await write(blob)
}

export async function hasOpenaiKey(): Promise<boolean> {
  const blob = await read()
  return Boolean(blob.openaiKeyEncrypted)
}
