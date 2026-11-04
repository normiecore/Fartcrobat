/** Rebuild a text document with real automatic pagination; never execute supplied HTML. */
import type { Session, PDFDocument } from '@engine/session'
import { graftPages, deletePage } from '@engine/ops/pages'
import { EngineError } from '@engine/define'
import { countSignatures } from '@engine/util/pdf'
import { reflowHtml, type ReflowSpec } from './reflow'

export function requireReflow(s: Session) {
  if (countSignatures(s.pdf))
    throw new EngineError(
      'This document has digital signatures. Reflowing replaces its pages; use an unsigned working copy.',
      'BAD_REFLOW'
    )
  if (!s.pdf.hasPermission('assemble'))
    throw new EngineError('The document security settings do not allow replacing its pages.', 'PERMISSION')
}

export function buildReflow(s: Session, spec: ReflowSpec): PDFDocument {
  const html = reflowHtml(spec)
  const input = s.mupdf.Document.openDocument(new TextEncoder().encode(html), 'text/html')
  const buffer = new s.mupdf.Buffer()
  let writer: InstanceType<Session['mupdf']['DocumentWriter']> | null = null
  try {
    const [w, h] = spec.page_size === 'Letter' ? [612, 792] : [595.28, 841.89]
    input.layout(w, h, spec.font_size ?? 11)
    const count = input.countPages()
    if (count < 1 || count > 20)
      throw new EngineError(
        'The rewritten document must fit from 1 to 20 pages. Shorten the content or split it into documents.',
        'BAD_REFLOW'
      )
    writer = new s.mupdf.DocumentWriter(buffer, 'pdf', '')
    for (let i = 0; i < count; i++) {
      const page = input.loadPage(i)
      try {
        const dev = writer.beginPage(page.getBounds())
        page.run(dev, s.mupdf.Matrix.identity)
        writer.endPage()
      } finally {
        page.destroy()
      }
    }
    writer.close()
    writer = null
    // New PDF generated in memory; no original PDF bytes, passwords or keys leave the worker.
    return new s.mupdf.PDFDocument(buffer.asUint8Array().slice())
  } finally {
    try {
      writer?.close()
    } catch {
      /* conversion failed */
    }
    buffer.destroy()
    input.destroy()
  }
}

export function installReflow(s: Session, replacement: PDFDocument, title: string) {
  const oldCount = s.pageCount()
  graftPages(
    s.pdf,
    replacement,
    Array.from({ length: replacement.countPages() }, (_, i) => i),
    -1
  )
  for (let i = oldCount - 1; i >= 0; i--) deletePage(s.pdf, i)
  const root = s.pdf.getTrailer().get('Root')
  for (const key of ['Outlines', 'PageLabels', 'StructTreeRoot', 'OpenAction']) root.delete(key)
  s.pdf.setMetaData('info:Title', title)
  s.structureChanged()
  s.documentChanged()
}
