import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AskIpcResult,
  Bm25ListIpcResult,
  Bm25RemoveIpcResult,
  Bm25RunIpcResult,
  ChunkParams,
  ChunksGetResult,
  ChunksListResult,
  ChunksRunResult,
  CollectionsListResult,
  EmbedRunIpcResult,
  EmbeddingsListIpcResult,
  EmbeddingsRemoveIpcResult,
  ErrorsBundleIpcResult,
  ErrorsListIpcResult,
  ErrorsReportIpcResult,
  EvalAutoGenerateIpcResult,
  EvalCaseAddIpcResult,
  EvalCaseRemoveIpcResult,
  EvalCaseUpdateIpcResult,
  EvalLocateIpcResult,
  EvalRunGetIpcResult,
  EvalRunIpcResult,
  EvalRunsListIpcResult,
  EvalSetCreateIpcResult,
  EvalSetDeleteIpcResult,
  EvalSetGetIpcResult,
  EvalSetsListIpcResult,
  GoldSpan,
  LibraryImportResult,
  LibraryListResult,
  LibraryOpenResult,
  LibraryRemoveResult,
  LogEntry,
  RendererErrorReport,
  RetrieverParams,
  StrategiesListIpcResult,
  StrategyConfig,
  StrategyDeleteIpcResult,
  StrategyGetIpcResult,
  StrategyMutateIpcResult,
  SettingsClearKeyResult,
  SettingsGetStringResult,
  SettingsHasKeyResult,
  SettingsSetKeyResult,
  SettingsSetStringResult
} from './types'

const api = {
  library: {
    list: (): Promise<LibraryListResult> => ipcRenderer.invoke('library:list'),
    import: (): Promise<LibraryImportResult> => ipcRenderer.invoke('library:import'),
    open: (id: string): Promise<LibraryOpenResult> => ipcRenderer.invoke('library:open', id),
    remove: (id: string): Promise<LibraryRemoveResult> => ipcRenderer.invoke('library:remove', id)
  },
  collections: {
    list: (): Promise<CollectionsListResult> => ipcRenderer.invoke('collections:list')
  },
  chunks: {
    run: (bookId: string, params: ChunkParams): Promise<ChunksRunResult> =>
      ipcRenderer.invoke('chunks:run', bookId, params),
    list: (bookId: string): Promise<ChunksListResult> => ipcRenderer.invoke('chunks:list', bookId),
    get: (bookId: string, strategyId: string): Promise<ChunksGetResult> =>
      ipcRenderer.invoke('chunks:get', bookId, strategyId)
  },
  embeddings: {
    run: (bookId: string, strategyId: string): Promise<EmbedRunIpcResult> =>
      ipcRenderer.invoke('embeddings:run', bookId, strategyId),
    list: (bookId: string): Promise<EmbeddingsListIpcResult> =>
      ipcRenderer.invoke('embeddings:list', bookId),
    remove: (bookId: string, strategyId: string): Promise<EmbeddingsRemoveIpcResult> =>
      ipcRenderer.invoke('embeddings:remove', bookId, strategyId)
  },
  strategies: {
    list: (): Promise<StrategiesListIpcResult> => ipcRenderer.invoke('strategies:list'),
    get: (id: string): Promise<StrategyGetIpcResult> => ipcRenderer.invoke('strategies:get', id),
    create: (name: string, config: StrategyConfig): Promise<StrategyMutateIpcResult> =>
      ipcRenderer.invoke('strategies:create', name, config),
    update: (
      id: string,
      patch: { name?: string; config?: StrategyConfig }
    ): Promise<StrategyMutateIpcResult> => ipcRenderer.invoke('strategies:update', id, patch),
    delete: (id: string): Promise<StrategyDeleteIpcResult> =>
      ipcRenderer.invoke('strategies:delete', id),
    duplicate: (id: string): Promise<StrategyMutateIpcResult> =>
      ipcRenderer.invoke('strategies:duplicate', id)
  },
  bm25: {
    run: (bookId: string, strategyId: string): Promise<Bm25RunIpcResult> =>
      ipcRenderer.invoke('bm25:run', bookId, strategyId),
    list: (bookId: string): Promise<Bm25ListIpcResult> =>
      ipcRenderer.invoke('bm25:list', bookId),
    remove: (bookId: string, strategyId: string): Promise<Bm25RemoveIpcResult> =>
      ipcRenderer.invoke('bm25:remove', bookId, strategyId)
  },
  settings: {
    hasOpenaiKey: (): Promise<SettingsHasKeyResult> => ipcRenderer.invoke('settings:hasOpenaiKey'),
    setOpenaiKey: (key: string): Promise<SettingsSetKeyResult> =>
      ipcRenderer.invoke('settings:setOpenaiKey', key),
    clearOpenaiKey: (): Promise<SettingsClearKeyResult> =>
      ipcRenderer.invoke('settings:clearOpenaiKey'),
    hasLangsmithKey: (): Promise<SettingsHasKeyResult> =>
      ipcRenderer.invoke('settings:hasLangsmithKey'),
    setLangsmithKey: (key: string): Promise<SettingsSetKeyResult> =>
      ipcRenderer.invoke('settings:setLangsmithKey', key),
    clearLangsmithKey: (): Promise<SettingsClearKeyResult> =>
      ipcRenderer.invoke('settings:clearLangsmithKey'),
    getLangsmithProject: (): Promise<SettingsGetStringResult> =>
      ipcRenderer.invoke('settings:getLangsmithProject'),
    setLangsmithProject: (name: string): Promise<SettingsSetStringResult> =>
      ipcRenderer.invoke('settings:setLangsmithProject', name)
  },
  ask: {
    run: (
      bookId: string,
      strategyId: string,
      retriever: RetrieverParams,
      query: string,
      k: number
    ): Promise<AskIpcResult> =>
      ipcRenderer.invoke('ask:run', bookId, strategyId, retriever, query, k)
  },
  evals: {
    list: (bookId: string): Promise<EvalSetsListIpcResult> =>
      ipcRenderer.invoke('evals:list', bookId),
    get: (bookId: string, setId: string): Promise<EvalSetGetIpcResult> =>
      ipcRenderer.invoke('evals:get', bookId, setId),
    create: (bookId: string, setId: string): Promise<EvalSetCreateIpcResult> =>
      ipcRenderer.invoke('evals:create', bookId, setId),
    delete: (bookId: string, setId: string): Promise<EvalSetDeleteIpcResult> =>
      ipcRenderer.invoke('evals:delete', bookId, setId),
    addCase: (
      bookId: string,
      setId: string,
      question: string,
      searchQuery: string,
      goldSpans: GoldSpan[],
      notes?: string
    ): Promise<EvalCaseAddIpcResult> =>
      ipcRenderer.invoke('evals:addCase', bookId, setId, question, searchQuery, goldSpans, notes),
    removeCase: (bookId: string, setId: string, caseId: string): Promise<EvalCaseRemoveIpcResult> =>
      ipcRenderer.invoke('evals:removeCase', bookId, setId, caseId),
    updateCase: (
      bookId: string,
      setId: string,
      caseId: string,
      updates: { question?: string; searchQuery?: string; goldSpans?: GoldSpan[]; notes?: string }
    ): Promise<EvalCaseUpdateIpcResult> =>
      ipcRenderer.invoke('evals:updateCase', bookId, setId, caseId, updates),
    locate: (bookId: string, quote: string): Promise<EvalLocateIpcResult> =>
      ipcRenderer.invoke('evals:locate', bookId, quote),
    run: (
      bookId: string,
      setId: string,
      strategyId: string,
      retriever: RetrieverParams,
      k: number,
      mode: 'retrieval' | 'agentic',
      caseIds?: string[]
    ): Promise<EvalRunIpcResult> =>
      ipcRenderer.invoke('evals:run', bookId, setId, strategyId, retriever, k, mode, caseIds),
    listRuns: (bookId: string): Promise<EvalRunsListIpcResult> =>
      ipcRenderer.invoke('evals:listRuns', bookId),
    getRun: (bookId: string, runId: string): Promise<EvalRunGetIpcResult> =>
      ipcRenderer.invoke('evals:getRun', bookId, runId),
    autoGenerate: (
      bookId: string,
      setId: string,
      strategyId: string,
      count: number
    ): Promise<EvalAutoGenerateIpcResult> =>
      ipcRenderer.invoke('evals:autoGenerate', bookId, setId, strategyId, count),
    backfillSearchQueries: (bookId: string, setId: string): Promise<EvalAutoGenerateIpcResult> =>
      ipcRenderer.invoke('evals:backfillSearchQueries', bookId, setId)
  },
  errors: {
    list: (): Promise<ErrorsListIpcResult> => ipcRenderer.invoke('errors:list'),
    bundle: (id: string): Promise<ErrorsBundleIpcResult> => ipcRenderer.invoke('errors:bundle', id),
    bundleAll: (): Promise<ErrorsBundleIpcResult> => ipcRenderer.invoke('errors:bundleAll'),
    report: (report: RendererErrorReport): Promise<ErrorsReportIpcResult> =>
      ipcRenderer.invoke('errors:report', report),
    onChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('errors:changed', listener)
      return () => ipcRenderer.off('errors:changed', listener)
    }
  },
  log: {
    forward: (entry: LogEntry): void => {
      ipcRenderer.send('log:forward', entry)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type Api = typeof api
