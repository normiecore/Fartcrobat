import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'
import { send } from './ipc'
import { APP_ORIGIN } from './protocol'

const windows = new Set<BrowserWindow>()
const quitConfirmed = new WeakSet<BrowserWindow>()
let lastFocused: BrowserWindow | null = null

export function currentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && windows.has(focused)) return focused
  if (lastFocused && !lastFocused.isDestroyed()) return lastFocused
  const all = [...windows].filter((w) => !w.isDestroyed())
  return all[all.length - 1] ?? null
}

export function allWindows(): BrowserWindow[] {
  return [...windows].filter((w) => !w.isDestroyed())
}

let quitting = false

/** Called on before-quit so that, once every window confirmed, the app really exits (macOS Cmd+Q). */
export function setQuitting(on: boolean) {
  quitting = on
}

export function confirmClose(win: BrowserWindow) {
  quitConfirmed.add(win)
  win.close()
  if (quitting && allWindows().length === 0) app.quit()
}

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
      spellcheck: true
    }
  })
  windows.add(win)
  lastFocused = win

  win.on('focus', () => (lastFocused = win))
  win.once('ready-to-show', () => {
    if (!process.env.FARTCROBAT_HIDDEN) win.show()
  })
  win.on('closed', () => {
    windows.delete(win)
    if (lastFocused === win) lastFocused = null
  })
  // Let the renderer ask about unsaved documents before the window goes away.
  win.on('close', (e) => {
    if (quitConfirmed.has(win) || process.env.FARTCROBAT_FORCE_CLOSE) return
    e.preventDefault()
    send(win, 'app:beforeQuit')
  })
  win.on('enter-full-screen', () => send(win, 'window:fullScreenChanged', true))
  win.on('leave-full-screen', () => send(win, 'window:fullScreenChanged', false))

  // Never navigate the app window away; open web links in the browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if ((devUrl && url.startsWith(devUrl)) || url.startsWith(APP_ORIGIN)) return
    e.preventDefault()
  })

  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (devUrl) win.loadURL(devUrl)
  else win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}
