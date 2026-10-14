// Updates, main process: Electron glue around ./main/service (see docs/features/updates.md).
import { app, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MainContext } from '@main/context'
import { readMachinePolicy } from '@main/policy'
import { allWindows, quitForUpdate } from '@main/windows'
import type { UpdateCapability } from '@shared/updates'
import { electronUpdater } from './main/electronUpdater'
import { fakeUpdater, readFakeConfig } from './main/fakeUpdater'
import { electronProbe } from './main/net'
import { UpdateService } from './main/service'
import { unpackagedVersion, updateCapability, updateSettings, type UpdateSettings } from './main/settings'
import type { Updater } from './main/updater'

function makeUpdater(capability: UpdateCapability, settings: UpdateSettings): Updater | null {
  if (capability !== 'install') return null
  const fakeFile = settings.fakeUpdaterFile
  if (fakeFile)
    return fakeUpdater({
      config: () => readFakeConfig(fakeFile),
      onQuit: (handler) => app.once('quit', (_e, exitCode) => handler(exitCode))
    })
  return electronUpdater(process.platform)
}

export function register(ctx: MainContext) {
  const settings = updateSettings(app.isPackaged, process.env)
  const capability = updateCapability({
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    hasUpdateConfig: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
  })
  const currentVersion =
    (!app.isPackaged && unpackagedVersion(app.getAppPath(), (path) => readFileSync(path, 'utf8'))) ||
    app.getVersion()
  const service = new UpdateService({
    currentVersion,
    capability,
    base: settings.base,
    testBase: settings.testBase,
    probe: electronProbe,
    updater: makeUpdater(capability, settings),
    autoChecks: settings.autoChecks,
    firstCheckDelayMs: settings.firstCheckDelayMs,
    policy: async () => (await readMachinePolicy()).autoUpdate,
    preference: () => ctx.store().prefs.checkForUpdates !== false,
    broadcast: (status) => {
      for (const win of allWindows()) ctx.send(win, 'updates:status', status)
    },
    quitForUpdate,
    // Looked up at call time, so tests can stand in for the browser.
    openExternal: (url) => shell.openExternal(url)
  })

  ctx.handle('feature:updates:status', async () => {
    await service.ready
    return service.status()
  })
  ctx.handle('feature:updates:check', () => service.check(true))
  // The download reports through 'updates:status'; the call returns at once.
  ctx.handle('feature:updates:download', () => void service.download())
  ctx.handle('feature:updates:cancel', () => service.cancel())
  ctx.handle('feature:updates:dismiss', () => service.dismiss())
  ctx.handle('feature:updates:restart', () => void service.restart())
  ctx.handle('feature:updates:openReleasePage', () => service.openReleasePage())

  ctx.store().onPrefsChange((prefs, prev) => {
    if (prefs.checkForUpdates !== prev.checkForUpdates) service.preferenceChanged()
  })
  app.on('will-quit', () => service.stop())
}
