// Updates: what each install type can do, and the test switches only unpackaged builds honour.
import { describe, expect, it } from 'vitest'
import { UPDATE_FIRST_CHECK_DELAY_MS } from '@shared/updates'
import { RELEASES_BASE } from './release'
import { MAC_INSTALLS_UPDATES, unpackagedVersion, updateCapability, updateSettings } from './settings'

describe('unpackaged version', () => {
  it("reads Fartcrobat's package.json from the app folder or a level or two up", () => {
    const files: Record<string, string> = {
      '/repo/package.json': JSON.stringify({ name: 'fartcrobat', version: '0.1.0' }),
      '/repo/out/package.json': JSON.stringify({ name: 'something-else', version: '9.9.9' })
    }
    const read = (path: string) => {
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    }
    expect(unpackagedVersion('/repo/out/main', read)).toBe('0.1.0')
    expect(unpackagedVersion('/repo', read)).toBe('0.1.0')
    expect(unpackagedVersion('/elsewhere/out/main', read)).toBeNull()
    expect(unpackagedVersion('/x/y', () => '{not json')).toBeNull()
  })
})

describe('update capability', () => {
  const packaged = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, hasUpdateConfig = true) =>
    updateCapability({ platform, isPackaged: true, env, hasUpdateConfig })

  it('installs on Windows and from AppImages', () => {
    expect(packaged('win32')).toBe('install')
    expect(packaged('linux', { APPIMAGE: '/home/me/Apps/Fartcrobat-0.2.0.AppImage' })).toBe('install')
  })

  it('only notifies for .deb and .tar.gz installs, macOS (until signed) and builds without update metadata', () => {
    expect(packaged('linux')).toBe('notify')
    expect(packaged('linux', { APPIMAGE: '' })).toBe('notify')
    expect(MAC_INSTALLS_UPDATES).toBe(false)
    expect(packaged('darwin')).toBe('notify')
    expect(packaged('win32', {}, false)).toBe('notify')
    expect(packaged('linux', { APPIMAGE: '/a.AppImage' }, false)).toBe('notify')
    expect(packaged('freebsd')).toBe('notify')
  })

  it('unpackaged: notify, unless the fake updater stands in; packaged builds ignore the fake', () => {
    const unpackaged = (env: NodeJS.ProcessEnv) =>
      updateCapability({ platform: 'linux', isPackaged: false, env, hasUpdateConfig: false })
    expect(unpackaged({})).toBe('notify')
    expect(unpackaged({ APPIMAGE: '/a.AppImage' })).toBe('notify')
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

  it('packaged builds always use github.com and the real schedule', () => {
    expect(updateSettings(true, test)).toEqual({
      base: RELEASES_BASE,
      testBase: null,
      autoChecks: true,
      firstCheckDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
      fakeUpdaterFile: null
    })
    expect(updateSettings(true, { FARTCROBAT_UPDATE_CHECKS: '0' }).autoChecks).toBe(true)
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
