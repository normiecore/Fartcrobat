import { app, BrowserWindow, clipboard, ClipboardItem, dialog, session, shell, type SaveDialogOptions as ElectronSaveDialogOptions } from 'electron'
import { existsSync, writeFileSync, type Stats } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, extname } from 'node:path'
import type { SaveDialogOptions } from '@shared/types'
import type { MainContext, MainFeatureModule } from './context'
import { defaultAppStatus, setDefaultApp } from './defaultApp'
import { handle, send } from './ipc'
import { applyDefaultMenu, applyMenu } from './menu'
import { registerPasswordHandlers } from './passwords'
import { destroyPrintWindows, listPrinters, printImages } from './print'
import { registerAppScheme, serveRenderer } from './protocol'
import { store } from './store'
import { sessionTemp } from './temp'
import { atomicWrite } from './util/atomicWrite'
import { filesFromArgv, openableFile } from './util/launchPaths'
import { TempFiles } from './util/tempFiles'
import { unsafeToOpenReason } from './util/unsafeFiles'
import {
  allWindows,
  answerCloseRequest,
  createWindow,
  currentWindow,
  deliverFiles,
  installQuitHandling,
  quitApp,
  relaunchApp,
  setOpenFiles,
  takeLaunchFiles
} from './windows'

app.setName('Fartcrobat')
if (process.env.FARTCROBAT_USER_DATA) app.setPath('userData', process.env.FARTCROBAT_USER_DATA)
// Match the installer's shortcuts so the taskbar groups the window with the pinned icon.
if (process.platform === 'win32') app.setAppUserModelId('org.fartcrobat.app')

/**
 * argv entries to skip: the executable. When running unpackaged the app path follows it; it is
 * not an openable file (index.js, a folder), and Chromium may reorder a second instance's
 * arguments, so it is filtered out like any other non-document argument instead of by position.
 */
const ARGV_SKIP = 1

// One running instance: a second launch (e.g. double-clicking another PDF) opens a tab here and
// the second process exits straight away without starting anything.
const primaryInstance = !!process.env.FARTCROBAT_MULTI_INSTANCE || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
else start()

function start() {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    // Relative paths are relative to the second process's folder; with no files this just
    // brings the window forward (launching the app again from the Start menu or the dock).
    deliverFiles(filesFromArgv(argv, workingDirectory || process.cwd(), ARGV_SKIP))
  })
  app.on('open-file', (e, path) => {
    e.preventDefault()
    const file = openableFile(path, process.cwd())
    if (file) deliverFiles([file])
  })

  registerAppScheme()
  deliverFiles(filesFromArgv(process.argv, process.cwd(), ARGV_SKIP))
  if (store().prefs.hardwareAcceleration === false) app.disableHardwareAcceleration()
  installQuitHandling(() => {
    destroyPrintWindows()
    sessionTemp().cleanup()
    store().flush()
  })

  app.whenReady().then(() => {
    TempFiles.sweepStale(app.getPath('temp'))
    // No dictionary downloads on Linux (see createWindow).
    if (process.platform === 'linux') session.defaultSession.setSpellCheckerEnabled(false)
    serveRenderer()
    registerCoreHandlers()
    registerFeatureHandlers()
    applyDefaultMenu()
    createWindow()
    app.on('activate', () => {
      if (allWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    store().flush()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    store().flush()
  })
}

/** Existence check that never blocks for long on an unreachable network drive. */
function existsWithin(path: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Unknown after the timeout: keep the entry (it may be on a slow share).
    const timer = setTimeout(() => resolve(true), ms)
    access(path).then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        resolve(err.code !== 'ENOENT' && err.code !== 'ENOTDIR')
      }
    )
  })
}

/** Runs `fn` over `items` with at most `limit` running at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

/** The extension a save dialog's filters ask for, when the chosen name has none of them. */
function missingExtension(path: string, filters: SaveDialogOptions['filters']): string | null {
  const concrete = (filters ?? []).flatMap((f) => f.extensions).filter((e) => e && e !== '*')
  if (!concrete.length) return null
  const ext = extname(path).slice(1).toLowerCase()
  if (concrete.some((e) => e.toLowerCase() === ext)) return null
  // With an "All files" filter, a name that has some extension is what the user meant.
  if (ext && (filters ?? []).some((f) => f.extensions.includes('*'))) return null
  return concrete[0]
}

async function showSaveDialog(win: BrowserWindow | null, opts: SaveDialogOptions): Promise<string | null> {
  let defaultPath = opts.defaultPath
  for (;;) {
    const options: ElectronSaveDialogOptions = {
      title: opts.title,
      defaultPath,
      filters: opts.filters,
      // Linux asks before replacing a file only when told to; macOS needs "New Folder" enabled.
      properties: ['showOverwriteConfirmation', 'createDirectory']
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return null
    const ext = missingExtension(res.filePath, opts.filters)
    if (!ext) return res.filePath
    // The dialog checked the name as typed; the extension added now may name an existing file.
    const path = `${res.filePath}.${ext}`
    if (!existsSync(path)) return path
    const box = {
      type: 'warning' as const,
      title: opts.title ?? 'Save',
      message: `“${basename(path)}” already exists. Do you want to replace it?`,
      detail: 'Replacing it overwrites its current contents.',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const { response } = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
    if (response === 0) return path
    defaultPath = path
  }
}

/** Marks a file Fartcrobat extracted from a PDF as coming from the Internet (Windows SmartScreen, Office Protected View). */
function markOfTheWeb(path: string) {
  if (process.platform !== 'win32') return
  try {
    writeFileSync(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
  } catch {}
}

function registerCoreHandlers() {
  handle('file:openDialog', async (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const props: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[] = [opts.directory ? 'openDirectory' : 'openFile']
    if (opts.multiple) props.push('multiSelections')
    if (opts.directory) props.push('createDirectory')
    const options = { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters, properties: props }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled ? [] : res.filePaths
  })
  handle('file:saveDialog', (e, opts) => showSaveDialog(BrowserWindow.fromWebContents(e.sender), opts))
  handle('file:read', async (_e, path) => new Uint8Array(await readFile(path)))
  handle('file:write', async (_e, path, data) => {
    await atomicWrite(path, data)
    if (sessionTemp().contains(path)) markOfTheWeb(path)
  })
  handle('file:exists', (_e, path) => existsWithin(path, 5000))
  handle('file:stat', async (_e, path) => {
    try {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  })
  // A private folder per file (only this user can read it), removed when the app quits.
  handle('file:tempPath', (_e, name) => sessionTemp().pathFor(name))

  handle('app:launchFiles', (e) => takeLaunchFiles(BrowserWindow.fromWebContents(e.sender)))
  handle('app:systemInfo', () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userDataPath: app.getPath('userData'),
    documentsPath: app.getPath('documents'),
    tempPath: app.getPath('temp'),
    isPackaged: app.isPackaged,
    userName: (() => {
      try {
        return userInfo().username
      } catch {
        return ''
      }
    })()
  }))
  handle('app:quit', () => quitApp())
  handle('app:quitConfirmed', (e) => answerCloseRequest(BrowserWindow.fromWebContents(e.sender), true))
  handle('app:quitCancelled', (e) => answerCloseRequest(BrowserWindow.fromWebContents(e.sender), false))
  handle('app:relaunch', () => {
    store().flush()
    relaunchApp()
  })

  handle('prefs:get', () => store().prefs)
  handle('prefs:set', (_e, patch) => store().setPrefs(patch))
  handle('store:get', (_e, key) => store().get(key))
  handle('store:set', (_e, key, value) => store().set(key, value))
  handle('recent:list', async () => {
    const list = store().recent
    const exists = await mapLimit(list, 4, (r) => existsWithin(r.path, 1500))
    return list.filter((_r, i) => exists[i])
  })
  handle('recent:add', (_e, file) => store().addRecent(file))
  handle('recent:remove', (_e, path) => store().removeRecent(path))
  handle('recent:clear', () => store().clearRecent())

  handle('menu:set', (_e, model) => applyMenu(model))
  handle('window:setTitle', (e, title) => BrowserWindow.fromWebContents(e.sender)?.setTitle(title))
  handle('window:setFullScreen', (e, on) => BrowserWindow.fromWebContents(e.sender)?.setFullScreen(on))
  handle('window:isFullScreen', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isFullScreen())
  handle('window:new', () => {
    createWindow()
  })
  handle('window:setOpenFiles', (e, paths) => setOpenFiles(BrowserWindow.fromWebContents(e.sender), Array.isArray(paths) ? paths : []))
  handle('window:editCommand', (e, action) => {
    const wc = e.sender
    switch (action) {
      case 'undo':
        return wc.undo()
      case 'redo':
        return wc.redo()
      case 'cut':
        return wc.cut()
      case 'copy':
        return wc.copy()
      case 'paste':
        return wc.paste()
      case 'delete':
        return wc.delete()
      case 'selectAll':
        return wc.selectAll()
    }
  })

  handle('shell:openExternal', async (_e, url) => {
    if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url)
  })
  handle('shell:showItemInFolder', (_e, path) => shell.showItemInFolder(path))
  handle('shell:openPath', async (_e, path) => {
    // Opening a file from a PDF (attachment, link) must never start a program.
    let stats: Stats | null = null
    try {
      stats = await stat(path)
    } catch {}
    const refused = unsafeToOpenReason(path, stats)
    if (refused) return refused
    return shell.openPath(path)
  })

  handle('defaultApp:status', () => defaultAppStatus())
  handle('defaultApp:set', () => setDefaultApp())

  handle('print:images', (_e, job) => printImages(job))
  handle('print:printers', (e) => listPrinters(BrowserWindow.fromWebContents(e.sender)))

  handle('clipboard:writeText', (_e, text) => clipboard.writeText(text))
  handle('clipboard:readImage', async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      return new Uint8Array(await blob.arrayBuffer())
    }
    return null
  })
  handle('clipboard:writeImage', (_e, png) =>
    clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })])
  )

  registerPasswordHandlers()
}

function registerFeatureHandlers() {
  const ctx: MainContext = { handle, send, store, currentWindow }
  const modules = import.meta.glob<MainFeatureModule>('../features/*/main.ts', { eager: true })
  for (const [path, mod] of Object.entries(modules)) {
    try {
      mod.register(ctx)
    } catch (err) {
      console.error(`Feature ${path} failed to register`, err)
    }
  }
}
