import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { importEpubFromDialog, listLibrary, openBook, removeBook } from './library'
import { getChunkSet, listChunkSets, runChunking } from './chunking'
import { listEmbeddingSets, removeEmbeddings, runEmbedding } from './embeddings'
import { ask } from './retrieval'
import {
  clearLangsmithKey,
  clearOpenaiKey,
  getLangsmithProject,
  hasLangsmithKey,
  hasOpenaiKey,
  setLangsmithKey,
  setLangsmithProject,
  setOpenaiKey
} from './settings'
import {
  addCase,
  createEvalSet,
  deleteEvalSet,
  getEvalRun,
  getEvalSet,
  listEvalRuns,
  listEvalSets,
  locateQuote,
  removeCase,
  runEval,
  updateCase
} from './evals'
import type {
  AskIpcResult,
  ChunkParams,
  ChunksGetResult,
  ChunksListResult,
  ChunksRunResult,
  EmbedRunIpcResult,
  EmbeddingsListIpcResult,
  EmbeddingsRemoveIpcResult,
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
  SettingsClearKeyResult,
  SettingsGetStringResult,
  SettingsHasKeyResult,
  SettingsSetKeyResult,
  SettingsSetStringResult
} from '../preload/types'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('library:list', async (): Promise<LibraryListResult> => {
    try {
      return { ok: true, books: await listLibrary() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('library:import', async (): Promise<LibraryImportResult> => {
    try {
      return { ok: true, data: await importEpubFromDialog() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('library:open', async (_, id: string): Promise<LibraryOpenResult> => {
    try {
      return { ok: true, data: await openBook(id) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('library:remove', async (_, id: string): Promise<LibraryRemoveResult> => {
    try {
      await removeBook(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'chunks:run',
    async (_, bookId: string, params: ChunkParams): Promise<ChunksRunResult> => {
      try {
        return { ok: true, data: await runChunking(bookId, params) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('chunks:list', async (_, bookId: string): Promise<ChunksListResult> => {
    try {
      return { ok: true, sets: await listChunkSets(bookId) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'chunks:get',
    async (_, bookId: string, strategyId: string): Promise<ChunksGetResult> => {
      try {
        return { ok: true, data: await getChunkSet(bookId, strategyId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'embeddings:run',
    async (_, bookId: string, strategyId: string): Promise<EmbedRunIpcResult> => {
      try {
        return { ok: true, data: await runEmbedding(bookId, strategyId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'embeddings:list',
    async (_, bookId: string): Promise<EmbeddingsListIpcResult> => {
      try {
        return { ok: true, sets: await listEmbeddingSets(bookId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'embeddings:remove',
    async (_, bookId: string, strategyId: string): Promise<EmbeddingsRemoveIpcResult> => {
      try {
        await removeEmbeddings(bookId, strategyId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('settings:hasOpenaiKey', async (): Promise<SettingsHasKeyResult> => {
    try {
      return { ok: true, hasKey: await hasOpenaiKey() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'settings:setOpenaiKey',
    async (_, key: string): Promise<SettingsSetKeyResult> => {
      try {
        await setOpenaiKey(key)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('settings:clearOpenaiKey', async (): Promise<SettingsClearKeyResult> => {
    try {
      await clearOpenaiKey()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('settings:hasLangsmithKey', async (): Promise<SettingsHasKeyResult> => {
    try {
      return { ok: true, hasKey: await hasLangsmithKey() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'settings:setLangsmithKey',
    async (_, key: string): Promise<SettingsSetKeyResult> => {
      try {
        await setLangsmithKey(key)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('settings:clearLangsmithKey', async (): Promise<SettingsClearKeyResult> => {
    try {
      await clearLangsmithKey()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'settings:getLangsmithProject',
    async (): Promise<SettingsGetStringResult> => {
      try {
        return { ok: true, value: await getLangsmithProject() }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'settings:setLangsmithProject',
    async (_, name: string): Promise<SettingsSetStringResult> => {
      try {
        await setLangsmithProject(name)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'ask:run',
    async (
      _,
      bookId: string,
      strategyId: string,
      query: string,
      k: number
    ): Promise<AskIpcResult> => {
      try {
        return { ok: true, data: await ask(bookId, strategyId, query, k) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('evals:list', async (_, bookId: string): Promise<EvalSetsListIpcResult> => {
    try {
      return { ok: true, sets: await listEvalSets(bookId) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'evals:get',
    async (_, bookId: string, setId: string): Promise<EvalSetGetIpcResult> => {
      try {
        return { ok: true, data: await getEvalSet(bookId, setId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:create',
    async (_, bookId: string, setId: string): Promise<EvalSetCreateIpcResult> => {
      try {
        return { ok: true, data: await createEvalSet(bookId, setId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:delete',
    async (_, bookId: string, setId: string): Promise<EvalSetDeleteIpcResult> => {
      try {
        await deleteEvalSet(bookId, setId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:addCase',
    async (
      _,
      bookId: string,
      setId: string,
      question: string,
      goldSpans: GoldSpan[],
      notes?: string
    ): Promise<EvalCaseAddIpcResult> => {
      try {
        return { ok: true, data: await addCase(bookId, setId, question, goldSpans, notes) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:removeCase',
    async (
      _,
      bookId: string,
      setId: string,
      caseId: string
    ): Promise<EvalCaseRemoveIpcResult> => {
      try {
        await removeCase(bookId, setId, caseId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:updateCase',
    async (
      _,
      bookId: string,
      setId: string,
      caseId: string,
      updates: { question?: string; goldSpans?: GoldSpan[]; notes?: string }
    ): Promise<EvalCaseUpdateIpcResult> => {
      try {
        return { ok: true, data: await updateCase(bookId, setId, caseId, updates) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:locate',
    async (_, bookId: string, quote: string): Promise<EvalLocateIpcResult> => {
      try {
        const result = await locateQuote(bookId, quote)
        if (!result) {
          return { ok: false, error: 'Quote not found in any spine item' }
        }
        return { ok: true, data: result }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:run',
    async (
      _,
      bookId: string,
      setId: string,
      strategyId: string,
      k: number
    ): Promise<EvalRunIpcResult> => {
      try {
        return { ok: true, data: await runEval(bookId, setId, strategyId, k) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:listRuns',
    async (_, bookId: string): Promise<EvalRunsListIpcResult> => {
      try {
        return { ok: true, runs: await listEvalRuns(bookId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'evals:getRun',
    async (_, bookId: string, runId: string): Promise<EvalRunGetIpcResult> => {
      try {
        return { ok: true, data: await getEvalRun(bookId, runId) }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
