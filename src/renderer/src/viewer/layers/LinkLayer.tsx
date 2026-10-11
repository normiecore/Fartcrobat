import { useEffect, useState } from 'react'
import type { LinkInfo } from '@engine/ops/nav'
import { usePageVersion, type DocumentModel } from '../../document/DocumentModel'
import { invoke } from '../../platform'
import { ask } from '../../ui/dialogs'
import type { PageGeometry } from '../geometry'

const trusted = new Set<string>()

export async function followExternalLink(uri: string) {
  let host = uri
  try {
    host = new URL(uri).host || uri
  } catch {}
  if (!trusted.has(host)) {
    const r = await ask({
      title: 'Open link?',
      message: (
        <>
          This document is trying to open <b>{uri}</b> in your web browser. Only continue if you trust the document.
        </>
      ),
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'always', label: 'Always allow this site', variant: 'quiet' },
        { id: 'open', label: 'Open', variant: 'primary' }
      ]
    })
    if (r === 'cancel' || r === null) return
    if (r === 'always') trusted.add(host)
  }
  await invoke('shell:openExternal', uri)
}

export function LinkLayer({ doc, pageIndex, geometry }: { doc: DocumentModel; pageIndex: number; geometry: PageGeometry }) {
  const version = usePageVersion(doc, pageIndex)
  const [links, setLinks] = useState<LinkInfo[]>([])
  useEffect(() => {
    let alive = true
    doc.core.nav
      .links(pageIndex)
      .then((l) => alive && setLinks(l))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])
  if (!links.length) return null
  return (
    <div className="viewer-layer viewer-link-layer">
      {links.map((l) => {
        const c = geometry.rectToCss(l.rect)
        return (
          <div
            key={l.index}
            className="viewer-link"
            title={l.external ? l.uri : l.dest ? `Go to page ${l.dest.page + 1}` : l.uri}
            style={{ left: c.left, top: c.top, width: c.width, height: c.height }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              if (l.dest) doc.view?.goToPage(l.dest.page, { x: l.dest.x, y: l.dest.y })
              else if (l.external) void followExternalLink(l.uri)
            }}
          />
        )
      })}
    </div>
  )
}
