import type { Rect } from '@shared/geometry'
import { defineOps } from '../define'
import type { Session } from '../session'

export interface LinkDestination {
  page: number
  /** Target position in page space of the destination page, when the link specifies one. */
  x: number | null
  y: number | null
  zoom: number | null
  type: string
}

export interface LinkInfo {
  index: number
  rect: Rect
  uri: string
  external: boolean
  dest: LinkDestination | null
}

export interface OutlineNode {
  title: string
  uri: string | null
  open: boolean
  dest: LinkDestination | null
  children: OutlineNode[]
}

function resolveDest(s: Session, target: any): LinkDestination | null {
  try {
    const d = s.pdf.resolveLinkDestination(target)
    if (!d || d.page < 0) return null
    const valid = (v: number) => (Number.isFinite(v) && !Number.isNaN(v) ? v : null)
    return { page: d.page, x: valid(d.x), y: valid(d.y), zoom: valid(d.zoom) || null, type: d.type }
  } catch {
    try {
      const page = s.pdf.resolveLink(target)
      return page >= 0 ? { page, x: null, y: null, zoom: null, type: 'Fit' } : null
    } catch {
      return null
    }
  }
}

export default defineOps('nav', {
  links(s, pageIndex: number): LinkInfo[] {
    const page = s.page(pageIndex)
    return page.getLinks().map((link, index) => {
      const uri = link.getURI() ?? ''
      const external = link.isExternal()
      return {
        index,
        rect: link.getBounds() as Rect,
        uri,
        external,
        dest: external ? null : resolveDest(s, link)
      }
    })
  },

  outline(s): OutlineNode[] {
    const items = s.pdf.loadOutline()
    if (!items) return []
    const convert = (item: any): OutlineNode => ({
      title: item.title ?? '',
      uri: item.uri ?? null,
      open: !!item.open,
      dest: item.uri && !/^[a-z]+:\/\//i.test(item.uri) ? resolveDest(s, item.uri) : null,
      children: (item.down ?? []).map(convert)
    })
    return items.map(convert)
  },

  /** Resolves a named destination or internal URI (e.g. "#page=3"). */
  resolve(s, uri: string): LinkDestination | null {
    return resolveDest(s, uri)
  }
})
