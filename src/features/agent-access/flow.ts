/** Design-preserving linked text regions. Claude chooses reading order from layout + page renders. */
import { EngineError } from '@engine/define'
import { openPlainSessionCopy } from '@engine/crypt'
import { graftPages } from '@engine/ops/pages'
import type { Session } from '@engine/session'
import type { Rect } from '@shared/geometry'
import { extractPageContent } from '@features/export-create/extract'
import editText, { createTextComposer } from '@features/edit-text/engine'
import { runsInRange, runsText, type TextEdit } from '@features/edit-text/model'
import { planTextChange, validateTextChanges, type TextChange } from './textEdits'

export interface FlowParagraph extends TextChange {
  space_after?: number
  keep_with_next?: boolean
}
export interface FlowRegion {
  page: number
  rect: Rect
}
export interface FlowSpec {
  regions: FlowRegion[]
  paragraphs: FlowParagraph[]
  continuation?: { template_page: number; rects: Rect[] }
}
export interface FlowResult {
  pages: number[]
  addedPages: number
  placements: { paragraph: number; page: number; rect: Rect }[]
  warnings: string[]
}
const fail = (m: string): never => {
  throw new EngineError(m, 'BAD_FLOW')
}
const area = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))

export function flowText(s: Session, spec: FlowSpec): FlowResult {
  if (
    !spec ||
    !Array.isArray(spec.paragraphs) ||
    !spec.paragraphs.length ||
    spec.paragraphs.length > 100 ||
    !Array.isArray(spec.regions) ||
    !spec.regions.length ||
    spec.regions.length > 40
  )
    fail('Give 1–100 paragraphs and 1–40 text regions in reading order.')
  if (s.pageCount() > 30) fail('Design-preserving flow currently supports documents up to 30 pages.')
  const allBlocks = new Map(Array.from({ length: s.pageCount() }, (_, p) => [p, editText.ops.analyze(s, p)]))
  const warnings = new Set<string>()
  const content = new Map<number, ReturnType<typeof extractPageContent>>()
  const seen = new Set<string>()
  let chars = 0
  const prepared = spec.paragraphs.map((c) => {
    if (
      !c ||
      !Number.isInteger(c.page) ||
      !allBlocks.has(c.page) ||
      typeof c.block_id !== 'string' ||
      typeof c.original_text !== 'string' ||
      typeof c.text !== 'string'
    )
      fail('Each flow paragraph needs a source page, block_id, exact original_text and replacement text.')
    if (c.rect !== undefined) fail('Set flow regions, not paragraph rects.')
    validateTextChanges([c], s.pageCount())
    if (!content.has(c.page)) content.set(c.page, extractPageContent(s, c.page, { images: true }))
    if (content.get(c.page)?.erase?.length)
      fail(
        'This source is a scanned page with an OCR text layer. Moving its hidden text would leave the old scanned text visible; use a rebuilt layout or edit the scan explicitly.'
      )
    const key = c.page + ':' + c.block_id
    if (seen.has(key)) fail('Each source text block may belong to a flow only once.')
    seen.add(key)
    chars += c.text.length
    if (chars > 90000 || c.text.length > 20000)
      fail('Flow text is limited to 90000 characters, 20000 per paragraph.')
    if (
      c.space_after !== undefined &&
      (!Number.isFinite(c.space_after) || c.space_after < 0 || c.space_after > 100)
    )
      fail('space_after must be from 0 to 100 points.')
    if (c.keep_with_next !== undefined && typeof c.keep_with_next !== 'boolean')
      fail('keep_with_next must be true or false.')
    const p = planTextChange(c, allBlocks.get(c.page)!)
    if (Math.abs(p.edit.frame.dir[1]) > 0.01 || p.edit.frame.dir[0] < 0.99)
      fail('Rotated or right-to-left text needs direct editing rather than a flow.')
    return { change: c, plan: p, composer: createTextComposer(s, c.page, p.edit.runs) }
  })
  const checkRect = (r: Rect, p: number) => {
    const b = s.pageBounds(p)
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      r.some((v) => !Number.isFinite(v)) ||
      r[2] - r[0] < 20 ||
      r[3] - r[1] < 20 ||
      r[0] < b[0] ||
      r[1] < b[1] ||
      r[2] > b[2] ||
      r[3] > b[3]
    )
      fail('Every region must be at least 20 by 20 points and inside its page.')
    if (!content.has(p)) content.set(p, extractPageContent(s, p, { images: true }))
    const c = content.get(p)!
    if (
      c.images.some((i) => area(r, [i.x0, i.y0, i.x1, i.y1]) > 4) ||
      c.drawings.some((i) => i.art && area(r, [i.x0, i.y0, i.x1, i.y1]) > 4)
    )
      warnings.add(
        'A text region intersects retained artwork. Review the page preview for intentional backgrounds versus obstructed images.'
      )
    if (c.links.length || c.comments.length)
      warnings.add(
        'Links and comment anchors retain their original positions. Check them when moving associated text.'
      )
    for (const block of allBlocks.get(p)!)
      if (!seen.has(p + ':' + block.id) && area(r, block.bbox) > 4)
        fail('A flow region overlaps text outside the flow. Include that block or adjust the region.')
  }
  const regions = spec.regions.map((r) => {
    if (!r || !Number.isInteger(r.page) || !allBlocks.has(r.page))
      return fail('A region names a page that does not exist.')
    checkRect(r.rect, r.page)
    return { page: r.page, rect: [...r.rect] as Rect }
  })
  for (let i = 0; i < regions.length; i++)
    for (let j = 0; j < i; j++)
      if (regions[i].page === regions[j].page && area(regions[i].rect, regions[j].rect) > 1)
        fail('Flow regions must not overlap.')
  const cont = spec.continuation
  if (cont) {
    if (!s.pdf.hasPermission('assemble'))
      fail('The document security settings do not allow appending continuation pages.')
    if (
      !Number.isInteger(cont.template_page) ||
      !allBlocks.has(cont.template_page) ||
      !Array.isArray(cont.rects) ||
      !cont.rects.length ||
      cont.rects.length > 4
    )
      fail('A continuation needs an existing template_page and 1–4 column rects.')
    for (const r of cont.rects) checkRect(r, cont.template_page)
    for (let i = 0; i < cont.rects.length; i++)
      for (let j = 0; j < i; j++)
        if (area(cont.rects[i], cont.rects[j]) > 1) fail('Continuation columns must not overlap.')
    if (s.page(cont.template_page).getAnnotations().length || s.page(cont.template_page).getWidgets().length)
      fail(
        'A continuation template with comments or form widgets is not supported. Choose a clean design page.'
      )
  }
  const template = cont ? openPlainSessionCopy(s, 'garbage=yes') : null
  try {
    // Remove exactly the managed text; artwork, lines, images and all other blocks stay in place.
    for (const p of [...prepared].sort(
      (a, b) => a.plan.page - b.plan.page || b.plan.block!.start - a.plan.block!.start
    ))
      editText.ops.commit(s, p.plan.page, {
        ...p.plan.edit,
        runs: p.plan.edit.runs.map((r) => ({ ...r, text: '' }))
      })
    const placements: FlowResult['placements'] = []
    const pages = new Set<number>(prepared.map((p) => p.plan.page))
    let addedPages = 0
    let ri = 0
    let y = regions[0].rect[1]
    const next = () => {
      ri++
      if (ri >= regions.length) {
        if (!cont || !template)
          throw new EngineError(
            'The text does not fit the supplied regions. Supply continuation pages or shorten it; nothing is shrunk automatically.',
            'BAD_FLOW'
          )
        if (addedPages >= 10 || s.pageCount() >= 30)
          fail('A flow can append at most 10 pages, with 30 pages total.')
        const page = s.pageCount()
        graftPages(s.pdf, template, [cont.template_page], -1)
        s.structureChanged()
        // Remove the managed source text from this repeated template, keeping its design.
        for (const p of prepared
          .filter((p) => p.plan.page === cont.template_page)
          .sort((a, b) => b.plan.block!.start - a.plan.block!.start))
          editText.ops.commit(s, page, {
            ...p.plan.edit,
            runs: p.plan.edit.runs.map((r) => ({ ...r, text: '' }))
          })
        for (const rect of cont.rects) regions.push({ page, rect: [...rect] as Rect })
        addedPages++
        warnings.add(
          'Continuation pages repeat the template artwork and unmanaged text. Check static page numbers and repeated labels.'
        )
      }
      y = regions[ri].rect[1]
    }
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]
      let remaining = p.plan.edit.runs
      if (!runsText(remaining).trim()) continue
      while (runsText(remaining).trim()) {
        const region = regions[ri]
        const edit: TextEdit = {
          ...p.plan.edit,
          source: null,
          runs: remaining,
          frame: { origin: [region.rect[0], y], dir: [1, 0], width: region.rect[2] - region.rect[0] },
          wrap: true
        }
        const layout = p.composer.layout(edit)
        if (layout.unsupported.length)
          fail('Some characters cannot be drawn: ' + layout.unsupported.join(' '))
        if (layout.fallbackFonts.length) warnings.add('Font substitution: ' + layout.fallbackFonts.join(', '))
        const available = region.rect[3] - y
        const maxSize = Math.max(...remaining.map((r) => r.size))
        // Keep a heading with at least two lines of the following paragraph where possible.
        const following = prepared[i + 1]
        const reserve =
          p.change.keep_with_next && following
            ? Math.max(...following.plan.edit.runs.map((r) => r.size)) * 2.6
            : 0
        if (reserve && layout.height + reserve > available && y > region.rect[1] + 1) {
          next()
          continue
        }
        let count = layout.lines.findIndex((l) => l.v + l.size * 0.3 > available + 0.01)
        if (count < 0) count = layout.lines.length
        if (count === 0 || (count === 1 && layout.lines.length > 1 && y > region.rect[1] + 1)) {
          next()
          continue
        }
        // Avoid a single orphan line at the top of the next column/page.
        if (layout.lines.length - count === 1 && count > 2) count--
        const end = count === layout.lines.length ? runsText(remaining).length : layout.lineEnds[count - 1]
        if (!end) fail('Could not find a safe line boundary for this paragraph.')
        const part = runsInRange(remaining, 0, end)
        const result = p.composer.draw(region.page, { ...edit, runs: part })
        if (result.unsupported.length) fail('Some replacement characters cannot be drawn.')
        if (result.fallbackFonts.length) warnings.add('Font substitution: ' + result.fallbackFonts.join(', '))
        if (
          result.bbox &&
          (result.bbox[0] < region.rect[0] - 1 ||
            result.bbox[2] > region.rect[2] + 1 ||
            result.bbox[3] > region.rect[3] + 1)
        )
          fail('The measured text does not fit its region. Adjust the region or font.')
        if (result.bbox) placements.push({ paragraph: i, page: region.page + 1, rect: result.bbox })
        pages.add(region.page)
        if (end >= runsText(remaining).length) {
          y = (result.bbox?.[3] ?? y + maxSize) + (p.change.space_after ?? Math.max(3, maxSize * 0.5))
          break
        }
        remaining = runsInRange(remaining, end, runsText(remaining).length)
        // Remove only wrapping whitespace, preserving all non-whitespace characters and styles.
        while (remaining.length && remaining[0].text && /^\s/.test(remaining[0].text))
          remaining[0] = { ...remaining[0], text: remaining[0].text.slice(1) }
        next()
      }
    }
    return {
      pages: [...pages].sort((a, b) => a - b).map((p) => p + 1),
      addedPages,
      placements,
      warnings: [...warnings]
    }
  } finally {
    template?.destroy()
  }
}
