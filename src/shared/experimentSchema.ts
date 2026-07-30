import { z } from 'zod'

export const EXPERIMENT_SCHEMA_VERSION = 1

const positiveInteger = z.number().int().positive()

const chunkerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed-token'),
    size: positiveInteger,
    overlap: z.number().int().nonnegative(),
    encoding: z.literal('cl100k_base').default('cl100k_base')
  }),
  z.object({
    kind: z.literal('fixed'),
    size: positiveInteger,
    overlap: z.number().int().nonnegative()
  }),
  z.object({ kind: z.literal('paragraph'), targetSize: positiveInteger }),
  z.object({ kind: z.literal('sentence'), targetSize: positiveInteger }),
  z.object({
    kind: z.literal('structural-token'),
    targetSize: positiveInteger,
    maxSize: positiveInteger,
    encoding: z.literal('cl100k_base').default('cl100k_base')
  }),
  z.object({ kind: z.literal('structural'), maxSize: positiveInteger }),
  z.object({
    kind: z.literal('semantic'),
    targetSize: positiveInteger,
    breakpointPercentile: z.number().min(0).max(100),
    bufferSize: z.number().int().nonnegative()
  })
])

const embeddingModelSchema = z.enum(['text-embedding-3-small', 'text-embedding-3-large'])

const retrievalPipelineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bm25') }),
  z.object({
    kind: z.literal('vector'),
    embeddingModel: embeddingModelSchema
  }),
  z.object({
    kind: z.literal('hybrid-rrf'),
    embeddingModel: embeddingModelSchema,
    rrfK: positiveInteger.default(60)
  })
])

const bookSelectionSchema = z
  .object({
    bookId: z.string().min(1),
    evalSetId: z.string().min(1).optional(),
    evalSetPath: z.string().min(1).optional()
  })
  .superRefine((selection, context) => {
    if ((selection.evalSetId === undefined) === (selection.evalSetPath === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Choose exactly one of evalSetId or evalSetPath'
      })
    }
  })

const experimentSchema = z
  .object({
    schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
    name: z.string().min(1),
    libraryDir: z.string().min(1).optional(),
    outputDir: z.string().min(1).default('.rag-eval/runs'),
    books: z.array(bookSelectionSchema).min(1),
    chunkers: z.array(chunkerSchema).min(1),
    retrievers: z.array(retrievalPipelineSchema).min(1),
    contextBudgets: z.array(positiveInteger).min(1),
    candidatePoolSize: positiveInteger.default(50),
    splits: z.array(z.enum(['dev', 'test'])).min(1).default(['dev']),
    maxCasesPerBook: positiveInteger.optional(),
    pricing: z
      .object({
        embeddingUsdPerMillion: z
          .object({
            'text-embedding-3-small': z.number().nonnegative().optional(),
            'text-embedding-3-large': z.number().nonnegative().optional()
          })
          .default({})
      })
      .default({ embeddingUsdPerMillion: {} })
  })
  .superRefine((experiment, context) => {
    for (const chunker of experiment.chunkers) {
      if (
        (chunker.kind === 'fixed' || chunker.kind === 'fixed-token') &&
        chunker.overlap >= chunker.size
      ) {
        context.addIssue({
          code: 'custom',
          message: `${chunker.kind} overlap must be smaller than size`
        })
      }
      if (chunker.kind === 'structural-token' && chunker.targetSize > chunker.maxSize) {
        context.addIssue({
          code: 'custom',
          message: 'structural-token targetSize must not exceed maxSize'
        })
      }
    }
    if (new Set(experiment.contextBudgets).size !== experiment.contextBudgets.length) {
      context.addIssue({ code: 'custom', message: 'contextBudgets must be unique' })
    }
  })

export type ExperimentConfig = z.infer<typeof experimentSchema>
export type ExperimentRetriever = ExperimentConfig['retrievers'][number]

export function parseExperimentConfig(value: unknown): ExperimentConfig {
  return experimentSchema.parse(value)
}
