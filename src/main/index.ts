import { app, BrowserWindow, clipboard, ClipboardItem, dialog, shell, type SaveDialogOptions as ElectronSaveDialogOptions } from 'electron'
import { existsSync, type Stats } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, extname, join } from 'node:path'
import { LEGACY, PRODUCT_NAME, userDataFolderName, userDataOverride } from '@shared/identity'
import { isRemotePath } from '@shared/remotePath'
import type { SaveDialogOptions } from '@shared/types'
import type { MainContext, MainFeatureModule } from './context'
import { appVersion } from './appVersion'
import { registerCertKeyHandlers } from './certkeys'
import { defaultAppStatus, refreshLinuxDesktopFile, setDefaultApp } from './defaultApp'
import { handle, send } from './ipc'
import { applyDefaultMenu, applyMenu } from './menu'
import { registerPasswordHandlers } from './passwords'
import { destroyPrintWindows, listPrinters, printImages } from './print'
import { registerAppScheme, serveRenderer } from './protocol'
import { store } from './store'
import { registerTabMoveHandlers } from './tabMoves'
import { sessionTemp } from './temp'
import { atomicWrite } from './util/atomicWrite'
import { externalUrlToOpen } from './util/externalUrl'
import { markAsDownloaded } from './util/markOfTheWeb'
import { filesFromArgv, openableFile } from './util/launchPaths'
import { removeLegacyUpdaterCache } from './util/legacyUpdaterCache'
import { keepSpellCheckOffline } from './util/spellcheck'
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

app.setName(PRODUCT_NAME)
pinUserData()
// Match the installer's shortcuts so the taskbar groups the window with the pinned icon.
if (process.platform === 'win32') app.setAppUserModelId(LEGACY.appId)
// Before any session exists: on Linux Chromium would otherwise download spell-check dictionaries
// from Google as each one starts (util/spellcheck.ts).
app.on('session-created', (s) => keepSpellCheckOffline(s))
// Lets form scripts' regular expressions run on V8's linear-time engine (the `l` flag), so a
// pattern in a PDF cannot freeze the window by backtracking (forms-fill/js/regex.ts).
app.commandLine.appendSwitch('js-flags', '--enable-experimental-regexp-engine')

/**
 * argv entries to skip: the executable. When running unpackaged the app path follows it; it is
 * not an openable file (index.js, a folder), and Chromium may reorder a second instance's
 * arguments, so it is filtered out like any other non-document argument instead of by position.
 */
const ARGV_SKIP = 1

/**
 * The userData folder: one named in the environment (development, tests), else the folder from
 * before a rename when this computer has one (src/shared/identity.ts), else Electron's default.
 * Runs before anything reads userData, the single-instance lock included, so a renamed copy and
 * an older one share the lock as well as the settings.
 */
function pinUserData() {
  const named = userDataOverride(process.env)
  if (named) return app.setPath('userData', named)
  const appData = app.getPath('appData')
  const folder = userDataFolderName((name) => existsSync(join(appData, name)))
  if (folder !== PRODUCT_NAME) app.setPath('userData', join(appData, folder))
}

// One running instance: a second launch (e.g. double-clicking another PDF) opens a tab here and
// the second process exits straight away without starting anything.
const primaryInstance = !!process.env.INKMOOR_MULTI_INSTANCE || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
else start()

function start() {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    // Relative paths are relative to the second process's folder; with no files this just
    // brings the window forward (launching the app again from the Start menu or the dock).
    deliverFiles(filesFromArgv(argv, workingDirectory || process.cwd(), ARGV_SKIP), { fromOtherApp: true })
  })
  app.on('open-file', (e, path) => {
    e.preventDefault()
    const file = openableFile(path, process.cwd())
    if (file) deliverFiles([file], { fromOtherApp: true })
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
    // A desktop entry written under the name the app had before a rename gets the current one.
    if (process.platform === 'linux') refreshLinuxDesktopFile()
    // The updater of the version before the rename downloaded into a folder nothing uses now.
    if (app.isPackaged) removeLegacyUpdaterCache()
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
  handle('file:write', async (_e, path, data, opts) => {
    await atomicWrite(path, data)
    // Attachments carry the Internet mark wherever they are written (opened or saved as).
    if (opts?.fromDocument || sessionTemp().contains(path)) await markAsDownloaded(path)
  })
  // Looking at a network path signs in to that computer: only once the person chose or confirmed it.
  handle('file:exists', (_e, path, opts) => (isRemotePath(path, process.platform) && !opts?.allowRemote ? false : existsWithin(path, 5000)))
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
    appVersion: appVersion(),
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
    const target = externalUrlToOpen(url)
    if (target) await shell.openExternal(target)
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
  registerCertKeyHandlers()
  registerTabMoveHandlers()
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
