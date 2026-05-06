import type { Chunk } from '../../../preload/types'

interface Position {
  node: Text
  nodeOffset: number
}

interface OffsetIndex {
  plain: string
  positions: Position[]
}

const HIGHLIGHT_NAMES = ['chunk-a', 'chunk-b', 'chunk-selected'] as const

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
}

export function buildOffsetIndex(root: Element): OffsetIndex {
  const positions: Position[] = []
  let plain = ''
  let lastWasSpace = true
  let firstNode = true

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement
      while (p) {
        const tag = p.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
        if (p === root) break
        p = p.parentElement
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })

  let node = walker.nextNode() as Text | null
  while (node) {
    if (!firstNode && !lastWasSpace) {
      positions.push({ node, nodeOffset: 0 })
      plain += ' '
      lastWasSpace = true
    }
    firstNode = false

    const text = node.nodeValue ?? ''
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (isWhitespace(c)) {
        if (!lastWasSpace) {
          positions.push({ node, nodeOffset: i })
          plain += ' '
          lastWasSpace = true
        }
      } else {
        positions.push({ node, nodeOffset: i })
        plain += c
        lastWasSpace = false
      }
    }

    node = walker.nextNode() as Text | null
  }

  if (plain.endsWith(' ')) {
    plain = plain.slice(0, -1)
    positions.pop()
  }

  return { plain, positions }
}

function rangeForOffsets(idx: OffsetIndex, start: number, end: number): Range | null {
  if (start < 0 || start >= end) return null
  if (end > idx.positions.length) end = idx.positions.length
  if (start >= idx.positions.length) return null
  const startPos = idx.positions[start]
  const endPos = idx.positions[end - 1]
  const range = document.createRange()
  range.setStart(startPos.node, startPos.nodeOffset)
  range.setEnd(endPos.node, endPos.nodeOffset + 1)
  return range
}

export function buildRangeForChunk(
  root: Element,
  textStart: number,
  textEnd: number
): Range | null {
  return rangeForOffsets(buildOffsetIndex(root), textStart, textEnd)
}

interface HighlightsHost {
  highlights?: Map<string, Highlight>
}

function highlightsHost(): Map<string, Highlight> | null {
  const host = (CSS as unknown as HighlightsHost).highlights
  return host ?? null
}

export function applyChunkOverlay(
  rootsByHref: Map<string, Element>,
  chunks: Chunk[],
  selectedChunks: Chunk[] = []
): { applied: number; missingSpines: string[] } {
  clearChunkOverlay()
  const host = highlightsHost()
  if (!host) {
    console.warn('CSS Custom Highlight API not supported in this Chromium build')
    return { applied: 0, missingSpines: [] }
  }

  const byHref = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    const list = byHref.get(chunk.spineHref)
    if (list) list.push(chunk)
    else byHref.set(chunk.spineHref, [chunk])
  }

  const altRanges: Range[][] = [[], []] // chunk-a, chunk-b
  const selectedRanges: Range[] = []
  const indexCache = new Map<string, OffsetIndex>()
  const missingSpines: string[] = []
  let applied = 0

  for (const [href, hrefChunks] of byHref) {
    const root = rootsByHref.get(href)
    if (!root) {
      missingSpines.push(href)
      continue
    }
    let idx = indexCache.get(href)
    if (!idx) {
      idx = buildOffsetIndex(root)
      indexCache.set(href, idx)
    }
    hrefChunks.sort((a, b) => a.textStart - b.textStart)
    for (let i = 0; i < hrefChunks.length; i++) {
      const chunk = hrefChunks[i]
      const range = rangeForOffsets(idx, chunk.textStart, chunk.textEnd)
      if (range) {
        altRanges[i % 2].push(range)
        applied++
      }
    }
  }

  for (const sel of selectedChunks) {
    const root = rootsByHref.get(sel.spineHref)
    if (!root) continue
    let idx = indexCache.get(sel.spineHref)
    if (!idx) {
      idx = buildOffsetIndex(root)
      indexCache.set(sel.spineHref, idx)
    }
    const range = rangeForOffsets(idx, sel.textStart, sel.textEnd)
    if (range) selectedRanges.push(range)
  }

  if (altRanges[0].length > 0) {
    const h = new Highlight(...altRanges[0])
    h.priority = 0
    host.set('chunk-a', h)
  }
  if (altRanges[1].length > 0) {
    const h = new Highlight(...altRanges[1])
    h.priority = 0
    host.set('chunk-b', h)
  }
  if (selectedRanges.length > 0) {
    const h = new Highlight(...selectedRanges)
    h.priority = 10
    host.set('chunk-selected', h)
  }

  return { applied, missingSpines }
}

export function clearChunkOverlay(): void {
  const host = highlightsHost()
  if (!host) return
  for (const name of HIGHLIGHT_NAMES) host.delete(name)
}
