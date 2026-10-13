/**
 * Engine operations of Export a PDF and Create a PDF (namespace 'export-create'). Export reads
 * pages one call at a time so the UI can show progress and cancel between pages; Create builds a
 * new PDF in a throwaway engine (no document needs to be open).
 */
import { defineOps, EngineError, withTransfer } from '@engine/define'
import { graftPages, openSource } from '@engine/ops/pages'
import type { PDFDocument, Session } from '@engine/session'
import type { PageRaster } from './content'
import { encodeAuto, extractPageContent, pageText, renderArea, type ExtractOptions } from './extract'
import { DEFAULT_IMAGE_PAGE_OPTIONS, IMAGE_EXTENSIONS, extensionOf, fitImagePage, type CreatePart, type ImagePageOptions } from './shared'

type Rect = [number, number, number, number]

function takeBuffer(buf: InstanceType<Session['mupdf']['Buffer']>): Uint8Array {
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

/** Friendlier message for pages too large to render at the chosen resolution. */
function renderError(err: unknown, pageIndex: number, dpi: number): Error {
  const msg = String((err as Error)?.message ?? err)
  if (/too large/i.test(msg)) {
    return new EngineError(`Page ${pageIndex + 1} is too large to export at ${dpi} dpi. Choose a lower resolution.`, 'TOO_LARGE')
  }
  return err instanceof Error ? err : new Error(msg)
}

/** The HTML MuPDF writes for one page: its positioned <div>, with every text line and image. */
function pageHtml(s: Session, pageIndex: number, images: boolean): string {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const buf = new m.Buffer()
  try {
    const writer = new m.DocumentWriter(buf, 'html', images ? 'preserve-images' : '')
    const dev = writer.beginPage(page.getBounds())
    page.run(dev, m.Matrix.identity)
    writer.endPage()
    writer.close()
    const html = new TextDecoder().decode(buf.asUint8Array())
    const start = html.indexOf('<body>')
    const end = html.lastIndexOf('</body>')
    const body = start >= 0 && end > start ? html.slice(start + 6, end) : html
    return body.trim().replace(/^<div id="page\d+"/, `<div id="page${pageIndex + 1}" class="page"`)
  } finally {
    buf.destroy()
  }
}

/** Writes the pages of an image (or any non-PDF MuPDF opens) into a PDF, sized as asked. */
function imageToPdf(s: Session, data: Uint8Array, name: string, opts: ImagePageOptions): PDFDocument {
  const m = s.mupdf
  let src: InstanceType<typeof m.Document>
  try {
    src = m.Document.openDocument(data, name)
  } catch (err) {
    throw new EngineError(`${name} could not be read as an image: ${(err as Error).message}`, 'OPEN_FAILED')
  }
  const buf = new m.Buffer()
  try {
    const writer = new m.DocumentWriter(buf, 'pdf', '')
    const n = src.countPages()
    for (let i = 0; i < n; i++) {
      const page = src.loadPage(i)
      try {
        const b = page.getBounds() as Rect
        const fit = fitImagePage(b[2] - b[0], b[3] - b[1], opts)
        const dev = writer.beginPage([0, 0, fit.pageWidth, fit.pageHeight])
        page.run(dev, [fit.scale, 0, 0, fit.scale, fit.x - b[0] * fit.scale, fit.y - b[1] * fit.scale])
        writer.endPage()
      } finally {
        page.destroy()
      }
    }
    writer.close()
    return new m.PDFDocument(takeBuffer(buf))
  } catch (err) {
    try {
      buf.destroy()
    } catch {}
    throw err
  } finally {
    src.destroy()
  }
}

function isPdf(data: Uint8Array, name: string): boolean {
  if (extensionOf(name) === 'pdf') return true
  const head = new TextDecoder().decode(data.subarray(0, Math.min(1024, data.length)))
  return head.includes('%PDF-')
}

export default defineOps('export-create', {
  /** Structured content of a page (styled text, images, rules, links) for Word, Excel, PowerPoint and HTML. */
  content(s, pageIndex: number, opts: ExtractOptions = {}) {
    const content = extractPageContent(s, pageIndex, opts)
    return withTransfer(
      content,
      content.images.map((i) => i.data.buffer as ArrayBuffer)
    )
  },

  /** The page as a PNG or JPEG image, with comments and form fields, at `dpi`. */
  image(s, pageIndex: number, opts: { dpi: number; format: 'png' | 'jpeg'; quality?: number; grayscale?: boolean }) {
    let pix
    try {
      pix = renderArea(s, pageIndex, opts.dpi, { grayscale: opts.grayscale })
    } catch (err) {
      throw renderError(err, pageIndex, opts.dpi)
    }
    try {
      pix.setResolution(opts.dpi, opts.dpi)
      const data = (opts.format === 'png' ? pix.asPNG() : pix.asJPEG(Math.max(1, Math.min(100, opts.quality ?? 85)))).slice()
      return withTransfer(data, [data.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /** Raw pixels of a page (for TIFF). */
  raster(s, pageIndex: number, opts: { dpi: number; grayscale?: boolean }) {
    let pix
    try {
      pix = renderArea(s, pageIndex, opts.dpi, { grayscale: opts.grayscale })
    } catch (err) {
      throw renderError(err, pageIndex, opts.dpi)
    }
    try {
      const w = pix.getWidth()
      const h = pix.getHeight()
      const n = pix.getNumberOfComponents() as 1 | 3
      const stride = pix.getStride()
      const src = pix.getPixels()
      const pixels = new Uint8Array(w * h * n)
      for (let y = 0; y < h; y++) pixels.set(src.subarray(y * stride, y * stride + w * n), y * w * n)
      const out: PageRaster = { width: w, height: h, channels: n, pixels }
      return withTransfer(out, [pixels.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /**
   * The page (or an area of it) as a picture, optionally without its text: the picture behind
   * editable text (PowerPoint, Word page layout) or a chart drawn with vectors. 'auto' picks PNG
   * for graphics and JPEG for photographs.
   */
  picture(
    s,
    pageIndex: number,
    opts: { dpi: number; text: boolean; clip?: [number, number, number, number]; format?: 'auto' | 'jpeg'; quality?: number }
  ) {
    let pix
    try {
      pix = renderArea(s, pageIndex, opts.dpi, { text: opts.text, clip: opts.clip })
    } catch (err) {
      throw renderError(err, pageIndex, opts.dpi)
    }
    try {
      const out =
        opts.format === 'jpeg'
          ? { data: pix.asJPEG(opts.quality ?? 85).slice(), mime: 'image/jpeg' as const }
          : encodeAuto(pix)
      const result = { ...out, width: pix.getWidth(), height: pix.getHeight() }
      return withTransfer(result, [result.data.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /** One page as positioned HTML (MuPDF's HTML output), images inlined as data URLs. */
  html(s, pageIndex: number, opts: { images: boolean }): string {
    return pageHtml(s, pageIndex, opts.images)
  },

  /** Plain text of a page, line by line (with filled-in form fields). */
  text(s, pageIndex: number): string {
    return pageText(s, pageIndex)
  },

  /**
   * Builds a new PDF from files (PDFs keep everything; images are placed on pages as asked; other
   * formats MuPDF reads are converted) and blank pages. Works without an open document.
   */
  build(s, parts: CreatePart[], opts: { image?: ImagePageOptions; title?: string } = {}) {
    const m = s.mupdf
    const out = new m.PDFDocument()
    try {
      const imageOpts = opts.image ?? DEFAULT_IMAGE_PAGE_OPTIONS
      parts.forEach((part, k) => {
        s.progress(k / parts.length, part.kind === 'file' ? `Adding ${part.name}` : 'Adding blank pages')
        if (part.kind === 'blank') {
          const count = Math.max(1, Math.min(500, Math.round(part.count)))
          for (let i = 0; i < count; i++) {
            const page = out.addPage([0, 0, part.width, part.height], 0, out.newDictionary(), '')
            out.insertPage(-1, page)
          }
          return
        }
        const ext = extensionOf(part.name)
        let src: PDFDocument
        if (!isPdf(part.data, part.name) && IMAGE_EXTENSIONS.includes(ext)) {
          src = imageToPdf(s, part.data, part.name, imageOpts)
        } else {
          try {
            src = openSource(s, part.data, part.name, part.password)
          } catch (err) {
            if ((err as EngineError).code === 'NEEDS_PASSWORD') {
              throw new EngineError(part.password ? `The password for ${part.name} is incorrect` : `${part.name} is password protected`, part.password ? 'WRONG_PASSWORD' : 'NEEDS_PASSWORD')
            }
            throw new EngineError(`${part.name} could not be converted: ${(err as Error).message}`, 'OPEN_FAILED')
          }
        }
        try {
          const n = src.countPages()
          if (!n) throw new EngineError(`${part.name} has no pages`, 'EMPTY')
          graftPages(
            out,
            src,
            Array.from({ length: n }, (_, i) => i),
            -1
          )
        } finally {
          src.destroy()
        }
      })
      if (!out.countPages()) throw new EngineError('Nothing to create: no pages were added', 'EMPTY')
      if (opts.title) out.setMetaData('info:Title', opts.title)
      out.setMetaData('info:Creator', 'Fartcrobat')
      s.progress(1, 'Finishing')
      const bytes = takeBuffer(out.saveToBuffer('garbage=compact,compress'))
      return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
    } finally {
      out.destroy()
    }
  }
})
