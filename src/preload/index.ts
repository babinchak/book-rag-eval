import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ChunkParams,
  ChunksGetResult,
  ChunksListResult,
  ChunksRunResult,
  LibraryImportResult,
  LibraryListResult,
  LibraryOpenResult,
  LibraryRemoveResult
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
