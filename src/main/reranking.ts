import { getVoyageKey } from './settings'
import { sidecar } from './sidecar'
import type { RetrievedChunkPayload } from '../preload/types'

export type VoyageRerankModel = 'rerank-2.5' | 'rerank-2.5-lite'

export interface VoyageRerankOutput {
  hits: RetrievedChunkPayload[]
  tokens?: number
  model: VoyageRerankModel
}

export async function rerankVoyage(
  query: string,
  hits: RetrievedChunkPayload[],
  model: VoyageRerankModel
): Promise<VoyageRerankOutput> {
  if (hits.length === 0) return { hits: [], tokens: 0, model }
  const voyageApiKey = await getVoyageKey()
  if (!voyageApiKey) {
    throw new Error('VOYAGE_API_KEY is not set. Add it to the environment before reranking.')
  }
  await sidecar.ensureStarted({ voyageApiKey })
  const response = await sidecar.rerank(
    query,
    hits.map((hit) => hit.chunk.text),
    model
  )
  const reranked = response.results.map((result, index) => {
    const hit = hits[result.index]
    if (!hit) throw new Error(`Voyage reranker returned invalid document index ${result.index}`)
    return {
      ...hit,
      distance: -result.relevance_score,
      rank: index + 1
    }
  })
  return { hits: reranked, tokens: response.tokens, model }
}
