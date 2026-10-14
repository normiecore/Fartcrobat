// electron-updater behind the Updater interface. It reads resources/app-update.yml (written by
// electron-builder's publish settings), downloads from the GitHub release with sha512 checks and
// differential downloads, and runs the installer.
import {
  AppImageUpdater,
  CancellationToken,
  MacUpdater,
  NsisUpdater,
  type AppUpdater
} from 'electron-updater'
import type { Updater } from './updater'

export function electronUpdater(platform: NodeJS.Platform = process.platform): Updater {
  let instance: AppUpdater | null = null
  /** The last download, which may still be settling after a cancel. */
  let pending: Promise<unknown> = Promise.resolve()

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
    // Later: the update installs silently when the app quits, without starting it again.
    u.autoInstallOnAppQuit = true
    u.allowPrerelease = false
    u.allowDowngrade = false
    // Failures also reject the promises below. Without a listener the emitter would throw.
    u.on('error', () => {})
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
      const run = u.downloadUpdate(token)
      pending = run
      try {
        await run
      } finally {
        u.off('download-progress', progress)
        signal.removeEventListener('abort', onAbort)
      }
    },

    installAndRestart() {
      // Silent, and start the new version afterwards. electron-updater quits the app itself too.
      updater().quitAndInstall(true, true)
    }
  }
}
