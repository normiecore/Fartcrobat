/**
 * The user-facing flows: protecting, unlocking and removing security, and compressing. Everything
 * that writes files asks where first and reports success or failure visibly.
 */
import type { DocUnlock, DocumentModel } from '@renderer/sdk'
import {
  PDF_FILTER,
  ask,
  basename,
  confirm,
  dirname,
  forgetSavedPassword,
  invoke,
  joinPath,
  openDialog,
  openNewDocument,
  openPaths,
  prompt,
  rememberDocumentPassword,
  showError,
  stripExtension,
  toast,
  useApp,
  withProgress,
  writeFile
} from '@renderer/sdk'
import type ops from './engine'
import { ProtectDialog } from './ProtectDialog'
import {
  FEATURE_ID,
  compressedName,
  encryptOptions,
  formatBytes,
  permissionsFor,
  reductionSummary,
  restrictionList,
  sentenceList,
  type OptimizeOptions,
  type ProtectSettings,
  type SecurityStatus
} from './shared'
import { useProtectOptimize, type CompressOutput, type CompressResult } from './state'

export function poOps(doc: DocumentModel, opts?: { onProgress?: (fraction: number, message?: string) => void }) {
  return doc.ops<typeof ops>(FEATURE_ID, opts)
}

export function securityOf(doc: DocumentModel) {
  return poOps(doc).security()
}

async function refreshInfo(doc: DocumentModel) {
  doc.set({ info: await doc.core.doc.info() })
}

function pdfName(name: string): string {
  return /\.pdf$/i.test(name) ? name : stripExtension(name) + '.pdf'
}

/** A path next to the document's file (or just a name for untitled documents). */
function siblingPath(doc: DocumentModel, name: string): string {
  const fp = doc.state.filePath
  return fp ? joinPath(dirname(fp), name) : name
}

async function chooseSavePath(title: string, defaultPath: string): Promise<string | null> {
  const chosen = await invoke('file:saveDialog', { title, defaultPath, filters: [PDF_FILTER] })
  if (!chosen) return null
  return /\.pdf$/i.test(chosen) ? chosen : chosen + '.pdf'
}

/**
 * After writing new bytes for the document to `path`, reopens the tab from them so the session
 * matches the file (security, size) and later saves keep it. Undo history starts afresh. Pass
 * `unlock` when the security changed (how the new file was opened, null for none).
 */
async function reloadFromSaved(
  doc: DocumentModel,
  bytes: Uint8Array,
  path: string,
  opts: { password?: string; ownerPassword?: string; unlock?: DocUnlock | null } = {}
) {
  const res = await doc.core.doc.reload(bytes, { password: opts.password })
  if (!res.ok) throw new Error('The saved file could not be reopened')
  if (opts.ownerPassword) await poOps(doc).checkPassword(opts.ownerPassword, { apply: true })
  const info = await doc.core.doc.info()
  doc.set({
    info,
    filePath: path,
    title: basename(path),
    dirty: false,
    selection: { kind: 'none' },
    ...(opts.unlock !== undefined ? { unlock: opts.unlock } : {})
  })
  await doc.core.doc.markSaved(basename(path))
  try {
    const recent = await invoke('recent:add', { path, name: basename(path), size: bytes.length, pageCount: info.pageCount })
    useApp.setState({ recent })
  } catch {}
}

// ---- permissions password -------------------------------------------------------------------

/** Asks for the permissions password until it is right. Returns true when the session is unlocked. */
export async function unlockWithPermissionsPassword(doc: DocumentModel, reason: string): Promise<boolean> {
  let message = reason
  for (;;) {
    const pw = await prompt({
      title: 'Permissions password',
      message,
      label: 'Permissions password',
      password: true,
      okLabel: 'Unlock',
      validate: (v) => (v ? null : 'Enter the password')
    })
    if (pw === null) return false
    try {
      const { level } = await poOps(doc).checkPassword(pw, { apply: true })
      if (level === 'owner') {
        await refreshInfo(doc)
        toast('Restrictions lifted for this session. The file itself keeps its security.', { kind: 'success' })
        return true
      }
      message =
        level === 'user'
          ? 'That is the password to open the document. Enter the permissions password to change its security.'
          : 'That password is not correct. Try again.'
    } catch (err) {
      showError(err, 'Could not check the password')
      return false
    }
  }
}

export async function enterPermissionsPassword(doc: DocumentModel) {
  const st = await securityOf(doc)
  if (!st.encrypted || st.ownerAccess) {
    toast('This document has no restrictions to lift.')
    return
  }
  await unlockWithPermissionsPassword(doc, `Enter the permissions password of “${doc.state.title}” to lift its restrictions while you work on it.`)
}

/** Asks for the open password of the file (needed to compress an encrypted copy). */
async function askOpenPassword(doc: DocumentModel): Promise<string | null> {
  let message: string = `“${doc.state.title}” is protected with a password. Enter it to compress the document; the compressed copy keeps the same password and permissions.`
  for (;;) {
    const pw = await prompt({ title: 'Password required', message, label: 'Document open password', password: true, okLabel: 'Continue', validate: (v) => (v ? null : 'Enter the password') })
    if (pw === null) return null
    const { level } = await poOps(doc).checkPassword(pw)
    if (level !== 'none') return pw
    message = 'That password is not correct. Try again.'
  }
}

// ---- protect --------------------------------------------------------------------------------

export async function openProtectDialog(doc: DocumentModel, mode: 'password' | 'restrict' = 'password') {
  await protectDocument(doc, { mode })
}

/**
 * The Protect flow, optionally with the dialog's choices ticked in advance (agent access).
 * Resolves true once the protected copy was saved and the tab reopened from it.
 */
export async function protectDocument(
  doc: DocumentModel,
  opts: { mode?: 'password' | 'restrict'; initial?: Partial<Pick<ProtectSettings, 'requireOpenPassword' | 'restrictEditing'>> } = {}
): Promise<boolean> {
  try {
    const st = await securityOf(doc)
    if (st.encrypted && !st.ownerAccess) {
      const ok = await unlockWithPermissionsPassword(
        doc,
        `“${doc.state.title}” is protected with a permissions password. Enter it to change the security settings.`
      )
      if (!ok) return false
    }
    const settings = await openDialog<ProtectSettings>((close) => (
      <ProtectDialog doc={doc} mode={opts.mode ?? 'password'} initial={opts.initial} onDone={close} />
    ))
    if (!settings) return false
    return await applyProtection(doc, settings)
  } catch (err) {
    showError(err, 'Could not protect the document')
    return false
  }
}

export async function applyProtection(doc: DocumentModel, settings: ProtectSettings): Promise<boolean> {
  const encrypt = encryptOptions(settings)
  const path = await chooseSavePath('Save Protected PDF', doc.state.filePath ?? pdfName(doc.state.title))
  if (!path) return false
  try {
    const bytes = await doc.busyWhile('Protecting…', () => doc.saveBytes({ mode: 'full', encrypt }))
    await writeFile(path, bytes)
    // Reopen with the permissions password: you keep full access while the file is restricted for others.
    await reloadFromSaved(doc, bytes, path, {
      password: encrypt.ownerPassword || encrypt.userPassword,
      ownerPassword: encrypt.userPassword ? undefined : encrypt.ownerPassword,
      unlock: encrypt.userPassword ? { method: 'typed', access: 'owner' } : null
    })
  } catch (err) {
    showError(err, 'Could not protect the document')
    return false
  }
  // The open password, so the file opens without asking (with the restrictions others get).
  let remembered = false
  if (settings.rememberPassword && encrypt.userPassword) {
    const saved = await rememberDocumentPassword(doc, path, encrypt.userPassword, 'user').catch(() => null)
    remembered = !!saved
    if (saved) doc.set({ unlock: { method: 'typed', access: 'owner', savedRef: saved.ref, lock: saved.lock } })
    else toast(`The password for “${basename(path)}” could not be saved on this device.`, { kind: 'warning' })
  }
  const restricted = settings.restrictEditing ? restrictionList(permissionsFor(settings)) : []
  const method = settings.method === 'aes-256' ? '256-bit AES' : settings.method === 'aes-128' ? '128-bit AES' : '128-bit RC4'
  await ask({
    title: 'Your PDF is protected',
    width: 480,
    message: (
      <div className="fc-protect-optimize-summary">
        <p>
          Saved <b>{basename(path)}</b> with {method} encryption.
        </p>
        <ul>
          {settings.requireOpenPassword && (
            <li>
              Opening it needs the password you set{remembered ? '. It is saved on this device, so the file opens here without asking' : ''}.
            </li>
          )}
          {settings.restrictEditing &&
            (restricted.length ? (
              <li>Without the permissions password, these are not allowed: {sentenceList(restricted)}.</li>
            ) : (
              <li>Changing its security needs the permissions password.</li>
            ))}
        </ul>
        <p className="fc-protect-optimize-muted">Keep your passwords somewhere safe. They can’t be recovered if you lose them.</p>
      </div>
    ),
    buttons: [{ id: 'ok', label: 'OK', variant: 'primary' }]
  })
  return true
}

// ---- remove security ------------------------------------------------------------------------

export async function removeSecurity(doc: DocumentModel) {
  await removeDocumentSecurity(doc)
}

/**
 * Remove Security. With `confirmed` the person already agreed elsewhere (agent access): the
 * question is skipped and the document is saved over its file, or where the person chooses when
 * it has none. Resolves with the path written, or null when nothing was saved.
 */
export async function removeDocumentSecurity(doc: DocumentModel, opts: { confirmed?: boolean } = {}): Promise<string | null> {
  try {
    const st = await securityOf(doc)
    if (!st.encrypted) {
      toast('This document has no security to remove.')
      return null
    }
    if (!st.ownerAccess) {
      const ok = await unlockWithPermissionsPassword(doc, `Enter the permissions password to remove security from “${doc.state.title}”.`)
      if (!ok) return null
    }
    const hasPath = !!doc.state.filePath
    const answer = opts.confirmed ? 'remove' : await ask<'cancel' | 'copy' | 'remove'>({
      title: 'Remove security',
      width: 500,
      message: (
        <>
          <p style={{ marginTop: 0 }}>
            Remove the password and all restrictions from “{doc.state.title}”? Anyone with the file will be able to open, print, copy and
            change it.
          </p>
          {hasPath ? (
            <p style={{ marginBottom: 0 }}>
              <b>Remove Security</b> saves the file without security{doc.state.dirty ? ', together with your unsaved changes' : ''}. <b>Save as Copy</b> keeps
              this file protected.
            </p>
          ) : (
            <p style={{ marginBottom: 0 }}>You will choose where to save the unprotected PDF.</p>
          )}
        </>
      ),
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        ...(hasPath ? [{ id: 'copy' as const, label: 'Save as Copy…' }] : []),
        { id: 'remove', label: 'Remove Security', variant: 'danger' }
      ]
    })
    if (answer !== 'copy' && answer !== 'remove') return null
    const asCopy = answer === 'copy'
    const path =
      !asCopy && doc.state.filePath
        ? doc.state.filePath
        : await chooseSavePath(
            asCopy ? 'Save Unprotected Copy' : 'Save Unprotected PDF',
            asCopy ? siblingPath(doc, `${stripExtension(doc.state.title)}_unprotected.pdf`) : pdfName(doc.state.title)
          )
    if (!path) return null
    const bytes = await doc.busyWhile('Removing security…', () => doc.saveBytes({ mode: 'full', decrypt: true }))
    await writeFile(path, bytes)
    if (asCopy && path !== doc.state.filePath) {
      toast(`Saved an unprotected copy: ${basename(path)}`, { kind: 'success', action: { label: 'Open', run: () => void openPaths([path]) } })
      return path
    }
    await reloadFromSaved(doc, bytes, path, { unlock: null })
    toast(`Security removed. “${basename(path)}” no longer has a password or restrictions.`, { kind: 'success' })
    return path
  } catch (err) {
    showError(err, 'Could not remove security')
    return null
  }
}

// ---- compress -------------------------------------------------------------------------------

/** Size of the document as it is on disk, when the tab has no unsaved changes. */
export async function savedSize(doc: DocumentModel): Promise<number | null> {
  const fp = doc.state.filePath
  if (!fp || doc.state.dirty) return null
  try {
    return (await invoke('file:stat', fp))?.size ?? null
  } catch {
    return null
  }
}

export async function compressDocument(doc: DocumentModel, options: OptimizeOptions, output: CompressOutput): Promise<CompressResult | null> {
  const title = doc.state.title
  try {
    const st: SecurityStatus = await securityOf(doc)
    let password: string | undefined
    if (st.needsOpenPassword) {
      const pw = await askOpenPassword(doc)
      if (pw === null) return null
      password = pw
    }
    if (doc.state.info.signatureCount > 0) {
      const go = await confirm({
        title: 'Compress a signed document?',
        message: 'Compressing writes a new file. The digital signatures in it will no longer be valid.',
        confirmLabel: 'Compress Anyway'
      })
      if (!go) return null
    }
    const { bytes, report } = await withProgress(`Compressing “${title}”…`, (onProgress) =>
      poOps(doc, { onProgress: (f, m) => onProgress(f, m) }).optimize(options, password)
    )
    const before = (await savedSize(doc)) ?? report.originalSize
    const name = compressedName(title)
    const base = { before, after: bytes.length, name, report, summary: reductionSummary(before, bytes.length) }
    if (bytes.length >= before) {
      const result: CompressResult = { ...base, smaller: false, path: null, openedInTab: false }
      setResult(doc, result)
      toast(`“${title}” is already well optimized: these settings would not make it smaller.`, { kind: 'info' })
      return result
    }
    let path: string | null = null
    if (output === 'tab') {
      const opened = await openNewDocument(bytes, name)
      if (!opened) return null
      await poOps(opened).markUnsaved()
    } else {
      path = await chooseSavePath('Save Compressed PDF', siblingPath(doc, name))
      if (!path) return null
      await writeFile(path, bytes)
      if (path === doc.state.filePath) await reloadFromSaved(doc, bytes, path, { password })
    }
    const result: CompressResult = { ...base, smaller: true, path, openedInTab: output === 'tab' }
    setResult(doc, result)
    const saved = path
    toast(result.summary, {
      kind: 'success',
      timeout: 8000,
      action: saved && saved !== doc.state.filePath ? { label: 'Open', run: () => void openPaths([saved]) } : undefined
    })
    return result
  } catch (err) {
    showError(err, `Could not compress ${title}`)
    return null
  }
}

function setResult(doc: DocumentModel, result: CompressResult) {
  useProtectOptimize.setState((s) => ({ results: { ...s.results, [doc.id]: result } }))
}

export function describeReport(r: CompressResult): string[] {
  const out: string[] = []
  const im = r.report.images
  if (im.downsampled) out.push(`${im.downsampled} image${im.downsampled === 1 ? '' : 's'} downsampled (${formatBytes(im.bytesBefore)} → ${formatBytes(im.bytesAfter)})`)
  if (im.recompressed) out.push(`${im.recompressed} image${im.recompressed === 1 ? '' : 's'} recompressed`)
  if (r.report.fontsSubset) out.push('Fonts subset to the characters used')
  const removed = r.report.discarded.filter((d) => d !== 'form fields flattened')
  if (r.report.discarded.includes('form fields flattened')) out.push('Form fields flattened')
  if (removed.length) out.push(`Removed: ${sentenceList(removed)}`)
  if (r.report.keptEncryption) out.push('Password protection kept')
  return out
}

// ---- saved password -------------------------------------------------------------------------

/** "Forget": the password saved on this device no longer opens the document (or its copies). */
export async function forgetDocumentPassword(doc: DocumentModel): Promise<boolean> {
  try {
    await forgetSavedPassword(doc)
    toast(`Fartcrobat will ask for the password of “${doc.state.title}” the next time it is opened.`)
    return true
  } catch (err) {
    showError(err, 'Could not forget the saved password')
    return false
  }
}
