// Updates, main process: Electron glue around ./main/service (see docs/features/updates.md).
import { app, shell } from 'electron'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { retargetAppFile } from '@features/agent-access/main/endpoint'
import { appVersion } from '@main/appVersion'
import type { MainContext } from '@main/context'
import { linuxAppImageMoved } from '@main/defaultApp'
import { readMachinePolicy } from '@main/policy'
import { allWindows, quitForUpdate } from '@main/windows'
import type { UpdateCapability } from '@shared/updates'
import { electronUpdater } from './main/electronUpdater'
import { fakeUpdater, readFakeConfig } from './main/fakeUpdater'
import { electronProbe } from './main/net'
import { UpdateService } from './main/service'
import { updateCapability, updateSettings, type UpdateSettings } from './main/settings'
import type { Updater } from './main/updater'

function makeUpdater(capability: UpdateCapability, settings: UpdateSettings): Updater | null {
  if (capability !== 'install') return null
  const fakeFile = settings.fakeUpdaterFile
  if (fakeFile)
    return fakeUpdater({
      config: () => readFakeConfig(fakeFile),
      onQuit: (handler) => app.once('quit', (_e, exitCode) => handler(exitCode))
    })
  return electronUpdater(process.platform, {
    // The AppImage got a new file name: what starts it (the desktop entry Fartcrobat wrote as the
    // default PDF app, the agent shim's app.json) must name the new file, before this process exits.
    appImageMoved: (from, to) => {
      linuxAppImageMoved(from, to)
      retargetAppFile(app.getPath('userData'), from, to)
    }
  })
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function register(ctx: MainContext) {
  const settings = updateSettings(app.isPackaged, process.env)
  const capability = updateCapability({
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    execPath: process.execPath,
    hasUpdateConfig: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
    writable
  })
  const service = new UpdateService({
    currentVersion: appVersion(),
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
