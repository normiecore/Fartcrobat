import { memo, useMemo } from 'react'
import type { DocumentModel } from '../document/DocumentModel'
import { registry } from '../app/registry'
import { useApp } from '../app/store'
import { PageGeometry, type CssRect } from './geometry'
import { PageCanvas } from './PageCanvas'
import { TextSelectionLayer } from './layers/TextSelectionLayer'
import { SearchLayer } from './layers/SearchLayer'
import { LinkLayer } from './layers/LinkLayer'
import { useHiddenAnnotations } from './hiddenAnnotations'

export const PageView = memo(function PageView({
  doc,
  pageIndex,
  width,
  height,
  zoom,
  rotation,
  left,
  top,
  priority,
  visibleRect
}: {
  doc: DocumentModel
  pageIndex: number
  width: number
  height: number
  zoom: number
  rotation: 0 | 90 | 180 | 270
  left: number
  top: number
  priority: number
  visibleRect: CssRect | null
}) {
  const geometry = useMemo(
    () => new PageGeometry(pageIndex, width, height, zoom, rotation),
    [pageIndex, width, height, zoom, rotation]
  )
  const toolId = useApp((s) => (s.spaceHand ? 'hand' : s.toolId))
  const tool = registry.tools.get(toolId)
  const defaults = !tool?.layer || !!tool.allowDefaultInteractions
  const hidden = useHiddenAnnotations(doc, pageIndex)
  const ToolLayer = tool?.layer
  return (
    <div
      className="viewer-page"
      data-page-index={pageIndex}
      style={{ left, top, width: geometry.cssWidth, height: geometry.cssHeight, cursor: tool?.cursor }}
    >
      <PageCanvas
        doc={doc}
        pageIndex={pageIndex}
        geometry={geometry}
        priority={priority}
        visibleRect={visibleRect}
        hidden={hidden}
      />
      <TextSelectionLayer doc={doc} pageIndex={pageIndex} geometry={geometry} interactive={defaults} />
      <SearchLayer doc={doc} pageIndex={pageIndex} geometry={geometry} />
      {defaults && <LinkLayer doc={doc} pageIndex={pageIndex} geometry={geometry} />}
      {registry.pageLayers
        .filter((l) => !l.when || l.when({ toolId, doc }))
        .map((L) => (
          <L.component key={L.id} doc={doc} pageIndex={pageIndex} geometry={geometry} />
        ))}
      {ToolLayer && <ToolLayer doc={doc} pageIndex={pageIndex} geometry={geometry} />}
    </div>
  )
})
