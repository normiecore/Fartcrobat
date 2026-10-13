import type { Rect } from '@shared/geometry'
import { authorName, setTool, showError, useApp, type DocumentModel } from '@renderer/sdk'
import type { StampDef } from './stampCatalog'
import { dynamicContents, dataUrlToBytes, drawStamp } from './stampRender'
import { customById, selectStamp } from './stampStore'

type StampOps = typeof import('./engine').default

/** Pixels per point used for stamps drawn with a canvas (sharp up to ~600% zoom). */
const PLACE_PX_PER_PT = 6

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
