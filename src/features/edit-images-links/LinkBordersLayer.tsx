import { useEffect, useState } from 'react'
import {
  ask,
  dirname,
  invoke,
  joinPath,
  openPaths,
  platform,
  registry,
  showError,
  useApp,
  usePageVersion,
  type DocumentModel,
  type PageLayerProps
} from '@renderer/sdk'
import type { LinkItem } from './engine'
import { ops } from './common'
import { fileSpecToPath, isAbsolutePath } from './filespec'

const trusted = new Set<string>()

/** Opens the file a link points to (PDFs open in a new tab), after asking once per file. */
export async function openFileLink(doc: DocumentModel, spec: string) {
  const native = fileSpecToPath(spec, platform === 'win32')
  let path = native
  if (!isAbsolutePath(native)) {
    const base = doc.state.filePath
    if (!base) {
      showError(new Error('Save this document first: the link uses a path relative to its folder.'), 'Could not open the file')
      return
    }
    path = joinPath(dirname(base), native)
  }
  try {
    if (!(await invoke('file:exists', path))) {
      showError(new Error(`${path} does not exist`), 'Could not open the file')
      return
    }
  } catch {}
  const isPdf = /\.pdf$/i.test(path)
  if (!trusted.has(path)) {
    const r = await ask({
      title: 'Open file?',
      message: (
        <>
          This document wants to open <b>{path}</b>
          {isPdf ? '.' : ' with its default app.'} Only continue if you trust the document and the file.
        </>
      ),
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'open', label: 'Open', variant: 'primary' }
      ]
    })
    if (r !== 'open') return
    trusted.add(path)
  }
  if (isPdf) {
    await openPaths([path])
    return
  }
  try {
    const err = await invoke('shell:openPath', path)
    if (err) showError(new Error(err), 'Could not open the file')
  } catch (err) {
    showError(err, 'Could not open the file')
  }
}

/**
 * Draws the rectangles of links that have a visible border (MuPDF does not render link
 * annotations) and makes links to files open them safely.
 */
export function LinkBordersLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const version = usePageVersion(doc, pageIndex)
  const toolId = useApp((s) => (s.spaceHand ? 'hand' : s.toolId))
  const [links, setLinks] = useState<LinkItem[]>([])
  useEffect(() => {
    let alive = true
    ops(doc)
      .links(pageIndex)
      .then((l) => alive && setLinks(l.filter((x) => x.appearance.visible || x.action.type === 'file')))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])
  if (!links.length) return null
  const tool = registry.tools.get(toolId)
  const interactive = !tool?.layer || !!tool.allowDefaultInteractions
  return (
    <div className="viewer-layer fc-edit-images-links-borders">
      {links.map((l) => {
        const c = geometry.rectToCss(l.rect)
        const ap = l.appearance
        const w = Math.max(1, ap.width * geometry.scale)
        const border = ap.visible ? `${w}px ${ap.style === 'dashed' ? 'dashed' : 'solid'} ${ap.color}` : undefined
        return (
          <div
            key={l.id}
            className={`fc-edit-images-links-border ${interactive && l.action.type === 'file' ? 'is-clickable' : ''}`}
            title={l.action.type === 'file' ? l.target : undefined}
            style={{
              left: c.left,
              top: c.top,
              width: c.width,
              height: c.height,
              ...(ap.style === 'underline' ? { borderBottom: border } : { border })
            }}
            onPointerDown={(e) => interactive && l.action.type === 'file' && e.stopPropagation()}
            onClick={(e) => {
              if (!interactive || l.action.type !== 'file') return
              e.stopPropagation()
              void openFileLink(doc, l.action.path)
            }}
          />
        )
      })}
    </div>
  )
}
