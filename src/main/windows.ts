import { app, BrowserWindow, dialog, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'
import { send } from './ipc'
import { APP_ORIGIN } from './protocol'
import { appImageFile } from './util/appImage'

/** Document windows (print jobs use hidden windows that are not part of this set). */
const windows = new Set<BrowserWindow>()
let lastFocused: BrowserWindow | null = null

/** Windows whose renderer has booted and listens for main-process events. */
const readyWindows = new WeakSet<BrowserWindow>()
/** Files waiting for a window's renderer to finish booting. */
const fileQueues = new WeakMap<BrowserWindow, string[]>()
/** Files handed over before any window existed (command line, macOS open-file at launch). */
const launchQueue: string[] = []
/** The files each window has open, so a window whose renderer crashed can reopen them. */
const openFilesByWindow = new WeakMap<BrowserWindow, string[]>()

/** Windows that may close without asking: their renderer confirmed, crashed or never booted. */
const closeApproved = new WeakSet<BrowserWindow>()
/** Windows to destroy rather than close: their renderer hangs or is gone. */
const forceClosed = new WeakSet<BrowserWindow>()

interface CloseRequest {
  promise: Promise<boolean>
  /** `force`: the renderer hangs or crashed, so the window is destroyed instead of closed. */
  settle(ok: boolean, force?: boolean): void
  startedAt: number
  timer: NodeJS.Timeout
  checking: boolean
  /** Dismisses the "not responding" message when the renderer answers after all. */
  dialogAbort: AbortController | null
  /** Don't ask "close anyway?" again before this time (the user chose to wait). */
  quietUntil: number
}
/** Open "may this window close?" questions to renderers. */
const closeRequests = new Map<BrowserWindow, CloseRequest>()

/** How often a pending close request checks that the renderer is still alive. */
const WATCHDOG_MS = 4000
/** How long the renderer has to answer a liveness probe. */
const PROBE_MS = 2500

type QuitPhase = 'idle' | 'asking' | 'approved'
let quitPhase: QuitPhase = 'idle'
let relaunchOnQuit = false

/** An update installer waiting for the quit to be approved (quitForUpdate). */
interface PendingInstall {
  install: () => void
  settle: (approved: boolean) => void
  promise: Promise<boolean>
}
let pendingInstall: PendingInstall | null = null

const forceClose = () => !!process.env.FARTCROBAT_FORCE_CLOSE

export function isAppWindow(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && windows.has(win) && !win.isDestroyed()
}

export function currentWindow(): BrowserWindow | null {
  // Windows already on their way out (closing after the user agreed) don't count.
  const usable = (w: BrowserWindow | null): w is BrowserWindow => isAppWindow(w) && !closeApproved.has(w)
  const focused = BrowserWindow.getFocusedWindow()
  if (usable(focused)) return focused
  if (usable(lastFocused)) return lastFocused
  const all = allWindows().filter(usable)
  return all[all.length - 1] ?? null
}

export function allWindows(): BrowserWindow[] {
  return [...windows].filter((w) => !w.isDestroyed())
}

/** Brings a window to the front (restoring it when minimized). */
export function showWindow(win: BrowserWindow) {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!process.env.FARTCROBAT_HIDDEN && readyToShow.has(win) && !win.isVisible()) win.show()
  if (win.isVisible()) win.focus()
}
const readyToShow = new WeakSet<BrowserWindow>()

// ---- files ------------------------------------------------------------------------------------

/**
 * Opens files in the current window, creating one when none exists (macOS keeps running without
 * windows). Files for a window whose renderer is still loading wait until it has booted, so
 * nothing is lost when several files arrive at once. With no files, just brings the app forward.
 */
export function deliverFiles(paths: string[]) {
  if (!app.isReady()) {
    launchQueue.push(...paths)
    return
  }
  const win = currentWindow() ?? createWindow()
  showWindow(win)
  if (!paths.length) return
  if (readyWindows.has(win)) send(win, 'app:openFiles', paths)
  else queueFor(win).push(...paths)
}

function queueFor(win: BrowserWindow): string[] {
  let q = fileQueues.get(win)
  if (!q) fileQueues.set(win, (q = []))
  return q
}

/**
 * Called by a renderer once it listens for events (app:launchFiles): marks the window ready and
 * returns the files waiting for it.
 */
export function takeLaunchFiles(win: BrowserWindow | null): string[] {
  if (!win || !windows.has(win)) return launchQueue.splice(0)
  readyWindows.add(win)
  const files = [...launchQueue.splice(0), ...queueFor(win).splice(0)]
  return [...new Set(files)]
}

/** The renderer reports which files it has open (used to reopen them after a crash). */
export function setOpenFiles(win: BrowserWindow | null, paths: string[]) {
  if (win && windows.has(win)) openFilesByWindow.set(win, paths.filter((p) => typeof p === 'string' && p.length > 0))
}

// ---- closing windows ---------------------------------------------------------------------------

/** Whether the renderer has to be asked before the window closes (it may hold unsaved work). */
function mayHoldUnsavedWork(win: BrowserWindow): boolean {
  return !win.isDestroyed() && readyWindows.has(win) && !win.webContents.isCrashed()
}

function approveAndClose(win: BrowserWindow) {
  closeApproved.add(win)
  if (win.isDestroyed()) return
  // A hung or crashed renderer cannot run the page's unload handlers: don't wait for it.
  if (forceClosed.has(win) || win.webContents.isCrashed()) win.destroy()
  else win.close()
}

/** Resolves with whether the renderer answered within `ms` (false when it hangs or is gone). */
function rendererAlive(win: BrowserWindow, ms: number): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isCrashed()) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    win.webContents.executeJavaScript('1', false).then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      }
    )
  })
}

async function checkRenderer(win: BrowserWindow, req: CloseRequest) {
  if (req.checking || closeRequests.get(win) !== req) return
  if (win.isDestroyed() || win.webContents.isCrashed()) {
    req.settle(true, true)
    return
  }
  if (Date.now() < req.quietUntil) return
  req.checking = true
  try {
    if (await rendererAlive(win, PROBE_MS)) return
    if (closeRequests.get(win) !== req) return
    req.dialogAbort = new AbortController()
    const { response } = await dialog.showMessageBox(win, {
      signal: req.dialogAbort.signal,
      type: 'warning',
      title: 'Fartcrobat is not responding',
      message: 'This window is not responding.',
      detail: 'You can wait for it to finish, or close it now. Changes you have not saved in this window will be lost.',
      buttons: ['Close Anyway', 'Wait'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    req.dialogAbort = null
    if (closeRequests.get(win) !== req) return
    if (response === 0) req.settle(true, true)
    else req.quietUntil = Date.now() + 15000
  } finally {
    req.checking = false
  }
}

/**
 * Asks the window's renderer whether it may close (it asks the user about unsaved documents).
 * Resolves true when it may. A renderer that crashed or stops responding cannot block closing:
 * the user is offered to close the window anyway.
 */
function requestClose(win: BrowserWindow): Promise<boolean> {
  const existing = closeRequests.get(win)
  if (existing) {
    // Asked again (another click on X, Quit again): bring the question back to the front, and
    // check at once whether the renderer still responds.
    showWindow(win)
    if (Date.now() - existing.startedAt > 1500) void checkRenderer(win, existing)
    return existing.promise
  }
  if (!mayHoldUnsavedWork(win)) return Promise.resolve(true)
  let settle!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => (settle = r))
  const req: CloseRequest = {
    promise,
    settle: (ok, force = false) => {
      if (closeRequests.get(win) !== req) return
      closeRequests.delete(win)
      clearInterval(req.timer)
      req.dialogAbort?.abort()
      if (ok && force) forceClosed.add(win)
      settle(ok)
    },
    startedAt: Date.now(),
    timer: setInterval(() => void checkRenderer(win, req), WATCHDOG_MS),
    checking: false,
    dialogAbort: null,
    quietUntil: 0
  }
  closeRequests.set(win, req)
  showWindow(win)
  send(win, 'app:beforeQuit')
  return promise
}

/** The renderer's answer to app:beforeQuit (app:quitConfirmed / app:quitCancelled). */
export function answerCloseRequest(win: BrowserWindow | null, ok: boolean) {
  if (!win || !windows.has(win)) return
  const req = closeRequests.get(win)
  if (req) req.settle(ok)
  else if (ok) approveAndClose(win) // a renderer closing its own window
}

/** Closes a window whose renderer already closed its documents. */
export function confirmClose(win: BrowserWindow) {
  answerCloseRequest(win, true)
}

// ---- quitting -----------------------------------------------------------------------------------

/**
 * Quitting asks one window at a time (the focused one first) about its unsaved documents, and
 * closes each window once it agreed. Cancelling stops the quit and keeps the remaining windows.
 */
async function runQuitSequence() {
  quitPhase = 'asking'
  let next: BrowserWindow | undefined = currentWindow() ?? undefined
  for (;;) {
    if (!next || next.isDestroyed() || closeApproved.has(next)) next = allWindows().find((w) => !closeApproved.has(w))
    if (!next) break
    const ok = await requestClose(next)
    if (!ok) {
      cancelQuit()
      return
    }
    approveAndClose(next)
    next = undefined
  }
  approveQuit()
  app.quit()
}

/**
 * Every window agreed to close: the app quits, and a pending update installer starts. When the
 * installer cannot start, the app starts again instead.
 */
function approveQuit() {
  quitPhase = 'approved'
  const pending = pendingInstall
  if (!pending) return
  pendingInstall = null
  // The installer starts the new version itself.
  relaunchOnQuit = false
  // The new version may start before this process has gone: it must not find the single-instance
  // lock still held and hand its start-up over to a process that is quitting.
  app.releaseSingleInstanceLock()
  try {
    pending.install()
  } catch (err) {
    // The windows are closed already: start this version again rather than leave the person with
    // neither the app nor the update.
    console.error('Could not start the update installer', err)
    relaunchOnQuit = true
  }
  pending.settle(true)
}

/** The person cancelled the quit: everything stays open, and a pending update stays ready. */
function cancelQuit() {
  quitPhase = 'idle'
  relaunchOnQuit = false
  const pending = pendingInstall
  pendingInstall = null
  pending?.settle(false)
}

/** Quits the app (File > Exit, Cmd+Q, the Dock, logging out), asking about unsaved changes first. */
export function quitApp() {
  app.quit()
}

/** Restarts the app after the normal quit flow (unsaved changes are asked about first). */
export function relaunchApp() {
  relaunchOnQuit = true
  app.quit()
}

/**
 * Restart now for an update: the normal quit flow (each window asks about its unsaved documents,
 * and Cancel stops it), then `install` runs once every window agreed to close, just before the app
 * exits. `install` starts the new version itself. Resolves with whether the quit went ahead.
 */
export function quitForUpdate(install: () => void): Promise<boolean> {
  if (pendingInstall) return pendingInstall.promise
  let settle!: (approved: boolean) => void
  const promise = new Promise<boolean>((resolve) => (settle = resolve))
  pendingInstall = { install, settle, promise }
  app.quit()
  return promise
}

/** Kept for compatibility: the quit flow is now driven by before-quit. */
export function setQuitting(on: boolean) {
  if (!on && quitPhase === 'approved') quitPhase = 'idle'
}

/**
 * Wires the app-level quit flow. `onQuit` runs once the app really exits (flush settings, remove
 * temporary files, stop print jobs).
 */
export function installQuitHandling(onQuit: () => void) {
  app.on('before-quit', (e) => {
    if (quitPhase === 'approved' || forceClose()) {
      approveQuit()
      return
    }
    const waiting = allWindows().filter((w) => !closeApproved.has(w) && mayHoldUnsavedWork(w))
    if (!waiting.length) {
      approveQuit()
      return
    }
    e.preventDefault()
    if (quitPhase === 'asking') {
      const asked = [...closeRequests.keys()][0]
      if (asked) void requestClose(asked)
      return
    }
    void runQuitSequence()
  })
  app.on('will-quit', () => {
    onQuit()
    if (relaunchOnQuit) {
      // An AppImage starts again from its file: the folder this process runs from goes with it.
      const appImage = appImageFile(process.execPath, process.env)
      app.relaunch(appImage ? { execPath: appImage, args: process.argv.slice(1) } : undefined)
    }
  })
}

// ---- crashes --------------------------------------------------------------------------------------

async function offerReload(win: BrowserWindow, reason: string) {
  const files = openFilesByWindow.get(win) ?? []
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    title: 'Fartcrobat',
    message: 'This window stopped working.',
    detail:
      (reason === 'oom' ? 'It ran out of memory. ' : '') +
      (files.length
        ? `Reload it to reopen the ${files.length === 1 ? 'document' : `${files.length} documents`} that ${files.length === 1 ? 'was' : 'were'} open. Changes that were not saved are lost.`
        : 'Reload it to continue. Changes that were not saved are lost.'),
    buttons: ['Reload', 'Close Window'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (win.isDestroyed()) return
  if (response === 1) {
    approveAndClose(win)
    return
  }
  queueFor(win).push(...files.filter((f) => !queueFor(win).includes(f)))
  win.webContents.reload()
}

// ---- creating windows ---------------------------------------------------------------------------

export function createWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1480, Math.round(width * 0.9)),
    height: Math.min(980, Math.round(height * 0.92)),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Fartcrobat',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f4f4f4',
    icon: join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium on Linux downloads Hunspell dictionaries from Google on first use; Fartcrobat
      // promises to work offline, so spell checking uses only the OS checker (Windows, macOS).
      spellcheck: process.platform !== 'linux'
    }
  })
  windows.add(win)
  lastFocused = win

  win.on('focus', () => (lastFocused = win))
  win.once('ready-to-show', () => {
    readyToShow.add(win)
    if (!process.env.FARTCROBAT_HIDDEN) win.show()
  })
  win.on('closed', () => {
    windows.delete(win)
    if (lastFocused === win) lastFocused = null
    const req = closeRequests.get(win)
    if (req) req.settle(true)
    // Hidden print windows must not keep the app alive on Windows/Linux.
    if (allWindows().length === 0 && process.platform !== 'darwin') app.quit()
  })
  // Let the renderer ask about unsaved documents before the window goes away.
  win.on('close', (e) => {
    if (closeApproved.has(win) || forceClose() || !mayHoldUnsavedWork(win)) return
    e.preventDefault()
    void requestClose(win).then((ok) => {
      if (ok) approveAndClose(win)
    })
  })
  win.on('unresponsive', () => {
    const req = closeRequests.get(win)
    if (req) void checkRenderer(win, req)
  })
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) readyWindows.delete(win)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    readyWindows.delete(win)
    const req = closeRequests.get(win)
    if (req) {
      req.settle(true, true) // nothing left to save
      return
    }
    if (details.reason === 'clean-exit' || quitPhase === 'approved' || win.isDestroyed() || closeApproved.has(win)) return
    void offerReload(win, details.reason)
  })
  win.on('enter-full-screen', () => send(win, 'window:fullScreenChanged', true))
  win.on('leave-full-screen', () => send(win, 'window:fullScreenChanged', false))

  // Never navigate the app window away; open web links in the browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if ((devUrl && url.startsWith(devUrl)) || url.startsWith(APP_ORIGIN)) return
    e.preventDefault()
  })

  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}
