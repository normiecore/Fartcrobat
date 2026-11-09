// Moving tabs between windows (docs/features/windows-tabs.md): where a dropped tab goes, the
// checks before a move, the hand-off message, and what the engine hands over for each kind of
// document (plain, edited, password-protected, certificate-encrypted).
import { describe, expect, it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type textOps from '@engine/ops/text'
import {
  dropDestination,
  handOffProblem,
  insertionIndex,
  moveRefusal,
  movedNote,
  newWindowBounds,
  reorder,
  windowChoiceLabels,
  type DocumentHandOff
} from '@shared/tabMoves'
import { fixture, openFixture } from './helpers'
import { includesBytes, openFixtureAs, openWithKey } from './passwordless-helpers'

const source = { x: 0, y: 0, width: 1000, height: 800 }
const other = { id: 7, bounds: { x: 1200, y: 100, width: 900, height: 700 } }

describe('where a dropped tab goes', () => {
  it('stays when let go over its own window', () => {
    expect(dropDestination({ x: 500, y: 400 }, source, [other])).toEqual({ kind: 'none' })
  })

  it('moves into another window when let go over its tab strip', () => {
    expect(dropDestination({ x: 1500, y: 120 }, source, [other])).toEqual({ kind: 'window', windowId: 7 })
  })

  it('opens a new window when let go over the desktop or over another window’s pages', () => {
    expect(dropDestination({ x: 1100, y: 500 }, source, [other])).toEqual({ kind: 'new', point: { x: 1100, y: 500 } })
    expect(dropDestination({ x: 1500, y: 500 }, source, [other])).toEqual({ kind: 'new', point: { x: 1500, y: 500 } })
  })

  it('prefers the first window listed (the focused one) where strips overlap', () => {
    const behind = { id: 9, bounds: { x: 1250, y: 90, width: 900, height: 700 } }
    expect(dropDestination({ x: 1300, y: 110 }, source, [other, behind])).toEqual({ kind: 'window', windowId: 7 })
  })

  it('ignores a point it cannot read', () => {
    expect(dropDestination({ x: Number.NaN, y: 3 }, source, [other])).toEqual({ kind: 'none' })
  })
})

describe('a new window for a dropped tab', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 }
  it('puts its tab strip under the pointer, with the size of the window the tab came from', () => {
    expect(newWindowBounds({ x: 800, y: 300 }, { width: 1000, height: 700 }, work)).toEqual({ x: 680, y: 284, width: 1000, height: 700 })
  })
  it('stays on the screen', () => {
    expect(newWindowBounds({ x: 1900, y: 1000 }, { width: 1000, height: 700 }, work)).toEqual({ x: 920, y: 340, width: 1000, height: 700 })
    expect(newWindowBounds({ x: 10, y: 5 }, { width: 3000, height: 2000 }, work)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })
})

describe('Move to … labels', () => {
  it('names windows by their document and numbers the ones that read the same', () => {
    expect(
      windowChoiceLabels([
        { id: 1, title: '• report.pdf - Inkmoor' },
        { id: 2, title: 'Inkmoor' },
        { id: 3, title: 'notes.pdf - Inkmoor' },
        { id: 4, title: 'notes.pdf - Inkmoor' }
      ])
    ).toEqual([
      { id: 1, label: 'Move to “report.pdf” window' },
      { id: 2, label: 'Move to Inkmoor window (Home)' },
      { id: 3, label: 'Move to “notes.pdf” window (1)' },
      { id: 4, label: 'Move to “notes.pdf” window (2)' }
    ])
  })
})

describe('checks before a move', () => {
  it('lets an idle document move', () => {
    expect(moveRefusal('a.pdf', { busy: null, windowBusy: false, guards: [null, undefined] })).toBeNull()
  })
  it('refuses while the document is busy, a dialog is open, or a feature says no (feature first)', () => {
    expect(moveRefusal('a.pdf', { busy: 'Saving…', windowBusy: false, guards: [] })).toBe('“a.pdf” is busy (saving). Move it when that has finished.')
    expect(moveRefusal('a.pdf', { busy: null, windowBusy: true, guards: [] })).toMatch(/^Finish what is open/)
    expect(moveRefusal('a.pdf', { busy: 'Saving…', windowBusy: true, guards: [null, 'Accept or reject the edits first.'] })).toBe(
      'Accept or reject the edits first.'
    )
  })
  it('tells the person when undo history stays behind, and says nothing otherwise', () => {
    expect(movedNote('a.pdf', { dirty: true, hadHistory: true })).toMatch(/unsaved changes.*undo history stayed behind/)
    expect(movedNote('a.pdf', { dirty: false, hadHistory: true })).toMatch(/undo history stayed behind/)
    expect(movedNote('a.pdf', { dirty: true, hadHistory: false })).toBeNull()
  })
})

describe('the hand-off message', () => {
  const good = (): DocumentHandOff => ({
    title: 'a.pdf',
    filePath: '/docs/a.pdf',
    sourcePath: null,
    dirty: true,
    bytes: new Uint8Array([37, 80, 68, 70]),
    password: null,
    unlock: null,
    view: { page: 2, zoom: 1.5, zoomMode: 'custom', layout: 'continuous' },
    hadHistory: true,
    from: { docId: 'doc-3', boot: 'abc' }
  })
  it('accepts a complete one', () => {
    expect(handOffProblem(good())).toBeNull()
  })
  it('refuses missing or malformed parts', () => {
    expect(handOffProblem(null)).toMatch(/missing/)
    expect(handOffProblem({ ...good(), bytes: new Uint8Array() })).toMatch(/no content/)
    expect(handOffProblem({ ...good(), bytes: 'x' })).toMatch(/no content/)
    expect(handOffProblem({ ...good(), filePath: 3 })).toMatch(/invalid path/)
    expect(handOffProblem({ ...good(), password: 1 })).toMatch(/incomplete/)
    expect(handOffProblem({ ...good(), view: { page: 'x' } })).toMatch(/incomplete/)
    expect(handOffProblem({ ...good(), from: undefined })).toMatch(/incomplete/)
  })
})

describe('reordering tabs in a strip', () => {
  it('moves a tab before the one it was dropped on', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(reorder(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a'])
  })
  it('leaves the order when dropped where it was, or for an unknown tab', () => {
    const tabs = ['a', 'b', 'c']
    expect(reorder(tabs, 1, 1)).toBe(tabs)
    expect(reorder(tabs, 1, 2)).toBe(tabs)
    expect(reorder(tabs, -1, 0)).toBe(tabs)
  })
  it('finds the insertion point from the pointer', () => {
    const tabs = [
      { left: 100, width: 100 },
      { left: 202, width: 100 }
    ]
    expect(insertionIndex(120, tabs)).toBe(0)
    expect(insertionIndex(160, tabs)).toBe(1)
    expect(insertionIndex(260, tabs)).toBe(2)
    expect(insertionIndex(900, tabs)).toBe(2)
  })
})

describe('what the engine hands over', () => {
  it('the exact bytes it was opened from while nothing changed', async () => {
    const e = await openFixture('text.pdf')
    const out = await e.doc.handOff()
    expect(Buffer.from(out.bytes).equals(Buffer.from(fixture('text.pdf')))).toBe(true)
    expect(out.password).toBeNull()
    expect(out.certificateKey).toBeNull()
    expect(await e.doc.editVersion()).toBe(out.version)
  })

  it('the current content with its unsaved changes, which open as such in another engine', async () => {
    const e = await openFixture('text.pdf')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'moved note' })
    const out = await e.doc.handOff()
    expect(await e.doc.isDirty()).toBe(true)
    const other = await createLocalEngine()
    const doc = other.ops<typeof docOps>('doc')
    const res = await doc.open(out.bytes, { fileName: 'text.pdf', dirty: true })
    expect(res.ok).toBe(true)
    expect(await doc.isDirty()).toBe(true)
    const notes = await other.ops<typeof annotOps>('annots').list(0)
    expect(notes.some((n) => n.contents === 'moved note')).toBe(true)
    // Later edits change the version: the window that moved it can tell.
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    expect(await e.doc.editVersion()).not.toBe(out.version)
  })

  it('a password-protected document stays protected and comes with its password', async () => {
    const e = await openFixture('encrypted.pdf', 'secret')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'x' })
    const out = await e.doc.handOff()
    expect(out.password).toBe('secret')
    const other = await createLocalEngine()
    const doc = other.ops<typeof docOps>('doc')
    const locked = await doc.open(out.bytes, { fileName: 'encrypted.pdf' })
    expect(locked.ok).toBe(false)
    const res = await doc.open(out.bytes, { fileName: 'encrypted.pdf', password: out.password! })
    expect(res.ok).toBe(true)
  })

  it('an edited signed document keeps its undo history and its file when the move is only being prepared', async () => {
    // Signed documents save incrementally, and a real Save reopens the document from the bytes it
    // wrote. A hand-off must not: the move can still be refused, and the tab then stays here.
    const e = await openFixture('digital-signatures/signed-timestamp.pdf')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'signed note' })
    expect((await e.doc.journal()).canUndo).toBe(true)
    const out = await e.doc.handOff()
    expect((await e.doc.journal()).canUndo).toBe(true)
    expect(await e.doc.isDirty()).toBe(true)
    await e.doc.undo()
    expect((await e.ops<typeof annotOps>('annots').list(0)).some((n) => n.contents === 'signed note')).toBe(false)
    // The bytes are still an incremental update of the signed file, with the note in it.
    const original = fixture('digital-signatures/signed-timestamp.pdf')
    expect(Buffer.from(out.bytes.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true)
    const other = await createLocalEngine()
    const res = await other.ops<typeof docOps>('doc').open(out.bytes, { fileName: 'signed-timestamp.pdf', dirty: true })
    expect(res.ok).toBe(true)
    expect((await other.ops<typeof annotOps>('annots').list(0)).some((n) => n.contents === 'signed note')).toBe(true)
  })

  it('an edited certificate-encrypted document keeps its undo history after a hand-off', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'kept' })
    await e.doc.handOff()
    expect((await e.doc.journal()).canUndo).toBe(true)
    await e.doc.undo()
    expect((await e.ops<typeof annotOps>('annots').list(0)).some((n) => n.contents === 'kept')).toBe(false)
  })

  it('a certificate-encrypted document stays encrypted and opens with the key it hands over', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'Moved secret note' })
    const out = await e.doc.handOff()
    expect(out.certificateKey).not.toBeNull()
    expect(includesBytes(out.bytes, 'Moved secret note')).toBe(false)
    const other = await openWithKey(out.bytes, out.certificateKey!, 'v5-classic.pdf')
    expect(await other.ops<typeof textOps>('text').plain(0)).toContain('Hello')
    const notes = await other.ops<typeof annotOps>('annots').list(0)
    expect(notes.some((n) => n.contents === 'Moved secret note')).toBe(true)
  })
})
