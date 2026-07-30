import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { configureLibraryDir } from '../main/library'
import { loadCanonicalBookDocument } from '../main/canonicalStore'
import { contentHash } from '../shared/artifactIdentity'
import { parseCorpusManifest, type CorpusManifest } from '../shared/corpusSchema'
import type { EvidenceCandidate, EvidenceReviewPacket } from '../shared/authoringSchema'
import type {
  CanonicalBookDocument,
  CanonicalDocumentNode,
  CanonicalNodeKind
} from '../shared/canonicalDocument'

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length === 0 || count <= 0) return []
  const selected: T[] = []
  const size = Math.min(items.length, count)
  for (let index = 0; index < size; index++) {
    selected.push(items[Math.floor(((index + 0.5) * items.length) / size)])
  }
  return selected
}

export function isLikelyCorpusBoilerplate(text: string): boolean {
  return [
    /project\s+gutenberg/i,
    /\belectronic works?\b/i,
    /\brefund\b/i,
    /\bwarrant(?:y|ies)\b/i,
    /\btrademark\b/i,
    /\bterms of this agreement\b/i,
    /\bwww\.gutenberg\.org\b/i,
    /\bdonation(?:s)?\b.*\bfoundation\b/i,
    /\bcopyright laws?\b/i
  ].some((pattern) => pattern.test(text))
}

function isUsefulText(node: CanonicalDocumentNode): boolean {
  if (node.text.length < 120) return false
  if (
    isLikelyCorpusBoilerplate(node.text) ||
    /\*\*\*\s*(?:start|end)\s+of\s+the/i.test(node.text)
  ) {
    return false
  }
  const letters = (node.text.match(/\p{L}/gu) ?? []).length
  const words = node.text.match(/[\p{L}\p{N}]+/gu) ?? []
  return letters / node.text.length >= 0.55 && words.length >= 20
}

function hasUsefulImageMetadata(node: CanonicalDocumentNode): boolean {
  return (
    node.kind === 'image' &&
    Boolean(node.image?.alt?.trim() || node.image?.caption?.trim() || node.text.trim())
  )
}

function allNodes(document: CanonicalBookDocument): CanonicalDocumentNode[] {
  return document.spine.flatMap((spine) => spine.nodes)
}

function candidateFromNode(
  document: CanonicalBookDocument,
  node: CanonicalDocumentNode
): EvidenceCandidate {
  const metadata = [node.image?.alt, node.image?.caption, node.table?.caption]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' — ')
  const excerpt = (node.text.trim() || metadata).slice(0, 1200)
  return {
    id: `candidate-${contentHash({
      sourceHash: document.sourceHash,
      nodeId: node.id
    }).slice(0, 20)}`,
    bookId: document.bookId,
    sourceHash: document.sourceHash,
    nodeId: node.id,
    kind: node.kind,
    spineHref: node.spineHref,
    textStart: node.textStart,
    textEnd: node.textEnd,
    headingPath: node.headingPath.map((heading) => heading.text),
    excerpt,
    assets: node.source.assets.map((asset) => asset.resolvedHref),
    reviewStatus: 'pending'
  }
}

export function sampleEvidenceCandidates(
  document: CanonicalBookDocument,
  count: number
): EvidenceCandidate[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Candidate count must be a positive integer')
  }
  const nodes = allNodes(document)
  const selected = new Map<string, CanonicalDocumentNode>()
  const quotas: Array<[CanonicalNodeKind, number]> = [
    ['table', 2],
    ['image', 2],
    ['footnote', 2],
    ['blockquote', 2],
    ['list', 2]
  ]

  for (const [kind, quota] of quotas) {
    const eligible = nodes.filter((node) =>
      kind === 'image'
        ? hasUsefulImageMetadata(node)
        : node.kind === kind && (kind === 'table' || isUsefulText(node))
    )
    for (const node of sampleEvenly(eligible, Math.min(quota, count - selected.size))) {
      selected.set(node.id, node)
    }
    if (selected.size >= count) break
  }

  const prose = nodes.filter(
    (node) => (node.kind === 'paragraph' || node.kind === 'other') && isUsefulText(node)
  )
  for (const node of sampleEvenly(prose, count - selected.size)) selected.set(node.id, node)

  if (selected.size < count) {
    const remaining = nodes.filter(
      (node) =>
        !selected.has(node.id) &&
        (isUsefulText(node) || node.kind === 'table' || hasUsefulImageMetadata(node))
    )
    for (const node of sampleEvenly(remaining, count - selected.size)) selected.set(node.id, node)
  }

  return [...selected.values()]
    .sort((left, right) => {
      const leftSpine = document.spine.findIndex((spine) => spine.href === left.spineHref)
      const rightSpine = document.spine.findIndex((spine) => spine.href === right.spineHref)
      return leftSpine - rightSpine || left.ordinal - right.ordinal
    })
    .map((node) => candidateFromNode(document, node))
}

function resolveFrom(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path)
}

export async function createEvidenceReviewPacket(
  corpusPath: string,
  outputPath: string,
  candidatesPerBook: number,
  libraryDir?: string
): Promise<string> {
  const absoluteCorpusPath = resolve(corpusPath)
  const corpusDir = dirname(absoluteCorpusPath)
  const corpus = parseCorpusManifest(
    JSON.parse(await fs.readFile(absoluteCorpusPath, 'utf8')) as unknown
  )
  const configuredLibraryDir = libraryDir ?? process.env.BOOK_RAG_EVAL_LIBRARY_DIR
  if (!configuredLibraryDir) {
    throw new Error('Set --library-dir or BOOK_RAG_EVAL_LIBRARY_DIR')
  }
  configureLibraryDir(resolveFrom(corpusDir, configuredLibraryDir))

  const candidates: EvidenceCandidate[] = []
  const bookSummaries: EvidenceReviewPacket['books'] = []
  const sourceBooks: Array<{ manifest: CorpusManifest['books'][number]; sourceHash: string }> = []
  for (const book of corpus.books) {
    const document = await loadCanonicalBookDocument(book.bookId)
    const selected = sampleEvidenceCandidates(document, candidatesPerBook)
    candidates.push(...selected)
    const availableKinds: Partial<Record<CanonicalNodeKind, number>> = {}
    for (const node of allNodes(document)) {
      availableKinds[node.kind] = (availableKinds[node.kind] ?? 0) + 1
    }
    bookSummaries.push({
      ...book,
      sourceHash: document.sourceHash,
      selectedCandidates: selected.length,
      availableKinds
    })
    sourceBooks.push({ manifest: book, sourceHash: document.sourceHash })
  }

  const packet: EvidenceReviewPacket = {
    schemaVersion: 1,
    corpusId: corpus.id,
    corpusFingerprint: contentHash({
      schemaVersion: corpus.schemaVersion,
      id: corpus.id,
      books: sourceBooks
    }),
    candidatesPerBook,
    books: bookSummaries,
    candidates
  }
  const absoluteOutputPath = resolve(outputPath)
  await fs.mkdir(dirname(absoluteOutputPath), { recursive: true })
  await fs.writeFile(absoluteOutputPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8')
  return absoluteOutputPath
}
