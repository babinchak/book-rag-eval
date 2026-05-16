// OpenAI pricing in USD per 1M tokens. Update as prices change.
// Source: https://openai.com/api/pricing/
interface ModelPricing {
  input?: number
  output?: number
  embedding?: number
}

const PER_1M = 1_000_000

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'text-embedding-3-large': { embedding: 0.13 },
  'text-embedding-3-small': { embedding: 0.02 },
  'text-embedding-ada-002': { embedding: 0.1 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-2024-08-06': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 }
}

function lookup(model: string): ModelPricing | null {
  return MODEL_PRICING[model] ?? null
}

export function embeddingCostUsd(model: string, tokens: number): number | null {
  const p = lookup(model)
  if (!p?.embedding) return null
  return (tokens / PER_1M) * p.embedding
}

export function chatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | null {
  const p = lookup(model)
  if (!p?.input || !p?.output) return null
  return (
    (promptTokens / PER_1M) * p.input + (completionTokens / PER_1M) * p.output
  )
}

export function formatUsd(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return '—'
  if (cost === 0) return '$0'
  if (cost < 0.0001) return '<$0.0001'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}
