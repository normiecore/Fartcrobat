import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { activeDocState, launch, openFile, runCommand, waitForRender } from './helpers'

/** A one-page PDF with some text and a signed signature field. */
function signedPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const helv = doc.addObject(doc.newDictionary())
  helv.put('Type', doc.newName('Font'))
  helv.put('Subtype', doc.newName('Type1'))
  helv.put('BaseFont', doc.newName('Helvetica'))
  const fonts = doc.newDictionary()
  fonts.put('F1', helv)
  const res = doc.newDictionary()
  res.put('Font', fonts)
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, 'BT /F1 36 Tf 72 700 Td (Signed contract) Tj ET'))
  const page = doc.findPage(0)
  const value = doc.addObject(doc.newDictionary())
  value.put('Type', doc.newName('Sig'))
  value.put('Filter', doc.newName('Adobe.PPKLite'))
  value.put('Contents', doc.newByteString(new Uint8Array([0, 0, 0, 0])))
  const sig = doc.addObject(doc.newDictionary())
  sig.put('FT', doc.newName('Sig'))
  sig.put('T', doc.newString('Signature1'))
  sig.put('V', value)
  sig.put('Type', doc.newName('Annot'))
  sig.put('Subtype', doc.newName('Widget'))
  sig.put('Rect', [100, 400, 300, 450])
  sig.put('P', page)
  sig.put('F', 4)
  page.put('Annots', [sig])
  const acro = doc.newDictionary()
  acro.put('Fields', [sig])
  acro.put('SigFlags', 3)
  doc.getTrailer().get('Root').put('AcroForm', acro)
  const out = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return out
}

async function addAnnotation(page: import('@playwright/test').Page, type: string, rect: number[]) {
  await page.evaluate(
    async ([t, r]) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      await d.ops('annots').create(0, { type: t, rect: r })
    },
    [type, rect] as const
  )
}

test('saving a signed file twice appends two valid incremental updates', async () => {
  mupdf.setLog({ warning: () => {}, error: () => {} } as any)
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-save-'))
  const file = join(dir, 'signed.pdf')
  const original = signedPdf()
  writeFileSync(file, original)
  const { app, page } = await launch()
  try {
    await openFile(page, file)
    await waitForRender(page)

    await addAnnotation(page, 'Square', [10, 10, 50, 50])
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await runCommand(page, 'file.save')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    const first = new Uint8Array(readFileSync(file))

    await addAnnotation(page, 'Circle', [60, 60, 90, 90])
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await runCommand(page, 'file.save')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    const second = new Uint8Array(readFileSync(file))

    // each save appends to the previous file; the signed original stays byte-for-byte intact
    expect(Buffer.from(first.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true)
    expect(Buffer.from(second.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true)
    const d = new mupdf.PDFDocument(second)
    expect(d.wasRepaired()).toBe(false)
    expect(d.countVersions()).toBe(3)
    const types = d
      .loadPage(0)
      .getAnnotations()
      .map((a) => a.getType())
    expect(types).toEqual(expect.arrayContaining(['Square', 'Circle']))
    d.destroy()

    // the tab keeps working after the saves
    await addAnnotation(page, 'Square', [100, 100, 150, 150])
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel).toBe('Add Square')
    await waitForRender(page)
    await page.screenshot({ path: 'test-results/core-save-signed.png' })
  } finally {
    await app.close()
  }
})
