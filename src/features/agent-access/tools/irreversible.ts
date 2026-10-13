// Agent tools: apply_redactions, sign_document, protect_document, remove_security.
import type { AgentToolName } from '@shared/agent/tools'
import { toast } from '@renderer/sdk'
import type { SignTarget } from '@features/digital-signatures/types'
import { startSigning } from '@features/digital-signatures/ui/flow'
import { sigOps, trustedSet, validateDocument } from '@features/digital-signatures/ui/store'
import { overallStatus, signatureStatus } from '@features/digital-signatures/status'
import { protectDocument, removeDocumentSecurity, securityOf } from '@features/protect-optimize/flows'
import { markNeedsReload, saveRedactedCopy } from '@features/redact/actions'
import { redactOps } from '@features/redact/store'
import {
  ToolError,
  auditName,
  describeDoc,
  pageIndex,
  rectArg,
  resolveDoc,
  runAsAgent,
  type ToolHandler
} from './common'
import { idList, optBoolean, optString, pagesPhrase, plural } from './act-common'
import { cancelled, checked, commitTyping, engineTask, handoff, paragraphs, requireConfirmation, undoLabel } from './act-runtime'

/** Smallest new signature box (points): smaller ones cannot show a readable signature. */
const MIN_SIGNATURE_BOX = { w: 36, h: 18 }

const applyRedactions: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const ids = checked(() => idList(args.ids, 'ids'))
  const all = await engineTask('Could not read the redaction marks', () => redactOps(doc).list())
  const missing = ids.filter((id) => !all.some((m) => m.id === id))
  if (missing.length)
    throw new ToolError('invalid_args', `No redaction mark with id ${missing.join(', ')}. Call list_annotations with types ["Redact"] for current ids.`)
  const marks = ids.length ? all.filter((m) => ids.includes(m.id)) : all
  if (!marks.length) throw new ToolError('invalid_args', 'There are no redaction marks to apply. Mark text or areas with mark_redactions first.')
  const pages = [...new Set(marks.map((m) => m.page))]
  const signed = doc.state.info.signatureCount
  const what = plural(marks.length, 'redaction mark')
  await commitTyping()
  await requireConfirmation(
    ctx,
    doc,
    {
      title: 'Apply redactions?',
      message: paragraphs(
        `The content under ${what} on ${pagesPhrase(pages)} of “${doc.state.title}” will be removed: text, images and drawings under the marks, and comments and form fields in those areas.`,
        'Once the document is saved this cannot be undone.',
        ...(signed
          ? [`This document has ${signed === 1 ? 'a digital signature' : `${signed} digital signatures`}. Redacting changes the signed content, so ${signed === 1 ? 'it' : 'they'} will no longer be valid.`]
          : [])
      ),
      confirmLabel: 'Apply redactions'
    },
    `apply ${what}`
  )
  const report = await engineTask('Could not apply redactions', () =>
    runAsAgent(doc, () =>
      doc
        .ops<typeof import('@features/redact/engine').default>('redact', {
          onProgress: (fraction, message) => ctx.progress(Math.round(fraction * 100), 100, message)
        })
        .apply(ids.length ? marks.map((m) => m.id) : null)
    )
  )
  // As after the person applies them: the tab reloads from the next saved file, so the removed
  // content is gone from memory too.
  markNeedsReload(doc)
  doc.clearSelection()
  toast(`Applied ${plural(report.marks, 'redaction')} on ${pagesPhrase(report.pages)}. Save the document to make it permanent.`, {
    kind: 'success',
    timeout: 10000,
    action: { label: 'Save As…', run: () => void saveRedactedCopy(doc) }
  })
  ctx.audit({ document: auditName(doc), summary: `applied ${plural(report.marks, 'redaction')} on ${pagesPhrase(report.pages)}` })
  return {
    data: {
      applied: report.marks,
      pages: report.pages.map((p) => p + 1),
      removedComments: report.removedAnnotations,
      removedFormFields: report.removedFields,
      undoLabel: await undoLabel(doc),
      next: 'The content is removed from the open document. Save it to make this permanent (save_document with a new path keeps the original file).'
    }
  }
}

const signDocument: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const fieldName = checked(() => optString(args.field_name, 'field_name'))
  const reason = checked(() => optString(args.reason, 'reason'))
  const location = checked(() => optString(args.location, 'location'))
  const certify = checked(() => optBoolean(args.certify, 'certify')) ?? false
  const cap = await engineTask('Could not check the document', () => sigOps(doc).capability())
  if (certify && !cap.canCertify) throw new ToolError('failed', cap.certifyReason ?? 'This document cannot be certified.')
  if (!cap.canSign) throw new ToolError('failed', cap.reason ?? 'This document cannot be signed.')
  const unsigned = cap.fields.filter((f) => !f.signed).map((f) => `"${f.name}"`)
  const box = args.page !== undefined || args.rect !== undefined
  let target: SignTarget
  if (fieldName !== undefined) {
    if (box) throw new ToolError('invalid_args', 'Give field_name, or page and rect for a new signature box, not both')
    const field = cap.fields.find((f) => f.name === fieldName)
    if (!field)
      throw new ToolError('invalid_args', `No signature field named "${fieldName}".${unsigned.length ? ` Unsigned signature fields: ${unsigned.join(', ')}.` : ''}`)
    if (field.signed) throw new ToolError('invalid_args', `The signature field "${fieldName}" is already signed.`)
    target = { kind: 'field', name: fieldName }
  } else if (box) {
    if (args.page === undefined || args.rect === undefined) throw new ToolError('invalid_args', 'A new signature box needs both page and rect')
    const page = pageIndex(args.page, doc.pageCount)
    const rect = rectArg(args.rect)
    if (rect[2] - rect[0] < MIN_SIGNATURE_BOX.w || rect[3] - rect[1] < MIN_SIGNATURE_BOX.h)
      throw new ToolError('invalid_args', `rect is too small for a signature: make it at least ${MIN_SIGNATURE_BOX.w} x ${MIN_SIGNATURE_BOX.h} points`)
    target = { kind: 'new', page, rect }
  } else if (cap.fields.filter((f) => !f.signed).length === 1) {
    target = { kind: 'field', name: cap.fields.find((f) => !f.signed)!.name }
  } else {
    throw new ToolError(
      'invalid_args',
      unsigned.length
        ? `Give field_name (unsigned signature fields: ${unsigned.join(', ')}), or page and rect for a new signature box.`
        : 'Give page and rect for a new signature box: this document has no unsigned signature fields.'
    )
  }
  await commitTyping()
  const signedOk = await handoff(ctx, () => startSigning(doc, { mode: certify ? 'certify' : 'sign', target, reason, location }))
  if (!signedOk)
    throw cancelled(
      ctx,
      doc,
      `${certify ? 'certifying' : 'signing'} not completed`,
      'The person did not complete the signature in Fartcrobat (they cancelled, or Fartcrobat showed them why it failed). The document was not changed.'
    )
  const saved = doc.state.filePath
  const report = await validateDocument(doc)
  const trusted = trustedSet()
  const status = overallStatus(report, trusted)
  ctx.audit({ document: saved ?? auditName(doc), summary: `${certify ? 'certified' : 'signed'}${saved ? ` and saved to ${saved}` : ''}` })
  return {
    data: {
      ...describeDoc(ctx, doc),
      saved,
      validation: status ? { level: status.level, message: status.message } : null,
      signatures: (report?.signatures ?? []).map((s) => ({
        field: s.fieldName,
        signer: s.signerName,
        signingTime: s.signingTime,
        page: s.page + 1,
        status: signatureStatus(s, trusted).level
      }))
    }
  }
}

const protectDocumentTool: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const requireOpenPassword = checked(() => optBoolean(args.require_open_password, 'require_open_password')) ?? true
  const restrictEditing = checked(() => optBoolean(args.restrict_editing, 'restrict_editing')) ?? false
  if (!requireOpenPassword && !restrictEditing) throw new ToolError('invalid_args', 'Choose require_open_password, restrict_editing or both')
  await commitTyping()
  const done = await handoff(ctx, () =>
    protectDocument(doc, { mode: requireOpenPassword ? 'password' : 'restrict', initial: { requireOpenPassword, restrictEditing } })
  )
  if (!done)
    throw cancelled(
      ctx,
      doc,
      'protecting not completed',
      'The document was not protected: the person cancelled the Protect dialog (or Fartcrobat showed them why it failed).'
    )
  const security = await securityOf(doc).catch(() => null)
  ctx.audit({ document: doc.state.filePath ?? auditName(doc), summary: `protected and saved to ${doc.state.filePath}` })
  return {
    data: {
      ...describeDoc(ctx, doc),
      saved: doc.state.filePath,
      encryption: security?.method ?? doc.state.info.encryption,
      requiresOpenPassword: security?.needsOpenPassword ?? requireOpenPassword
    }
  }
}

const removeSecurity: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const st = await engineTask('Could not read the security settings', () => securityOf(doc))
  if (!st.encrypted) throw new ToolError('invalid_args', `“${doc.state.title}” has no password or restrictions to remove.`)
  await commitTyping()
  const path = doc.state.filePath
  await requireConfirmation(
    ctx,
    doc,
    {
      title: 'Remove security?',
      message: paragraphs(
        `Remove the password and all restrictions from “${doc.state.title}”? Anyone with the file will be able to open, print, copy and change it.`,
        path
          ? `Fartcrobat saves it without security over its file${doc.state.dirty ? ', together with the unsaved changes' : ''}.`
          : 'You will choose where to save the unprotected PDF.',
        ...(st.ownerAccess ? [] : ['Its permissions password is needed: you will be asked for it.'])
      ),
      confirmLabel: 'Remove Security',
      details: path ? [path] : undefined
    },
    'remove security'
  )
  const saved = await handoff(ctx, () => removeDocumentSecurity(doc, { confirmed: true }))
  if (!saved)
    throw cancelled(
      ctx,
      doc,
      'security not removed',
      'The security was not removed: the person cancelled (or Fartcrobat showed them why it failed).'
    )
  ctx.audit({ document: saved, summary: `removed security, saved to ${saved}` })
  return { data: { ...describeDoc(ctx, doc), saved, encrypted: !!doc.state.info.encryption } }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  apply_redactions: applyRedactions,
  sign_document: signDocument,
  protect_document: protectDocumentTool,
  remove_security: removeSecurity
}
