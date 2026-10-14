// mark_redactions: turns the agent's items into redaction marks. Pure, Node-testable.
import { rectToQuad } from '@shared/geometry'
import { DEFAULT_PROPS, type MarkSpec, type RedactionProps } from '@features/redact/shared'
import { InvalidArgs, isObject } from './act-common'
import { rectValue } from './act-annots'

/**
 * One mark per item: rects become a text mark (one quad per line), a rect an area mark, and a
 * page without either marks the whole page (as Mark Page Range does).
 */
export function markSpecsFromItems(items: unknown, pageCount: number, pageSize: (page: number) => { width: number; height: number }): MarkSpec[] {
  if (items === undefined || items === null) return []
  if (!Array.isArray(items)) throw new InvalidArgs('items must be a list of { page, rect } or { page, rects }')
  return items.map((item, i): MarkSpec => {
    const where = `items[${i}]`
    if (!isObject(item)) throw new InvalidArgs(`${where} must be an object with page`)
    const page = item.page
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount)
      throw new InvalidArgs(`${where}.page must be a page number from 1 to ${pageCount}`)
    const index = page - 1
    if (item.rects !== undefined) {
      if (!Array.isArray(item.rects) || !item.rects.length) throw new InvalidArgs(`${where}.rects must be a list of rects, one per line of text`)
      return { page: index, kind: 'text', quads: item.rects.map((r, k) => rectToQuad(rectValue(r, `${where}.rects[${k}]`))) }
    }
    if (item.rect !== undefined) {
      const rect = rectValue(item.rect, `${where}.rect`)
      if (rect[2] - rect[0] < 0.5 || rect[3] - rect[1] < 0.5) throw new InvalidArgs(`${where}.rect is too small`)
      return { page: index, kind: 'area', rect }
    }
    const size = pageSize(index)
    return { page: index, kind: 'page', rect: [0, 0, size.width, size.height] }
  })
}

/** Mark properties: the person's defaults, with overlay text printed on the boxes when given. */
export function markProps(defaults: RedactionProps = DEFAULT_PROPS, overlayText?: string): RedactionProps {
  const text = overlayText?.trim()
  return text ? { ...defaults, overlay: 'custom', customText: text } : defaults
}
