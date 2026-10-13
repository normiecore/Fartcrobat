import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type textOps from '@engine/ops/text'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import { fixture, openFixture } from './helpers'

describe('dirty tracking', () => {
  it('stays dirty after undoing past the save and making a different edit', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    await e.doc.save({})
    await e.doc.markSaved('text.pdf')
    expect(await e.doc.isDirty()).toBe(false)
    await e.doc.undo()
    expect(e.lastChanges?.dirty).toBe(true)
    // lands on the same journal position as the saved state, but it is a different document
    await annots.create(0, { type: 'Circle', rect: [60, 60, 90, 90] })
    expect(e.lastChanges?.journal.position).toBe(1)
    expect(e.lastChanges?.dirty).toBe(true)
    expect(await e.doc.isDirty()).toBe(true)
    // undo/redo inside the new history never reaches the saved state again
    await e.doc.undo()
    expect(e.lastChanges?.dirty).toBe(true)
    await e.doc.redo()
    expect(e.lastChanges?.dirty).toBe(true)
    // saving again makes it clean
    await e.doc.markSaved('text.pdf')
    expect(await e.doc.isDirty()).toBe(false)
  })

  it('still reports clean when undo and redo come back to the saved state', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    await e.doc.markSaved('text.pdf')
    await e.doc.undo()
    expect(e.lastChanges?.dirty).toBe(true)
    await e.doc.redo()
    expect(e.lastChanges?.dirty).toBe(false)
  })

  it('a failed or empty operation does not lose the saved state in the redo history', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    await e.doc.markSaved('text.pdf')
    await e.doc.undo()
    await expect(annots.create(0, {})).rejects.toThrow()
    await e.doc.redo()
    expect(e.lastChanges?.dirty).toBe(false)
  })

  it('opens new documents as unsaved when asked, and keeps them unsaved through queries', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    const res = await doc.open(fixture('text.pdf'), { fileName: 'Binder1.pdf', dirty: true })
    expect(res.ok).toBe(true)
    expect(engine.lastChanges?.dirty).toBe(true)
    await engine.ops<typeof textOps>('text').plain(0)
    expect(engine.lastChanges?.dirty).toBe(true)
    await doc.markSaved('Binder1.pdf')
    expect(await doc.isDirty()).toBe(false)
  })

  it('remembers the unsaved flag across the password prompt', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    const first = await doc.open(fixture('encrypted.pdf'), { fileName: 'enc.pdf', dirty: true })
    expect(first.ok).toBe(false)
    const res = await doc.authenticate('secret')
    expect(res.ok).toBe(true)
    expect(engine.lastChanges?.dirty).toBe(true)
  })

  it('markDirty and reload({ dirty }) report unsaved content', async () => {
    const e = await openFixture('text.pdf')
    await e.doc.markDirty()
    expect(e.lastChanges?.dirty).toBe(true)
    await e.doc.markSaved('text.pdf')
    const bytes = await e.doc.save({})
    const res = await e.doc.reload(bytes, { dirty: true })
    expect(res.ok).toBe(true)
    expect(e.lastChanges?.dirty).toBe(true)
    const clean = await e.doc.reload(bytes, {})
    expect(clean.ok).toBe(true)
    expect(e.lastChanges?.dirty).toBe(false)
  })

  it('keeps the default comment author after a reload', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.setAuthor('Darren')
    const bytes = await e.doc.save({})
    await e.doc.reload(bytes, {})
    const note = await annots.create(0, { type: 'Text', rect: [10, 10, 30, 30] })
    expect(note.author).toBe('Darren')
  })
})
