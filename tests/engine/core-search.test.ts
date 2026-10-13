import { describe, expect, it, vi } from 'vitest'
import type { ChangeSet } from '@shared/types'
import type { PageText } from '@engine/ops/text'
import { DocumentModel, type SearchState, type ViewController } from '@renderer/document/DocumentModel'
import { openFixture, type OpenedEngine } from './helpers'

/**
 * A DocumentModel driven by the in-process engine (instead of a worker). `overrideText` replaces
 * the text the engine reports for a page, and `emit` delivers a ChangeSet like an engine mutation.
 */
function modelFor(e: OpenedEngine) {
  const listeners = new Set<(cs: ChangeSet) => void>()
  const overrideText = new Map<number, PageText>()
  const client = {
    ops: (ns: string) =>
      new Proxy(
        {},
        {
          get:
            (_t, name) =>
            async (...args: unknown[]) => {
              if (ns === 'text' && name === 'page' && overrideText.has(args[0] as number)) return overrideText.get(args[0] as number)
              return e.call(`${ns}.${String(name)}`, ...args)
            }
        }
      ),
    onChanges: (l: (cs: ChangeSet) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    terminate() {}
  }
  const doc = new DocumentModel(client as any, e.info, { title: 'text.pdf', filePath: null })
  const scrolled: { page: number; rect: number[] }[] = []
  doc.view = {
    scrollToRect: vi.fn((page: number, rect: number[]) => scrolled.push({ page, rect })),
    goToPage: vi.fn()
  } as unknown as ViewController
  const emit = (pages: number[]) => {
    const cs: ChangeSet = {
      pages,
      all: false,
      structure: false,
      document: false,
      journal: doc.state.journal,
      dirty: true
    }
    for (const l of listeners) l(cs)
  }
  return { doc, scrolled, overrideText, emit }
}

const settle = () => new Promise((r) => setTimeout(r, 20))
const activeHit = (s: SearchState) => s.hits[s.active]

describe('document search', () => {
  it('keeps the active hit on the start page while hits from earlier pages arrive', async () => {
    const e = await openFixture('text.pdf')
    const { doc, scrolled } = modelFor(e)
    doc.set({ currentPage: 2 })
    await doc.search('quick brown fox')
    await settle()
    const s = doc.state.search
    expect(s.done).toBe(true)
    expect(s.hits.map((h) => h.page)).toEqual([0, 1, 2, 3, 4])
    expect(activeHit(s).page).toBe(2)
    expect(scrolled.map((x) => x.page)).toEqual([2])
    // Find Next moves forwards
    doc.nextHit(1)
    await settle()
    expect(activeHit(doc.state.search).page).toBe(3)
    expect(scrolled.at(-1)?.page).toBe(3)
  })

  it('ignores a superseded search entirely', async () => {
    const e = await openFixture('text.pdf')
    const { doc, scrolled } = modelFor(e)
    doc.set({ currentPage: 2 })
    const writes: string[] = []
    let second = false
    doc.store.subscribe((s, prev) => {
      if (second && s.search !== prev.search) writes.push(s.search.query)
    })
    const first = doc.search('Lorem')
    second = true
    const latest = doc.search('quick brown fox')
    await Promise.all([first, latest])
    await settle()
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every((q) => q === 'quick brown fox')).toBe(true)
    const s = doc.state.search
    expect(s.query).toBe('quick brown fox')
    expect(s.hits).toHaveLength(5)
    expect(activeHit(s).page).toBe(2)
    // only the new term was revealed
    expect(scrolled.map((x) => x.page)).toEqual([2])
  })

  it('does not stay "running" for a whitespace-only query', async () => {
    const e = await openFixture('text.pdf')
    const { doc } = modelFor(e)
    await doc.search('   ')
    expect(doc.state.search.running).toBe(false)
    expect(doc.state.search.hits).toHaveLength(0)
  })

  it('re-runs the search and drops stale selections on pages whose text changed', async () => {
    const e = await openFixture('text.pdf')
    const { doc, overrideText, emit } = modelFor(e)
    await doc.search('quick brown fox')
    await settle()
    const before = doc.state.search.hits.find((h) => h.page === 1)!
    const t1 = await doc.pageText(1)
    doc.setSelection({ kind: 'text', ranges: [{ page: 1, start: 0, end: 5 }, { page: 2, start: 0, end: 5 }] })
    // An edit inserts text in front of the match on page 1 and the engine reports a page change.
    const shift = 'Inserted. '.length
    const at = t1.text.indexOf('Hello')
    overrideText.set(1, { ...t1, text: t1.text.slice(0, at) + 'Inserted. ' + t1.text.slice(at) })
    emit([1])
    await settle()
    const after = doc.state.search.hits.find((h) => h.page === 1)!
    expect(after.start).toBe(before.start + shift)
    expect(doc.state.search.hits).toHaveLength(5)
    const sel = doc.state.selection
    expect(sel.kind === 'text' && sel.ranges).toEqual([{ page: 2, start: 0, end: 5 }])
  })

  it('keeps hits and selection when a page change leaves its text alone (e.g. a new comment)', async () => {
    const e = await openFixture('text.pdf')
    const { doc, emit } = modelFor(e)
    await doc.search('quick brown fox')
    await settle()
    doc.nextHit(1)
    await settle()
    const hits = doc.state.search.hits
    const active = doc.state.search.active
    const selection = { kind: 'text' as const, ranges: [{ page: 1, start: 0, end: 5 }] }
    doc.setSelection(selection)
    emit([1])
    await settle()
    expect(doc.state.search.hits).toEqual(hits)
    expect(doc.state.search.active).toBe(active)
    expect(doc.state.selection).toBe(selection)
  })
})
