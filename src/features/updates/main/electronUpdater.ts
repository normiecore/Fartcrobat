// electron-updater behind the Updater interface. It reads resources/app-update.yml (written by
// electron-builder's publish settings), downloads from the GitHub release with sha512 checks and
// differential downloads, and runs the installer.
import {
  AppImageUpdater,
  BaseUpdater,
  CancellationToken,
  MacUpdater,
  NsisUpdater,
  type AppUpdater
} from 'electron-updater'
import type { Updater } from './updater'

/**
 * Sent in place of electron-updater's x-user-staging-id header, a random ID it keeps per install
 * and sends with every request for update metadata. With the same value everywhere, GitHub cannot
 * tell one install from another (docs/features/updates.md, U4). Staged rollouts are not used.
 */
export const STAGING_ID = '00000000-0000-0000-0000-000000000000'

export interface ElectronUpdaterHooks {
  /**
   * An AppImage update was installed under a new file name and the old file is gone
   * (electron-updater does that when the old name has a version in it). Synchronous: it can run
   * while the app quits.
   */
  appImageMoved?(from: string, to: string): void
}

export function electronUpdater(
  platform: NodeJS.Platform = process.platform,
  hooks: ElectronUpdaterHooks = {}
): Updater {
  let instance: AppUpdater | null = null
  /** The last download, which may still be settling after a cancel. */
  let pending: Promise<unknown> = Promise.resolve()
  /** The last error electron-updater reported (an install that failed only says so this way). */
  let lastError: unknown = null

  // Chosen by platform rather than through electron-updater's autoUpdater, which picks the .deb
  // updater for .deb installs: those only get notified (docs/features/updates.md, U2).
  const updater = (): AppUpdater => {
    if (instance) return instance
    const u =
      platform === 'win32'
        ? new NsisUpdater()
        : platform === 'darwin'
          ? new MacUpdater()
          : new AppImageUpdater()
    u.autoDownload = false
    // Later: the update installs silently when the app quits, without starting it again. Off
    // until a download finishes (see download).
    u.autoInstallOnAppQuit = false
    u.allowPrerelease = false
    u.allowDowngrade = false
    u.requestHeaders = { 'x-user-staging-id': STAGING_ID }
    // Failures also reject the promises below. Without a listener the emitter would throw.
    u.on('error', (err) => {
      lastError = err
    })
    if (u instanceof AppImageUpdater)
      u.on('appimage-filename-updated', (to) => {
        // Emitted during the install, before this process exits: APPIMAGE still names the old file.
        const from = process.env.APPIMAGE
        if (!from || from === to) return
        try {
          hooks.appImageMoved?.(from, to)
        } catch (err) {
          console.error('Updates: could not follow the renamed AppImage', err)
        }
      })
    return (instance = u)
  }

  return {
    async findUpdate() {
      // electron-updater hands back a download still settling after a cancel instead of starting
      // a new one.
      await pending.catch(() => {})
      try {
        const result = await updater().checkForUpdates()
        return result?.isUpdateAvailable ? result.updateInfo.version : null
      } catch (err) {
        // The release has no update metadata for this platform (v0.1.0 was published before in-app
        // updates): trying again will not help, the release page will.
        if (
          err &&
          typeof err === 'object' &&
          (err as { code?: unknown }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
        )
          return null
        throw err
      }
    },

    async download(onProgress, signal) {
      const u = updater()
      const token = new CancellationToken()
      const onAbort = () => token.cancel()
      signal.addEventListener('abort', onAbort)
      const progress = (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) =>
        onProgress({
          percent: p.percent,
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond
        })
      u.on('download-progress', progress)
      // electron-updater arms its quit handler once the file is in, which the token no longer
      // stops (the signature check and the rename after the transfer). The handler reads this
      // flag when the app quits.
      u.autoInstallOnAppQuit = true
      const run = u.downloadUpdate(token)
      pending = run
      let done = false
      try {
        await run
        done = !signal.aborted
      } finally {
        u.off('download-progress', progress)
        signal.removeEventListener('abort', onAbort)
        // Cancelled (even after the transfer) or failed: the person was not told it is ready, so
        // nothing installs when they quit.
        if (!done) u.autoInstallOnAppQuit = false
      }
      if (!done) throw new Error('cancelled')
    },

    installAndRestart() {
      const u = updater()
      // Silent, and start the new version afterwards. The app is already quitting.
      if (!(u instanceof BaseUpdater)) {
        u.quitAndInstall(true, true)
        return
      }
      // install() says whether the installer started (quitAndInstall only reports an 'error'
      // event): an AppImage in a folder that became read-only, an installer that is gone.
      lastError = null
      if (!u.install(true, true))
        throw lastError instanceof Error ? lastError : new Error('The update installer did not start')
    }
  }
}
