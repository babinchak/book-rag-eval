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
  autoGenerateCases,
  backfillSearchQueries,
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
import { captureIpcError } from './ipcContext'
import { ingestRendererLog, log } from './log'
import { listErrors, recordRendererReport, subscribe } from './errorRegistry'
import { buildBundle, buildBundleAll } from './diagnosticBundle'
import type {
  AskIpcResult,
  ChunkParams,
  ChunksGetResult,
  ChunksListResult,
  ChunksRunResult,
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

  // Push inbox updates to this window when the registry changes.
  const unsubscribe = subscribe(() => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send('errors:changed')
  })
  mainWindow.on('closed', () => unsubscribe())
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
      return { ok: false, error: captureIpcError(err, 'library:list', []) }
    }
  })

  ipcMain.handle('library:import', async (): Promise<LibraryImportResult> => {
    try {
      return { ok: true, data: await importEpubFromDialog() }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'library:import', []) }
    }
  })

  ipcMain.handle('library:open', async (_, id: string): Promise<LibraryOpenResult> => {
    try {
      return { ok: true, data: await openBook(id) }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'library:open', [id]) }
    }
  })

  ipcMain.handle('library:remove', async (_, id: string): Promise<LibraryRemoveResult> => {
    try {
      await removeBook(id)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'library:remove', [id]) }
    }
  })

  ipcMain.handle(
    'chunks:run',
    async (_, bookId: string, params: ChunkParams): Promise<ChunksRunResult> => {
      try {
        return { ok: true, data: await runChunking(bookId, params) }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'chunks:run', [bookId, params]) }
      }
    }
  )

  ipcMain.handle('chunks:list', async (_, bookId: string): Promise<ChunksListResult> => {
    try {
      return { ok: true, sets: await listChunkSets(bookId) }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'chunks:list', [bookId]) }
    }
  })

  ipcMain.handle(
    'chunks:get',
    async (_, bookId: string, strategyId: string): Promise<ChunksGetResult> => {
      try {
        return { ok: true, data: await getChunkSet(bookId, strategyId) }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'chunks:get', [bookId, strategyId]) }
      }
    }
  )

  ipcMain.handle(
    'embeddings:run',
    async (_, bookId: string, strategyId: string): Promise<EmbedRunIpcResult> => {
      try {
        return { ok: true, data: await runEmbedding(bookId, strategyId) }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'embeddings:run', [bookId, strategyId]) }
      }
    }
  )

  ipcMain.handle('embeddings:list', async (_, bookId: string): Promise<EmbeddingsListIpcResult> => {
    try {
      return { ok: true, sets: await listEmbeddingSets(bookId) }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'embeddings:list', [bookId]) }
    }
  })

  ipcMain.handle(
    'embeddings:remove',
    async (_, bookId: string, strategyId: string): Promise<EmbeddingsRemoveIpcResult> => {
      try {
        await removeEmbeddings(bookId, strategyId)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'embeddings:remove', [bookId, strategyId])
        }
      }
    }
  )

  ipcMain.handle('settings:hasOpenaiKey', async (): Promise<SettingsHasKeyResult> => {
    try {
      return { ok: true, hasKey: await hasOpenaiKey() }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'settings:hasOpenaiKey', []) }
    }
  })

  ipcMain.handle('settings:setOpenaiKey', async (_, key: string): Promise<SettingsSetKeyResult> => {
    try {
      await setOpenaiKey(key)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'settings:setOpenaiKey', [key]) }
    }
  })

  ipcMain.handle('settings:clearOpenaiKey', async (): Promise<SettingsClearKeyResult> => {
    try {
      await clearOpenaiKey()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'settings:clearOpenaiKey', []) }
    }
  })

  ipcMain.handle('settings:hasLangsmithKey', async (): Promise<SettingsHasKeyResult> => {
    try {
      return { ok: true, hasKey: await hasLangsmithKey() }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'settings:hasLangsmithKey', []) }
    }
  })

  ipcMain.handle(
    'settings:setLangsmithKey',
    async (_, key: string): Promise<SettingsSetKeyResult> => {
      try {
        await setLangsmithKey(key)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'settings:setLangsmithKey', [key]) }
      }
    }
  )

  ipcMain.handle('settings:clearLangsmithKey', async (): Promise<SettingsClearKeyResult> => {
    try {
      await clearLangsmithKey()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'settings:clearLangsmithKey', []) }
    }
  })

  ipcMain.handle('settings:getLangsmithProject', async (): Promise<SettingsGetStringResult> => {
    try {
      return { ok: true, value: await getLangsmithProject() }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'settings:getLangsmithProject', []) }
    }
  })

  ipcMain.handle(
    'settings:setLangsmithProject',
    async (_, name: string): Promise<SettingsSetStringResult> => {
      try {
        await setLangsmithProject(name)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'settings:setLangsmithProject', [name])
        }
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
        return {
          ok: false,
          error: captureIpcError(err, 'ask:run', [bookId, strategyId, query, k])
        }
      }
    }
  )

  ipcMain.handle('evals:list', async (_, bookId: string): Promise<EvalSetsListIpcResult> => {
    try {
      return { ok: true, sets: await listEvalSets(bookId) }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'evals:list', [bookId]) }
    }
  })

  ipcMain.handle(
    'evals:get',
    async (_, bookId: string, setId: string): Promise<EvalSetGetIpcResult> => {
      try {
        return { ok: true, data: await getEvalSet(bookId, setId) }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'evals:get', [bookId, setId]) }
      }
    }
  )

  ipcMain.handle(
    'evals:create',
    async (_, bookId: string, setId: string): Promise<EvalSetCreateIpcResult> => {
      try {
        return { ok: true, data: await createEvalSet(bookId, setId) }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'evals:create', [bookId, setId]) }
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
        return { ok: false, error: captureIpcError(err, 'evals:delete', [bookId, setId]) }
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
      searchQuery: string,
      goldSpans: GoldSpan[],
      notes?: string
    ): Promise<EvalCaseAddIpcResult> => {
      try {
        return {
          ok: true,
          data: await addCase(bookId, setId, question, searchQuery, goldSpans, notes)
        }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'evals:addCase', [
            bookId,
            setId,
            question,
            searchQuery,
            goldSpans,
            notes
          ])
        }
      }
    }
  )

  ipcMain.handle(
    'evals:removeCase',
    async (_, bookId: string, setId: string, caseId: string): Promise<EvalCaseRemoveIpcResult> => {
      try {
        await removeCase(bookId, setId, caseId)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'evals:removeCase', [bookId, setId, caseId])
        }
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
      updates: { question?: string; searchQuery?: string; goldSpans?: GoldSpan[]; notes?: string }
    ): Promise<EvalCaseUpdateIpcResult> => {
      try {
        return { ok: true, data: await updateCase(bookId, setId, caseId, updates) }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'evals:updateCase', [bookId, setId, caseId, updates])
        }
      }
    }
  )

  ipcMain.handle(
    'evals:locate',
    async (_, bookId: string, quote: string): Promise<EvalLocateIpcResult> => {
      try {
        const result = await locateQuote(bookId, quote)
        if (!result) {
          return {
            ok: false,
            error: { message: 'Quote not found in any spine item' }
          }
        }
        return { ok: true, data: result }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'evals:locate', [bookId, quote]) }
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
      k: number,
      mode: 'retrieval' | 'agentic',
      caseIds?: string[]
    ): Promise<EvalRunIpcResult> => {
      try {
        return { ok: true, data: await runEval(bookId, setId, strategyId, k, mode, caseIds) }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'evals:run', [bookId, setId, strategyId, k, mode, caseIds])
        }
      }
    }
  )

  ipcMain.handle('evals:listRuns', async (_, bookId: string): Promise<EvalRunsListIpcResult> => {
    try {
      return { ok: true, runs: await listEvalRuns(bookId) }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'evals:listRuns', [bookId]) }
    }
  })

  ipcMain.handle(
    'evals:getRun',
    async (_, bookId: string, runId: string): Promise<EvalRunGetIpcResult> => {
      try {
        return { ok: true, data: await getEvalRun(bookId, runId) }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'evals:getRun', [bookId, runId]) }
      }
    }
  )

  ipcMain.handle(
    'evals:autoGenerate',
    async (
      _,
      bookId: string,
      setId: string,
      strategyId: string,
      count: number
    ): Promise<EvalAutoGenerateIpcResult> => {
      try {
        return {
          ok: true,
          data: await autoGenerateCases(bookId, setId, strategyId, count)
        }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'evals:autoGenerate', [bookId, setId, strategyId, count])
        }
      }
    }
  )

  ipcMain.handle(
    'evals:backfillSearchQueries',
    async (_, bookId: string, setId: string): Promise<EvalAutoGenerateIpcResult> => {
      try {
        return {
          ok: true,
          data: await backfillSearchQueries(bookId, setId)
        }
      } catch (err) {
        return {
          ok: false,
          error: captureIpcError(err, 'evals:backfillSearchQueries', [bookId, setId])
        }
      }
    }
  )

  // Error/log infrastructure
  ipcMain.handle('errors:list', async (): Promise<ErrorsListIpcResult> => {
    try {
      return { ok: true, entries: listErrors() }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'errors:list', []) }
    }
  })

  ipcMain.handle('errors:bundle', async (_, errorId: string): Promise<ErrorsBundleIpcResult> => {
    try {
      return { ok: true, markdown: buildBundle(errorId) }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'errors:bundle', [errorId]) }
    }
  })

  ipcMain.handle('errors:bundleAll', async (): Promise<ErrorsBundleIpcResult> => {
    try {
      return { ok: true, markdown: buildBundleAll() }
    } catch (err) {
      return { ok: false, error: captureIpcError(err, 'errors:bundleAll', []) }
    }
  })

  ipcMain.handle(
    'errors:report',
    async (_, report: RendererErrorReport): Promise<ErrorsReportIpcResult> => {
      try {
        const rec = recordRendererReport(report)
        return { ok: true, errorId: rec.id }
      } catch (err) {
        return { ok: false, error: captureIpcError(err, 'errors:report', [report]) }
      }
    }
  )

  ipcMain.on('log:forward', (_, entry: LogEntry) => {
    try {
      ingestRendererLog(entry)
    } catch (err) {
      log.warn('log', `failed to ingest renderer log: ${(err as Error).message}`)
    }
  })

  // Main-process unhandled errors
  process.on('uncaughtException', (err) => {
    log.error('process', `uncaughtException: ${err.message}`, { stack: err.stack })
    captureIpcError(err, '<uncaughtException>', [])
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    log.error('process', `unhandledRejection: ${err.message}`, { stack: err.stack })
    captureIpcError(err, '<unhandledRejection>', [])
  })

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
