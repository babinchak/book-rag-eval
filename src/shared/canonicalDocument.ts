import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'

export const CANONICAL_DOCUMENT_SCHEMA_VERSION = 1
export const CANONICAL_PARSER_VERSION = 'canonical-xhtml-v1'

export type CanonicalNodeKind =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'list'
  | 'table'
  | 'image'
  | 'footnote'
  | 'other'

export interface CanonicalHeading {
  nodeId: string
  level: number
  text: string
}

export interface CanonicalAssetReference {
  kind: 'image'
  rawHref: string
  resolvedHref: string
}

export interface CanonicalTableData {
  caption: string | null
  rows: string[][]
}

export interface CanonicalImageData {
  alt: string | null
  caption: string | null
}

export interface CanonicalNodeSource {
  tagName: string
  domPath: string
  elementId: string | null
  epubType: string | null
  role: string | null
  assets: CanonicalAssetReference[]
}

export interface CanonicalDocumentNode {
  id: string
  kind: CanonicalNodeKind
  spineHref: string
  ordinal: number
  textStart: number
  textEnd: number
  text: string
  headingPath: CanonicalHeading[]
  previousNodeId: string | null
  nextNodeId: string | null
  source: CanonicalNodeSource
  table?: CanonicalTableData
  image?: CanonicalImageData
}

export interface CanonicalSpineDocument {
  href: string
  spineIndex: number
  text: string
  nodes: CanonicalDocumentNode[]
}

export interface CanonicalBookDocument {
  schemaVersion: typeof CANONICAL_DOCUMENT_SCHEMA_VERSION
  parserVersion: typeof CANONICAL_PARSER_VERSION
  bookId: string
  sourceHash: string
  spine: CanonicalSpineDocument[]
}

export interface CanonicalSpineSource {
  href: string
  rawHtml: string
}

type Element = DefaultTreeAdapterTypes.Element
type Node = DefaultTreeAdapterTypes.Node

const SKIPPED_TAGS = new Set(['head', 'script', 'style', 'template', 'noscript'])
const FALLBACK_BLOCK_TAGS = new Set([
  'article',
  'aside',
  'dd',
  'div',
  'dt',
  'figcaption',
  'main',
  'pre',
  'section'
])
const PRIMARY_TAGS = new Set([
  'blockquote',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'img',
  'li',
  'p',
  'table'
])

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function attr(element: Element, ...names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const found = element.attrs.find((item) => {
    const fullName = item.prefix ? `${item.prefix}:${item.name}` : item.name
    return wanted.has(fullName.toLowerCase()) || wanted.has(item.name.toLowerCase())
  })
  return found?.value ?? null
}

function normalizedText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function textContent(node: Node): string {
  if ('value' in node) return node.value
  if (!('childNodes' in node)) return ''
  if (isElement(node) && SKIPPED_TAGS.has(node.tagName)) return ''
  return node.childNodes.map(textContent).join('')
}

function descendants(element: Element, predicate: (candidate: Element) => boolean): Element[] {
  const found: Element[] = []
  const visit = (node: Node): void => {
    if (!('childNodes' in node)) return
    for (const child of node.childNodes) {
      if (!isElement(child)) continue
      if (predicate(child)) found.push(child)
      visit(child)
    }
  }
  visit(element)
  return found
}

function containsPrimaryDescendant(element: Element): boolean {
  return (
    descendants(
      element,
      (candidate) => PRIMARY_TAGS.has(candidate.tagName) || isFootnote(candidate)
    ).length > 0
  )
}

function isFootnote(element: Element): boolean {
  const epubType = attr(element, 'epub:type', 'type')?.toLowerCase() ?? ''
  const role = attr(element, 'role')?.toLowerCase() ?? ''
  return (
    /\b(?:footnote|endnote|rearnote|note)\b/.test(epubType) ||
    role === 'doc-footnote' ||
    role === 'doc-endnote'
  )
}

function resolveAssetHref(spineHref: string, rawHref: string): string {
  if (/^(?:data:|https?:|urn:)/i.test(rawHref)) return rawHref
  const [pathPart, suffix = ''] = rawHref.split(/(?=[?#])/u, 2)
  const baseDir = posix.dirname(spineHref.startsWith('/') ? spineHref.slice(1) : spineHref)
  const resolved = posix.normalize(posix.join(baseDir === '.' ? '' : baseDir, pathPart))
  return `${resolved}${suffix}`
}

function imageElements(element: Element): Element[] {
  const own = element.tagName === 'img' || element.tagName === 'image' ? [element] : []
  return [
    ...own,
    ...descendants(
      element,
      (candidate) => candidate.tagName === 'img' || candidate.tagName === 'image'
    )
  ]
}

function assetReferences(element: Element, spineHref: string): CanonicalAssetReference[] {
  const refs: CanonicalAssetReference[] = []
  const seen = new Set<string>()
  for (const image of imageElements(element)) {
    const rawHref = attr(image, 'src', 'href', 'xlink:href')
    if (!rawHref) continue
    const resolvedHref = resolveAssetHref(spineHref, rawHref)
    const key = `${rawHref}\0${resolvedHref}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ kind: 'image', rawHref, resolvedHref })
  }
  return refs
}

function firstDescendant(element: Element, tagName: string): Element | null {
  return descendants(element, (candidate) => candidate.tagName === tagName)[0] ?? null
}

function imageData(element: Element): CanonicalImageData {
  const image = imageElements(element)[0] ?? null
  const captionElement =
    element.tagName === 'figure' ? firstDescendant(element, 'figcaption') : null
  const alt = image ? normalizedText(attr(image, 'alt', 'title') ?? '') || null : null
  const caption = captionElement ? normalizedText(textContent(captionElement)) || null : null
  return { alt, caption }
}

function tableData(element: Element): CanonicalTableData {
  const captionElement = firstDescendant(element, 'caption')
  const rows = descendants(element, (candidate) => candidate.tagName === 'tr').map((row) =>
    descendants(row, (candidate) => candidate.tagName === 'th' || candidate.tagName === 'td').map(
      (cell) => normalizedText(textContent(cell))
    )
  )
  return {
    caption: captionElement ? normalizedText(textContent(captionElement)) || null : null,
    rows
  }
}

function tableText(data: CanonicalTableData): string {
  const lines = data.rows.filter((row) => row.length > 0).map((row) => row.join(' | '))
  return [data.caption, ...lines].filter((line): line is string => Boolean(line)).join('\n')
}

function nodeId(bookId: string, spineHref: string, domPath: string): string {
  const digest = createHash('sha256')
    .update(`${bookId}\0${spineHref}\0${domPath}`)
    .digest('hex')
    .slice(0, 20)
  return `node_${digest}`
}

function classify(element: Element): CanonicalNodeKind | null {
  if (isFootnote(element)) return 'footnote'
  if (/^h[1-6]$/.test(element.tagName)) return 'heading'
  if (element.tagName === 'table') return 'table'
  if (element.tagName === 'figure' || element.tagName === 'img' || element.tagName === 'image') {
    return 'image'
  }
  if (element.tagName === 'blockquote') return 'blockquote'
  if (element.tagName === 'li') return 'list'
  if (element.tagName === 'p') return 'paragraph'
  if (
    FALLBACK_BLOCK_TAGS.has(element.tagName) &&
    normalizedText(textContent(element)) &&
    !containsPrimaryDescendant(element)
  ) {
    return 'other'
  }
  return null
}

export function canonicalSourceHashOf(spine: CanonicalSpineSource[]): string {
  const hash = createHash('sha256')
  for (const item of spine) hash.update(item.href).update('\0').update(item.rawHtml).update('\0')
  return hash.digest('hex')
}

export function buildCanonicalSpineDocument(
  bookId: string,
  spineIndex: number,
  source: CanonicalSpineSource
): CanonicalSpineDocument {
  const document = parse(source.rawHtml)
  const nodes: CanonicalDocumentNode[] = []
  const textParts: string[] = []
  const headings: Array<CanonicalHeading | undefined> = new Array(6)
  let textLength = 0

  const addNode = (
    element: Element,
    domPath: string,
    kind: CanonicalNodeKind,
    suppliedText?: string,
    suppliedTable?: CanonicalTableData,
    suppliedImage?: CanonicalImageData
  ): void => {
    const id = nodeId(bookId, source.href, domPath)
    const text =
      suppliedText ??
      (kind === 'image'
        ? [suppliedImage?.caption, suppliedImage?.alt]
            .filter((value): value is string => Boolean(value))
            .join(' — ')
        : normalizedText(textContent(element)))

    let headingPath = headings.filter((heading): heading is CanonicalHeading => Boolean(heading))
    if (kind === 'heading') {
      const level = Number(element.tagName.slice(1))
      headings[level - 1] = { nodeId: id, level, text }
      headings.fill(undefined, level)
      headingPath = headings.filter((heading): heading is CanonicalHeading => Boolean(heading))
    }

    if (text.length > 0 && textLength > 0) {
      textParts.push('\n\n')
      textLength += 2
    }
    const textStart = textLength
    textParts.push(text)
    textLength += text.length

    nodes.push({
      id,
      kind,
      spineHref: source.href,
      ordinal: nodes.length,
      textStart,
      textEnd: textLength,
      text,
      headingPath: headingPath.map((heading) => ({ ...heading })),
      previousNodeId: null,
      nextNodeId: null,
      source: {
        tagName: element.tagName,
        domPath,
        elementId: attr(element, 'id'),
        epubType: attr(element, 'epub:type', 'type'),
        role: attr(element, 'role'),
        assets: assetReferences(element, source.href)
      },
      ...(suppliedTable ? { table: suppliedTable } : {}),
      ...(suppliedImage ? { image: suppliedImage } : {})
    })
  }

  const visit = (element: Element, domPath: string): void => {
    if (SKIPPED_TAGS.has(element.tagName)) return
    const kind = classify(element)
    if (kind) {
      if (kind === 'table') {
        const data = tableData(element)
        addNode(element, domPath, kind, tableText(data), data)
      } else if (kind === 'image') {
        const data = imageData(element)
        addNode(element, domPath, kind, undefined, undefined, data)
      } else {
        addNode(element, domPath, kind)
      }

      if (kind !== 'image') {
        imageElements(element).forEach((image, index) => {
          const data = imageData(image)
          addNode(
            image,
            `${domPath}/embedded-image[${index + 1}]`,
            'image',
            undefined,
            undefined,
            data
          )
        })
      }
      return
    }

    const tagCounts = new Map<string, number>()
    for (const child of element.childNodes) {
      if (!isElement(child)) continue
      const count = (tagCounts.get(child.tagName) ?? 0) + 1
      tagCounts.set(child.tagName, count)
      visit(child, `${domPath}/${child.tagName}[${count}]`)
    }
  }

  const roots = document.childNodes.filter(isElement)
  roots.forEach((root, index) => visit(root, `/${root.tagName}[${index + 1}]`))

  for (let index = 0; index < nodes.length; index++) {
    nodes[index].previousNodeId = nodes[index - 1]?.id ?? null
    nodes[index].nextNodeId = nodes[index + 1]?.id ?? null
  }

  return {
    href: source.href,
    spineIndex,
    text: textParts.join(''),
    nodes
  }
}

export function buildCanonicalBookDocument(
  bookId: string,
  spine: CanonicalSpineSource[]
): CanonicalBookDocument {
  return {
    schemaVersion: CANONICAL_DOCUMENT_SCHEMA_VERSION,
    parserVersion: CANONICAL_PARSER_VERSION,
    bookId,
    sourceHash: canonicalSourceHashOf(spine),
    spine: spine.map((item, index) => buildCanonicalSpineDocument(bookId, index, item))
  }
}
