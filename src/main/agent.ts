import { tool } from '@langchain/core/tools'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { ChatOpenAI } from '@langchain/openai'
import { END, START, StateGraph } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from '@langchain/core/messages'
import { z } from 'zod'
import { retrieve } from './retrieval'
import {
  getLangsmithKey,
  getLangsmithProject,
  getOpenaiKey
} from './settings'
import type { AskResultPayload, RetrievedChunkPayload } from '../preload/types'

class RunIdCapture extends BaseCallbackHandler {
  name = 'run_id_capture'
  rootRunId?: string

  handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    runId: string,
    parentRunId?: string
  ): void {
    if (!parentRunId && !this.rootRunId) {
      this.rootRunId = runId
    }
  }
}

let cachedTenantId: string | null = null

async function langsmithRunUrl(
  runId: string,
  project: string | undefined
): Promise<string | null> {
  try {
    const { Client } = await import('langsmith')
    const client = new Client()
    if (!cachedTenantId) {
      const run = await client.readRun(runId)
      cachedTenantId = (run as { tenant_id?: string }).tenant_id ?? null
    }
    if (!cachedTenantId) return null
    const projectSeg = project ? encodeURIComponent(project) : 'default'
    return `https://smith.langchain.com/o/${cachedTenantId}/projects/p/${projectSeg}/r/${runId}`
  } catch {
    return null
  }
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

interface AgentState {
  messages: BaseMessage[]
}

const graphState = {
  messages: {
    reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y)
  }
}

function shouldContinue(state: AgentState): 'tools' | typeof END {
  const last = state.messages[state.messages.length - 1] as AIMessage
  return last.tool_calls?.length ? 'tools' : END
}

interface ToolHit {
  chunkId: string
  spineHref: string
  textStart: number
  textEnd: number
  text: string
  distance: number
  rank: number
}

async function configureLangSmith(): Promise<void> {
  const key = await getLangsmithKey()
  if (key) {
    process.env.LANGSMITH_API_KEY = key
    process.env.LANGSMITH_TRACING = 'true'
    const project = await getLangsmithProject()
    if (project) process.env.LANGSMITH_PROJECT = project
    else delete process.env.LANGSMITH_PROJECT
  } else {
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGSMITH_TRACING
    delete process.env.LANGSMITH_PROJECT
  }
}

export async function runAgent(
  bookId: string,
  strategyId: string,
  question: string,
  k: number
): Promise<AskResultPayload> {
  const apiKey = await getOpenaiKey()
  if (!apiKey) {
    throw new Error('OpenAI API key is not set. Add it in Settings.')
  }

  await configureLangSmith()

  const retrieveChunks = tool(
    async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await retrieve(
        bookId,
        strategyId,
        query,
        Math.min(limit ?? k, 20)
      )
      const hits: ToolHit[] = results.map((r) => ({
        chunkId: r.chunk.id,
        spineHref: r.chunk.spineHref,
        textStart: r.chunk.textStart,
        textEnd: r.chunk.textEnd,
        text: r.chunk.text,
        distance: r.distance,
        rank: r.rank
      }))
      return JSON.stringify({ chunks: hits })
    },
    {
      name: 'retrieve_chunks',
      description:
        'Search the book for passages relevant to a query using semantic similarity. ' +
        'Returns top-k chunks with full text. Use this to find evidence before answering.',
      schema: z.object({
        query: z.string().describe('Natural-language search query.'),
        limit: z
          .number()
          .optional()
          .describe(`Max results (default ${k}, max 20).`)
      })
    }
  )

  const tools = [retrieveChunks]
  const toolNode = new ToolNode<AgentState>(tools)
  const model = new ChatOpenAI({
    model: DEFAULT_MODEL,
    apiKey
  }).bindTools(tools)

  async function callModel(state: AgentState): Promise<{ messages: BaseMessage[] }> {
    const response = await model.invoke(state.messages)
    return { messages: [response] }
  }

  const graph = new StateGraph<AgentState>({ channels: graphState })
    .addNode('agent', callModel)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent')
    .compile()

  const capture = new RunIdCapture()
  const lsKey = await getLangsmithKey()

  const finalState = (await graph.invoke(
    {
      messages: [
        new SystemMessage(
          'You are answering questions about a book. ' +
            'Use the retrieve_chunks tool to find relevant passages before answering. ' +
            'If the answer is not in the retrieved passages, say so plainly. ' +
            'Cite passage numbers in brackets like [1] or [1, 3] after relevant claims. ' +
            'The numbers correspond to the order chunks appear in your tool results.'
        ),
        new HumanMessage(question)
      ]
    },
    { callbacks: [capture] }
  )) as unknown as AgentState

  let traceUrl: string | undefined
  if (lsKey && capture.rootRunId) {
    const project = await getLangsmithProject()
    const url = await langsmithRunUrl(capture.rootRunId, project ?? undefined)
    if (url) traceUrl = url
  }

  const allHits: ToolHit[] = []
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0

  for (const msg of finalState.messages) {
    if (
      msg instanceof ToolMessage &&
      typeof msg.content === 'string' &&
      msg.name === 'retrieve_chunks'
    ) {
      try {
        const parsed = JSON.parse(msg.content) as { chunks?: ToolHit[] }
        if (Array.isArray(parsed.chunks)) {
          for (const c of parsed.chunks) allHits.push(c)
        }
      } catch {
        // ignore malformed tool message
      }
    }
    if (msg instanceof AIMessage) {
      const meta = msg.response_metadata as Record<string, unknown> | undefined
      const usage = meta?.tokenUsage as
        | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
        | undefined
      if (usage) {
        promptTokens += usage.promptTokens ?? 0
        completionTokens += usage.completionTokens ?? 0
        totalTokens += usage.totalTokens ?? 0
      }
    }
  }

  const lastMsg = finalState.messages[finalState.messages.length - 1]
  const answer =
    typeof lastMsg.content === 'string'
      ? lastMsg.content
      : JSON.stringify(lastMsg.content)

  // Dedupe across multiple tool calls; preserve first-seen order.
  const seen = new Set<string>()
  const retrieved: RetrievedChunkPayload[] = []
  for (const h of allHits) {
    if (seen.has(h.chunkId)) continue
    seen.add(h.chunkId)
    retrieved.push({
      chunk: {
        id: h.chunkId,
        strategyId,
        spineHref: h.spineHref,
        textStart: h.textStart,
        textEnd: h.textEnd,
        text: h.text
      },
      distance: h.distance,
      rank: retrieved.length + 1
    })
  }

  return {
    answer,
    retrieved,
    promptTokens,
    completionTokens,
    totalTokens,
    model: DEFAULT_MODEL,
    langsmithRunUrl: traceUrl
  }
}
