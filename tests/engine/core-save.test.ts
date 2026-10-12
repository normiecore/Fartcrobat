import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import { saveDocument } from '@engine/ops/doc'
import { openBytes, reopen, signedFormPdf, xrefChain } from './core-docs'

function startsWith(bytes: Uint8Array, prefix: Uint8Array) {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
  return true
}

describe('incremental saves', () => {
  it('chains consecutive incremental saves onto the previous file', async () => {
    const original = signedFormPdf()
    const e = await openBytes(original, 'signed.pdf')
    const annots = e.ops<typeof annotOps>('annots')

    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    const first = await e.doc.save({})
    await e.doc.markSaved('signed.pdf')
    expect(startsWith(first, original)).toBe(true)

    await annots.create(0, { type: 'Circle', rect: [60, 60, 90, 90] })
    const second = await e.doc.save({})
    await e.doc.markSaved('signed.pdf')

    // The second save appends to the first one, and its /Prev points at the first save's xref.
    expect(startsWith(second, first)).toBe(true)
    const chain1 = xrefChain(first)
    const chain2 = xrefChain(second)
    expect(chain2.prevs).toContain(chain1.startxrefs[chain1.startxrefs.length - 1])

    const d = reopen(second)
    expect(d.wasRepaired()).toBe(false)
    expect(d.countVersions()).toBe(3)
    const page = d.loadPage(0)
    const types = page.getAnnotations().map((a) => a.getType())
    expect(types).toContain('Square')
    expect(types).toContain('Circle')
    // every field (Name x2, Choice x2, Signature1) is still there, and the signature is still signed
    expect(page.getWidgets().length + d.loadPage(1).getWidgets().length).toBe(5)
    const sig = d
      .loadPage(1)
      .getWidgets()
      .find((w) => w.getFieldType() === 'signature')!
    expect(sig.getObject().get('V').isNull()).toBe(false)
    d.destroy()
  })

  it('stays valid after undoing past an incremental save and editing again', async () => {
    const e = await openBytes(signedFormPdf(), 'signed.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    await e.doc.save({})
    await e.doc.markSaved('signed.pdf')
    await e.doc.undo()
    await annots.create(0, { type: 'Circle', rect: [60, 60, 90, 90] })
    const bytes = await e.doc.save({})
    const d = reopen(bytes)
    expect(d.wasRepaired()).toBe(false)
    d.destroy()
  })

  it('keeps the dirty state when the bytes are only exported, and reports clean after markSaved', async () => {
    const e = await openBytes(signedFormPdf(), 'signed.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    expect(e.lastChanges?.dirty).toBe(true)
    // e.g. "Combine" reading the current bytes: nothing was written to the document's own file
    await e.doc.save({})
    expect(e.lastChanges?.dirty).toBe(true)
    expect(await e.doc.isDirty()).toBe(true)
    await e.doc.markSaved('signed.pdf')
    expect(await e.doc.isDirty()).toBe(false)
    // edits after the save still work and are undoable
    const c = await annots.create(0, { type: 'Circle', rect: [60, 60, 90, 90] })
    expect(e.lastChanges?.dirty).toBe(true)
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Circle')
    await e.doc.undo()
    expect(e.lastChanges?.dirty).toBe(false)
    expect((await annots.list(0)).some((a) => a.id === c.id)).toBe(false)
  })

  it('keeps per-document settings and form state working after an incremental save', async () => {
    const e = await openBytes(signedFormPdf(), 'signed.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    const forms = e.ops<typeof formOps>('forms')
    await annots.setAuthor('Darren')
    await forms.setValues([{ name: 'Name', value: 'Before' }])
    const saved = await e.doc.save({})
    const copy = saved.slice()
    // The worker transfers the returned buffer to the UI thread, which detaches it here.
    structuredClone(saved.buffer, { transfer: [saved.buffer] })
    await e.doc.markSaved('signed.pdf')
    const note = await annots.create(0, { type: 'Text', rect: [10, 10, 30, 30] })
    expect(note.author).toBe('Darren')
    const fields = await forms.listAll()
    expect(fields.find((f) => f.name === 'Name')!.value).toBe('Before')
    // the session's copy of the file (used to validate signatures) survives the transfer
    expect(e.session.sourceBytes?.length).toBe(copy.length)
    expect(e.session.sourceBytes).toEqual(copy)
  })

  it('refuses an incremental save from inside an undoable operation and stays usable', async () => {
    const original = signedFormPdf()
    const e = await openBytes(original, 'signed.pdf')
    expect(() =>
      e.session.runMutation('Feature', () => saveDocument(e.session, { mode: 'incremental' }))
    ).toThrow(/inside an undoable operation/)
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    const bytes = await e.doc.save({})
    expect(startsWith(bytes, original)).toBe(true)
    const d = reopen(bytes)
    expect(d.wasRepaired()).toBe(false)
    d.destroy()
  })
})
