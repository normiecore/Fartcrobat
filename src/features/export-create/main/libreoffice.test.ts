/**
 * LibreOffice detection and conversion (main process logic, plain Node). Lives next to the code
 * because main-process files belong to the Node TypeScript project. Conversion tests are skipped
 * when LibreOffice is not installed.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidatePaths, convertWithLibreOffice, findLibreOffice, libreOfficeVersion } from './libreoffice'

const FIXTURES = resolve(__dirname, '../../../../tests/fixtures/export-create')

describe('LibreOffice detection', () => {
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
})
