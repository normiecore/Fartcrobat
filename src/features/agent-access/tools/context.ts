// Agent tools: list_documents, get_context, get_document_info, get_page_text, render_page, find_text, list_annotations, list_form_fields, list_signatures.
// All of them only read; the shaping of their output lives in contextShape.ts.
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import type { AgentToolName } from '@shared/agent/tools'
import { rangeRects, registry, searchPage, useApp, type DocumentModel, type SearchHit } from '@renderer/sdk'
import { hasActiveEditors } from '@renderer/app/commands'
import { PATTERNS, searchPattern, type PatternId } from '@features/redact/patterns'
import { TEXT_MARKUP, textUnderQuads } from '@features/comments/shared'
import { trustedSet, useSigStore, validateDocument } from '@features/digital-signatures/ui/store'
import type navigationOps from '@features/navigation/engine'
import {
  auditName,
  describeDoc,
  pageIndex,
  parsePages,
  rectArg,
  resolveDoc,
  round,
  throwIfAborted,
  ToolError,
  type ToolContext,
  type ToolHandler
} from './common'
import {
  annotationsOut,
  fieldsOut,
  hitOut,
  isEmptyPage,
  outlineOut,
  pageSizes,
  pagesOut,
  pageTextOut,
  rangeText,
  renderPlan,
  signaturesOut,
  TextBudget,
  toBase64,
  type HitOut,
  type RenderPlan
} from './contextShape'

const annots = (doc: DocumentModel) => doc.ops<typeof annotOps>('annots')
const forms = (doc: DocumentModel) => doc.ops<typeof formOps>('forms')

/** An optional whole-number argument within [min, max]. */
export function intArg(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolError('invalid_args', `${name} must be a whole number`)
  if (value < min || value > max) throw new ToolError('invalid_args', `${name} must be from ${min} to ${max}`)
  return value
}

export function boolArg(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ToolError('invalid_args', `${name} must be true or false`)
  return value
}

/** The document a call reads, recorded in the audit log. */
function docFor(ctx: ToolContext, handle: unknown): DocumentModel {
  const doc = resolveDoc(ctx, handle)
  ctx.audit({ document: auditName(doc) })
  return doc
}

/** Reports progress every few pages of a long loop. */
function pageProgress(ctx: ToolContext, done: number, total: number, message: string) {
  if (total >= 20 && (done % 10 === 0 || done === total)) ctx.progress(done, total, message)
}

// ---- list_documents, get_context --------------------------------------------------------------------

async function listDocuments(_args: Record<string, unknown>, ctx: ToolContext) {
  const docs = useApp.getState().docs.filter((d) => !d.isClosed)
  return { data: { documents: docs.map((d) => describeDoc(ctx, d)) } }
}

const MAX_SELECTED_CHARS = 20000

async function describeSelection(doc: DocumentModel) {
  const sel = doc.state.selection
  if (sel.kind === 'text') {
    const parts: string[] = []
    const byPage = new Map<number, number[][]>()
    for (const r of sel.ranges) {
      const t = await doc.pageText(r.page)
      parts.push(t.text.slice(r.start, r.end))
      const rects = byPage.get(r.page) ?? []
      rects.push(...rangeRects(t, r.start, r.end).map((x) => round(x)))
      byPage.set(r.page, rects)
    }
    let text = parts.join('\n').replace(/[ \t]+\n/g, '\n').trim()
    const truncated = text.length > MAX_SELECTED_CHARS
    if (truncated) text = text.slice(0, MAX_SELECTED_CHARS)
    return {
      kind: 'text',
      text,
      ...(truncated ? { truncated: true } : {}),
      pages: [...byPage].map(([page, rects]) => ({ page: page + 1, rects }))
    }
  }
  if (sel.kind === 'annotations') {
    const list = await annots(doc).list(sel.page)
    const ids = new Set(sel.ids)
    return {
      kind: 'comments',
      page: sel.page + 1,
      comments: list.filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, type: a.type, ...(a.contents ? { text: a.contents } : {}) }))
    }
  }
  // Something a tool selected (a form field being prepared, an image being edited...).
  if (sel.kind === 'custom') return { kind: sel.type, page: sel.page + 1 }
  return null
}

async function getContext(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const s = doc.state
  const app = useApp.getState()
  const isActive = app.activeDocId === doc.id
  const shown = isActive ? (doc.view?.visiblePages() ?? []) : []
  const visible = shown.length ? shown : [s.currentPage]
  const group = app.toolGroupId ? registry.toolGroups.find((g) => g.id === app.toolGroupId) : undefined
  const tool = app.toolId !== 'select' ? registry.tools.get(app.toolId) : undefined
  const search = s.search.query.trim()
    ? {
        query: s.search.query,
        ...(s.search.options.matchCase ? { matchCase: true } : {}),
        ...(s.search.options.wholeWords ? { wholeWords: true } : {}),
        hits: s.search.hits.length,
        ...(s.search.hits[s.search.active] ? { currentHitPage: s.search.hits[s.search.active].page + 1 } : {}),
        ...(s.search.done ? {} : { stillSearching: true })
      }
    : null
  return {
    data: {
      document: describeDoc(ctx, doc),
      lookingAtThisDocument: isActive && ctx.request.currentWindow !== false,
      currentPage: s.currentPage + 1,
      visiblePages: [...new Set(visible)].sort((a, b) => a - b).map((p) => p + 1),
      zoomPercent: Math.round(s.zoom * 100),
      layout: s.layout,
      selection: await describeSelection(doc),
      search,
      unsavedChanges: s.dirty,
      lastChange: s.journal.undoLabel,
      ...(s.journal.redoLabel ? { lastUndone: s.journal.redoLabel } : {}),
      // Changes typed into a text box or form field that are not in the document yet.
      typing: hasActiveEditors(),
      ...(isActive && group ? { openTool: group.label } : {}),
      ...(isActive && tool ? { pointerTool: tool.label } : {}),
      ...(s.busy ? { busy: s.busy } : {})
    }
  }
}

// ---- get_document_info --------------------------------------------------------------------------

async function getDocumentInfo(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const includeOutline = boolArg(args.include_outline, 'include_outline', true)
  const s = doc.state
  const info = s.info
  const includePages = boolArg(args.include_pages, 'include_pages', info.pageCount <= 200)
  const m = info.metadata
  const data: Record<string, unknown> = {
    ...describeDoc(ctx, doc),
    // "PDF 1.7", or the format a converted file had ("DOCX", "PNG")
    format: info.format,
    ...(info.converted ? { converted: true } : {}),
    metadata: Object.fromEntries(
      Object.entries({
        title: m.title,
        author: m.author,
        subject: m.subject,
        keywords: m.keywords,
        creator: m.creator,
        producer: m.producer,
        created: m.creationDate,
        modified: m.modDate
      }).filter(([, v]) => !!v)
    ),
    ...(info.language ? { language: info.language } : {}),
    security: info.encryption
      ? { encryption: info.encryption, permissions: info.permissions }
      : { encryption: null },
    form: info.hasForm ? { hasForm: true, ...(info.hasXfa ? { xfa: true } : {}) } : { hasForm: false },
    signatureCount: info.signatureCount,
    ...(info.layerCount ? { layerCount: info.layerCount } : {}),
    ...(info.wasRepaired ? { wasRepaired: true } : {})
  }
  if (info.hasForm) {
    const fields = await forms(doc).listAll()
    ;(data.form as Record<string, unknown>).fieldCount = new Set(fields.map((f) => f.name)).size
  }
  if (includePages) data.pages = pagesOut(info.pages)
  else data.pageSizes = pageSizes(info.pages)
  if (info.attachmentCount) {
    try {
      const list = await doc.ops<typeof navigationOps>('navigation').attachments()
      data.attachments = [
        ...list.files.map((f) => ({ name: f.fileName, ...(f.size !== null ? { size: f.size } : {}), ...(f.description ? { description: f.description } : {}) })),
        ...list.annotations.map((f) => ({ name: f.fileName, page: f.page + 1, commentId: f.id, ...(f.size !== null ? { size: f.size } : {}) }))
      ]
    } catch {
      data.attachmentCount = info.attachmentCount
    }
  }
  if (includeOutline) {
    const { outline, truncated } = outlineOut(await doc.core.nav.outline())
    data.outline = outline
    if (truncated) data.outlineTruncated = true
  }
  return { data }
}

// ---- get_page_text ------------------------------------------------------------------------------

async function getPageText(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const pages = parsePages(args.pages, doc.pageCount)
  const withLines = boolArg(args.include_lines, 'include_lines', false)
  const budget = new TextBudget(intArg(args.max_chars, 'max_chars', 60000, 1000, 400000))
  const empty: number[] = []
  for (let k = 0; k < pages.length; k++) {
    throwIfAborted(ctx)
    const out = pageTextOut(await doc.pageText(pages[k]), withLines)
    if (isEmptyPage(out)) empty.push(out.page)
    if (!budget.add(out)) break
    pageProgress(ctx, k + 1, pages.length, 'Reading pages')
  }
  const rest = budget.nextPage === null ? [] : pages.filter((p) => p + 1 >= budget.nextPage!)
  return {
    data: {
      pages: budget.pages,
      ...(budget.full
        ? {
            truncated: true,
            nextPage: budget.nextPage,
            note: `Stopped at max_chars. Continue with pages "${rangeText(rest)}".`
          }
        : {}),
      ...(empty.length ? { pagesWithoutText: empty, hint: 'Pages without text may be scans: use render_page or recognize_text.' } : {})
    }
  }
}

// ---- render_page --------------------------------------------------------------------------------

/** PNG of a part of a page (the engine renders the clip; the canvas encodes it). */
async function renderRegion(doc: DocumentModel, page: number, plan: RenderPlan): Promise<{ png: Uint8Array; width: number; height: number }> {
  const r = await doc.core.render.page(page, { scale: plan.scale, clip: plan.clip! })
  const canvas = new OffscreenCanvas(r.width, r.height)
  const g = canvas.getContext('2d')
  if (!g) throw new Error('Could not draw the page')
  if (r.bitmap) {
    g.drawImage(r.bitmap, 0, 0)
    r.bitmap.close()
  } else if (r.pixels) g.putImageData(new ImageData(r.pixels as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return { png: new Uint8Array(await blob.arrayBuffer()), width: r.width, height: r.height }
}

async function renderPage(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const page = pageIndex(args.page, doc.pageCount)
  const dpi = intArg(args.dpi, 'dpi', 96, 36, 200)
  const region = args.region === undefined || args.region === null ? null : rectArg(args.region, 'region')
  const size = doc.state.info.pages[page]
  const plan = renderPlan([size.width, size.height], dpi, region)
  if (!plan) {
    throw new ToolError('invalid_args', `region is outside the page: page ${page + 1} is ${round([size.width, size.height]).join(' x ')} points.`)
  }
  let png: Uint8Array
  let width = plan.width
  let height = plan.height
  if (plan.clip) ({ png, width, height } = await renderRegion(doc, page, plan))
  else png = await doc.core.render.image(page, { dpi: plan.dpi, format: 'png' })
  return {
    images: [{ data: toBase64(png), mimeType: 'image/png' as const }],
    data: {
      page: page + 1,
      width,
      height,
      dpi: plan.dpi,
      ...(plan.scaledDown ? { note: `Resolution lowered to ${plan.dpi} dpi to keep the picture at most 2000 pixels on each side.` } : {}),
      region: round(plan.region),
      pageSize: round([size.width, size.height]),
      // pixel (px, py) is at point (region[0] + px * 72 / dpi, region[1] + py * 72 / dpi)
      pointsPerPixel: Math.round((72 / plan.dpi) * 10000) / 10000
    }
  }
}

// ---- find_text ----------------------------------------------------------------------------------

async function findText(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const query = args.query
  const pattern = args.pattern
  if ((query === undefined) === (pattern === undefined)) throw new ToolError('invalid_args', 'Give either query or pattern.')
  if (query !== undefined && (typeof query !== 'string' || !query.trim())) throw new ToolError('invalid_args', 'query must be some text')
  if (pattern !== undefined && !PATTERNS.some((p) => p.id === pattern))
    throw new ToolError('invalid_args', `pattern must be one of ${PATTERNS.map((p) => p.id).join(', ')}`)
  const opts = { matchCase: boolArg(args.match_case, 'match_case', false), wholeWords: boolArg(args.whole_words, 'whole_words', false) }
  const max = intArg(args.max_results, 'max_results', 200, 1, 2000)
  const pages = parsePages(args.pages, doc.pageCount)
  const hits: HitOut[] = []
  let stoppedAt: number | null = null
  for (let k = 0; k < pages.length && stoppedAt === null; k++) {
    throwIfAborted(ctx)
    const t = await doc.pageText(pages[k])
    const found: SearchHit[] = typeof query === 'string' ? searchPage(t, query, opts) : searchPattern(t, pattern as PatternId)
    for (const h of found) {
      if (hits.length >= max) {
        stoppedAt = pages[k]
        break
      }
      hits.push(hitOut(t, h))
    }
    pageProgress(ctx, k + 1, pages.length, 'Searching')
  }
  return {
    data: {
      count: hits.length,
      hits,
      ...(stoppedAt !== null
        ? { truncated: true, nextPage: stoppedAt + 1, note: `Stopped at max_results. More matches from page ${stoppedAt + 1} on.` }
        : {})
    }
  }
}

// ---- list_annotations ---------------------------------------------------------------------------

async function listAnnotations(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const pages = parsePages(args.pages, doc.pageCount)
  if (args.types !== undefined && (!Array.isArray(args.types) || args.types.some((t) => typeof t !== 'string')))
    throw new ToolError('invalid_args', 'types must be a list of annotation types such as ["Text", "Highlight"]')
  const types = (args.types as string[] | undefined) ?? null
  const list = []
  const marked = new Map<number, string>()
  for (let k = 0; k < pages.length; k++) {
    throwIfAborted(ctx)
    const onPage = await annots(doc).list(pages[k])
    list.push(...onPage)
    const markup = onPage.filter((a) => TEXT_MARKUP.has(a.type) && a.quads.length)
    if (markup.length) {
      const t = await doc.pageText(pages[k])
      for (const a of markup) marked.set(a.id, textUnderQuads(t, a.quads))
    }
    pageProgress(ctx, k + 1, pages.length, 'Reading comments')
  }
  const items = annotationsOut(list, { types, marked })
  return { data: { count: items.length, annotations: items } }
}

// ---- list_form_fields, list_signatures ------------------------------------------------------------

async function listFormFields(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const pages = args.pages === undefined ? null : new Set(parsePages(args.pages, doc.pageCount))
  const info = doc.state.info
  if (!info.hasForm) return { data: { count: 0, fields: [], note: 'This document has no form fields.' } }
  const fields = fieldsOut(await forms(doc).listAll(), pages)
  return { data: { count: fields.length, fields, ...(info.hasXfa ? { note: 'This form also has an XFA (dynamic) version, which Fartcrobat does not show.' } : {}) } }
}

async function listSignatures(args: Record<string, unknown>, ctx: ToolContext) {
  const doc = docFor(ctx, args.handle)
  const info = doc.state.info
  if (!info.signatureCount && !info.hasForm) return { data: { signatures: [], unsignedFields: [] } }
  // The validation the Signatures panel shows, kept fresh for the document on screen only.
  const cached = useApp.getState().activeDocId === doc.id ? useSigStore.getState().byDoc[doc.id] : undefined
  const report = cached?.report && !cached.running ? cached.report : await validateDocument(doc)
  if (!report) {
    const error = useSigStore.getState().byDoc[doc.id]?.error
    throw new ToolError('failed', `The signatures could not be validated${error ? `: ${error}` : '.'}`)
  }
  return { data: signaturesOut(report, trustedSet()) }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  list_documents: listDocuments,
  get_context: getContext,
  get_document_info: getDocumentInfo,
  get_page_text: getPageText,
  render_page: renderPage,
  find_text: findText,
  list_annotations: listAnnotations,
  list_form_fields: listFormFields,
  list_signatures: listSignatures
}
