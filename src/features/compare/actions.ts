import {
  invoke,
  openNewDocument,
  openToolGroup,
  showError,
  stripExtension,
  toast,
  useApp,
  withProgress,
  type DocumentModel
} from '@renderer/sdk'
import type { ProtectionSummary } from '@engine/util/protection'
import { parsePageRange } from './core'
import type compareOps from './engine'
import { CancelledError, runComparison } from './pipeline'
import type { ReportInput } from './report'
import { release, retain } from './sources'
import { ALL_FILTER, getCompare, setCompare, type Session, type Side, type Slot } from './store'
import { categoryOf, type Change, type CompareOptions } from './types'
import { WorkerBackend } from './workerBackend'

const compareOf = (doc: DocumentModel, onProgress?: (f: number, m?: string) => void) =>
  doc.ops<typeof compareOps>('compare', onProgress ? { onProgress } : undefined)

/** Pages of a slot to compare, or an error message. */
export function slotPages(slot: Slot): { pages: number[] } | { error: string } {
  if (!slot.doc) return { error: 'Choose a file' }
  if (slot.allPages) return { pages: [...Array(slot.doc.pageCount).keys()] }
  return parsePageRange(slot.range, slot.doc.pageCount)
}

/** Why the Compare button is disabled, or null when ready. */
export function compareBlocker(): string | null {
  const { slots, running } = getCompare()
  if (running) return 'A comparison is running'
  if (!slots.old.doc) return 'Choose the old file'
  if (!slots.new.doc) return 'Choose the new file'
  for (const side of ['old', 'new'] as Side[]) {
    const r = slotPages(slots[side])
    if ('error' in r) return `${side === 'old' ? 'Old' : 'New'} file: ${r.error}`
  }
  return null
}

let sessionUnsubs: (() => void)[] = []
let sessionSeq = 0

function setSession(session: Session | null) {
  const prev = getCompare().session
  for (const u of sessionUnsubs) u()
  sessionUnsubs = []
  if (session) {
    retain(session.old.doc)
    retain(session.new.doc)
    for (const side of [session.old, session.new]) {
      sessionUnsubs.push(
        side.doc.onChange((cs) => {
          if (!cs.pages.length && !cs.all && !cs.structure) return
          if (getCompare().session !== session) return
          setCompare({ stale: `“${side.name}” was changed after the comparison. Compare again to update the results.` })
        })
      )
    }
  }
  setCompare({
    session,
    stale: null,
    selected: session?.result.changes[0]?.id ?? null,
    focusTick: getCompare().focusTick + 1,
    filter: { ...ALL_FILTER }
  })
  if (prev) {
    release(prev.old.doc)
    release(prev.new.doc)
  }
}

/** Runs a comparison of the two chosen files and shows the results. */
export async function runCompare() {
  const blocker = compareBlocker()
  if (blocker) {
    toast(blocker, { kind: 'warning' })
    return
  }
  const { slots, options } = getCompare()
  const oldSlot = slots.old
  const newSlot = slots.new
  const oldDoc = oldSlot.doc!
  const newDoc = newSlot.doc!
  const oldPages = (slotPages(oldSlot) as { pages: number[] }).pages
  const newPages = (slotPages(newSlot) as { pages: number[] }).pages
  // Keep both documents alive while the comparison runs, even if the slots change.
  retain(oldDoc)
  retain(newDoc)
  const backend = new WorkerBackend()
  let cancelled = false
  let last = 0
  const cancel = () => {
    cancelled = true
    backend.terminate()
  }
  setCompare({ running: { fraction: 0, message: 'Starting…', cancel } })
  try {
    const result = await runComparison(
      { ops: compareOf(oldDoc), pages: oldPages },
      { ops: compareOf(newDoc), pages: newPages },
      { ...options },
      backend,
      (fraction, message) => {
        const now = performance.now()
        if (now - last < 60 && fraction < 1) return
        last = now
        setCompare((s) => (s.running ? { running: { ...s.running, fraction, message } } : {}))
      },
      () => cancelled
    )
    setSession({
      id: ++sessionSeq,
      old: { doc: oldDoc, name: oldSlot.name, path: oldSlot.path },
      new: { doc: newDoc, name: newSlot.name, path: newSlot.path },
      result
    })
    setCompare({ running: null })
    const n = result.changes.length
    toast(n ? `Found ${n} change${n === 1 ? '' : 's'}` : 'No differences found. The documents are the same.', {
      kind: 'success',
      timeout: 3000
    })
  } catch (err) {
    setCompare({ running: null })
    if (err instanceof CancelledError || cancelled) toast('Comparison cancelled', { timeout: 2500 })
    else showError(err, 'Could not compare the files')
  } finally {
    backend.terminate()
    release(oldDoc)
    release(newDoc)
  }
}

/** Back to the file choice (keeps the chosen files and options). */
export function newComparison() {
  setSession(null)
}

export function setOptions(patch: Partial<CompareOptions>) {
  setCompare((s) => ({ options: { ...s.options, ...patch } }))
  void invoke('store:set', 'compare:options', getCompare().options).catch(() => {})
}

export async function loadSavedOptions() {
  try {
    const saved = (await invoke('store:get', 'compare:options')) as Partial<CompareOptions> | undefined
    if (saved && typeof saved === 'object') setCompare((s) => ({ options: { ...s.options, ...saved } }))
  } catch {}
}

// ---- results navigation -----------------------------------------------------------------------

export function visibleChanges(): Change[] {
  const { session, filter } = getCompare()
  if (!session) return []
  return session.result.changes.filter((c) => filter[categoryOf(c.type)])
}

export function selectChange(id: number | null, scroll = true) {
  setCompare((s) => ({ selected: id, focusTick: scroll ? s.focusTick + 1 : s.focusTick }))
}

/** Selects the next (dir 1) or previous (dir -1) visible change and scrolls to it. */
export function stepChange(dir: 1 | -1) {
  const list = visibleChanges()
  if (!list.length) return
  const { selected } = getCompare()
  const i = list.findIndex((c) => c.id === selected)
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + dir))
  selectChange(list[next].id)
}

export const hasResults = () => !!getCompare().session && useApp.getState().toolGroupId === 'compare'

// ---- report ---------------------------------------------------------------------------------

function alive(doc: DocumentModel) {
  return !doc.isClosed
}

/** The compared document whose protection the report keeps: the first protected one, Old then New. */
function protectingSide(session: Session): Session['old'] | null {
  return [session.old, session.new].find((side) => !!side.doc.state.info.encryption) ?? null
}

/** "It keeps the protection of “a.pdf”: 256-bit AES encryption and the same open password." */
function protectionNote(p: ProtectionSummary, name: string): string {
  const parts = [`${p.method} encryption`]
  if (p.needsPassword) parts.push('the same open password')
  if (p.restricted) parts.push('the same restrictions')
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `It keeps the protection of “${name}”: ${list}.`
}

/** Creates the compare report PDF and opens it in a new tab. */
export async function exportReport() {
  const session = getCompare().session
  if (!session) return
  if (!alive(session.new.doc)) {
    showError(new Error(`“${session.new.name}” was closed. Compare again to create a report.`), 'Could not create the report')
    return
  }
  const { result } = session
  try {
    // The report shows text of both documents, so it keeps the protection of the first protected one.
    const protectedBy = protectingSide(session)
    if (protectedBy && !alive(protectedBy.doc)) {
      showError(new Error(`“${protectedBy.name}” was closed. Compare again to create a report.`), 'Could not create the report')
      return
    }
    const { bytes, password, note } = await withProgress('Creating compare report…', async () => {
      const removedPages = result.changes.filter((c) => c.type === 'pageRemoved').map((c) => c.old!.page)
      let removedPdf: Uint8Array | null = null
      if (removedPages.length && alive(session.old.doc)) removedPdf = await compareOf(session.old.doc).copyPages(removedPages)
      const input: ReportInput = {
        oldName: session.old.name,
        newName: session.new.name,
        oldPageCount: session.old.doc.pageCount,
        newPageCount: session.new.doc.pageCount,
        oldPages: result.oldPages,
        newPages: result.newPages,
        options: result.options,
        date: new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        changes: result.changes,
        counts: result.counts,
        pageByPage: result.pageByPage,
        removedPdf,
        removedPages
      }
      const plain = await compareOf(session.new.doc).report(input)
      const protection = protectedBy ? await compareOf(protectedBy.doc).protection() : null
      if (!protectedBy || !protection) return { bytes: plain, password: undefined, note: '' }
      const ops = compareOf(protectedBy.doc)
      return {
        bytes: await ops.protectReport(plain),
        password: (await ops.openPassword()) ?? undefined,
        note: '. ' + protectionNote(protection, protectedBy.name)
      }
    })
    const name = `Compare report – ${stripExtension(session.old.name)} vs ${stripExtension(session.new.name)}.pdf`
    const doc = await openNewDocument(bytes, name, { password })
    if (!doc) return
    // Show the report itself; the results stay available under Compare files.
    openToolGroup(null)
    toast(`Compare report created${note}`, { kind: 'success', action: { label: 'Back to results', run: () => openToolGroup('compare') } })
  } catch (err) {
    showError(err, 'Could not create the report')
  }
}
