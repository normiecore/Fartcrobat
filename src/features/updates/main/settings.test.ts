// Updates: what each install type can do, and the test switches only unpackaged builds honour.
import { describe, expect, it } from 'vitest'
import { UPDATE_FIRST_CHECK_DELAY_MS } from '@shared/updates'
import { RELEASES_BASE } from './release'
import { MAC_INSTALLS_UPDATES, updateCapability, updateSettings } from './settings'

describe('update capability', () => {
  const MOUNT = '/tmp/.mount_FartcrAb12'
  const OWN_APPIMAGE = { APPIMAGE: '/home/me/Apps/Fartcrobat-0.2.0.AppImage', APPDIR: MOUNT }
  const packaged = (
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv = {},
    hasUpdateConfig = true,
    { execPath = `${MOUNT}/fartcrobat`, writable = (_dir: string): boolean => true } = {}
  ) => updateCapability({ platform, isPackaged: true, env, execPath, hasUpdateConfig, writable })

  it('installs on Windows and from AppImages', () => {
    expect(packaged('win32', {}, true, { execPath: 'C:\\Program Files\\Fartcrobat\\Fartcrobat.exe' })).toBe(
      'install'
    )
    expect(packaged('linux', OWN_APPIMAGE)).toBe('install')
  })

  it('only notifies for .deb and .tar.gz installs, macOS (until signed) and builds without update metadata', () => {
    expect(packaged('linux')).toBe('notify')
    expect(packaged('linux', { APPIMAGE: '' })).toBe('notify')
    expect(MAC_INSTALLS_UPDATES).toBe(false)
    expect(packaged('darwin')).toBe('notify')
    expect(packaged('win32', {}, false)).toBe('notify')
    expect(packaged('linux', OWN_APPIMAGE, false)).toBe('notify')
    expect(packaged('freebsd')).toBe('notify')
  })

  it("notifies for an AppImage that isn't this process's own: the update would delete that file", () => {
    // A .deb copy started by an AI app (or a PDF opened from an app) that runs as an AppImage
    // inherits that app's APPIMAGE and APPDIR.
    const inherited = { APPIMAGE: '/home/me/Apps/LM-Studio-0.3.9.AppImage', APPDIR: '/tmp/.mount_LMxyz' }
    expect(packaged('linux', inherited, true, { execPath: '/opt/Fartcrobat/fartcrobat' })).toBe('notify')
    expect(packaged('linux', { APPIMAGE: '/home/me/Apps/Other.AppImage' }, true, { execPath: '/opt/Fartcrobat/fartcrobat' })).toBe(
      'notify'
    )
    // APPIMAGE without APPDIR, even from inside a mount.
    expect(packaged('linux', { APPIMAGE: OWN_APPIMAGE.APPIMAGE })).toBe('notify')
  })

  it('notifies for an AppImage in a folder the person cannot write to (the update replaces the file)', () => {
    const asked: string[] = []
    const env = { APPIMAGE: '/opt/apps/Fartcrobat.AppImage', APPDIR: MOUNT }
    const readOnly = (dir: string) => {
      asked.push(dir)
      return false
    }
    expect(packaged('linux', env, true, { writable: readOnly })).toBe('notify')
    expect(asked).toEqual(['/opt/apps'])
    expect(packaged('linux', env, true, { writable: (dir) => dir === '/opt/apps' })).toBe('install')
  })

  it('unpackaged: notify, unless the fake updater stands in; packaged builds ignore the fake', () => {
    const unpackaged = (env: NodeJS.ProcessEnv) =>
      updateCapability({
        platform: 'linux',
        isPackaged: false,
        env,
        execPath: `${MOUNT}/fartcrobat`,
        hasUpdateConfig: false,
        writable: () => true
      })
    expect(unpackaged({})).toBe('notify')
    expect(unpackaged(OWN_APPIMAGE)).toBe('notify')
    expect(unpackaged({ FARTCROBAT_FAKE_UPDATER: '/tmp/fake.json' })).toBe('install')
    expect(packaged('darwin', { FARTCROBAT_FAKE_UPDATER: '/tmp/fake.json' })).toBe('notify')
  })
})

describe('update settings', () => {
  const test = {
    FARTCROBAT_UPDATE_URL: 'http://127.0.0.1:4567/normiecore/Fartcrobat/',
    FARTCROBAT_UPDATE_CHECKS: '1',
    FARTCROBAT_UPDATE_FIRST_CHECK_MS: '200',
    FARTCROBAT_FAKE_UPDATER: '/tmp/fake.json'
  }

  it('packaged builds always use github.com and the real schedule; tests can only turn checks off', () => {
    expect(updateSettings(true, test)).toEqual({
      base: RELEASES_BASE,
      testBase: null,
      autoChecks: true,
      firstCheckDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
      fakeUpdaterFile: null
    })
    // FARTCROBAT_UPDATE_CHECKS=0 only turns automatic checks off (e2e runs against a packaged
    // build must not ask github.com); it can never turn them on or point them elsewhere.
    expect(updateSettings(true, { FARTCROBAT_UPDATE_CHECKS: '0' })).toEqual({
      base: RELEASES_BASE,
      testBase: null,
      autoChecks: false,
      firstCheckDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
      fakeUpdaterFile: null
    })
    expect(updateSettings(true, { FARTCROBAT_UPDATE_CHECKS: '' }).autoChecks).toBe(true)
  })

  it('unpackaged builds check automatically only when a test asks', () => {
    expect(updateSettings(false, {})).toEqual({
      base: RELEASES_BASE,
      testBase: null,
      autoChecks: false,
      firstCheckDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
      fakeUpdaterFile: null
    })
    expect(updateSettings(false, test)).toEqual({
      base: 'http://127.0.0.1:4567/normiecore/Fartcrobat',
      testBase: 'http://127.0.0.1:4567/normiecore/Fartcrobat',
      autoChecks: true,
      firstCheckDelayMs: 200,
      fakeUpdaterFile: '/tmp/fake.json'
    })
    expect(updateSettings(false, { FARTCROBAT_UPDATE_CHECKS: '0' }).autoChecks).toBe(false)
    expect(updateSettings(false, { FARTCROBAT_UPDATE_FIRST_CHECK_MS: '0' }).firstCheckDelayMs).toBe(0)
    expect(updateSettings(false, { FARTCROBAT_UPDATE_FIRST_CHECK_MS: 'soon' }).firstCheckDelayMs).toBe(
      UPDATE_FIRST_CHECK_DELAY_MS
    )
    expect(updateSettings(false, { FARTCROBAT_UPDATE_FIRST_CHECK_MS: '-5' }).firstCheckDelayMs).toBe(
      UPDATE_FIRST_CHECK_DELAY_MS
    )
    // Only http(s) bases.
    expect(updateSettings(false, { FARTCROBAT_UPDATE_URL: 'file:///tmp/releases' }).base).toBe(RELEASES_BASE)
    expect(updateSettings(false, { FARTCROBAT_UPDATE_URL: 'not a url' }).testBase).toBeNull()
  })
})
