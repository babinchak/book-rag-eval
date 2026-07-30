import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { parse as parseYaml } from 'yaml'
import { getOpenaiKey } from '../main/settings'
import { countChunkTokens } from '../main/tokenChunking'
import { contentHash } from '../shared/artifactIdentity'
import {
  EVAL_DRAFT_RUN_SCHEMA_VERSION,
  generatedEvalDraftSchema,
  parseEvidenceReviewPacket,
  type EvidenceCandidate,
  type EvidenceReviewPacket
} from '../shared/authoringSchema'
import {
  parseDraftGenerationConfig,
  type DraftGenerationConfig
} from '../shared/draftGenerationSchema'
import { readSourceControlState, type SourceControlState } from './sourceControl'

export const DRAFT_PROMPT_VERSION = 'canonical-eval-draft-v1'

// Structured-output schemas are transmitted alongside the messages but are not
// visible in userPromptFor. Reserve enough room so preflight estimates and
// request ceilings remain conservative.
const STRUCTURED_OUTPUT_OVERHEAD_TOKENS = 500
const RETRY_FEEDBACK_RESERVE_TOKENS = 128

const SYSTEM_PROMPT = `You draft evaluation questions for a book retrieval benchmark.

The input is one canonical EPUB node selected independently of every candidate chunker. Return:
1. A specific, natural question answerable from this node alone.
2. A realistic 3-12 word search query that paraphrases the information need.
3. The smallest useful verbatim contiguous answer span copied exactly from the excerpt.
4. A concise reference answer.
5. Descriptive tags and an easy/medium/hard difficulty.

Do not mention "the excerpt", node IDs, retrieval, or benchmark machinery. Do not create yes/no or vague questions. Do not copy a four-word phrase from the excerpt into the search query. The exact answer span must occur in the excerpt.

For table nodes, ask about a relationship or value represented by the table and tag it "table". For image nodes, only use the supplied alt/caption metadata, tag it "image_metadata", and do not claim to inspect pixels.`

interface LoadedDraftConfig {
  configPath: string
  packetPath: string
  outputDir: string
  config: DraftGenerationConfig
  packet: EvidenceReviewPacket
  candidates: EvidenceCandidate[]
}

export interface DraftGenerationPlan {
  schemaVersion: 1
  fingerprint: string
  promptVersion: typeof DRAFT_PROMPT_VERSION
  promptHash: string
  sourceControl: SourceControlState
  name: string
  model: DraftGenerationConfig['model']
  configPath: string
  packetPath: string
  outputDir: string
  runPath: string
  corpusId: string
  corpusFingerprint: string
  candidates: number
  candidatesByBook: Record<string, number>
  candidatesByKind: Record<string, number>
  estimatedInputTokens: number
  maxOutputTokens: number
  estimatedCostUsd: number
  retryUpperBoundCostUsd: number
}

export interface DraftModelResponse {
  draft: unknown
  rawModelContent?: unknown
  resolvedModel?: string
  inputTokens: number
  outputTokens: number
}

export interface DraftModel {
  generate(systemPrompt: string, userPrompt: string): Promise<DraftModelResponse>
}

export interface DraftAttempt {
  candidateId: string
  attempt: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  rawDraft: unknown
  rawModelContent?: unknown
  resolvedModel?: string
  validationError?: string
}

export interface EvalDraftRecord {
  candidateId: string
  bookId: string
  sourceHash: string
  nodeId: string
  spineHref: string
  evidenceKind: 'text' | 'table' | 'image'
  evidenceTextStart?: number
  evidenceTextEnd?: number
  question: string
  canonicalSearchQuery: string
  answerSpan: string
  referenceAnswer: string
  tags: string[]
  difficulty: 'easy' | 'medium' | 'hard'
  reviewStatus: 'pending' | 'approved' | 'rejected'
  provenance: {
    kind: 'llm_assisted'
    model: string
    promptHash: string
    packetFingerprint: string
  }
}

export interface DraftCostLedger {
  inputTokens: number
  outputTokens: number
  actualCostUsd: number
  requests: number
}

export interface DraftGenerationRun {
  schemaVersion: typeof EVAL_DRAFT_RUN_SCHEMA_VERSION
  fingerprint: string
  status: 'running' | 'completed' | 'completed_with_failures' | 'failed'
  plan: DraftGenerationPlan
  startedAt: number
  updatedAt: number
  completedAt?: number
  maxUsd: number
  ledger: DraftCostLedger
  attempts: DraftAttempt[]
  drafts: EvalDraftRecord[]
  failures: Array<{ candidateId: string; error: string }>
  error?: string
}

function resolveFrom(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path)
}

function selectCandidates(
  packet: EvidenceReviewPacket,
  maxCandidatesPerBook?: number
): EvidenceCandidate[] {
  if (maxCandidatesPerBook === undefined) return packet.candidates
  const counts = new Map<string, number>()
  return packet.candidates.filter((candidate) => {
    const count = counts.get(candidate.bookId) ?? 0
    if (count >= maxCandidatesPerBook) return false
    counts.set(candidate.bookId, count + 1)
    return true
  })
}

async function loadDraftConfig(configPath: string): Promise<LoadedDraftConfig> {
  const absoluteConfigPath = resolve(configPath)
  const configDir = dirname(absoluteConfigPath)
  const config = parseDraftGenerationConfig(
    parseYaml(await fs.readFile(absoluteConfigPath, 'utf8')) as unknown
  )
  const packetPath = resolveFrom(configDir, config.packetPath)
  const packet = parseEvidenceReviewPacket(
    JSON.parse(await fs.readFile(packetPath, 'utf8')) as unknown
  )
  return {
    configPath: absoluteConfigPath,
    packetPath,
    outputDir: resolveFrom(configDir, config.outputDir),
    config,
    packet,
    candidates: selectCandidates(packet, config.maxCandidatesPerBook)
  }
}

function bookFor(
  packet: EvidenceReviewPacket,
  bookId: string
): EvidenceReviewPacket['books'][number] {
  const book = packet.books.find((candidate) => candidate.bookId === bookId)
  if (!book) throw new Error(`Candidate references missing book ${bookId}`)
  return book
}

function userPromptFor(packet: EvidenceReviewPacket, candidate: EvidenceCandidate): string {
  const book = bookFor(packet, candidate.bookId)
  return JSON.stringify(
    {
      book: { title: book.title, author: book.author },
      canonicalNode: {
        kind: candidate.kind,
        headingPath: candidate.headingPath,
        excerpt: candidate.excerpt,
        assets: candidate.assets
      }
    },
    null,
    2
  )
}

function inputTokensFor(packet: EvidenceReviewPacket, candidate: EvidenceCandidate): number {
  return (
    countChunkTokens(SYSTEM_PROMPT) +
    countChunkTokens(userPromptFor(packet, candidate)) +
    STRUCTURED_OUTPUT_OVERHEAD_TOKENS
  )
}

function requestCost(
  config: DraftGenerationConfig,
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens / 1_000_000) * config.pricing.inputUsdPerMillion +
    (outputTokens / 1_000_000) * config.pricing.outputUsdPerMillion
  )
}

function reproducibleConfig(config: DraftGenerationConfig): object {
  return {
    schemaVersion: config.schemaVersion,
    name: config.name,
    model: config.model,
    pricing: config.pricing,
    maxCandidatesPerBook: config.maxCandidatesPerBook,
    maxAttemptsPerCandidate: config.maxAttemptsPerCandidate
  }
}

export async function planDraftGeneration(configPath: string): Promise<DraftGenerationPlan> {
  const loaded = await loadDraftConfig(configPath)
  const sourceControl = await readSourceControlState()
  const promptHash = contentHash({ version: DRAFT_PROMPT_VERSION, prompt: SYSTEM_PROMPT })
  const estimatedInputTokens = loaded.candidates.reduce(
    (total, candidate) => total + inputTokensFor(loaded.packet, candidate),
    0
  )
  const maxOutputTokens = loaded.candidates.length * loaded.config.model.maxOutputTokensPerCandidate
  const estimatedCostUsd = requestCost(loaded.config, estimatedInputTokens, maxOutputTokens)
  const retryCount = loaded.config.maxAttemptsPerCandidate - 1
  const retryUpperBoundInputTokens =
    estimatedInputTokens * loaded.config.maxAttemptsPerCandidate +
    loaded.candidates.length * retryCount * RETRY_FEEDBACK_RESERVE_TOKENS
  const retryUpperBoundOutputTokens = maxOutputTokens * loaded.config.maxAttemptsPerCandidate
  const fingerprint = contentHash({
    config: reproducibleConfig(loaded.config),
    packetFingerprint: loaded.packet.corpusFingerprint,
    candidateIds: loaded.candidates.map((candidate) => candidate.id),
    promptHash,
    sourceControl
  })
  const candidatesByBook: Record<string, number> = {}
  const candidatesByKind: Record<string, number> = {}
  for (const candidate of loaded.candidates) {
    candidatesByBook[candidate.bookId] = (candidatesByBook[candidate.bookId] ?? 0) + 1
    candidatesByKind[candidate.kind] = (candidatesByKind[candidate.kind] ?? 0) + 1
  }
  const runPath = join(loaded.outputDir, `${loaded.config.name}-${fingerprint.slice(0, 16)}.json`)
  return {
    schemaVersion: 1,
    fingerprint,
    promptVersion: DRAFT_PROMPT_VERSION,
    promptHash,
    sourceControl,
    name: loaded.config.name,
    model: loaded.config.model,
    configPath: loaded.configPath,
    packetPath: loaded.packetPath,
    outputDir: loaded.outputDir,
    runPath,
    corpusId: loaded.packet.corpusId,
    corpusFingerprint: loaded.packet.corpusFingerprint,
    candidates: loaded.candidates.length,
    candidatesByBook,
    candidatesByKind,
    estimatedInputTokens,
    maxOutputTokens,
    estimatedCostUsd,
    retryUpperBoundCostUsd: requestCost(
      loaded.config,
      retryUpperBoundInputTokens,
      retryUpperBoundOutputTokens
    )
  }
}

function phraseSet(text: string, size: number): Set<string> {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const phrases = new Set<string>()
  for (let index = 0; index <= tokens.length - size; index++) {
    phrases.add(tokens.slice(index, index + size).join(' '))
  }
  return phrases
}

export function validateDraft(
  candidate: EvidenceCandidate,
  draftValue: unknown,
  model: string,
  promptHash: string,
  packetFingerprint: string
): EvalDraftRecord {
  const draft = generatedEvalDraftSchema.parse(draftValue)
  if (!draft.question.trim().endsWith('?')) {
    throw new Error('Question must end with a question mark')
  }
  const answerOffset = candidate.excerpt.indexOf(draft.answerSpan)
  if (answerOffset < 0) {
    throw new Error('answerSpan is not an exact contiguous substring of the canonical excerpt')
  }
  const queryWords = draft.searchQuery.match(/[\p{L}\p{N}]+/gu) ?? []
  if (queryWords.length < 3 || queryWords.length > 12) {
    throw new Error('searchQuery must contain 3-12 words')
  }
  const excerptPhrases = phraseSet(candidate.excerpt, 4)
  const leakingPhrase = [...phraseSet(draft.searchQuery, 4)].find((phrase) =>
    excerptPhrases.has(phrase)
  )
  if (leakingPhrase) {
    throw new Error(`searchQuery copies a four-word phrase: "${leakingPhrase}"`)
  }

  const evidenceKind =
    candidate.kind === 'table' ? 'table' : candidate.kind === 'image' ? 'image' : 'text'
  const tags = new Set(draft.tags)
  if (evidenceKind === 'table') tags.add('table')
  if (evidenceKind === 'image') tags.add('image_metadata')
  return {
    candidateId: candidate.id,
    bookId: candidate.bookId,
    sourceHash: candidate.sourceHash,
    nodeId: candidate.nodeId,
    spineHref: candidate.spineHref,
    evidenceKind,
    ...(evidenceKind === 'text'
      ? {
          evidenceTextStart: candidate.textStart + answerOffset,
          evidenceTextEnd: candidate.textStart + answerOffset + draft.answerSpan.length
        }
      : {}),
    question: draft.question.trim(),
    canonicalSearchQuery: draft.searchQuery.trim(),
    answerSpan: draft.answerSpan,
    referenceAnswer: draft.referenceAnswer.trim(),
    tags: [...tags],
    difficulty: draft.difficulty,
    reviewStatus: 'pending',
    provenance: {
      kind: 'llm_assisted',
      model,
      promptHash,
      packetFingerprint
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temporaryPath, path)
}

async function readExistingRun(
  path: string,
  fingerprint: string
): Promise<DraftGenerationRun | null> {
  try {
    const run = JSON.parse(await fs.readFile(path, 'utf8')) as DraftGenerationRun
    if (run.schemaVersion !== EVAL_DRAFT_RUN_SCHEMA_VERSION || run.fingerprint !== fingerprint) {
      throw new Error(`Existing draft run at ${path} has a different fingerprint or schema`)
    }
    return run
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function createOpenAiDraftModel(config: DraftGenerationConfig): Promise<DraftModel> {
  const apiKey = await getOpenaiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for draft generation')
  }
  const model = new ChatOpenAI({
    model: config.model.name,
    apiKey,
    maxTokens: config.model.maxOutputTokensPerCandidate,
    ...(config.model.temperature === undefined ? {} : { temperature: config.model.temperature }),
    ...(config.model.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: config.model.reasoningEffort } })
  }).withStructuredOutput(generatedEvalDraftSchema, {
    name: 'canonical_book_eval_draft',
    includeRaw: true
  })
  return {
    async generate(systemPrompt, userPrompt) {
      const response = (await model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt)
      ])) as unknown as {
        parsed: unknown
        raw?: {
          content?: unknown
          usage_metadata?: {
            input_tokens?: number
            output_tokens?: number
          }
          response_metadata?: {
            model_name?: string
            model?: string
            tokenUsage?: {
              promptTokens?: number
              completionTokens?: number
            }
          }
        }
      }
      const inputTokens =
        response.raw?.usage_metadata?.input_tokens ??
        response.raw?.response_metadata?.tokenUsage?.promptTokens
      const outputTokens =
        response.raw?.usage_metadata?.output_tokens ??
        response.raw?.response_metadata?.tokenUsage?.completionTokens
      if (inputTokens === undefined || outputTokens === undefined) {
        throw new Error('Model response omitted token usage; refusing unmetered generation')
      }
      return {
        draft: response.parsed ?? null,
        rawModelContent: response.raw?.content,
        resolvedModel:
          response.raw?.response_metadata?.model_name ?? response.raw?.response_metadata?.model,
        inputTokens,
        outputTokens
      }
    }
  }
}

function recordAttemptCost(
  run: DraftGenerationRun,
  config: DraftGenerationConfig,
  response: DraftModelResponse
): number {
  const cost = requestCost(config, response.inputTokens, response.outputTokens)
  run.ledger.inputTokens += response.inputTokens
  run.ledger.outputTokens += response.outputTokens
  run.ledger.actualCostUsd += cost
  run.ledger.requests += 1
  return cost
}

export async function runDraftGeneration(
  configPath: string,
  maxUsd: number,
  options: { resume?: boolean; model?: DraftModel } = {}
): Promise<DraftGenerationRun> {
  if (!Number.isFinite(maxUsd) || maxUsd < 0) {
    throw new Error('--max-usd must be non-negative')
  }
  const loaded = await loadDraftConfig(configPath)
  const plan = await planDraftGeneration(configPath)
  if (plan.estimatedCostUsd > maxUsd) {
    throw new Error(
      `Planned one-attempt cost $${plan.estimatedCostUsd.toFixed(6)} exceeds --max-usd $${maxUsd.toFixed(6)}`
    )
  }
  const existing = options.resume ? await readExistingRun(plan.runPath, plan.fingerprint) : null
  if (!options.resume && (await readExistingRun(plan.runPath, plan.fingerprint))) {
    throw new Error(`Draft run already exists at ${plan.runPath}; use resume-drafts`)
  }
  const now = Date.now()
  const run: DraftGenerationRun = existing ?? {
    schemaVersion: EVAL_DRAFT_RUN_SCHEMA_VERSION,
    fingerprint: plan.fingerprint,
    status: 'running',
    plan,
    startedAt: now,
    updatedAt: now,
    maxUsd,
    ledger: { inputTokens: 0, outputTokens: 0, actualCostUsd: 0, requests: 0 },
    attempts: [],
    drafts: [],
    failures: []
  }
  if (run.ledger.actualCostUsd > maxUsd + 1e-9) {
    throw new Error('Existing draft run has already spent more than the new ceiling')
  }
  run.status = 'running'
  run.maxUsd = maxUsd
  delete run.error
  await writeJsonAtomic(plan.runPath, run)

  try {
    let model = options.model
    for (const candidate of loaded.candidates) {
      if (run.drafts.some((draft) => draft.candidateId === candidate.id)) continue
      const previousAttempts = run.attempts.filter(
        (attempt) => attempt.candidateId === candidate.id
      )
      if (
        previousAttempts.length >= loaded.config.maxAttemptsPerCandidate &&
        run.failures.some((failure) => failure.candidateId === candidate.id)
      ) {
        continue
      }
      const recoverable = [...previousAttempts]
        .reverse()
        .find((attempt) => attempt.validationError === undefined)
      if (recoverable) {
        try {
          run.drafts.push(
            validateDraft(
              candidate,
              recoverable.rawDraft,
              recoverable.resolvedModel ?? loaded.config.model.name,
              plan.promptHash,
              loaded.packet.corpusFingerprint
            )
          )
          run.updatedAt = Date.now()
          await writeJsonAtomic(plan.runPath, run)
          continue
        } catch (error) {
          recoverable.validationError = (error as Error).message
          await writeJsonAtomic(plan.runPath, run)
        }
      }

      let lastValidationError = 'No valid model response'
      for (
        let attemptNumber = previousAttempts.length + 1;
        attemptNumber <= loaded.config.maxAttemptsPerCandidate;
        attemptNumber++
      ) {
        const userPrompt = userPromptFor(loaded.packet, candidate)
        const retryPrompt =
          attemptNumber === 1
            ? userPrompt
            : `${userPrompt}\n\nPrevious output failed validation: ${lastValidationError.slice(0, 400)}\nReturn a corrected draft.`
        const maximumRequestCost = requestCost(
          loaded.config,
          countChunkTokens(SYSTEM_PROMPT) +
            countChunkTokens(retryPrompt) +
            STRUCTURED_OUTPUT_OVERHEAD_TOKENS,
          loaded.config.model.maxOutputTokensPerCandidate
        )
        if (run.ledger.actualCostUsd + maximumRequestCost > maxUsd + 1e-9) {
          throw new Error(
            `Next request could exceed --max-usd: spent $${run.ledger.actualCostUsd.toFixed(6)}, request ceiling $${maximumRequestCost.toFixed(6)}`
          )
        }
        model ??= await createOpenAiDraftModel(loaded.config)
        const response = await model.generate(SYSTEM_PROMPT, retryPrompt)
        const costUsd = recordAttemptCost(run, loaded.config, response)
        const attempt: DraftAttempt = {
          candidateId: candidate.id,
          attempt: attemptNumber,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd,
          rawDraft: response.draft,
          ...(response.rawModelContent === undefined
            ? {}
            : { rawModelContent: response.rawModelContent }),
          ...(response.resolvedModel === undefined ? {} : { resolvedModel: response.resolvedModel })
        }
        run.attempts.push(attempt)
        run.updatedAt = Date.now()
        await writeJsonAtomic(plan.runPath, run)
        try {
          run.drafts.push(
            validateDraft(
              candidate,
              response.draft,
              response.resolvedModel ?? loaded.config.model.name,
              plan.promptHash,
              loaded.packet.corpusFingerprint
            )
          )
          await writeJsonAtomic(plan.runPath, run)
          break
        } catch (error) {
          lastValidationError = (error as Error).message
          attempt.validationError = lastValidationError
          await writeJsonAtomic(plan.runPath, run)
        }
      }
      if (!run.drafts.some((draft) => draft.candidateId === candidate.id)) {
        if (!run.failures.some((failure) => failure.candidateId === candidate.id)) {
          run.failures.push({ candidateId: candidate.id, error: lastValidationError })
        }
        await writeJsonAtomic(plan.runPath, run)
      }
    }
    run.status = run.failures.length > 0 ? 'completed_with_failures' : 'completed'
    run.completedAt = Date.now()
    run.updatedAt = run.completedAt
    await writeJsonAtomic(plan.runPath, run)
    return run
  } catch (error) {
    run.status = 'failed'
    run.error = (error as Error).message
    run.updatedAt = Date.now()
    await writeJsonAtomic(plan.runPath, run)
    throw error
  }
}
