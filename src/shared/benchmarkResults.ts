import type { RetrievalMetrics } from './evalMetrics'
import type {
  ExperimentContextPolicy,
  ExperimentQueryMode,
  ExperimentRetriever
} from './experimentSchema'

export interface BenchmarkRunSummary {
  runPath: string
  fingerprint: string
  caseSetFingerprint: string
  name: string
  status: 'running' | 'completed' | 'failed'
  updatedAt: number
  actualCostUsd: number
  resultCells: number
  uniqueCases: number
  contextBudgets: number[]
  queryModes: ExperimentQueryMode[]
}

export interface BenchmarkResultCell {
  bookId: string
  caseId: string
  strategyId: string
  retriever: ExperimentRetriever
  queryMode: ExperimentQueryMode
  retrievalQuery: string
  contextPolicy: ExperimentContextPolicy
  contextBudget: number
  retrievedChunkIds: string[]
  retrievedTokens: number
  metrics: Omit<RetrievalMetrics, 'candidateRelevance'>
}

export interface BenchmarkRunResults {
  run: BenchmarkRunSummary
  cells: BenchmarkResultCell[]
}
