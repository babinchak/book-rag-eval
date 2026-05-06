import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AskIpcResult,
  ChunkParams,
  ChunksGetResult,
  ChunksListResult,
  ChunksRunResult,
  EmbedRunIpcResult,
  EmbeddingsListIpcResult,
  EmbeddingsRemoveIpcResult,
  LibraryImportResult,
  LibraryListResult,
  LibraryOpenResult,
  LibraryRemoveResult,
  SettingsClearKeyResult,
  SettingsHasKeyResult,
  SettingsSetKeyResult
} from './types'

const api = {
  library: {
    list: (): Promise<LibraryListResult> => ipcRenderer.invoke('library:list'),
    import: (): Promise<LibraryImportResult> => ipcRenderer.invoke('library:import'),
    open: (id: string): Promise<LibraryOpenResult> => ipcRenderer.invoke('library:open', id),
    remove: (id: string): Promise<LibraryRemoveResult> => ipcRenderer.invoke('library:remove', id)
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
  settings: {
    hasOpenaiKey: (): Promise<SettingsHasKeyResult> => ipcRenderer.invoke('settings:hasOpenaiKey'),
    setOpenaiKey: (key: string): Promise<SettingsSetKeyResult> =>
      ipcRenderer.invoke('settings:setOpenaiKey', key),
    clearOpenaiKey: (): Promise<SettingsClearKeyResult> =>
      ipcRenderer.invoke('settings:clearOpenaiKey')
  },
  ask: {
    run: (bookId: string, strategyId: string, query: string, k: number): Promise<AskIpcResult> =>
      ipcRenderer.invoke('ask:run', bookId, strategyId, query, k)
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
