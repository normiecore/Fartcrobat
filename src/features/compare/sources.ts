/**
 * Choosing the Old and New files: open tabs, recent files, Browse… or drag and drop. Files that are
 * not open in a tab are opened privately (their own engine, no tab) and closed again when no longer
 * used by a slot or by the results.
 */
import type docOpsT from '@engine/ops/doc'
import type { DocInfo } from '@shared/types'
import {
  basename,
  DocumentModel,
  EngineClient,
  invoke,
  OPEN_FILTERS,
  readFile,
  registry,
  showError,
  stripExtension,
  unlockCertificateFile,
  unlockFile,
  useApp,
  type DocUnlock
} from '@renderer/sdk'
import { compareStore, emptySlot, getCompare, patchSlot, setCompare, type Side } from './store'

/** Reference counts of privately opened documents. */
const owned = new Map<DocumentModel, number>()

export function isTabDoc(doc: DocumentModel): boolean {
  return useApp.getState().docs.includes(doc)
}

export function retain(doc: DocumentModel | null) {
  if (doc && owned.has(doc)) owned.set(doc, owned.get(doc)! + 1)
}

export function release(doc: DocumentModel | null) {
  if (!doc || !owned.has(doc)) return
  const n = owned.get(doc)! - 1
  if (n > 0) owned.set(doc, n)
  else {
    owned.delete(doc)
    doc.close()
  }
}

function setSlotDoc(side: Side, doc: DocumentModel, name: string, path: string | null) {
  const prev = getCompare().slots[side].doc
  retain(doc)
  patchSlot(side, { doc, name, path, loading: false, allPages: true, range: '' })
  release(prev)
}

export function chooseTab(side: Side, doc: DocumentModel) {
  setSlotDoc(side, doc, doc.state.title, doc.state.filePath)
}

function extensionOf(name: string) {
  return (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()
}

/**
 * Opens a file without a tab. Asks for a password when needed (or unlocks a certificate-encrypted
 * file with the person's keys); null if the user cancelled.
 */
async function openPrivate(path: string): Promise<DocumentModel | null> {
  const name = basename(path)
  let bytes: Uint8Array | null = null
  let title = name
  const converter = registry.fileConverters.find((c) => c.extensions.includes(extensionOf(name)))
  if (converter) {
    bytes = await converter.convert(path).catch(() => null)
    if (bytes) title = stripExtension(name) + '.pdf'
  }
  bytes ??= await readFile(path)
  const engine = new EngineClient()
  try {
    await engine.ready()
    const docOps = engine.ops<typeof docOpsT>('doc')
    const res = await docOps.open(bytes, { fileName: title })
    let info: DocInfo | null = res.ok ? res.info : null
    let unlock: DocUnlock | null = null
    if (!res.ok && res.needsCertificate) {
      const unlocked = await unlockCertificateFile({
        name,
        filePath: path,
        certificate: res.certificate,
        purpose: `to compare “${name}”`,
        attempt: async (key) => {
          const r = await docOps.unlockCertificate(key)
          if (r.ok) info = r.info
          return r.ok
        }
      })
      if (!unlocked || !info) {
        engine.terminate()
        return null
      }
      unlock = { method: 'certificate', access: unlocked.access, via: unlocked.via, certificateKey: unlocked.key }
    } else if (!res.ok) {
      const unlocked = await unlockFile({
        name,
        filePath: path,
        lock: res.lock,
        purpose: 'to compare it',
        attempt: async (pw) => {
          const r = await docOps.authenticate(pw)
          if (!r.ok) return null
          info = r.info
          return r.access ?? 'user'
        }
      })
      if (!unlocked || !info) {
        engine.terminate()
        return null
      }
      const { password: _password, ...rest } = unlocked
      unlock = rest
    }
    const opened: DocInfo = info!
    const doc = new DocumentModel(engine, opened, {
      title: opened.converted ? stripExtension(name) + '.pdf' : title,
      filePath: path,
      unlock
    })
    owned.set(doc, 0)
    return doc
  } catch (err) {
    engine.terminate()
    throw err
  }
}

/** Uses a file from disk for one side (the open tab if the file is already open). */
export async function chooseFile(side: Side, path: string) {
  const tab = useApp.getState().docs.find((d) => d.state.filePath === path)
  if (tab) {
    chooseTab(side, tab)
    return
  }
  const before = getCompare().slots[side]
  patchSlot(side, { loading: true, name: basename(path), path })
  try {
    const doc = await openPrivate(path)
    if (!doc) {
      patchSlot(side, { loading: false, name: before.name, path: before.path })
      return
    }
    // The user may have picked something else meanwhile.
    if (getCompare().slots[side].path !== path) {
      retain(doc)
      release(doc)
      return
    }
    setSlotDoc(side, doc, doc.state.title, path)
  } catch (err) {
    patchSlot(side, { loading: false, name: before.name, path: before.path })
    showError(err, `Could not open ${basename(path)}`)
  }
}

export async function browse(side: Side) {
  try {
    const paths = await invoke('file:openDialog', {
      title: side === 'old' ? 'Choose the old file' : 'Choose the new file',
      filters: OPEN_FILTERS,
      multiple: false
    })
    if (paths.length) await chooseFile(side, paths[0])
  } catch (err) {
    showError(err, 'Could not choose a file')
  }
}

export function clearSlot(side: Side) {
  const prev = getCompare().slots[side].doc
  patchSlot(side, emptySlot())
  release(prev)
}

export function swapSlots() {
  setCompare((s) => ({ slots: { old: s.slots.new, new: s.slots.old } }))
}

/** Forgets tabs that were closed (slots) and notes it when the shown results depend on them. */
export function watchTabs(): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.docs === prev.docs) return
    const st = compareStore.getState()
    for (const side of ['old', 'new'] as Side[]) {
      const doc = st.slots[side].doc
      if (doc && !owned.has(doc) && !s.docs.includes(doc)) patchSlot(side, emptySlot())
    }
    const session = st.session
    if (session) {
      for (const side of [session.old, session.new]) {
        if (!owned.has(side.doc) && !s.docs.includes(side.doc) && prev.docs.includes(side.doc)) {
          setCompare({ stale: `“${side.name}” was closed, so its pages can no longer be shown.` })
        }
      }
    }
  })
}
