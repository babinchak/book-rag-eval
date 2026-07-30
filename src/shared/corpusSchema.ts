import { z } from 'zod'

export const CORPUS_MANIFEST_SCHEMA_VERSION = 1

const corpusManifestSchema = z.object({
  schemaVersion: z.literal(CORPUS_MANIFEST_SCHEMA_VERSION),
  id: z.string().min(1),
  description: z.string().min(1),
  books: z
    .array(
      z.object({
        bookId: z.string().min(1),
        title: z.string().min(1),
        author: z.string().min(1),
        tags: z.array(z.string().min(1)).default([])
      })
    )
    .min(1)
})

export type CorpusManifest = z.infer<typeof corpusManifestSchema>

export function parseCorpusManifest(value: unknown): CorpusManifest {
  return corpusManifestSchema.parse(value)
}
