// DocumentModel: engine replies that changed nothing (renders, reads) notify nobody.
import { describe, expect, it } from 'vitest'
import type { ChangeSet, DocInfo, JournalState } from '@shared/types'
import { DocumentModel } from '@renderer/document/DocumentModel'
import type { EngineClient } from '@renderer/engine/EngineClient'

const journal = (position: number): JournalState => ({
  canUndo: position > 0,
  canRedo: false,
  undoLabel: position > 0 ? 'Edit' : null,
  redoLabel: null,
  position
})

const changes = (patch: Partial<ChangeSet> = {}): ChangeSet => ({
  pages: [],
  all: false,
  structure: false,
  document: false,
  journal: journal(0),
  dirty: false,
  ...patch
})

const info = {
  pageCount: 2,
  pages: [0, 1].map((i) => ({ index: i, id: 10 + i, width: 612, height: 792, rotation: 0, label: String(i + 1) }))
} as unknown as DocInfo

/** Emits ChangeSets; every engine call answers null (facts() is only asked after document changes). */
class FakeEngine {
  private listeners = new Set<(cs: ChangeSet) => void>()
  onChanges(l: (cs: ChangeSet) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  ops() {
    return new Proxy({}, { get: () => () => Promise.resolve({}) })
  }
  emit(cs: ChangeSet) {
    for (const l of this.listeners) l(cs)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function open(dirty = false) {
  const engine = new FakeEngine()
  const doc = new DocumentModel(engine as unknown as EngineClient, info, { title: 'a.pdf', filePath: '/a.pdf', dirty })
  let notified = 0
  doc.store.subscribe(() => notified++)
  const listened: ChangeSet[] = []
  doc.onChange((cs) => listened.push(cs))
  return { engine, doc, notified: () => notified, listened }
}

describe('DocumentModel replies that change nothing', () => {
  it('leaves the state alone, but still tells change listeners', async () => {
    const { engine, doc, notified, listened } = open()
    const before = doc.state
    engine.emit(changes())
    engine.emit(changes())
    await tick()
    expect(notified()).toBe(0)
    expect(doc.state).toBe(before)
    expect(listened).toHaveLength(2)
  })

  it('keeps an equal journal object, so its subscribers skip a page change', async () => {
    const { engine, doc, notified } = open()
    engine.emit(changes({ journal: journal(1), dirty: true }))
    await tick()
    const j = doc.state.journal
    const versions = doc.state.pageVersions
    expect(j.position).toBe(1)
    engine.emit(changes({ pages: [1], journal: journal(1), dirty: true }))
    await tick()
    expect(doc.state.journal).toBe(j)
    expect(doc.state.pageVersions).not.toBe(versions)
    expect(doc.state.pageVersions[11]).toBe(1)
    // a document-level change keeps the page versions object
    const n = notified()
    const pv = doc.state.pageVersions
    engine.emit(changes({ document: true, journal: journal(1), dirty: true }))
    await tick()
    expect(notified()).toBeGreaterThan(n)
    expect(doc.state.pageVersions).toBe(pv)
    expect(doc.state.docVersion).toBe(1)
  })

  it('still applies a dirty flag or journal that differs', async () => {
    const { engine, doc, notified } = open(true)
    engine.emit(changes({ dirty: true }))
    await tick()
    expect(notified()).toBe(0)
    // the engine says the document is clean (saved): that is applied
    engine.emit(changes({ dirty: false }))
    await tick()
    expect(notified()).toBe(1)
    expect(doc.state.dirty).toBe(false)
    // a flag set by a feature (Edit Text marks typing as unsaved) is still reset by the engine
    doc.set({ dirty: true })
    engine.emit(changes({ dirty: false }))
    await tick()
    expect(doc.state.dirty).toBe(false)
    engine.emit(changes({ journal: journal(2) }))
    await tick()
    expect(doc.state.journal.position).toBe(2)
  })
})
