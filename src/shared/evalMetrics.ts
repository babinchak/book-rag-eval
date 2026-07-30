import type { GoldEvidence } from './evalSchema'

export interface RankedEvidenceCandidate {
  id: string
  bookId: string
  spineHref: string
  textStart: number
  textEnd: number
  canonicalNodeIds: string[]
  tokenCount: number
}

export interface CandidateRelevance {
  candidateId: string
  relevant: boolean
  overlapChars: number
  matchedRequirementIds: string[]
}

export interface RetrievalMetrics {
  hitAtK: number | null
  mrr: number | null
  ndcgAtK: number | null
  evidenceRecall: number | null
  fullEvidenceSuccess: number | null
  contextPrecision: number | null
  goldSpanCoverage: number | null
  tokensBeforeFirstEvidence: number | null
  correctBookRecall: number | null
  firstHitRank: number | null
  candidateRelevance: CandidateRelevance[]
}

export interface RetrievalMetricOptions {
  textHitOverlapRatio?: number
}

interface EvidenceMatch {
  matched: boolean
  overlapChars: number
  coverage: number
}

function matchEvidence(
  candidate: RankedEvidenceCandidate,
  evidence: GoldEvidence,
  textHitOverlapRatio: number
): EvidenceMatch {
  if (candidate.bookId !== evidence.bookId || candidate.spineHref !== evidence.spineHref) {
    return { matched: false, overlapChars: 0, coverage: 0 }
  }
  if (evidence.kind !== 'text') {
    const matched = candidate.canonicalNodeIds.includes(evidence.nodeId)
    return { matched, overlapChars: 0, coverage: matched ? 1 : 0 }
  }
  const overlap = Math.max(
    0,
    Math.min(candidate.textEnd, evidence.textEnd!) -
      Math.max(candidate.textStart, evidence.textStart!)
  )
  const length = evidence.textEnd! - evidence.textStart!
  const coverage = length > 0 ? Math.min(1, overlap / length) : 0
  return { matched: coverage >= textHitOverlapRatio, overlapChars: overlap, coverage }
}

function discount(rank: number): number {
  return 1 / Math.log2(rank + 1)
}

export function computeRetrievalMetrics(
  candidates: RankedEvidenceCandidate[],
  evidence: GoldEvidence[],
  options: RetrievalMetricOptions = {}
): RetrievalMetrics {
  if (evidence.length === 0) {
    return {
      hitAtK: null,
      mrr: null,
      ndcgAtK: null,
      evidenceRecall: null,
      fullEvidenceSuccess: null,
      contextPrecision: null,
      goldSpanCoverage: null,
      tokensBeforeFirstEvidence: null,
      correctBookRecall: null,
      firstHitRank: null,
      candidateRelevance: candidates.map((candidate) => ({
        candidateId: candidate.id,
        relevant: false,
        overlapChars: 0,
        matchedRequirementIds: []
      }))
    }
  }

  const threshold = options.textHitOverlapRatio ?? 0.3
  const byRequirement = new Map<string, GoldEvidence[]>()
  for (const item of evidence) {
    const group = byRequirement.get(item.requirementId) ?? []
    group.push(item)
    byRequirement.set(item.requirementId, group)
  }

  const relevance = candidates.map((candidate) => {
    const matchedRequirementIds: string[] = []
    let overlapChars = 0
    for (const [requirementId, alternatives] of byRequirement) {
      const matches = alternatives.map((item) => matchEvidence(candidate, item, threshold))
      if (matches.some((match) => match.matched)) matchedRequirementIds.push(requirementId)
      overlapChars += Math.max(0, ...matches.map((match) => match.overlapChars))
    }
    return {
      candidateId: candidate.id,
      relevant: matchedRequirementIds.length > 0,
      overlapChars,
      matchedRequirementIds
    }
  })

  const firstHitIndex = relevance.findIndex((item) => item.relevant)
  const firstHitRank = firstHitIndex >= 0 ? firstHitIndex + 1 : null
  const satisfied = new Set(relevance.flatMap((item) => item.matchedRequirementIds))
  const requirementCount = byRequirement.size

  const coverageByRequirement: number[] = []
  for (const alternatives of byRequirement.values()) {
    let bestAlternativeCoverage = 0
    for (const alternative of alternatives) {
      const intervals = candidates
        .map((candidate) => {
          if (
            alternative.kind !== 'text' ||
            candidate.bookId !== alternative.bookId ||
            candidate.spineHref !== alternative.spineHref
          ) {
            return null
          }
          const start = Math.max(candidate.textStart, alternative.textStart!)
          const end = Math.min(candidate.textEnd, alternative.textEnd!)
          return end > start ? ([start, end] as const) : null
        })
        .filter((interval): interval is readonly [number, number] => interval !== null)
        .sort((a, b) => a[0] - b[0])
      let covered = 0
      let cursor = -1
      for (const [start, end] of intervals) {
        const uncoveredStart = Math.max(start, cursor)
        if (end > uncoveredStart) covered += end - uncoveredStart
        cursor = Math.max(cursor, end)
      }
      const alternativeCoverage =
        alternative.kind === 'text'
          ? Math.min(1, covered / (alternative.textEnd! - alternative.textStart!))
          : candidates.some((candidate) => matchEvidence(candidate, alternative, threshold).matched)
            ? 1
            : 0
      bestAlternativeCoverage = Math.max(bestAlternativeCoverage, alternativeCoverage)
    }
    coverageByRequirement.push(bestAlternativeCoverage)
  }

  const gainedRequirements = new Set<string>()
  let dcg = 0
  for (const [index, item] of relevance.entries()) {
    const newRequirements = item.matchedRequirementIds.filter(
      (requirementId) => !gainedRequirements.has(requirementId)
    )
    if (newRequirements.length > 0) {
      dcg += newRequirements.length * discount(index + 1)
      newRequirements.forEach((requirementId) => gainedRequirements.add(requirementId))
    }
  }
  let idealDcg = 0
  for (let rank = 1; rank <= Math.min(requirementCount, candidates.length); rank++) {
    idealDcg += discount(rank)
  }

  const totalTokens = candidates.reduce((sum, candidate) => sum + candidate.tokenCount, 0)
  const relevantTokens = candidates.reduce(
    (sum, candidate, index) => sum + (relevance[index].relevant ? candidate.tokenCount : 0),
    0
  )
  const tokensBeforeFirstEvidence =
    firstHitIndex < 0
      ? totalTokens
      : candidates.slice(0, firstHitIndex).reduce((sum, candidate) => sum + candidate.tokenCount, 0)

  const requiredBooks = new Set(evidence.map((item) => item.bookId))
  const retrievedBooks = new Set(candidates.map((candidate) => candidate.bookId))
  const foundBooks = [...requiredBooks].filter((bookId) => retrievedBooks.has(bookId)).length

  return {
    hitAtK: firstHitRank === null ? 0 : 1,
    mrr: firstHitRank === null ? 0 : 1 / firstHitRank,
    ndcgAtK: idealDcg === 0 ? 0 : dcg / idealDcg,
    evidenceRecall: satisfied.size / requirementCount,
    fullEvidenceSuccess: satisfied.size === requirementCount ? 1 : 0,
    contextPrecision: totalTokens === 0 ? 0 : relevantTokens / totalTokens,
    goldSpanCoverage:
      coverageByRequirement.reduce((sum, coverage) => sum + coverage, 0) / requirementCount,
    tokensBeforeFirstEvidence,
    correctBookRecall: foundBooks / requiredBooks.size,
    firstHitRank,
    candidateRelevance: relevance
  }
}

export interface ContextCandidate extends RankedEvidenceCandidate {
  text: string
}

export interface AssembledContextItem {
  candidate: ContextCandidate
  text: string
  tokenCount: number
}

export interface AssembledContext {
  items: AssembledContextItem[]
  totalTokens: number
  skippedDuplicateIds: string[]
  skippedOverBudgetIds: string[]
}

function uncoveredRanges(
  start: number,
  end: number,
  covered: ReadonlyArray<readonly [number, number]>
): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  let cursor = start
  for (const [coveredStart, coveredEnd] of covered) {
    if (coveredEnd <= cursor || coveredStart >= end) continue
    if (coveredStart > cursor) ranges.push([cursor, Math.min(coveredStart, end)])
    cursor = Math.max(cursor, coveredEnd)
    if (cursor >= end) break
  }
  if (cursor < end) ranges.push([cursor, end])
  return ranges
}

export function assembleContextBudget(
  candidates: ContextCandidate[],
  maxTokens: number,
  countTokens: (text: string) => number
): AssembledContext {
  if (!Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new Error('Context token budget must be a non-negative integer')
  }

  const items: AssembledContextItem[] = []
  const seenIds = new Set<string>()
  const coveredBySource = new Map<string, Array<readonly [number, number]>>()
  const skippedDuplicateIds: string[] = []
  const skippedOverBudgetIds: string[] = []
  let totalTokens = 0

  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) {
      skippedDuplicateIds.push(candidate.id)
      continue
    }
    seenIds.add(candidate.id)

    const sourceKey = `${candidate.bookId}\0${candidate.spineHref}`
    const covered = coveredBySource.get(sourceKey) ?? []
    const ranges = uncoveredRanges(candidate.textStart, candidate.textEnd, covered)
    if (ranges.length === 0) {
      skippedDuplicateIds.push(candidate.id)
      continue
    }
    const text = ranges
      .map(([start, end]) =>
        candidate.text.slice(start - candidate.textStart, end - candidate.textStart)
      )
      .join('\n')
    const tokenCount = countTokens(text)
    if (totalTokens + tokenCount > maxTokens) {
      skippedOverBudgetIds.push(candidate.id)
      continue
    }

    items.push({ candidate, text, tokenCount })
    totalTokens += tokenCount
    covered.push([candidate.textStart, candidate.textEnd])
    covered.sort((a, b) => a[0] - b[0])
    coveredBySource.set(sourceKey, covered)
  }

  return { items, totalTokens, skippedDuplicateIds, skippedOverBudgetIds }
}
