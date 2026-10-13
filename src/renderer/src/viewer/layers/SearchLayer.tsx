import { useEffect, useState } from 'react'
import { useDocState, usePageVersion, type DocumentModel } from '../../document/DocumentModel'
import { rangeRects, type PageText } from '../../document/textModel'
import type { PageGeometry } from '../geometry'
import { tryLoadText } from './textSync'

export function SearchLayer({ doc, pageIndex, geometry }: { doc: DocumentModel; pageIndex: number; geometry: PageGeometry }) {
  const search = useDocState(doc, (s) => s.search)
  const version = usePageVersion(doc, pageIndex)
  const [text, setText] = useState<PageText | null>(null)
  const hits = search.hits.map((h, i) => ({ h, i })).filter(({ h }) => h.page === pageIndex)
  const has = hits.length > 0
  useEffect(() => {
    if (!has) return
    let alive = true
    void tryLoadText(doc, pageIndex).then((t) => alive && t && setText(t))
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version, has])
  if (!has || !text) return null
  return (
    <div className="viewer-layer viewer-search-layer">
      {hits.flatMap(({ h, i }) =>
        rangeRects(text, h.start, h.end).map((r, k) => {
          const c = geometry.rectToCss(r)
          return (
            <div
              key={`${i}-${k}`}
              className={`viewer-search-hit ${i === search.active ? 'is-active' : ''}`}
              style={{ left: c.left - 1, top: c.top - 1, width: c.width + 2, height: c.height + 2 }}
            />
          )
        })
      )}
    </div>
  )
}
