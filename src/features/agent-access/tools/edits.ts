// Agent tools: add_annotations, update_annotations, reply_to_comment, set_form_values, mark_redactions,
// organize_pages, recognize_text, set_metadata, undo, redo.
import type { AgentToolName } from '@shared/agent/tools'
import type { AnnotInfo } from '@engine/ops/annots'
import type annotOps from '@engine/ops/annots'
import type pageOps from '@engine/ops/pages'
import { EngineCallError } from '@renderer/engine/EngineClient'
import { basename, platform, rangeQuads, unlockAuditSummary, useApp, type DocumentModel } from '@renderer/sdk'
import { formController } from '@features/forms-fill/controller'
import { formsSettings, loadFormsSettings } from '@features/forms-fill/settings'
import type markupOps from '@features/markup-tools/engine'
import { getToolStyle, loadToolStyles } from '@features/markup-tools/style'
import type navigationOps from '@features/navigation/engine'
import { BUNDLED_LANGUAGE } from '@features/ocr/constants'
import type ocrOps from '@features/ocr/engine'
import { isAvailable, refreshLanguages, useLanguages } from '@features/ocr/languages'
import { pageHasText, recognizePages, type PageProgress, type RunResult } from '@features/ocr/pipeline'
import { ocrOpsOf } from '@features/ocr/run'
import { markRecognized } from '@features/ocr/scanBar'
import { loadOcrSettings, ocrSettings } from '@features/ocr/settings'
import { startTesseract, type TesseractSession } from '@features/ocr/tesseract'
import { loadFile, orgOps, withUnlock } from '@features/organize-pages/files'
import { findOnPage, type FindQuery, type PatternId } from '@features/redact/patterns'
import type { MarkSpec } from '@features/redact/shared'
import { currentProps, loadProps, redactOps } from '@features/redact/store'
import {
  AGENT_ACTOR,
  ToolError,
  auditName,
  clientLabel,
  parsePages,
  resolveDoc,
  runAsAgent,
  throwIfAborted,
  type ToolContext,
  type ToolHandler
} from './common'
import { idList, optBoolean, optString, pagesPhrase, plural } from './act-common'
import { AGENT_ANNOT_TYPES, NOT_COMMENTS, buildAnnotation, buildUpdate, type AgentAnnotType } from './act-annots'
import { noCertificateFailure, openErrorCode } from './act-files'
import { formFields, planFill, resolveValues } from './act-forms'
import { duplicatedIndices, insertedIndices, planOrganize } from './act-pages'
import { markProps, markSpecsFromItems } from './act-redact'
import { agentName, cancelled, checked, engineTask, handoff, paragraphs, requireConfirmation, toolErrorFrom, undoLabel } from './act-runtime'
import { confirmNetworkPaths } from './files'

function annots(doc: DocumentModel) {
  return doc.ops<typeof annotOps>('annots')
}

/** An annotation by id, or null when there is none (any type, form fields and links included). */
async function findAnnotation(doc: DocumentModel, id: number): Promise<AnnotInfo | null> {
  try {
    return await annots(doc).get(id)
  } catch (err) {
    if (err instanceof EngineCallError && err.code === 'NO_ANNOTATION') return null
    throw toolErrorFrom(err, 'Could not read the comments')
  }
}

const LABELS: Record<AgentAnnotType, [string, string]> = {
  note: ['note', 'notes'],
  textbox: ['text box', 'text boxes'],
  highlight: ['highlight', 'highlights'],
  underline: ['underline', 'underlines'],
  strikeout: ['strikethrough', 'strikethroughs'],
  squiggly: ['squiggly underline', 'squiggly underlines'],
  rectangle: ['rectangle', 'rectangles'],
  oval: ['oval', 'ovals'],
  line: ['line', 'lines'],
  arrow: ['arrow', 'arrows']
}

/** "3 highlights and 1 note" (never their text). */
function countSummary(types: AgentAnnotType[]): string {
  const parts = AGENT_ANNOT_TYPES.filter((t) => types.includes(t)).map((t) => {
    const n = types.filter((x) => x === t).length
    return plural(n, LABELS[t][0], LABELS[t][1])
  })
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? 'nothing')
}

// ---- comments --------------------------------------------------------------------------------

const addAnnotations: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  if (!Array.isArray(args.items) || !args.items.length) throw new ToolError('invalid_args', 'items must list the comments to add')
  if (args.items.length > 500) throw new ToolError('invalid_args', 'Add at most 500 comments per call')
  await loadToolStyles()
  const info = doc.state.info
  const author = agentName(ctx)
  const items = args.items as unknown[]
  const built = checked(() =>
    items.map((item, i) =>
      buildAnnotation(item, i, {
        pageCount: info.pageCount,
        pageSize: (p) => info.pages[p],
        style: getToolStyle,
        author
      })
    )
  )
  const created: { id: number; page: number; type: AgentAnnotType }[] = []
  const ops = doc.ops<typeof markupOps>('markup-tools')
  try {
    await runAsAgent(doc, async () => {
      // One undo step per comment, labelled like the person's tool ("Agent: Add Highlight").
      for (const b of built) {
        throwIfAborted(ctx)
        const [a] = await ops.create([{ page: b.page, spec: b.spec }], b.tool.undoLabel)
        created.push({ id: a.id, page: a.page + 1, type: b.type })
      }
    })
  } catch (err) {
    if (created.length) {
      ctx.audit({ document: auditName(doc), outcome: 'error', summary: `added ${countSummary(created.map((c) => c.type))} before stopping` })
      const e = toolErrorFrom(err, 'Could not add every comment')
      throw new ToolError(e instanceof ToolError ? e.code : 'failed', `${e.message} (added ${created.length} before stopping: ids ${created.map((c) => c.id).join(', ')})`)
    }
    throw toolErrorFrom(err, 'Could not add the comments')
  }
  ctx.audit({ document: auditName(doc), summary: `added ${countSummary(created.map((c) => c.type))}` })
  return { data: { created, author, undoLabel: await undoLabel(doc) } }
}

const updateAnnotations: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const updates = args.updates ?? []
  if (!Array.isArray(updates)) throw new ToolError('invalid_args', 'updates must be a list of { id, text, color, rect }')
  const deleteIds = checked(() => idList(args.delete_ids, 'delete_ids'))
  if (!updates.length && !deleteIds.length) throw new ToolError('invalid_args', 'Give updates or delete_ids')
  const ids = new Set<number>(deleteIds)
  for (const u of updates) if (u && typeof u === 'object' && typeof (u as { id?: unknown }).id === 'number') ids.add((u as { id: number }).id)
  const found = new Map<number, AnnotInfo | null>()
  for (const id of ids) found.set(id, await findAnnotation(doc, id))
  const plan = checked(() => updates.map((u, i) => buildUpdate(u, i, (id) => found.get(id)?.type ?? null)))
  for (const id of deleteIds) {
    const a = found.get(id)
    if (!a) throw new ToolError('invalid_args', `No comment with id ${id}. Call list_annotations for current ids.`)
    if (NOT_COMMENTS.has(a.type)) throw new ToolError('invalid_args', `${id} is a ${a.type === 'Widget' ? 'form field' : a.type.toLowerCase()}, not a comment`)
  }
  for (const id of ids) {
    if (found.get(id)?.locked) throw new ToolError('invalid_args', `Comment ${id} is locked. Ask the person to unlock it in Fartcrobat first.`)
  }
  const ops = annots(doc)
  await engineTask('Could not change the comments', () =>
    runAsAgent(doc, async () => {
      for (const u of plan) {
        throwIfAborted(ctx)
        const page = found.get(u.id)!.page
        if (Object.keys(u.spec).length) await ops.update(u.id, u.spec, page)
        if (u.rect) await ops.transform([{ id: u.id, rect: u.rect }], page)
      }
      if (deleteIds.length) await ops.delete(deleteIds)
    })
  )
  const parts = [plan.length ? `changed ${plural(plan.length, 'comment')}` : '', deleteIds.length ? `deleted ${plural(deleteIds.length, 'comment')}` : '']
  ctx.audit({ document: auditName(doc), summary: parts.filter(Boolean).join(', ') })
  return { data: { updated: plan.map((u) => u.id), deleted: deleteIds, undoLabel: await undoLabel(doc) } }
}

const REVIEW_STATES = ['Accepted', 'Rejected', 'Cancelled', 'Completed', 'None']

const replyToComment: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  if (typeof args.id !== 'number' || !Number.isInteger(args.id)) throw new ToolError('invalid_args', 'id must be a comment id from list_annotations')
  const text = checked(() => optString(args.text, 'text'))?.trim()
  if (!text) throw new ToolError('invalid_args', 'text is required: the reply')
  const status = args.status as string | undefined
  if (status !== undefined && !REVIEW_STATES.includes(status)) throw new ToolError('invalid_args', `status must be one of ${REVIEW_STATES.join(', ')}`)
  const target = await findAnnotation(doc, args.id)
  if (!target) throw new ToolError('invalid_args', `No comment with id ${args.id}. Call list_annotations for current ids.`)
  if (NOT_COMMENTS.has(target.type)) throw new ToolError('invalid_args', `${args.id} is not a comment`)
  // Replies belong to the thread's first comment, as in the Comments panel.
  let root = target
  for (let depth = 0; root.inReplyTo !== null && depth < 32; depth++) {
    const parent = await findAnnotation(doc, root.inReplyTo)
    if (!parent) break
    root = parent
  }
  const author = agentName(ctx)
  const ops = annots(doc)
  const reply = await engineTask('Could not add the reply', () =>
    runAsAgent(doc, async () => {
      const r = await ops.reply(root.id, text, author)
      if (status) await ops.setState(root.id, status, author)
      return r
    })
  )
  ctx.audit({ document: auditName(doc), summary: status ? `replied to a comment and set its status to ${status}` : 'replied to a comment' })
  return { data: { replyId: reply.id, threadId: root.id, page: root.page + 1, status: status ?? null, undoLabel: await undoLabel(doc) } }
}

// ---- forms -----------------------------------------------------------------------------------

const setFormValues: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const perms = doc.state.info.permissions
  if (perms.form === false && perms.annotate === false)
    throw new ToolError('failed', `The security settings of “${doc.state.title}” don't allow filling in its form.`)
  const ctl = formController(doc)
  const snapshot = await engineTask('Could not read the form', () => ctl.snapshot())
  const entries = checked(() => resolveValues(args.values, formFields(snapshot.fields)))
  await loadFormsSettings()
  let plan
  try {
    plan = await runAsAgent(doc, () =>
      ctl.enqueue(async () => {
        const rt = await ctl.runtime()
        const p = planFill(rt, entries, { calculate: formsSettings().autoCalculate })
        try {
          await ctl.fill.fill(p.changes, entries.length === 1 ? 'Fill Form Field' : 'Fill Form')
        } catch (err) {
          p.restore()
          throw err
        }
        return p
      })
    )
  } catch (err) {
    throw toolErrorFrom(err, 'Could not fill in the form')
  }
  const calculated = plan.changes.filter((c) => !entries.some((e) => e.field.name === c.name)).map((c) => c.name)
  ctx.audit({ document: auditName(doc), summary: `filled ${plural(entries.length, 'field')}` })
  return {
    data: {
      filled: entries.map((e) => e.field.name),
      calculated,
      ...(plan.messages.length ? { formMessages: plan.messages } : {}),
      undoLabel: await undoLabel(doc)
    }
  }
}

// ---- redaction -------------------------------------------------------------------------------

const PATTERNS: PatternId[] = ['phone', 'email', 'creditCard', 'ssn', 'date']
const MAX_MARKS = 5000

const markRedactions: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const info = doc.state.info
  const specs: MarkSpec[] = checked(() => markSpecsFromItems(args.items, info.pageCount, (p) => info.pages[p]))
  const query = checked(() => optString(args.query, 'query'))
  const pattern = args.pattern as PatternId | undefined
  if (pattern !== undefined && !PATTERNS.includes(pattern)) throw new ToolError('invalid_args', `pattern must be one of ${PATTERNS.join(', ')}`)
  if (query !== undefined && pattern !== undefined) throw new ToolError('invalid_args', 'Give query or pattern, not both')
  const overlay = checked(() => optString(args.overlay_text, 'overlay_text'))
  if (!specs.length && !query && !pattern) throw new ToolError('invalid_args', 'Give items to mark, or a query or pattern to mark every match')
  let matches = 0
  if (query || pattern) {
    const find: FindQuery = {
      mode: pattern ? 'pattern' : 'phrase',
      phrase: query ?? '',
      list: [],
      pattern: pattern ?? 'email',
      wholeWords: checked(() => optBoolean(args.whole_words, 'whole_words')) ?? false,
      matchCase: checked(() => optBoolean(args.match_case, 'match_case')) ?? false
    }
    const pages = parsePages(args.pages, info.pageCount)
    for (let k = 0; k < pages.length; k++) {
      throwIfAborted(ctx)
      ctx.progress(k, pages.length, `Searching page ${pages[k] + 1}`)
      const t = await engineTask('Could not read the page text', () => doc.pageText(pages[k]))
      for (const hit of findOnPage(t, find)) {
        const quads = rangeQuads(t, hit.start, Math.min(hit.end, t.text.length))
        if (!quads.length) continue
        specs.push({ page: pages[k], kind: 'text', quads })
        matches++
      }
      if (specs.length > MAX_MARKS) throw new ToolError('invalid_args', `More than ${MAX_MARKS} marks: narrow the search with pages or a more specific query`)
    }
  }
  if (!specs.length) {
    ctx.audit({ document: auditName(doc), summary: 'no matches to mark' })
    return { data: { marked: 0, matches: 0, note: 'Nothing matched, so nothing was marked.' } }
  }
  await loadProps()
  const props = markProps(currentProps(), overlay)
  // Signed like the agent's comments, so the Comments panel shows who marked what.
  const author = agentName(ctx)
  const marks = await engineTask('Could not mark for redaction', () => runAsAgent(doc, () => redactOps(doc).mark(specs, props, author)))
  const pages = [...new Set(marks.map((m) => m.page))]
  ctx.audit({ document: auditName(doc), summary: `${plural(marks.length, 'redaction mark')} on ${pagesPhrase(pages)}` })
  return {
    data: {
      marked: marks.length,
      ...(query || pattern ? { matches } : {}),
      ids: marks.map((m) => m.id),
      pages: pages.map((p) => p + 1),
      undoLabel: await undoLabel(doc),
      next: 'Marks remove nothing until apply_redactions; the person can review them in Fartcrobat.'
    }
  }
}

// ---- pages -----------------------------------------------------------------------------------

const organizePages: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const count = doc.pageCount
  const given = args.pages !== undefined && args.pages !== null && args.pages !== ''
  const pages = given ? parsePages(args.pages, count) : null
  const plan = checked(() => planOrganize(args, pages, count, platform))
  const pagesApi = doc.ops<typeof pageOps>('pages')
  let changed: number[] = []
  let summary: string
  switch (plan.op) {
    case 'rotate':
      await engineTask('Could not rotate the pages', () => runAsAgent(doc, () => pagesApi.rotate(plan.pages, plan.degrees)))
      changed = plan.pages
      summary = `rotated ${pagesPhrase(plan.pages)} by ${plan.degrees}°`
      break
    case 'delete':
      await engineTask('Could not delete the pages', () => runAsAgent(doc, () => pagesApi.delete(plan.pages)))
      summary = `deleted ${pagesPhrase(plan.pages)}`
      break
    case 'move':
      await engineTask('Could not move the pages', () => runAsAgent(doc, () => pagesApi.move(plan.pages, plan.gap)))
      changed = plan.after
      summary = `moved ${pagesPhrase(plan.pages)}`
      break
    case 'insert_blank':
      await engineTask('Could not insert the pages', () => runAsAgent(doc, () => pagesApi.insertBlank(plan.gap, { count: plan.count })))
      changed = insertedIndices(plan.gap, plan.count)
      summary = `inserted ${plural(plan.count, 'blank page')}`
      break
    case 'duplicate':
      changed = await engineTask('Could not duplicate the pages', () => runAsAgent(doc, () => orgOps(doc).duplicate(plan.pages)))
      if (!changed.length) changed = duplicatedIndices(plan.pages)
      summary = `duplicated ${pagesPhrase(plan.pages)}`
      break
    case 'insert_file': {
      await confirmNetworkPaths(ctx, doc, [plan.path], `Inserting pages from “${basename(plan.path)}”`)
      const file = await loadFile(plan.path).catch((err) => {
        throw new ToolError(openErrorCode(String(err?.message ?? err)) === 'unsupported' ? 'unsupported' : 'file_error', `Could not read ${plan.path}: ${err?.message ?? err}`)
      })
      // The key of a certificate-encrypted file goes to this document's engine, so insertFiles opens it too.
      const probe = await handoff(ctx, () =>
        withUnlock(file, doc, (pw) => orgOps(doc).probe(file.bytes, file.engineName, pw), { actor: 'agent', failWithoutKey: true })
      ).catch((err) => {
        if (err instanceof ToolError) throw err
        const noKey = noCertificateFailure(file.name, err)
        if (noKey) throw new ToolError(noKey.code, noKey.message)
        const message = String(err?.message ?? err)
        throw new ToolError(openErrorCode(message), `Could not open ${plan.path}: ${message}`)
      })
      if (!probe) throw cancelled(ctx, doc, `unlocking ${plan.path} cancelled`, `Nothing was inserted: the person cancelled unlocking ${file.name} in Fartcrobat.`)
      changed = await engineTask('Could not insert the pages', () =>
        runAsAgent(doc, () =>
          orgOps(doc).insertFiles(plan.gap, [{ data: file.bytes, fileName: file.engineName, password: probe.password }])
        )
      )
      // Like open_document, the audit line says how a protected source was unlocked.
      const how = unlockAuditSummary(probe.unlock)
      summary = `inserted ${plural(changed.length, 'page')} from ${plan.path}${how ? ` (${how})` : ''}`
      break
    }
  }
  ctx.audit({ document: auditName(doc), summary })
  return {
    data: {
      operation: plan.op,
      pageCount: (await doc.core.doc.facts().catch(() => doc.state.info)).pageCount,
      ...(changed.length ? { pages: changed.map((i) => i + 1) } : {}),
      undoLabel: await undoLabel(doc)
    }
  }
}

// ---- OCR -------------------------------------------------------------------------------------

const recognizeText: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  if (doc.state.info.permissions.edit === false)
    throw new ToolError('failed', `Text can't be recognized: the security settings of “${doc.state.title}” don't allow changes.`)
  const pages = parsePages(args.pages, doc.pageCount)
  const force = checked(() => optBoolean(args.force, 'force')) ?? false
  await loadOcrSettings()
  const installed = useLanguages.getState().loaded ? useLanguages.getState().installed : await refreshLanguages()
  const preferred = useApp.getState().prefs.ocrLanguage
  const language = isAvailable(preferred, installed) ? preferred : BUNDLED_LANGUAGE
  const req = { pages, language, dpi: ocrSettings().dpi, skipPagesWithText: !force }
  // Pages with text are skipped up front so progress counts only the pages that are recognized.
  let todo = pages.length
  if (!force) {
    const statuses = await engineTask('Could not check the pages', () => ocrOpsOf(doc).status(pages))
    todo = statuses.filter((s) => !pageHasText(s)).length
    if (!todo) {
      ctx.audit({ document: auditName(doc), summary: 'all pages already had text' })
      return { data: { recognized: [], skipped: pages.map((p) => p + 1), note: 'Every page already has text. Pass force: true to recognize them anyway.' } }
    }
  }
  let finished = 0
  const onPage = (p: PageProgress) => {
    if (p.state === 'done' || p.state === 'failed') finished++
    if (p.state !== 'skipped') ctx.progress(finished, todo, `Page ${p.page + 1}: ${p.state}`)
  }
  let tesseract: TesseractSession | null = null
  let run: RunResult
  try {
    run = await doc.busyWhile('Recognizing text…', async () => {
      tesseract = await startTesseract(language, installed, ctx.signal)
      return recognizePages(ocrOpsOf(doc), tesseract, req, { onPage, signal: ctx.signal })
    })
  } catch (err) {
    if (ctx.signal.aborted) throw new ToolError('aborted', 'Text recognition was cancelled. Nothing was changed.')
    throw toolErrorFrom(err, 'Text recognition failed')
  } finally {
    ;(tesseract as TesseractSession | null)?.terminate()
  }
  if (run.cancelled || ctx.signal.aborted) throw new ToolError('aborted', 'Text recognition was cancelled. Nothing was changed.')
  const writer = doc.ops<typeof ocrOps>('ocr')
  const applied = run.results.length
    ? await engineTask('Could not add the recognized text', () => runAsAgent(doc, () => writer.addTextLayer(run.results)))
    : []
  const words = applied.reduce((n, a) => n + a.words, 0)
  if (words > 0) markRecognized(doc)
  const withText = applied.filter((a) => a.words > 0).map((a) => a.page)
  ctx.audit({ document: auditName(doc), summary: withText.length ? `recognized text on ${pagesPhrase(withText)}` : 'no text recognized' })
  return {
    data: {
      recognized: applied.map((a) => ({ page: a.page + 1, words: a.words })),
      words,
      skipped: run.skipped.map((p) => p + 1),
      failed: run.failed.map((f) => ({ page: f.page + 1, message: f.message })),
      language,
      undoLabel: applied.length ? await undoLabel(doc) : null
    }
  }
}

// ---- properties ------------------------------------------------------------------------------

const META_KEYS = ['title', 'author', 'subject', 'keywords'] as const

const setMetadata: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const patch: Partial<Record<(typeof META_KEYS)[number], string>> = {}
  for (const k of META_KEYS) {
    const v = checked(() => optString(args[k], k))
    if (v !== undefined) patch[k] = v
  }
  if (!Object.keys(patch).length) throw new ToolError('invalid_args', 'Give title, author, subject or keywords')
  if (doc.state.info.permissions.edit === false)
    throw new ToolError('failed', `The security settings of “${doc.state.title}” don't allow changing its properties.`)
  await engineTask('Could not change the document properties', () =>
    runAsAgent(doc, () => doc.ops<typeof navigationOps>('navigation').setProperties({ metadata: patch }))
  )
  ctx.audit({ document: auditName(doc), summary: `set ${Object.keys(patch).join(', ')}` })
  return { data: { changed: Object.keys(patch), undoLabel: await undoLabel(doc) } }
}

// ---- undo and redo ---------------------------------------------------------------------------

/**
 * What the person is asked before the agent undoes or redoes a step, or null when it may go
 * ahead: the agent's own steps need no click, except applying redactions, which the person
 * approved and whose undo brings the removed content back.
 */
export function stepQuestion(
  dir: 'undo' | 'redo',
  label: string | null,
  agent: string
): { title: string; lines: string[]; declined: string } | null {
  const step = label ?? 'a change'
  const own = !!label?.startsWith(`${AGENT_ACTOR}: `)
  const redaction = !!label?.endsWith('Apply Redactions')
  if (own && !redaction) return null
  const Dir = dir === 'undo' ? 'Undo' : 'Redo'
  const lines = [`${agent} wants to ${dir} “${step}”${own ? '' : ', a change you made'}.`]
  if (redaction)
    lines.push(
      dir === 'undo'
        ? 'The content the redactions removed comes back, and saving the document would keep it.'
        : 'The content under the redaction marks is removed again.'
    )
  if (!own && dir === 'undo') lines.push(`If ${agent} then makes another change, yours can't be redone.`)
  return { title: redaction ? `${Dir} the redactions?` : `${Dir} your change?`, lines, declined: `${dir} ${step}` }
}

async function step(ctx: ToolContext, args: Record<string, unknown>, dir: 'undo' | 'redo') {
  const doc = resolveDoc(ctx, args.handle)
  const journal = () => engineTask('Could not read the undo history', () => doc.core.doc.journal())
  const before = await journal()
  const can = dir === 'undo' ? before.canUndo : before.canRedo
  if (!can) throw new ToolError('invalid_args', dir === 'undo' ? 'There is nothing to undo.' : 'There is nothing to redo.')
  const label = dir === 'undo' ? before.undoLabel : before.redoLabel
  const question = stepQuestion(dir, label, clientLabel(ctx))
  if (question) {
    await requireConfirmation(
      ctx,
      doc,
      { title: question.title, message: paragraphs(...question.lines), confirmLabel: dir === 'undo' ? 'Undo' : 'Redo' },
      question.declined
    )
    // The history may have moved while the person decided: never undo a step they did not see.
    const now = await journal()
    if (now.position !== before.position || (dir === 'undo' ? now.undoLabel : now.redoLabel) !== label)
      throw new ToolError('failed', `The document changed while the person was deciding, so nothing was ${dir === 'undo' ? 'undone' : 'redone'}. Call ${dir} again if it is still wanted.`)
  }
  await engineTask(`Could not ${dir}`, () => (dir === 'undo' ? doc.undo() : doc.redo()))
  const after = await doc.core.doc.journal()
  ctx.audit({ document: auditName(doc), summary: `${dir === 'undo' ? 'undid' : 'redid'} ${label ?? 'a change'}` })
  return {
    data: {
      [dir === 'undo' ? 'undone' : 'redone']: label,
      undoLabel: after.undoLabel,
      redoLabel: after.redoLabel
    }
  }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  add_annotations: addAnnotations,
  update_annotations: updateAnnotations,
  reply_to_comment: replyToComment,
  set_form_values: setFormValues,
  mark_redactions: markRedactions,
  organize_pages: organizePages,
  recognize_text: recognizeText,
  set_metadata: setMetadata,
  undo: (args, ctx) => step(ctx, args, 'undo'),
  redo: (args, ctx) => step(ctx, args, 'redo')
}
