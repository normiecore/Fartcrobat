// What keeps installs from before a rename working (src/shared/identity.ts): the same userData
// folder, machine policies at the old locations, the MCP helper finding the app under either name,
// and desktop entries written under the old name. Most tests pass a made-up product ("Newname")
// so they do not depend on the current name.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY, PRODUCT_NAME, productNames, userDataEnvFor, userDataFolderName, userDataOverride, type Names } from '@shared/identity'
import { firstSaying, machinePolicyFiles, machineReadings, windowsPolicyKeys, type MachinePolicy, type RunFile } from '@main/policy'
import { GENERATED_MARKER, LEGACY_GENERATED_MARKER, desktopEntry, hasGeneratedMarker, refreshedDesktopEntry } from '@main/util/linuxDesktop'
import { isInkmoorProgId } from '@main/util/systemDefaults'
import { TempFiles } from '@main/util/tempFiles'
import { legacyUpdaterCacheDir } from '@main/util/legacyUpdaterCache'
import { defaultUserDataDir, installCandidates, separateProfile } from '../../src/agent-shim/launch'

const renamed: Names = { current: 'Newname', legacy: LEGACY.productName }

describe('identity', () => {
  it('is Inkmoor, was Fartcrobat, and its legacy ids match the build configuration', () => {
    expect(PRODUCT_NAME).toBe('Inkmoor')
    expect(LEGACY.productName).toBe('Fartcrobat')
    expect(productNames()).toEqual(['Inkmoor', 'Fartcrobat'])
    expect(LEGACY.appId).toBe('org.fartcrobat.app')
    expect(LEGACY.nsisGuid).toBe('bd977413-7ee9-5f76-80a8-7e980aa59bd1')
  })

  it('keeps the userData folder from before a rename and never picks it for new installs', () => {
    const has = (...names: string[]) => (name: string) => names.includes(name)
    expect(userDataFolderName(has('Fartcrobat'), renamed)).toBe('Fartcrobat')
    expect(userDataFolderName(has(), renamed)).toBe('Newname')
    // A folder under the new name exists (a fresh install that later found an old folder, or a
    // person who copied it): the new one wins.
    expect(userDataFolderName(has('Fartcrobat', 'Newname'), renamed)).toBe('Newname')
    // The current names.
    expect(userDataFolderName(has('Fartcrobat'))).toBe('Fartcrobat')
    expect(userDataFolderName(has())).toBe('Inkmoor')
    expect(userDataFolderName(has('Fartcrobat'), { current: 'Fartcrobat', legacy: 'Fartcrobat' })).toBe('Fartcrobat')
  })

  it('reads the userData variable under the new name, then the legacy one', () => {
    expect(userDataEnvFor('Newname')).toBe('NEWNAME_USER_DATA')
    expect(userDataEnvFor('Ink Moor')).toBe('INK_MOOR_USER_DATA')
    expect(userDataOverride({ NEWNAME_USER_DATA: '/a', FARTCROBAT_USER_DATA: '/b' }, renamed)).toBe('/a')
    expect(userDataOverride({ FARTCROBAT_USER_DATA: '/b' }, renamed)).toBe('/b')
    expect(userDataOverride({}, renamed)).toBeNull()
  })
})

describe('machine policy across a rename', () => {
  it('reads the new location first and the old one after it', () => {
    expect(machinePolicyFiles('linux', renamed)).toEqual(['/etc/newname/policy.json', '/etc/fartcrobat/policy.json'])
    expect(machinePolicyFiles('darwin', renamed)).toEqual([
      '/Library/Application Support/Newname/policy.json',
      '/Library/Application Support/Fartcrobat/policy.json'
    ])
    expect(machinePolicyFiles('win32', renamed)).toEqual([])
    expect(machinePolicyFiles('linux')).toEqual(['/etc/inkmoor/policy.json', '/etc/fartcrobat/policy.json'])
    expect(windowsPolicyKeys(renamed)).toEqual(['HKLM\\SOFTWARE\\Policies\\Newname', 'HKLM\\SOFTWARE\\Policies\\Fartcrobat'])
  })

  it('lets the first location that mentions a setting decide it', () => {
    const p = (agentAccess: MachinePolicy['agentAccess'], rememberPasswords: MachinePolicy['rememberPasswords'] = null) =>
      ({ agentAccess, rememberPasswords, autoUpdate: null }) as MachinePolicy
    expect(firstSaying([p(null), p('disabled', 'disabled')])).toEqual(p('disabled', 'disabled'))
    expect(firstSaying([p('enabled'), p('disabled', 'enabled')])).toEqual(p('enabled', 'enabled'))
    // A broken new policy is still a decision (it fails closed) rather than falling through.
    expect(firstSaying([p('invalid'), p('enabled')])).toEqual(p('invalid'))
    expect(firstSaying([])).toEqual(p(null))
  })

  it('applies a Windows policy deployed under the old key', async () => {
    const queried: string[] = []
    const run: RunFile = (_file, args, done) => {
      queried.push(args[1])
      if (args[1].endsWith('\\Newname')) return done(Object.assign(new Error('not found'), { code: 1 }), '')
      done(null, '\r\n    AgentAccess    REG_DWORD    0x0\r\n')
    }
    const policy = await machineReadings({ platform: 'win32', env: {}, run, names: renamed })
    expect(queried).toEqual(['HKLM\\SOFTWARE\\Policies\\Newname', 'HKLM\\SOFTWARE\\Policies\\Fartcrobat'])
    expect(policy).toEqual({ agentAccess: 'disabled', rememberPasswords: null, autoUpdate: null })
  })
})

describe('MCP helper across a rename', () => {
  it('uses the folder from before the rename, as the app does', () => {
    const exists = (path: string) => path === '/home/me/.config/Fartcrobat'
    expect(defaultUserDataDir({}, 'linux', '/home/me', exists, renamed)).toBe('/home/me/.config/Fartcrobat')
    expect(defaultUserDataDir({}, 'linux', '/home/me', () => false, renamed)).toBe('/home/me/.config/Newname')
    expect(
      defaultUserDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me', () => false, renamed)
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\Newname')
  })

  it('treats a ChatGPT setup that names either usual folder as the usual profile', () => {
    expect(separateProfile({ FARTCROBAT_USER_DATA: '/home/me/.config/Fartcrobat' }, 'linux', '/home/me', renamed)).toBe(false)
    expect(separateProfile({ NEWNAME_USER_DATA: '/home/me/.config/Newname' }, 'linux', '/home/me', renamed)).toBe(false)
    expect(separateProfile({ NEWNAME_USER_DATA: '/tmp/profile' }, 'linux', '/home/me', renamed)).toBe(true)
    expect(
      separateProfile(
        { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', FARTCROBAT_USER_DATA: 'c:\\users\\me\\appdata\\roaming\\fartcrobat' },
        'win32',
        'C:\\Users\\me',
        renamed
      )
    ).toBe(false)
  })

  it('finds the app under either name', () => {
    expect(installCandidates('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\me', ['D:\\Apps\\Fartcrobat'], renamed)).toEqual([
      // An install updated across the rename keeps its folder; the executable may have either name.
      'D:\\Apps\\Fartcrobat\\Newname.exe',
      'D:\\Apps\\Fartcrobat\\Fartcrobat.exe',
      'C:\\L\\Programs\\Newname\\Newname.exe',
      'C:\\L\\Programs\\Newname\\Fartcrobat.exe',
      'C:\\L\\Programs\\Fartcrobat\\Newname.exe',
      'C:\\L\\Programs\\Fartcrobat\\Fartcrobat.exe'
    ])
    expect(installCandidates('darwin', {}, '/Users/me', [], renamed)).toEqual([
      '/Applications/Newname.app/Contents/MacOS/Newname',
      '/Users/me/Applications/Newname.app/Contents/MacOS/Newname',
      '/Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat',
      '/Users/me/Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat'
    ])
    expect(installCandidates('linux', {}, '/home/me', [], renamed)).toEqual([
      '/opt/Newname/newname',
      '/opt/Newname/fartcrobat',
      '/opt/Fartcrobat/fartcrobat'
    ])
  })
})

describe('desktop integration across a rename', () => {
  it('does not count an "Open with" choice of the removed old executable as the default on Windows', () => {
    // The update removed Fartcrobat.exe, so that choice opens nothing: offer Make default again.
    expect(isInkmoorProgId('Applications\\Fartcrobat.exe', 'Newname.exe')).toBe(false)
    expect(isInkmoorProgId('Applications\\Newname.exe', 'Newname.exe')).toBe(true)
    expect(isInkmoorProgId(LEGACY.windowsProgId, 'Newname.exe')).toBe(true)
    expect(isInkmoorProgId('Applications\\Other.exe', 'Newname.exe')).toBe(false)
  })

  it('updates a desktop entry it wrote earlier for this executable, and nothing else', () => {
    const exe = '/home/me/Apps/App-x86_64.AppImage'
    const fresh = desktopEntry(exe, 'fartcrobat')
    expect(hasGeneratedMarker(fresh)).toBe(true)
    expect(refreshedDesktopEntry(fresh, exe, 'fartcrobat')).toBeNull()
    // Written under the old name, with the old marker.
    const old = fresh
      .replace(/^Name=.*$/m, 'Name=Fartcrobat')
      .replace(/^StartupWMClass=.*$/m, 'StartupWMClass=Fartcrobat')
      .replace(GENERATED_MARKER, LEGACY_GENERATED_MARKER)
    expect(GENERATED_MARKER).toBe('X-Inkmoor-Generated=true')
    expect(LEGACY_GENERATED_MARKER).toBe('X-Fartcrobat-Generated=true')
    expect(refreshedDesktopEntry(old, exe, 'fartcrobat')).toBe(fresh)
    // Another install's entry, or one the person or a package wrote.
    expect(refreshedDesktopEntry(old, '/opt/other/app', 'fartcrobat')).toBeNull()
    expect(refreshedDesktopEntry(old.replace(LEGACY_GENERATED_MARKER, ''), exe, 'fartcrobat')).toBeNull()
    // The marker only counts on a line of its own.
    expect(hasGeneratedMarker(`Comment=${GENERATED_MARKER}\n`)).toBe(false)
  })
})

describe('temporary folders across a rename', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'fc-rename-temp-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('sweeps stale folders with the prefix of any of its names', () => {
    for (const name of ['fartcrobat-999999-abc', 'fartcrobat-print-999999-abc', 'other-999999-abc']) mkdirSync(join(base, name))
    writeFileSync(join(base, 'fartcrobat-999999-abc', 'f'), 'x')
    const removed = TempFiles.sweepStale(base, () => false).map((p) => p.slice(base.length + 1)).sort()
    expect(removed).toEqual(['fartcrobat-999999-abc', 'fartcrobat-print-999999-abc'])
  })
})

describe('updater cache across a rename', () => {
  it('names the folder the old updater downloaded into, on each system', () => {
    expect(legacyUpdaterCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')).toBe(
      'C:\\Users\\me\\AppData\\Local\\fartcrobat-updater'
    )
    expect(legacyUpdaterCacheDir('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Caches/fartcrobat-updater')
    expect(legacyUpdaterCacheDir('linux', {}, '/home/me')).toBe('/home/me/.cache/fartcrobat-updater')
    expect(legacyUpdaterCacheDir('linux', { XDG_CACHE_HOME: '/c' }, '/home/me')).toBe('/c/fartcrobat-updater')
    // Never the current one.
    expect(legacyUpdaterCacheDir('linux', {}, '/home/me', 'Fartcrobat')).toBeNull()
  })
})
