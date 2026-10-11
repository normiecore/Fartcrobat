import type { Point, Rect } from '@shared/geometry'
import { authorName, setTool, showError, useApp, type DocumentModel } from '@renderer/sdk'
import type { StampDef } from './stampCatalog'
import { dynamicContents, dataUrlToBytes, drawStamp } from './stampRender'
import { customById, selectStamp } from './stampStore'

type StampOps = typeof import('./engine').default

/** Pixels per point used for stamps drawn with a canvas (sharp up to ~600% zoom). */
const PLACE_PX_PER_PT = 6

/** Default rectangle for a click: the stamp's default size centred on the point, kept on the page. */
export function clickRect(def: StampDef, p: Point, pageW: number, pageH: number): Rect {
  let w = def.width
  let h = w / def.aspect
  const fit = Math.min(1, (pageW * 0.9) / w, (pageH * 0.9) / h)
  w *= fit
  h *= fit
  let x = p[0] - w / 2
  let y = p[1] - h / 2
  x = Math.max(0, Math.min(pageW - w, x))
  y = Math.max(0, Math.min(pageH - h, y))
  return [x, y, x + w, y + h]
}

/** Rectangle for a drag from a to b keeping the stamp's proportions (anchored at a). */
export function dragRect(def: StampDef, a: Point, b: Point, pageW: number, pageH: number): Rect {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let w = Math.max(Math.abs(dx), Math.abs(dy) * def.aspect)
  // keep it on the page
  const maxW = dx >= 0 ? pageW - a[0] : a[0]
  const maxH = dy >= 0 ? pageH - a[1] : a[1]
  w = Math.max(4, Math.min(w, maxW, maxH * def.aspect))
  const h = w / def.aspect
  const x0 = dx >= 0 ? a[0] : a[0] - w
  const y0 = dy >= 0 ? a[1] : a[1] - h
  return [x0, y0, x0 + w, y0 + h]
}

/**
 * Places a stamp on a page. Selects it afterwards and, unless "Keep tool selected" is on, returns
 * to the Select tool (like Acrobat).
 */
export async function placeStamp(doc: DocumentModel, pageIndex: number, def: StampDef, rect: Rect): Promise<number | null> {
  try {
    const author = authorName()
    const now = new Date()
    let image: Uint8Array | undefined
    let contents: string | undefined
    if (def.shape === 'image') {
      const c = customById(def.id)
      if (!c) throw new Error('This custom stamp no longer exists')
      image = dataUrlToBytes(c.dataUrl)
    } else if (def.shape !== 'builtin') {
      image = (await drawStamp(def, { author, date: now, pxPerPt: PLACE_PX_PER_PT })).png
      if (def.shape === 'dynamic') contents = dynamicContents(def, author, now)
    }
    const info = await doc.ops<StampOps>('stamps-measure').addStamp(pageIndex, {
      rect,
      name: def.name,
      label: def.label,
      color: def.shape === 'image' ? undefined : def.color,
      image,
      contents,
      extra: { stamp: def.id, category: def.category }
    })
    selectStamp(def.id)
    if (!useApp.getState().prefs.keepToolSelected) setTool('select')
    doc.setSelection({ kind: 'annotations', page: pageIndex, ids: [info.id] })
    return info.id
  } catch (err) {
    showError(err, 'Could not add the stamp')
    return null
  }
}
