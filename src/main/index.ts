import { app, BrowserWindow, clipboard, ClipboardItem, dialog, shell } from 'electron'
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { filesFromArgv } from './args'
import type { MainContext, MainFeatureModule } from './context'
import { defaultAppStatus, setDefaultApp } from './defaultApp'
import { handle, send } from './ipc'
import { applyDefaultMenu, applyMenu } from './menu'
import { listPrinters, printImages } from './print'
import { registerAppScheme, serveRenderer } from './protocol'
import { store } from './store'
import { allWindows, confirmClose, createWindow, currentWindow, setQuitting } from './windows'

app.setName('Fartcrobat')
if (process.env.FARTCROBAT_USER_DATA) app.setPath('userData', process.env.FARTCROBAT_USER_DATA)

/** Files given on the command line or by the OS before the window was ready. */
const pendingFiles: string[] = []

function openFiles(paths: string[]) {
  if (!paths.length) return
  const win = currentWindow()
  if (!win) {
    pendingFiles.push(...paths)
    return
  }
  if (win.isMinimized()) win.restore()
  win.focus()
  send(win, 'app:openFiles', paths)
}

// One running instance: a second launch (e.g. double-clicking another PDF) opens a tab here.
if (!process.env.FARTCROBAT_MULTI_INSTANCE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => openFiles(filesFromArgv(argv, workingDirectory || process.cwd())))
}

app.on('open-file', (e, path) => {
  e.preventDefault()
  if (app.isReady() && currentWindow()) openFiles([path])
  else pendingFiles.push(path)
})

registerAppScheme()
pendingFiles.push(...filesFromArgv(process.argv, process.cwd()))
if (store().prefs.hardwareAcceleration === false) app.disableHardwareAcceleration()

function atomicWrite(path: string, data: Uint8Array) {
  const tmp = join(dirname(path), `.${basename(path)}.fartcrobat-${process.pid}.tmp`)
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, path)
  } catch (err) {
    // Windows cannot rename over a file another program holds open; fall back to overwriting.
    try {
      writeFileSync(path, data)
    } finally {
      try {
        unlinkSync(tmp)
      } catch {}
    }
    if (!existsSync(path)) throw err
  }
}

function registerCoreHandlers() {
  handle('file:openDialog', async (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const props: ('openFile' | 'openDirectory' | 'multiSelections')[] = [opts.directory ? 'openDirectory' : 'openFile']
    if (opts.multiple) props.push('multiSelections')
    const res = await dialog.showOpenDialog(win!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: props
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('file:saveDialog', async (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const res = await dialog.showSaveDialog(win!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })
  handle('file:read', (_e, path) => new Uint8Array(readFileSync(path)))
  handle('file:write', (_e, path, data) => atomicWrite(path, data))
  handle('file:exists', (_e, path) => existsSync(path))
  handle('file:stat', (_e, path) => {
    try {
      const s = statSync(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  })
  handle('file:tempPath', (_e, name) => join(app.getPath('temp'), `fartcrobat-${process.pid}-${basename(name)}`))

  handle('app:launchFiles', () => pendingFiles.splice(0))
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
  handle('app:quitConfirmed', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) confirmClose(win)
  })
  handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  handle('prefs:get', () => store().prefs)
  handle('prefs:set', (_e, patch) => store().setPrefs(patch))
  handle('store:get', (_e, key) => store().get(key))
  handle('store:set', (_e, key, value) => store().set(key, value))
  handle('recent:list', () => store().recent.filter((r) => existsSync(r.path)))
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

  handle('shell:openExternal', async (_e, url) => {
    if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url)
  })
  handle('shell:showItemInFolder', (_e, path) => shell.showItemInFolder(path))
  handle('shell:openPath', (_e, path) => shell.openPath(path))

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

app.whenReady().then(() => {
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
  setQuitting(true)
  store().flush()
})
