import { describe, expect, it } from 'vitest'
import type pageOps from '@engine/ops/pages'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import { openFixture, roundTrip } from './helpers'

describe('document properties', () => {
  it('writes dates read from info() back as valid PDF dates', async () => {
    const e = await openFixture('text.pdf')
    await e.doc.setMetadata({ creationDate: '2024-05-06T07:08:09.000Z', title: 'Dated' })
    const info = await e.doc.info()
    expect(info.metadata.creationDate).toBe('2024-05-06T07:08:09.000Z')
    // the modification date moves to now
    expect(Date.now() - Date.parse(info.metadata.modDate)).toBeLessThan(60_000)
    const rt = await roundTrip(e)
    expect(rt.info.metadata.creationDate).toBe('2024-05-06T07:08:09.000Z')
    // sending back what info() returned keeps the dates
    await e.doc.setMetadata(info.metadata)
    const again = await e.doc.info()
    expect(again.metadata.creationDate).toBe(info.metadata.creationDate)
    expect(again.metadata.modDate).toBe(info.metadata.modDate)
    await expect(e.doc.setMetadata({ creationDate: 'yesterday-ish' })).rejects.toThrow(/date/)
  })

  it('keeps region subtags of the document language', async () => {
    const e = await openFixture('text.pdf')
    await e.doc.setLanguage('en-US')
    expect((await e.doc.info()).language).toBe('en-US')
    const rt = await roundTrip(e)
    expect(rt.info.language).toBe('en-US')
    await e.doc.setLanguage('')
    expect((await e.doc.info()).language).toBeNull()
  })
})

describe('converting reflowable files', () => {
  it('lays out text files on Letter pages, on open and on insert', async () => {
    const text = new TextEncoder().encode('Meeting notes\n\nFirst point.\nSecond point.\n')
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(text, { fileName: 'notes.txt' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(Math.round(res.info.pages[0].width)).toBe(612)
      expect(Math.round(res.info.pages[0].height)).toBe(792)
    }

    const e = await openFixture('text.pdf')
    await e.ops<typeof pageOps>('pages').insertFrom(-1, text, { fileName: 'notes.txt' })
    const info = await e.doc.info()
    const last = info.pages[info.pageCount - 1]
    expect([Math.round(last.width), Math.round(last.height)]).toEqual([612, 792])
  })
})
