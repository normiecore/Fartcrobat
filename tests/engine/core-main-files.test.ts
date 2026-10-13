import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWrite } from '@main/util/atomicWrite'
import { filesFromArgv, normalizeLaunchArg, openableFile } from '@main/util/launchPaths'
import { safeFileName, TempFiles } from '@main/util/tempFiles'
import { unsafeToOpenReason } from '@main/util/unsafeFiles'

const posix = process.platform !== 'win32'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'core-main-files-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const leftovers = (d: string) => readdirSync(d).filter((n) => n.includes('fartcrobat-tmp'))
const bytes = (s: string) => new TextEncoder().encode(s)

describe('launch paths', () => {
  it('resolves relative paths against the launching process folder', () => {
    writeFileSync(join(dir, 'report.pdf'), 'x')
    expect(normalizeLaunchArg('report.pdf', dir)).toBe(join(dir, 'report.pdf'))
    expect(filesFromArgv(['/usr/bin/fartcrobat', 'report.pdf'], dir)).toEqual([join(dir, 'report.pdf')])
    // The same argument from another folder names another (missing) file.
    expect(filesFromArgv(['/usr/bin/fartcrobat', 'report.pdf'], tmpdir())).toEqual([])
  })

  it('accepts file:// URIs and ignores flags, other URLs and the app script', () => {
    const file = join(dir, 'a b.pdf')
    writeFileSync(file, 'x')
    const uri = pathToFileURL(file).toString()
    expect(uri).toContain('a%20b.pdf')
    expect(normalizeLaunchArg(uri, '/')).toBe(file)
    expect(normalizeLaunchArg('--no-sandbox', dir)).toBeNull()
    expect(normalizeLaunchArg('https://example.com/a.pdf', dir)).toBeNull()
    writeFileSync(join(dir, 'index.js'), 'x')
    expect(filesFromArgv(['electron', join(dir, 'index.js'), '--flag', uri, uri], dir, 2)).toEqual([file])
  })

  it('opens Office and OpenDocument files the converter handles, but not unknown types or folders', () => {
    for (const n of ['a.doc', 'b.odt', 'c.rtf', 'd.xls', 'e.ods', 'f.csv', 'g.ppt', 'h.odp', 'i.docx', 'j.exe']) writeFileSync(join(dir, n), 'x')
    mkdirSync(join(dir, 'folder.pdf'))
    const got = filesFromArgv(['x', 'a.doc', 'b.odt', 'c.rtf', 'd.xls', 'e.ods', 'f.csv', 'g.ppt', 'h.odp', 'i.docx', 'j.exe', 'folder.pdf'], dir)
    expect(got.map((p) => p.slice(dir.length + 1))).toEqual(['a.doc', 'b.odt', 'c.rtf', 'd.xls', 'e.ods', 'f.csv', 'g.ppt', 'h.odp', 'i.docx'])
    expect(openableFile(join(dir, 'j.exe'), dir)).toBeNull()
    expect(openableFile(join(dir, 'a.doc'), '/')).toBe(join(dir, 'a.doc'))
  })
})

describe('opening files from a PDF', () => {
  const file = { isFile: () => true, isDirectory: () => false, mode: 0o644 }
  const folder = { isFile: () => false, isDirectory: () => true, mode: 0o755 }

  it('refuses programs, scripts and launchers on every platform', () => {
    for (const name of ['Invoice.pdf.exe', 'run.BAT', 'x.js', 'x.vbs', 'x.hta', 'x.lnk', 'x.scr', 'x.msi', 'x.ps1', 'x.jar', 'x.desktop', 'x.sh', 'x.command', 'x.AppImage', 'x.docm', 'evil.exe.  ']) {
      expect(unsafeToOpenReason(`/tmp/${name}`, file, 'linux'), name).toMatch(/For your safety/)
      expect(unsafeToOpenReason(`C:\\Temp\\${name}`, file, 'win32'), name).toMatch(/For your safety/)
    }
    // macOS application bundles are folders.
    expect(unsafeToOpenReason('/Applications/Calculator.app/', folder, 'darwin')).toMatch(/Calculator\.app/)
  })

  it('allows documents and ordinary folders', () => {
    for (const name of ['report.pdf', 'notes.txt', 'sheet.xlsx', 'photo.JPG', 'archive.pdf.docx']) {
      expect(unsafeToOpenReason(`/tmp/${name}`, file, 'linux'), name).toBeNull()
      expect(unsafeToOpenReason(`C:\\Temp\\${name}`, file, 'win32'), name).toBeNull()
    }
    expect(unsafeToOpenReason('/home/me/Exports', folder, 'linux')).toBeNull()
    // Exported files on FAT/NTFS drives often have the executable bit: documents still open.
    expect(unsafeToOpenReason('/media/usb/report.pdf', { ...file, mode: 0o777 }, 'linux')).toBeNull()
  })

  it('refuses executables without an extension and Windows stream names', () => {
    expect(unsafeToOpenReason('/tmp/installer', { ...file, mode: 0o755 }, 'linux')).toMatch(/executable/)
    expect(unsafeToOpenReason('/tmp/readme', file, 'linux')).toBeNull()
    expect(unsafeToOpenReason('C:\\Temp\\a.pdf:evil', file, 'win32')).toMatch(/For your safety/)
  })
})

describe('atomicWrite', () => {
  it('creates and replaces files without leaving temporary files', async () => {
    const p = join(dir, 'a.pdf')
    await atomicWrite(p, bytes('one'))
    await atomicWrite(p, bytes('two'))
    expect(readFileSync(p, 'utf8')).toBe('two')
    expect(leftovers(dir)).toEqual([])
  })

  it.runIf(posix)('keeps symbolic links and updates the file they point to', async () => {
    const real = join(dir, 'Dropbox', 'contract.pdf')
    mkdirSync(join(dir, 'Dropbox'))
    writeFileSync(real, 'v1')
    const link = join(dir, 'contract.pdf')
    symlinkSync(join('Dropbox', 'contract.pdf'), link)
    await atomicWrite(link, bytes('v2'))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('v2')
    // A link to a file that does not exist yet creates that file.
    const dangling = join(dir, 'new.pdf')
    symlinkSync(join(dir, 'Dropbox', 'new.pdf'), dangling)
    await atomicWrite(dangling, bytes('n'))
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, 'Dropbox', 'new.pdf'), 'utf8')).toBe('n')
    expect(leftovers(join(dir, 'Dropbox'))).toEqual([])
  })

  it.runIf(posix)('keeps the file permissions', async () => {
    const p = join(dir, 'private.pdf')
    writeFileSync(p, 'v1')
    chmodSync(p, 0o600)
    await atomicWrite(p, bytes('v2'))
    expect(statSync(p).mode & 0o777).toBe(0o600)
    chmodSync(p, 0o640)
    await atomicWrite(p, bytes('v3'))
    expect(statSync(p).mode & 0o777).toBe(0o640)
  })

  it.runIf(posix)('updates every hard link of the file', async () => {
    const a = join(dir, 'a.pdf')
    const b = join(dir, 'b.pdf')
    writeFileSync(a, 'v1')
    linkSync(a, b)
    await atomicWrite(a, bytes('v2'))
    expect(readFileSync(b, 'utf8')).toBe('v2')
    expect(statSync(a).ino).toBe(statSync(b).ino)
    expect(leftovers(dir)).toEqual([])
  })

  it('retries a rename Windows reports as busy, then falls back to overwriting in place', async () => {
    const p = join(dir, 'busy.pdf')
    writeFileSync(p, 'v1')
    let calls = 0
    const busy = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
    await atomicWrite(p, bytes('v2'), {
      platform: 'win32',
      retryDelays: [1, 1, 1],
      fs: {
        rename: async (from, to) => {
          if (++calls < 3) throw busy
          const { rename } = await import('node:fs/promises')
          await rename(from, to)
        }
      }
    })
    expect(calls).toBe(3)
    expect(readFileSync(p, 'utf8')).toBe('v2')

    calls = 0
    await atomicWrite(p, bytes('v3'), {
      platform: 'win32',
      retryDelays: [1, 1],
      fs: {
        rename: async () => {
          calls++
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }
      }
    })
    expect(calls).toBe(3)
    expect(readFileSync(p, 'utf8')).toBe('v3')
    expect(leftovers(dir)).toEqual([])
  })

  it('does not retry or overwrite in place for other errors, and keeps the original', async () => {
    const p = join(dir, 'keep.pdf')
    writeFileSync(p, 'original')
    await expect(
      atomicWrite(p, bytes('new'), {
        platform: 'linux',
        fs: { rename: async () => Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' })) }
      })
    ).rejects.toThrow(/EXDEV/)
    expect(readFileSync(p, 'utf8')).toBe('original')
    expect(leftovers(dir)).toEqual([])
  })

  it('removes the temporary file when writing fails (disk full)', async () => {
    const p = join(dir, 'full.pdf')
    writeFileSync(p, 'original')
    await expect(
      atomicWrite(p, bytes('new'), { fs: { writeData: async () => Promise.reject(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })) } })
    ).rejects.toThrow(/ENOSPC/)
    expect(readFileSync(p, 'utf8')).toBe('original')
    expect(leftovers(dir)).toEqual([])
  })

  it('refuses to replace a folder', async () => {
    mkdirSync(join(dir, 'folder.pdf'))
    await expect(atomicWrite(join(dir, 'folder.pdf'), bytes('x'))).rejects.toThrow(/folder/)
    expect(leftovers(dir)).toEqual([])
  })
})

describe('session temporary files', () => {
  it('keeps files in one private folder per session and removes it on cleanup', () => {
    const t = new TempFiles(dir)
    const a = t.pathFor('Invoice.pdf')
    const b = t.pathFor('Invoice.pdf')
    expect(a).not.toBe(b)
    expect(a.endsWith('Invoice.pdf')).toBe(true)
    expect(a.startsWith(join(dir, `fartcrobat-${process.pid}-`))).toBe(true)
    if (posix) expect(statSync(t.root()).mode & 0o777).toBe(0o700)
    expect(t.contains(a)).toBe(true)
    expect(t.contains(join(dir, 'other.pdf'))).toBe(false)
    const print = t.newDir('print-')
    writeFileSync(join(print, 'p0.png'), 'x')
    t.removeDir(print)
    expect(existsSync(print)).toBe(false)
    const root = t.root()
    t.cleanup()
    expect(existsSync(root)).toBe(false)
  })

  it('makes attachment names safe', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Windows\\evil.pdf')).toBe('evil.pdf')
    expect(safeFileName('a<b>:c?.pdf')).toBe('a_b__c_.pdf')
    expect(safeFileName('CON.txt')).toBe('_CON.txt')
    expect(safeFileName('report.pdf. . ')).toBe('report.pdf')
    expect(safeFileName('')).toBe('attachment')
    expect(safeFileName('x'.repeat(300) + '.pdf').length).toBe(180)
    expect(safeFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true)
  })

  it('sweeps folders of sessions that are no longer running, and only those', () => {
    const dead = join(dir, 'fartcrobat-999999-abc')
    const deadOld = join(dir, 'fartcrobat-print-999998-1')
    const deadFile = join(dir, 'fartcrobat-999997-attachment.pdf')
    const alive = join(dir, `fartcrobat-${process.pid}-xyz`)
    const other = join(dir, 'fartcrobat-e2e-123')
    for (const d of [dead, deadOld, alive, other]) mkdirSync(d)
    writeFileSync(deadFile, 'x')
    writeFileSync(join(dead, 'p0.png'), 'x')
    const removed = TempFiles.sweepStale(dir, (pid) => pid === process.pid)
    expect(removed.sort()).toEqual([dead, deadFile, deadOld].sort())
    expect(existsSync(alive)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})
