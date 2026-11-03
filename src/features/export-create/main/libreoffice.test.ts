/**
 * LibreOffice detection and conversion (main process logic, plain Node). Lives next to the code
 * because main-process files belong to the Node TypeScript project. Conversion tests are skipped
 * when LibreOffice is not installed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidatePaths, convertWithLibreOffice, findLibreOffice, libreOfficeVersion, prepareProfile } from './libreoffice'

const FIXTURES = resolve(__dirname, '../../../../tests/fixtures/export-create')

describe('LibreOffice detection', () => {
  it('does not look for LibreOffice in relative PATH folders', () => {
    const win = candidatePaths('win32', { PATH: '.;C:\\Tools;relative\\dir', ProgramFiles: 'C:\\Program Files' })
    expect(win.some((p) => p.startsWith('C:\\Tools'))).toBe(true)
    expect(win.filter((p) => !/^[A-Za-z]:\\/.test(p))).toEqual([])
    const linux = candidatePaths('linux', { PATH: '.:/usr/bin::bin' })
    expect(linux.filter((p) => !p.startsWith('/'))).toEqual([])
  })

  it('knows the standard install locations of every platform', () => {
    const win = candidatePaths('win32', { ProgramFiles: 'C:\\Program Files', PATH: '' })
    expect(win).toContain('C:\\Program Files\\LibreOffice\\program\\soffice.exe')
    const mac = candidatePaths('darwin', { HOME: '/Users/me', PATH: '' })
    expect(mac).toContain('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    const linux = candidatePaths('linux', { HOME: '/home/me', PATH: '/usr/local/bin:/usr/bin' })
    expect(linux.slice(0, 4)).toEqual(['/usr/local/bin/soffice', '/usr/local/bin/libreoffice', '/usr/bin/soffice', '/usr/bin/libreoffice'])
    for (const p of ['/usr/lib/libreoffice/program/soffice', '/snap/bin/libreoffice', '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice']) {
      expect(linux).toContain(p)
    }
  })

  it('ignores a preferred path that does not exist', async () => {
    const found = await findLibreOffice('/no/such/soffice', { version: false })
    if (found) expect(found.path).not.toBe('/no/such/soffice')
  })
})

describe('LibreOffice conversion', async () => {
  const soffice = await findLibreOffice(undefined, { version: false })
  it.skipIf(!soffice)('reports its version', async () => {
    const v = await libreOfficeVersion(soffice!.path)
    expect(v).toMatch(/^\d+\.\d+/)
  })

  it.skipIf(!soffice)('converts a Word document to PDF with a private profile', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'fc-lo-profile-'))
    const pdf = await convertWithLibreOffice(soffice!.path, join(FIXTURES, 'sample.docx'), { profileDir })
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe('%PDF-')
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(pdf, 'application/pdf')
    const text = doc.loadPage(0).toStructuredText('').asText()
    expect(text).toContain('Converted Word Document')
    expect(text).toContain('Second paragraph')
    expect(text).toContain('Alpha')
    // The profile is kept for the next conversion (faster start).
    expect(existsSync(profileDir)).toBe(true)
  })

  it.skipIf(!soffice)('converts a CSV file and fails clearly for a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-lo-csv-'))
    const csv = join(dir, 'numbers.csv')
    writeFileSync(csv, 'Name,Value\nAlpha,1\nBeta,2\n')
    const pdf = await convertWithLibreOffice(soffice!.path, csv)
    expect(pdf.length).toBeGreaterThan(500)
    await expect(convertWithLibreOffice(soffice!.path, join(dir, 'missing.docx'))).rejects.toThrow(/does not exist/)
    expect(readFileSync(csv, 'utf8')).toContain('Alpha')
  })

  // linked-image.docx/.odt (make_linked_office.py) link one image from http://127.0.0.1:47613 and
  // one from file:///tmp/fartcrobat-linked-image-test.png. Neither may be loaded.
  const LINKED_FILE = '/tmp/fartcrobat-linked-image-test.png'
  // A 1x1 PNG.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  for (const ext of ['docx', 'odt']) {
    it.skipIf(!soffice || process.platform === 'win32')(`does not load images a ${ext} file links to`, async () => {
      const requests: string[] = []
      const server = createServer((req, res) => {
        requests.push(req.url ?? '')
        res.setHeader('Content-Type', 'image/png')
        res.end(PNG)
      })
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(47613, '127.0.0.1', () => resolve(true))
      })
      if (!listening) return // the port is taken: nothing to check against
      writeFileSync(LINKED_FILE, PNG)
      // A profile LibreOffice already wrote its own settings into is fixed up too.
      const profileDir = mkdtempSync(join(tmpdir(), 'fc-lo-profile-'))
      prepareProfile(profileDir)
      writeFileSync(join(profileDir, 'user', 'registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"></oor:items>')
      try {
        const pdf = await convertWithLibreOffice(soffice!.path, join(FIXTURES, `linked-image.${ext}`), { profileDir })
        const mupdf = await import('mupdf')
        const doc = mupdf.Document.openDocument(pdf, 'application/pdf')
        const page = doc.loadPage(0)
        expect(page.toStructuredText('').asText()).toContain('Linked images document')
        let images = 0
        page.toStructuredText('preserve-images').walk({ onImageBlock: () => void images++ })
        expect(images).toBe(0)
        expect(requests).toEqual([])
      } finally {
        server.close()
        rmSync(LINKED_FILE, { force: true })
        rmSync(profileDir, { recursive: true, force: true })
      }
    })
  }
})
