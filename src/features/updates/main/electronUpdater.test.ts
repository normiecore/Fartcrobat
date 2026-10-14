// Updates: what the app sets on electron-updater and how it reads its answers. electron-updater is
// replaced by a stand-in that behaves like it where it matters here: the quit handler it arms once
// a download is in (and which reads autoInstallOnAppQuit when the app quits), install() that
// reports a failure only through its result and an 'error' event, and the AppImage rename event.
import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronUpdater, STAGING_ID } from './electronUpdater'

interface StandIn extends EventEmitter {
  autoInstallOnAppQuit: boolean
  requestHeaders: Record<string, string> | null
  installs: { silent: boolean; runAfter: boolean }[]
  installWorks: boolean
  /** Ends the transfer the token covers and runs what follows it (electron-updater's done()). */
  finishDownload(): void
  /** The app quits normally (exit code 0). */
  quit(): void
}

const made = vi.hoisted((): StandIn[] => [])

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  class CancellationToken {
    cancelled = false
    cancel() {
      this.cancelled = true
    }
  }
  class AppUpdater extends EventEmitter {
    autoDownload = true
    autoInstallOnAppQuit = true
    allowPrerelease = false
    allowDowngrade = false
    requestHeaders: Record<string, string> | null = null
    installs: { silent: boolean; runAfter: boolean }[] = []
    installWorks = true
    private quitHandler: (() => void) | null = null
    private settle: (() => void) | null = null
    constructor() {
      super()
      made.push(this as unknown as StandIn)
    }
    async checkForUpdates() {
      return { isUpdateAvailable: true, updateInfo: { version: '0.2.0' } }
    }
    downloadUpdate(token: CancellationToken) {
      return new Promise<string[]>((resolve, reject) => {
        this.settle = () => {
          // The token only stops the transfer itself.
          if (token.cancelled) return reject(new Error('cancelled'))
          resolve([])
        }
      })
    }
    finishDownload() {
      const settle = this.settle
      this.settle = null
      // done(): the file is in and the quit handler is armed (when autoInstallOnAppQuit is on).
      if (this.autoInstallOnAppQuit && !this.quitHandler)
        this.quitHandler = () => {
          if (this.autoInstallOnAppQuit) this.install(true, false)
        }
      // Resolves even when cancelled meanwhile: the transfer was over.
      settle?.call(null)
    }
    quit() {
      this.quitHandler?.()
    }
    install(silent: boolean, runAfter: boolean): boolean {
      this.installs.push({ silent, runAfter })
      return true
    }
    quitAndInstall(silent: boolean, runAfter: boolean) {
      this.install(silent, runAfter)
    }
  }
  class BaseUpdater extends AppUpdater {
    install(silent: boolean, runAfter: boolean): boolean {
      if (!this.installWorks) {
        this.emit('error', new Error('EACCES: permission denied, unlink'))
        return false
      }
      return super.install(silent, runAfter)
    }
  }
  class NsisUpdater extends BaseUpdater {}
  class AppImageUpdater extends BaseUpdater {}
  class MacUpdater extends AppUpdater {}
  return { AppUpdater, BaseUpdater, NsisUpdater, AppImageUpdater, MacUpdater, CancellationToken }
})


const noProgress = () => {}

describe('electron-updater settings', () => {
  afterEach(() => {
    made.length = 0
    delete process.env.APPIMAGE
  })

  it('sends the same staging ID as every other install, never a per-install one', async () => {
    const updater = electronUpdater('win32')
    expect(await updater.findUpdate('0.2.0')).toBe('0.2.0')
    expect(made[0].requestHeaders).toEqual({ 'x-user-staging-id': STAGING_ID })
    expect(STAGING_ID).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('a finished download installs when the app quits (Later)', async () => {
    const updater = electronUpdater('win32')
    await updater.findUpdate('0.2.0')
    const done = updater.download(noProgress, new AbortController().signal)
    made[0].finishDownload()
    await done
    made[0].quit()
    expect(made[0].installs).toEqual([{ silent: true, runAfter: false }])
  })

  it('a download cancelled after its transfer ended does not install when the app quits', async () => {
    const updater = electronUpdater('win32')
    await updater.findUpdate('0.2.0')
    const cancel = new AbortController()
    const done = updater.download(noProgress, cancel.signal)
    // Cancel lands while electron-updater checks the signature or renames the file.
    cancel.abort()
    made[0].finishDownload()
    await expect(done).rejects.toThrow()
    made[0].quit()
    expect(made[0].installs).toEqual([])

    // Downloaded again and not cancelled: Later installs it.
    const again = updater.download(noProgress, new AbortController().signal)
    made[0].finishDownload()
    await again
    made[0].quit()
    expect(made[0].installs).toEqual([{ silent: true, runAfter: false }])
  })

  it('Restart now says so when the installer did not start', async () => {
    const works = electronUpdater('linux')
    await works.findUpdate('0.2.0')
    works.installAndRestart()
    expect(made[0].installs).toEqual([{ silent: true, runAfter: true }])

    // An AppImage in a folder that became read-only: install() fails and only says so in an event.
    const fails = electronUpdater('linux')
    await fails.findUpdate('0.2.0')
    made[1].installWorks = false
    expect(() => fails.installAndRestart()).toThrow('EACCES')
  })

  it('tells the app where an AppImage update put the new file', async () => {
    const moved: [string, string][] = []
    const updater = electronUpdater('linux', { appImageMoved: (from, to) => moved.push([from, to]) })
    await updater.findUpdate('0.2.0')
    process.env.APPIMAGE = '/home/me/Apps/Fartcrobat-0.2.0.AppImage'
    made[0].emit('appimage-filename-updated', '/home/me/Apps/Fartcrobat-0.2.1.AppImage')
    expect(moved).toEqual([['/home/me/Apps/Fartcrobat-0.2.0.AppImage', '/home/me/Apps/Fartcrobat-0.2.1.AppImage']])
  })
})
