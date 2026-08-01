import type { GoldEvidence } from './evalSchema'

export const RETRIEVAL_METRIC_VERSION = 2

export interface RankedEvidenceCandidate {
  id: string
  bookId: string
  spineHref: string
  textStart: number
  textEnd: number
  canonicalNodeIds: string[]
  tokenCount: number
  /** Canonical source ranges actually present after context overlap deduplication. */
  sourceRanges?: Array<readonly [number, number]>
  /** Payload segments in the exact order presented to the downstream reader. */
  payloadSegments?: Array<{
    textStart: number
    textEnd: number
    text: string
  }>
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
  exactEvidenceDensity: number | null
  goldSpanCoverage: number | null
  tokensBeforeFirstEvidence: number | null
  tokensToFirstEvidence: number | null
  tokensToFullEvidence: number | null
  evidenceEfficiency: number | null
  payloadEvidenceEfficiency: number | null
  correctBookRecall: number | null
  firstHitRank: number | null
  candidateRelevance: CandidateRelevance[]
}

export interface RetrievalMetricOptions {
  textHitOverlapRatio?: number
  contextBudgetTokens?: number
  countTokens?: (text: string) => number
}

interface EvidenceMatch {
  matched: boolean
  overlapChars: number
  coverage: number
}

function sourceRanges(candidate: RankedEvidenceCandidate): Array<readonly [number, number]> {
  return candidate.sourceRanges ?? [[candidate.textStart, candidate.textEnd]]
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
  const overlap = sourceRanges(candidate).reduce(
    (total, [start, end]) =>
      total + Math.max(0, Math.min(end, evidence.textEnd!) - Math.max(start, evidence.textStart!)),
    0
  )
  const length = evidence.textEnd! - evidence.textStart!
  const coverage = length > 0 ? Math.min(1, overlap / length) : 0
  return { matched: coverage >= textHitOverlapRatio, overlapChars: overlap, coverage }
}

function mergeIntervals(
  intervals: Array<readonly [number, number]>
): Array<readonly [number, number]> {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])
  const merged: Array<readonly [number, number]> = []
  for (const interval of sorted) {
    const last = merged.at(-1)
    if (!last || interval[0] > last[1]) {
      merged.push(interval)
    } else {
      merged[merged.length - 1] = [last[0], Math.max(last[1], interval[1])]
    }
  }
  return merged
}

function proportionalTokens(candidate: RankedEvidenceCandidate, sourceChars: number): number {
  const length = Math.max(1, candidate.textEnd - candidate.textStart)
  return Math.min(candidate.tokenCount, Math.max(0, (sourceChars / length) * candidate.tokenCount))
}

function tokensThroughEvidence(
  candidate: RankedEvidenceCandidate,
  evidence: GoldEvidence,
  threshold: number,
  countTokens?: (text: string) => number
): number {
  if (evidence.kind !== 'text') return candidate.tokenCount
  const requiredChars = (evidence.textEnd! - evidence.textStart!) * threshold
  let coveredChars = 0
  let priorTokens = 0
  if (candidate.payloadSegments && countTokens) {
    for (const segment of candidate.payloadSegments) {
      const overlapStart = Math.max(segment.textStart, evidence.textStart!)
      const overlapEnd = Math.min(segment.textEnd, evidence.textEnd!)
      if (overlapEnd <= overlapStart) {
        priorTokens += countTokens(segment.text)
        continue
      }
      const remainingChars = requiredChars - coveredChars
      const availableChars = overlapEnd - overlapStart
      if (availableChars >= remainingChars) {
        const evidencePoint = overlapStart + remainingChars
        const prefixEnd = Math.max(0, evidencePoint - segment.textStart)
        return Math.min(
          candidate.tokenCount,
          priorTokens + countTokens(segment.text.slice(0, prefixEnd))
        )
      }
      coveredChars += availableChars
      priorTokens += countTokens(segment.text)
    }
  }
  const firstOverlap = sourceRanges(candidate)
    .map(
      ([start, end]) =>
        [Math.max(start, evidence.textStart!), Math.min(end, evidence.textEnd!)] as const
    )
    .find(([start, end]) => end > start)
  if (!firstOverlap) return candidate.tokenCount
  return proportionalTokens(candidate, firstOverlap[0] - candidate.textStart + requiredChars)
}

function exactRelevantTokens(
  candidate: RankedEvidenceCandidate,
  evidence: GoldEvidence[],
  countTokens?: (text: string) => number
): number {
  if (
    evidence.some(
      (item) => item.kind !== 'text' && candidate.canonicalNodeIds.includes(item.nodeId)
    )
  ) {
    return candidate.tokenCount
  }
  const textEvidence = evidence.filter(
    (item): item is GoldEvidence & { textStart: number; textEnd: number } =>
      item.kind === 'text' &&
      item.bookId === candidate.bookId &&
      item.spineHref === candidate.spineHref
  )
  if (textEvidence.length === 0) return 0

  if (candidate.payloadSegments && countTokens) {
    let tokens = 0
    for (const segment of candidate.payloadSegments) {
      const intervals = mergeIntervals(
        textEvidence.map((item) => [
          Math.max(segment.textStart, item.textStart),
          Math.min(segment.textEnd, item.textEnd)
        ])
      )
      for (const [start, end] of intervals) {
        tokens += countTokens(
          segment.text.slice(start - segment.textStart, end - segment.textStart)
        )
      }
    }
    return Math.min(candidate.tokenCount, tokens)
  }

  const intervals = mergeIntervals(
    sourceRanges(candidate).flatMap(([candidateStart, candidateEnd]) =>
      textEvidence.map(
        (item) =>
          [Math.max(candidateStart, item.textStart), Math.min(candidateEnd, item.textEnd)] as const
      )
    )
  )
  return proportionalTokens(
    candidate,
    intervals.reduce((total, [start, end]) => total + end - start, 0)
  )
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
      exactEvidenceDensity: null,
      goldSpanCoverage: null,
      tokensBeforeFirstEvidence: null,
      tokensToFirstEvidence: null,
      tokensToFullEvidence: null,
      evidenceEfficiency: null,
      payloadEvidenceEfficiency: null,
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
        .flatMap((candidate) => {
          if (
            alternative.kind !== 'text' ||
            candidate.bookId !== alternative.bookId ||
            candidate.spineHref !== alternative.spineHref
          ) {
            return []
          }
          return sourceRanges(candidate).map(([candidateStart, candidateEnd]) => {
            const start = Math.max(candidateStart, alternative.textStart!)
            const end = Math.min(candidateEnd, alternative.textEnd!)
            return end > start ? ([start, end] as const) : null
          })
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

  const budget = options.contextBudgetTokens ?? Math.max(1, totalTokens)
  const requirementFirstEvidenceTokens = new Map<string, number>()
  const requirementPayloadTokens = new Map<string, number>()
  let cumulativeTokens = 0
  candidates.forEach((candidate, index) => {
    const item = relevance[index]
    for (const requirementId of item.matchedRequirementIds) {
      const alternatives = byRequirement.get(requirementId) ?? []
      if (!requirementFirstEvidenceTokens.has(requirementId)) {
        const withinCandidate = Math.min(
          ...alternatives
            .filter((alternative) => matchEvidence(candidate, alternative, threshold).matched)
            .map((alternative) =>
              tokensThroughEvidence(candidate, alternative, threshold, options.countTokens)
            )
        )
        requirementFirstEvidenceTokens.set(
          requirementId,
          Math.min(budget, cumulativeTokens + withinCandidate)
        )
        requirementPayloadTokens.set(
          requirementId,
          Math.min(budget, cumulativeTokens + candidate.tokenCount)
        )
      }
    }
    cumulativeTokens += candidate.tokenCount
  })
  const efficiencyFor = (positions: Map<string, number>): number =>
    [...byRequirement.keys()].reduce(
      (total, requirementId) =>
        total + Math.max(0, 1 - (positions.get(requirementId) ?? budget) / budget),
      0
    ) / requirementCount
  const tokensToFirstEvidence =
    requirementFirstEvidenceTokens.size === 0
      ? budget
      : Math.min(...requirementFirstEvidenceTokens.values())
  const tokensToFullEvidence =
    requirementFirstEvidenceTokens.size < requirementCount
      ? budget
      : Math.max(...requirementFirstEvidenceTokens.values())
  const exactTokens = candidates.reduce(
    (total, candidate) => total + exactRelevantTokens(candidate, evidence, options.countTokens),
    0
  )

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
    exactEvidenceDensity: totalTokens === 0 ? 0 : Math.min(1, exactTokens / totalTokens),
    goldSpanCoverage:
      coverageByRequirement.reduce((sum, coverage) => sum + coverage, 0) / requirementCount,
    tokensBeforeFirstEvidence,
    tokensToFirstEvidence,
    tokensToFullEvidence,
    evidenceEfficiency: efficiencyFor(requirementFirstEvidenceTokens),
    payloadEvidenceEfficiency: efficiencyFor(requirementPayloadTokens),
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
  sourceRanges: Array<readonly [number, number]>
  payloadSegments: Array<{ textStart: number; textEnd: number; text: string }>
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
    const payloadSegments = ranges.map(([start, end]) => ({
      textStart: start,
      textEnd: end,
      text: candidate.text.slice(start - candidate.textStart, end - candidate.textStart)
    }))
    const text = payloadSegments.map((segment) => segment.text).join('\n')
    const tokenCount = countTokens(text)
    if (totalTokens + tokenCount > maxTokens) {
      skippedOverBudgetIds.push(candidate.id)
      continue
    }

    items.push({ candidate, text, tokenCount, sourceRanges: ranges, payloadSegments })
    totalTokens += tokenCount
    covered.push([candidate.textStart, candidate.textEnd])
    covered.sort((a, b) => a[0] - b[0])
    coveredBySource.set(sourceKey, covered)
  }

  return { items, totalTokens, skippedDuplicateIds, skippedOverBudgetIds }
}
