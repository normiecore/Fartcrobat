// Updates: Restart now goes through the normal quit flow (src/main/windows.ts). The installer
// starts only once every window agreed to close; Cancel in any window stops it. Electron is
// replaced by a small stand-in that behaves like it for quitting and closing windows.
import type { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** What the stand-in records, shared with the tests. */
const log = vi.hoisted((): string[] => [])

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeEvent {
    defaultPrevented = false
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  class FakeWebContents extends EventEmitter {
    sent: string[] = []
    send(channel: string) {
      this.sent.push(channel)
    }
    isCrashed() {
      return false
    }
    executeJavaScript() {
      return Promise.resolve(1)
    }
    setWindowOpenHandler() {}
    reload() {}
  }
  class FakeWindow extends EventEmitter {
    /** The last window created has the focus. */
    static focused: FakeWindow | null = null
    static getFocusedWindow() {
      const win = FakeWindow.focused
      return win && !win.destroyed ? win : null
    }
    webContents = new FakeWebContents()
    destroyed = false
    constructor() {
      super()
      FakeWindow.focused = this
    }
    isDestroyed() {
      return this.destroyed
    }
    isMinimized() {
      return false
    }
    isVisible() {
      return true
    }
    restore() {}
    show() {}
    focus() {}
    loadURL() {
      return Promise.resolve()
    }
    close() {
      if (this.destroyed) return
      const e = new FakeEvent()
      this.emit('close', e)
      if (!e.defaultPrevented) this.destroy()
    }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }
  class FakeApp extends EventEmitter {
    isPackaged = false
    quitting = false
    isReady() {
      return true
    }
    quit() {
      log.push('app.quit')
      if (this.quitting) return
      const e = new FakeEvent()
      this.emit('before-quit', e)
      if (e.defaultPrevented) return
      this.quitting = true
      this.emit('will-quit', new FakeEvent())
      this.emit('quit', new FakeEvent(), 0)
    }
    relaunch() {
      log.push('app.relaunch')
    }
    releaseSingleInstanceLock() {
      log.push('releaseSingleInstanceLock')
    }
  }
  return {
    app: new FakeApp(),
    BrowserWindow: FakeWindow,
    dialog: { showMessageBox: () => new Promise(() => {}) },
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1600, height: 1000 } }) },
    shell: { openExternal: async () => {} },
    ipcMain: { handle() {}, removeHandler() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    net: { fetch: async () => new Response('') }
  }
})

type Windows = typeof import('@main/windows')
type Win = ReturnType<Windows['createWindow']> & { webContents: { sent: string[] } }

async function load() {
  // A fresh windows.ts (it keeps its state in the module) and a fresh app.
  vi.resetModules()
  log.length = 0
  const { app } = (await import('electron')) as unknown as { app: EventEmitter & { quitting: boolean } }
  app.removeAllListeners()
  app.quitting = false
  const windows: Windows = await import('@main/windows')
  windows.installQuitHandling(() => log.push('onQuit'))
  /** A window whose renderer booted (so it is asked about unsaved documents). */
  const open = () => {
    const win = windows.createWindow() as Win
    windows.takeLaunchFiles(win)
    return win
  }
  const install = () => log.push('install')
  return { windows, open, install }
}

const asked = (win: Win) => win.webContents.sent.filter((c) => c === 'app:beforeQuit').length
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('quitForUpdate', { timeout: 5000 }, () => {
  beforeEach(() => {
    delete process.env.FARTCROBAT_FORCE_CLOSE
  })

  it('installs only after every window agreed to close, then quits without relaunching', async () => {
    const { windows, open, install } = await load()
    const a = open()
    const b = open()
    const result = windows.quitForUpdate(install)
    await flush()
    // One window at a time, the focused one (the last created) first.
    expect(asked(b)).toBe(1)
    expect(asked(a)).toBe(0)
    expect(log).not.toContain('install')
    windows.answerCloseRequest(b, true)
    await flush()
    expect(b.isDestroyed()).toBe(true)
    expect(asked(a)).toBe(1)
    expect(log).not.toContain('install')
    windows.answerCloseRequest(a, true)
    expect(await result).toBe(true)
    // The lock goes first, so the new version does not hand its start-up to this process.
    expect(log.indexOf('releaseSingleInstanceLock')).toBeLessThan(log.indexOf('install'))
    expect(log.indexOf('install')).toBeLessThan(log.indexOf('onQuit'))
    expect(log.filter((l) => l === 'install')).toHaveLength(1)
    expect(log).not.toContain('app.relaunch')
  })

  it('Cancel in a window stops the restart: nothing is installed and the other windows stay', async () => {
    const { windows, open, install } = await load()
    const a = open()
    const b = open()
    const result = windows.quitForUpdate(install)
    await flush()
    windows.answerCloseRequest(b, false)
    expect(await result).toBe(false)
    expect(log).not.toContain('install')
    expect(log).not.toContain('onQuit')
    expect(a.isDestroyed()).toBe(false)
    expect(b.isDestroyed()).toBe(false)
    // A later ordinary quit does not run the cancelled install either.
    const quit = (async () => windows.quitApp())()
    await quit
    await flush()
    windows.answerCloseRequest(b, true)
    await flush()
    windows.answerCloseRequest(a, true)
    await flush()
    expect(log).toContain('onQuit')
    expect(log).not.toContain('install')
  })

  it('a second Restart while the windows are being asked waits for the same answer', async () => {
    const { windows, open, install } = await load()
    const a = open()
    const first = windows.quitForUpdate(install)
    const second = windows.quitForUpdate(() => log.push('other install'))
    await flush()
    expect(asked(a)).toBe(1)
    windows.answerCloseRequest(a, true)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(log.filter((l) => l.includes('install'))).toEqual(['install'])
  })

  it('installs at once when no window has anything to ask', async () => {
    const { windows, install } = await load()
    // A window whose renderer never booted holds no documents.
    windows.createWindow()
    expect(await windows.quitForUpdate(install)).toBe(true)
    expect(log).toContain('install')
    expect(log).toContain('onQuit')
  })

  it('a failing installer still lets the app quit', async () => {
    const { windows } = await load()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await windows.quitForUpdate(() => {
        throw new Error('spawn failed')
      })
    ).toBe(true)
    expect(log).toContain('onQuit')
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})
