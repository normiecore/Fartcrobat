import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RENDERER_CSP } from '@main/util/csp'
import { appImageFile } from '@main/util/appImage'
import {
  applicationsDirs,
  desktopEntry,
  desktopExecQuote,
  findDesktopFile,
  GENERATED_MARKER,
  isGeneratedDesktopFile,
  retargetDesktopEntry,
  userApplicationsDir
} from '@main/util/linuxDesktop'
import { sheetStyle } from '@main/util/printSheet'
import { isFartcrobatProgId, parseLpstatDefault, parseWindowsDevice, regValue, WINDOWS_PROG_ID } from '@main/util/systemDefaults'

const ROOT = resolve(__dirname, '../..')

describe('default printer', () => {
  it('reads the CUPS default destination', () => {
    expect(parseLpstatDefault('system default destination: Office_Laser\n')).toBe('Office_Laser')
    expect(parseLpstatDefault('no system default destination\n')).toBeNull()
    expect(parseLpstatDefault('')).toBeNull()
  })

  it('reads the Windows default printer (names may contain spaces)', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows\r\n    Device    REG_SZ    HP LaserJet 400 M401 (Office),winspool,Ne01:\r\n\r\n'
    expect(parseWindowsDevice(out)).toBe('HP LaserJet 400 M401 (Office)')
    expect(parseWindowsDevice('')).toBeNull()
  })
})

describe('default PDF app on Windows', () => {
  it('reads the whole UserChoice ProgId, spaces included', () => {
    const out = '\r\nHKEY_CURRENT_USER\\...\\.pdf\\UserChoice\r\n    ProgId    REG_SZ    PDF Document\r\n'
    expect(regValue(out, 'ProgId')).toBe('PDF Document')
    expect(isFartcrobatProgId('PDF Document')).toBe(false)
    expect(isFartcrobatProgId('Acrobat.Document.DC')).toBe(false)
    expect(isFartcrobatProgId(regValue(`    ProgId    REG_SZ    ${WINDOWS_PROG_ID}`, 'ProgId')!)).toBe(true)
    expect(isFartcrobatProgId('Applications\\Fartcrobat.exe')).toBe(true)
  })

  it('matches the ProgId the installer registers', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    const win = yml.slice(yml.indexOf('\nwin:'), yml.indexOf('\nnsis:'))
    expect(win).toMatch(new RegExp(`name: ${WINDOWS_PROG_ID.replace('.', '\\.')}\\n`))
    expect(yml).not.toMatch(/^fileAssociations:/m)
    const nsh = readFileSync(join(ROOT, 'build/installer.nsh'), 'utf8')
    expect(nsh).toContain(`".pdf" "${WINDOWS_PROG_ID}"`)
    expect(nsh).toContain('Software\\RegisteredApplications" "Fartcrobat"')
  })
})

describe('Linux desktop entry', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'core-main-xdg-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('looks in the XDG data folders', () => {
    const env = { XDG_DATA_HOME: join(home, 'data'), XDG_DATA_DIRS: `${join(home, 'sys')}:relative/ignored` }
    expect(userApplicationsDir(env, home)).toBe(join(home, 'data/applications'))
    expect(applicationsDirs(env, home)).toEqual([join(home, 'data/applications'), join(home, 'sys/applications')])
    expect(userApplicationsDir({}, home)).toBe(join(home, '.local/share/applications'))
    expect(findDesktopFile(env, home)).toBeNull()
    mkdirSync(join(home, 'sys/applications'), { recursive: true })
    writeFileSync(join(home, 'sys/applications/fartcrobat.desktop'), '[Desktop Entry]\n')
    expect(findDesktopFile(env, home)).toBe(join(home, 'sys/applications/fartcrobat.desktop'))
    expect(isGeneratedDesktopFile(join(home, 'sys/applications/fartcrobat.desktop'))).toBe(false)
  })

  it('writes an entry that starts the AppImage with the files, marked as generated', () => {
    const entry = desktopEntry('/home/me/Apps/Fartcrobat 0.1.0.AppImage', 'fartcrobat')
    expect(entry).toContain('Exec="/home/me/Apps/Fartcrobat 0.1.0.AppImage" %F\n')
    expect(entry).toContain('MimeType=application/pdf;')
    expect(entry).toContain(GENERATED_MARKER)
    const p = join(home, 'x.desktop')
    writeFileSync(p, entry)
    expect(existsSync(p) && isGeneratedDesktopFile(p)).toBe(true)
  })

  it('escapes special characters in the program path', () => {
    expect(desktopExecQuote('/opt/a"b`c$d\\e%f')).toBe('"/opt/a\\\\"b\\\\`c\\\\$d\\\\\\\\e%%f"')
  })
  it('follows an AppImage an update renamed, only in entries Fartcrobat wrote for that file', () => {
    const from = '/home/me/Apps/Fartcrobat-0.2.0.AppImage'
    const to = '/home/me/Apps/Fartcrobat-0.2.1.AppImage'
    const entry = desktopEntry(from, 'fartcrobat')
    expect(retargetDesktopEntry(entry, from, to)).toBe(desktopEntry(to, 'fartcrobat'))
    // Another install the person made the default, or an entry a package installed.
    expect(retargetDesktopEntry(desktopEntry('/opt/Fartcrobat/fartcrobat', 'fartcrobat'), from, to)).toBeNull()
    expect(retargetDesktopEntry(entry.replace(GENERATED_MARKER, ''), from, to)).toBeNull()
  })
})

describe('AppImage', () => {
  const mount = '/tmp/.mount_FartcrAb12'
  const own = { APPIMAGE: '/home/me/Apps/Fartcrobat.AppImage', APPDIR: mount }
  const none = () => null

  it('is the file this process runs from only when execPath is inside APPDIR', () => {
    expect(appImageFile(`${mount}/fartcrobat`, own, none)).toBe(own.APPIMAGE)
    expect(appImageFile(`${mount}/fartcrobat`, { ...own, APPDIR: `${mount}/` }, none)).toBe(own.APPIMAGE)
    // Passed on by another AppImage that started this copy.
    expect(appImageFile('/opt/Fartcrobat/fartcrobat', own, none)).toBeNull()
    expect(appImageFile(`${mount}x/fartcrobat`, own, none)).toBeNull()
    expect(appImageFile(`${mount}/fartcrobat`, { APPIMAGE: own.APPIMAGE }, none)).toBeNull()
    expect(appImageFile(`${mount}/fartcrobat`, { APPDIR: mount }, none)).toBeNull()
    expect(appImageFile('/fartcrobat', { ...own, APPDIR: '/' }, none)).toBeNull()
    // A mount under a linked temporary folder: execPath is the resolved path.
    const linked = { ...own, APPDIR: '/home/me/tmp/.mount_FartcrAb12' }
    expect(appImageFile(`${mount}/fartcrobat`, linked, (p) => (p === linked.APPDIR ? mount : null))).toBe(
      own.APPIMAGE
    )
    expect(appImageFile(`${mount}/fartcrobat`, linked, none)).toBeNull()
  })
})

describe('printing', () => {
  it('never enlarges sheets with "shrink", keeps "actual" size and fills the paper with "fit"', () => {
    expect(sheetStyle('actual', 612, 792)).toBe('width:8.500in;height:11.000in')
    expect(sheetStyle('shrink', 612, 792)).toBe('width:8.500in;height:11.000in;max-width:100%;max-height:100%;object-fit:contain')
    expect(sheetStyle('fit', 612, 792)).toContain('max-width:100%')
    expect(sheetStyle(undefined, 612, 792)).toContain('max-width:100%')
  })
})

describe('Content Security Policy', () => {
  it('serves the same policy the page declares', () => {
    const html = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8')
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
    expect(meta).toBe(RENDERER_CSP)
    expect(RENDERER_CSP).toContain("connect-src 'self' blob: data:")
    expect(RENDERER_CSP).not.toContain("'unsafe-eval'")
  })
})
