import { z } from 'zod'

export const DRAFT_GENERATION_CONFIG_SCHEMA_VERSION = 1

const positiveInteger = z.number().int().positive()

const draftGenerationConfigSchema = z.object({
  schemaVersion: z.literal(DRAFT_GENERATION_CONFIG_SCHEMA_VERSION),
  name: z.string().min(1),
  packetPath: z.string().min(1),
  outputDir: z.string().min(1).default('.rag-eval/eval-drafts'),
  model: z.object({
    provider: z.literal('openai'),
    name: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    maxOutputTokensPerCandidate: positiveInteger.default(500)
  }),
  pricing: z.object({
    inputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().nonnegative()
  }),
  maxCandidatesPerBook: positiveInteger.optional(),
  maxAttemptsPerCandidate: positiveInteger.max(5).default(3)
})

export type DraftGenerationConfig = z.infer<typeof draftGenerationConfigSchema>

export function parseDraftGenerationConfig(value: unknown): DraftGenerationConfig {
  return draftGenerationConfigSchema.parse(value)
}
