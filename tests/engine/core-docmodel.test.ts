// DocumentModel change handling, driven by a fake engine (no worker, no DOM).
import { describe, expect, it, vi } from 'vitest'
import type { ChangeSet, DocInfo, JournalState } from '@shared/types'
import { DocumentModel } from '@renderer/document/DocumentModel'
import { EngineCallError, type EngineClient } from '@renderer/engine/EngineClient'

const journal = (position: number): JournalState => ({
  canUndo: position > 0,
  canRedo: false,
  undoLabel: position > 0 ? 'Edit' : null,
  redoLabel: null,
  position
})

function changes(patch: Partial<ChangeSet>): ChangeSet {
  return {
    pages: [],
    all: false,
    structure: false,
    document: false,
    journal: journal(0),
    dirty: false,
    ...patch
  }
}

function docInfo(title: string, pageCount = 2): DocInfo {
  return {
    pageCount,
    pages: [...Array(pageCount).keys()].map((i) => ({
      index: i,
      id: 10 + i,
      width: 612,
      height: 792,
      rotation: 0,
      label: String(i + 1),
      mediaBox: [0, 0, 612, 792],
      cropBox: [0, 0, 612, 792]
    })),
    metadata: {
      title,
      author: '',
      subject: '',
      keywords: '',
      creator: '',
      producer: '',
      creationDate: '',
      modDate: ''
    },
    version: '1.7',
    format: 'PDF 1.7',
    converted: false,
    encryption: null,
    security: null,
    permissions: {} as DocInfo['permissions'],
    hasForm: false,
    hasXfa: false,
    signatureCount: 0,
    layerCount: 0,
    attachmentCount: 0,
    wasRepaired: false,
    canSaveIncrementally: true,
    language: null
  }
}

class FakeEngine {
  private listeners = new Set<(cs: ChangeSet) => void>()
  pendingInfo: ((info: DocInfo) => void)[] = []
  facts: Omit<DocInfo, 'pages'> = docInfo('Original')
  /** Makes facts() wait for fail() or terminate(), like info() always does. */
  holdFacts = false
  /** Methods called, in order. */
  calls: string[] = []
  private terminated = false
  private waiting = new Set<(err: Error) => void>()
  onChanges(l: (cs: ChangeSet) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  ops() {
    return new Proxy(
      {},
      {
        get: (_t, method) => () => {
          // A terminated engine refuses every later call, like the real client.
          if (this.terminated) return Promise.reject(new EngineCallError('Document is closed', 'CLOSED'))
          this.calls.push(String(method))
          if (method === 'info') return this.wait<DocInfo>((resolve) => this.pendingInfo.push(resolve))
          if (method === 'facts') return this.holdFacts ? this.wait(() => {}) : Promise.resolve(this.facts)
          return Promise.resolve(null)
        }
      }
    )
  }
  private wait<T>(keep: (resolve: (v: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      keep(resolve)
      this.waiting.add(reject)
    })
  }
  emit(cs: ChangeSet) {
    for (const l of this.listeners) l(cs)
  }
  /** Fails every call still waiting for a reply. */
  fail(err: Error) {
    for (const reject of this.waiting) reject(err)
    this.waiting.clear()
  }
  terminate() {
    this.terminated = true
    this.fail(new EngineCallError('Document is closed', 'CLOSED'))
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('DocumentModel change handling', () => {
  it('never lets an older structural change overwrite a newer dirty/undo state', async () => {
    const engine = new FakeEngine()
    const doc = new DocumentModel(engine as unknown as EngineClient, docInfo('Original'), {
      title: 'a.pdf',
      filePath: '/a.pdf'
    })
    // 1: a structural change (waits for the new DocInfo), reported clean
    engine.emit(changes({ structure: true, all: true, journal: journal(1), dirty: false }))
    // 2: a later edit, reported dirty, applied right away
    engine.emit(changes({ pages: [0], journal: journal(2), dirty: true }))
    await tick()
    expect(doc.state.dirty).toBe(true)
    expect(doc.state.journal.position).toBe(2)
    // the DocInfo for change 1 arrives late
    engine.pendingInfo.shift()!(docInfo('Original', 3))
    await tick()
    expect(doc.state.info.pageCount).toBe(3)
    expect(doc.state.dirty).toBe(true)
    expect(doc.state.journal.position).toBe(2)
  })

  it('refreshes document facts (metadata, language, signatures...) after document-level changes', async () => {
    const engine = new FakeEngine()
    const doc = new DocumentModel(engine as unknown as EngineClient, docInfo('Original'), {
      title: 'a.pdf',
      filePath: '/a.pdf'
    })
    const pages = doc.state.info.pages
    engine.facts = { ...docInfo('Renamed'), language: 'en-US', signatureCount: 1 }
    engine.emit(changes({ document: true, journal: journal(1), dirty: true }))
    await tick()
    expect(doc.state.info.metadata.title).toBe('Renamed')
    expect(doc.state.info.language).toBe('en-US')
    expect(doc.state.info.signatureCount).toBe(1)
    // the page list is untouched by a document-level change
    expect(doc.state.info.pages).toBe(pages)
  })

  it('keeps a document opened as unsaved dirty until the engine says otherwise', async () => {
    const engine = new FakeEngine()
    const doc = new DocumentModel(engine as unknown as EngineClient, docInfo('Binder1'), {
      title: 'Binder1.pdf',
      filePath: null,
      dirty: true
    })
    expect(doc.state.dirty).toBe(true)
    engine.emit(changes({ dirty: true }))
    await tick()
    expect(doc.state.dirty).toBe(true)
  })

  it('says nothing about refreshes a closed document no longer gets, and reports them while it is open', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const closed of [true, false]) {
        const engine = new FakeEngine()
        engine.holdFacts = true
        const doc = new DocumentModel(engine as unknown as EngineClient, docInfo('Original'), {
          title: 'a.pdf',
          filePath: '/a.pdf'
        })
        // A page was added (new DocInfo) and the file was saved (new facts) just before closing.
        engine.emit(changes({ structure: true, all: true, journal: journal(1) }))
        engine.emit(changes({ document: true, journal: journal(1) }))
        if (closed) doc.close()
        else engine.fail(new EngineCallError('MuPDF error: broken xref', 'MUPDF'))
        await tick()
        expect(errors).toHaveBeenCalledTimes(closed ? 0 : 2)
      }
    } finally {
      errors.mockRestore()
    }
  })

  it('ignores Undo and Redo once closed (from a toast that outlived its tab)', async () => {
    const engine = new FakeEngine()
    const doc = new DocumentModel(engine as unknown as EngineClient, docInfo('Original'), { title: 'a.pdf', filePath: '/a.pdf' })
    await doc.undo()
    await doc.redo()
    expect(engine.calls.filter((c) => c === 'undo' || c === 'redo')).toEqual(['undo', 'redo'])
    doc.close()
    await expect(doc.undo()).resolves.toBeUndefined()
    await expect(doc.redo()).resolves.toBeUndefined()
  })
})
