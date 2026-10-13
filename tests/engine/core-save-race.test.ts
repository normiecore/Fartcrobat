import { describe, expect, it } from 'vitest'
import type pagesOps from '@engine/ops/pages'
import { openFixture } from './helpers'

describe('marking a document saved', () => {
  it('stays dirty when the document changed after the saved bytes were produced', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pagesOps>('pages')
    await pages.rotate([1], 90)
    const { bytes, version } = await e.doc.saveWithVersion({})
    expect(bytes.length).toBeGreaterThan(1000)
    // An edit lands while the bytes are being written to disk.
    await pages.rotate([0], 90)
    await e.doc.markSaved('text.pdf', version)
    expect(e.lastChanges?.dirty).toBe(true)
    expect(await e.doc.isDirty()).toBe(true)

    // The next save covers everything.
    const second = await e.doc.saveWithVersion({})
    await e.doc.markSaved('text.pdf', second.version)
    expect(await e.doc.isDirty()).toBe(false)
  })

  it('is clean when nothing changed since the bytes were produced', async () => {
    const e = await openFixture('text.pdf')
    await e.ops<typeof pagesOps>('pages').rotate([0], 90)
    expect(await e.doc.isDirty()).toBe(true)
    const { version } = await e.doc.saveWithVersion({})
    await e.doc.markSaved('text.pdf', version)
    expect(await e.doc.isDirty()).toBe(false)
  })

  it('counts undo and redo as changes since the save', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pagesOps>('pages')
    await pages.rotate([0], 90)
    await pages.rotate([1], 90)
    const { version } = await e.doc.saveWithVersion({})
    await e.doc.undo()
    await e.doc.markSaved('text.pdf', version)
    expect(await e.doc.isDirty()).toBe(true)
  })

  it('a converted document saved while being edited is still unsaved', async () => {
    const e = await openFixture('text.pdf')
    const created = await e.doc.createBlank({ pages: 1 })
    expect(created.ok).toBe(true)
    expect(await e.doc.isDirty()).toBe(true)
    const { version } = await e.doc.saveWithVersion({})
    await e.ops<typeof pagesOps>('pages').rotate([0], 90)
    await e.doc.markSaved('new.pdf', version)
    expect(await e.doc.isDirty()).toBe(true)
  })

  it('works with incremental saves, which reopen the document from the saved bytes', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pagesOps>('pages')
    await pages.rotate([0], 90)
    const first = await e.doc.saveWithVersion({ mode: 'incremental' })
    await e.doc.markSaved('text.pdf', first.version)
    expect(await e.doc.isDirty()).toBe(false)

    await pages.rotate([1], 90)
    const second = await e.doc.saveWithVersion({ mode: 'incremental' })
    await pages.rotate([2], 90)
    await e.doc.markSaved('text.pdf', second.version)
    expect(await e.doc.isDirty()).toBe(true)
  })

  it('queries and empty operations during the write do not count as edits', async () => {
    const e = await openFixture('text.pdf')
    await e.ops<typeof pagesOps>('pages').rotate([0], 90)
    const { version } = await e.doc.saveWithVersion({})
    await e.doc.info()
    await e.doc.undo()
    await e.doc.redo()
    // Undo + redo lands on the same content, but the engine cannot know the file matches it.
    await e.doc.markSaved('text.pdf', version)
    expect(await e.doc.isDirty()).toBe(true)

    const again = await e.doc.saveWithVersion({})
    await e.doc.info()
    await e.doc.journal()
    await e.doc.markSaved('text.pdf', again.version)
    expect(await e.doc.isDirty()).toBe(false)
  })

  it('markSaved without a version keeps its old meaning', async () => {
    const e = await openFixture('text.pdf')
    await e.ops<typeof pagesOps>('pages').rotate([0], 90)
    await e.doc.markSaved('text.pdf')
    expect(await e.doc.isDirty()).toBe(false)
  })
})
