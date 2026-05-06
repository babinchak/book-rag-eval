import { spawn } from 'node:child_process'
import AdmZip from 'adm-zip'
import type { ReadiumManifest, SpineItem } from '../preload/types'

const READIUM_BIN = process.env.READIUM_BIN || 'readium'

export function runReadiumManifest(epubPath: string): Promise<ReadiumManifest> {
  return new Promise((resolve, reject) => {
    const child = spawn(READIUM_BIN, ['manifest', epubPath], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            `Readium CLI binary not found (looking for "${READIUM_BIN}"). ` +
              `Install from https://github.com/readium/cli and ensure it is on PATH, ` +
              `or set the READIUM_BIN environment variable to its absolute path.`
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
        resolve(JSON.parse(stdout) as ReadiumManifest)
      } catch (e) {
        reject(new Error(`Failed to parse readium manifest output: ${(e as Error).message}`))
      }
    })
  })
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  css: 'text/css'
}

function resolveZipPath(baseDir: string, relative: string): string {
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : []
  for (const segment of relative.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '' && segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}

function inlineAsset(
  byPath: Map<string, ReturnType<AdmZip['getEntries']>[number]>,
  baseDir: string,
  src: string
): string | null {
  if (src.startsWith('data:') || /^https?:\/\//i.test(src)) return null
  const cleaned = src.split('#')[0].split('?')[0]
  const resolved = resolveZipPath(baseDir, cleaned)
  const entry = byPath.get(resolved) ?? byPath.get(decodeURIComponent(resolved))
  if (!entry) return null
  const ext = resolved.split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
  return `data:${mime};base64,${entry.getData().toString('base64')}`
}

function inlineXhtml(
  html: string,
  xhtmlPath: string,
  byPath: Map<string, ReturnType<AdmZip['getEntries']>[number]>
): string {
  const baseDir = xhtmlPath.includes('/') ? xhtmlPath.split('/').slice(0, -1).join('/') : ''

  return html
    .replace(/(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/gi, (match, prefix, quote, src: string) => {
      const dataUrl = inlineAsset(byPath, baseDir, src)
      return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : match
    })
    .replace(
      /(<image\b[^>]*\b(?:xlink:href|href)=)(["'])([^"']+)\2/gi,
      (match, prefix, quote, src: string) => {
        const dataUrl = inlineAsset(byPath, baseDir, src)
        return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : match
      }
    )
    .replace(
      /(<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=)(["'])([^"']+)\2/gi,
      (match, prefix, quote, src: string) => {
        const dataUrl = inlineAsset(byPath, baseDir, src)
        return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : match
      }
    )
}

export function extractSpineHtml(epubPath: string, manifest: ReadiumManifest): SpineItem[] {
  const readingOrder = manifest.readingOrder ?? []
  if (readingOrder.length === 0) return []

  const zip = new AdmZip(epubPath)
  const entries = zip.getEntries()
  const byPath = new Map(entries.map((e) => [e.entryName, e]))

  return readingOrder.map((link) => {
    const href = link.href
    const candidate = href.startsWith('/') ? href.slice(1) : href
    const entry = byPath.get(candidate) ?? byPath.get(decodeURIComponent(candidate))
    const rawHtml = entry ? entry.getData().toString('utf8') : `<!-- missing: ${href} -->`
    const html = entry ? inlineXhtml(rawHtml, candidate, byPath) : rawHtml
    return { href, html }
  })
}
