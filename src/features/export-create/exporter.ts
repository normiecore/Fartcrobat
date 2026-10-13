/**
 * Runs an export: reads the pages one engine call at a time (progress, cancel between pages),
 * analyses the layout and builds the file. The document builders load on first use.
 * Works with a DocumentModel's engine in the app and with the in-process engine in tests.
 */
import type { ClientOps } from '@engine/define'
import type exportOps from './engine'
import type { PageContent, PageRaster } from './content'
import { analyzeDocument, pendingPictures, type DocLayout } from './layout'
import { FORMAT_INFO, IMAGE_EXT, pageImageName, type ExportOptions } from './shared'

export type ExportEngine = ClientOps<typeof exportOps>

export interface ExportJob {
  options: ExportOptions
  /** Zero-based page indices, in order. */
  pages: number[]
  /** Document title (metadata of the new file). */
  title: string
  /** Base name for files ("Report" -> Report.docx, Report_Page_1.png). */
  baseName: string
  lang?: string | null
  author?: string
  eol?: '\n' | '\r\n'
  onProgress?: (fraction: number, message: string) => void
  isCancelled?: () => boolean
}

export type ExportResult =
  | { kind: 'file'; data: Uint8Array; name: string; ext: string }
  | { kind: 'images'; files: { name: string; data: Uint8Array }[] }

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

/** Resolution of pictures rendered from the page (artwork, slide pictures, page backgrounds). */
const PICTURE_DPI = 150

function check(job: ExportJob) {
  if (job.isCancelled?.()) throw new ExportCancelled()
}

async function readContents(engine: ExportEngine, job: ExportJob, share: number, opts: { images: boolean }): Promise<PageContent[]> {
  const out: PageContent[] = []
  const n = job.pages.length
  for (let k = 0; k < n; k++) {
    check(job)
    job.onProgress?.((k / n) * share, `Reading page ${k + 1} of ${n}…`)
    out.push(await engine.content(job.pages[k], { images: opts.images }))
  }
  return out
}

/** Renders the vector artwork the layout turned into pictures. */
async function resolvePictures(engine: ExportEngine, layout: DocLayout, job: ExportJob, from: number, to: number) {
  const pending = pendingPictures(layout)
  for (let k = 0; k < pending.length; k++) {
    check(job)
    job.onProgress?.(from + ((to - from) * k) / pending.length, 'Converting drawings to pictures…')
    const img = pending[k]
    const r = img.render!
    const pic = await engine.picture(r.pageIndex, { dpi: PICTURE_DPI * 1.5, text: r.text, clip: r.clip })
    img.image = { ...img.image, data: pic.data, mime: pic.mime, width: pic.width, height: pic.height }
  }
}

/** Pictures of the pages without their text (behind editable text boxes). */
async function pageBackgrounds(engine: ExportEngine, layout: DocLayout, job: ExportJob, from: number, to: number, all: boolean) {
  const n = layout.pages.length
  for (let k = 0; k < n; k++) {
    check(job)
    const page = layout.pages[k]
    if (!all && !page.graphics) continue
    job.onProgress?.(from + ((to - from) * k) / n, `Drawing page ${k + 1} of ${n}…`)
    const pic = await engine.picture(page.index, { dpi: PICTURE_DPI, text: false, format: 'auto', skipLines: page.decorations, erase: page.erase })
    page.background = { x0: 0, y0: 0, x1: page.width, y1: page.height, block: -1, data: pic.data, mime: pic.mime, width: pic.width, height: pic.height }
  }
}

export async function runExport(engine: ExportEngine, job: ExportJob): Promise<ExportResult> {
  const o = job.options
  const meta = { title: job.title, author: job.author }
  const n = job.pages.length
  if (!n) throw new Error('There are no pages to export')
  const file = (data: Uint8Array, ext = FORMAT_INFO[o.format].ext): ExportResult => ({ kind: 'file', data, ext, name: `${job.baseName}.${ext}` })

  switch (o.format) {
    case 'word': {
      // Retain Page Layout puts the images in the picture of the page's graphics.
      const contents = await readContents(engine, job, 0.6, { images: o.word.images && o.word.layout === 'flowing' })
      const positioned = o.word.layout === 'page'
      const layout = analyzeDocument(contents, {
        structure: o.word.structure,
        tables: o.word.tables,
        images: o.word.images,
        pictures: o.word.images && !positioned,
        positioned
      })
      if (o.word.layout === 'page') {
        if (o.word.images) await pageBackgrounds(engine, layout, job, 0.6, 0.85, false)
      } else if (o.word.images) await resolvePictures(engine, layout, job, 0.6, 0.85)
      check(job)
      job.onProgress?.(0.9, 'Writing the Word document…')
      const { buildDocx } = await import('./builders/docx')
      return file(await buildDocx(layout, o.word, meta))
    }
    case 'excel': {
      const contents = await readContents(engine, job, 0.8, { images: false })
      const layout = analyzeDocument(contents, { structure: true, tables: true, images: false })
      check(job)
      job.onProgress?.(0.85, 'Writing the spreadsheet…')
      const { buildXlsx } = await import('./builders/xlsx')
      return file(await buildXlsx(layout, o.excel, meta))
    }
    case 'powerpoint': {
      const editable = o.powerpoint.mode === 'editable'
      const contents = editable ? await readContents(engine, job, 0.4, { images: false }) : job.pages.map((index) => emptyContent(index))
      const layout = analyzeDocument(contents, { structure: true, tables: true, images: false, positioned: true })
      const pictures = []
      for (let k = 0; k < n; k++) {
        check(job)
        job.onProgress?.(0.4 + (0.45 * k) / n, `Drawing slide ${k + 1} of ${n}…`)
        const pic = await engine.picture(job.pages[k], {
          dpi: editable ? PICTURE_DPI : 200,
          text: !editable,
          format: editable ? 'auto' : 'jpeg',
          quality: 88,
          skipLines: editable ? layout.pages[k].decorations : undefined,
          erase: editable ? layout.pages[k].erase : undefined
        })
        pictures.push({ data: pic.data, mime: pic.mime })
        if (!editable) {
          // Page sizes for the slides.
          const ratio = 72 / 200
          layout.pages[k].width = pic.width * ratio
          layout.pages[k].height = pic.height * ratio
        }
      }
      check(job)
      job.onProgress?.(0.9, 'Writing the presentation…')
      const { buildPptx } = await import('./builders/pptx')
      return file(await buildPptx(layout, o.powerpoint, meta, pictures))
    }
    case 'html': {
      const { buildPageHtml, buildFlowingHtml, positionedPageHtml } = await import('./builders/html')
      let html: string
      if (o.html.layout === 'page') {
        const pages = []
        for (let k = 0; k < n; k++) {
          check(job)
          job.onProgress?.((0.9 * k) / n, `Reading page ${k + 1} of ${n}…`)
          const index = job.pages[k]
          const content = await engine.content(index, { images: false })
          // A scan with recognized text: the text is written from the page's content, over the
          // picture of the scan without that text.
          const recognized = !!content.erase
          const graphics =
            o.html.images &&
            (recognized || content.images.length > 0 || content.rules.length > 0 || content.fills.length > 0 || content.drawings.length > 0)
          // With a picture of the graphics behind the text, the page's images are in that picture.
          const pageHtml = recognized ? positionedPageHtml(content, index + 1) : await engine.html(index, { images: o.html.images && !graphics })
          const background = graphics ? await engine.picture(index, { dpi: PICTURE_DPI, text: false, format: 'auto', erase: content.erase }) : undefined
          pages.push({ html: pageHtml, background })
        }
        html = buildPageHtml(pages, { title: job.title, lang: job.lang })
      } else {
        const contents = await readContents(engine, job, 0.6, { images: o.html.images })
        const layout = analyzeDocument(contents, { structure: true, tables: true, images: o.html.images })
        if (o.html.images) await resolvePictures(engine, layout, job, 0.6, 0.9)
        html = buildFlowingHtml(layout, { title: job.title, lang: job.lang, images: o.html.images })
      }
      return file(new TextEncoder().encode(html))
    }
    case 'text': {
      const { joinPages, layoutText } = await import('./builders/text')
      let pages: string[]
      if (o.text.layout === 'paragraphs') {
        const contents = await readContents(engine, job, 0.9, { images: false })
        pages = layoutText(analyzeDocument(contents, { structure: true, tables: true, images: false }))
      } else {
        pages = []
        for (let k = 0; k < n; k++) {
          check(job)
          job.onProgress?.(k / n, `Reading page ${k + 1} of ${n}…`)
          pages.push(await engine.text(job.pages[k]))
        }
      }
      return file(new TextEncoder().encode(joinPages(pages, { pageBreaks: o.text.pageBreaks, eol: job.eol ?? '\n' })))
    }
    case 'image': {
      const img = o.image
      if (img.format === 'tiff') {
        const rasters: PageRaster[] = []
        for (let k = 0; k < n; k++) {
          check(job)
          job.onProgress?.((0.8 * k) / n, `Drawing page ${k + 1} of ${n}…`)
          rasters.push(await engine.raster(job.pages[k], { dpi: img.dpi, grayscale: img.grayscale }))
        }
        check(job)
        job.onProgress?.(0.85, 'Writing the TIFF file…')
        const { encodeTiff } = await import('./builders/tiff')
        return file(await encodeTiff(rasters, { dpi: img.dpi, compression: img.compression }), IMAGE_EXT.tiff)
      }
      const files: { name: string; data: Uint8Array }[] = []
      for (let k = 0; k < n; k++) {
        check(job)
        job.onProgress?.(k / n, `Saving page ${k + 1} of ${n}…`)
        const data = await engine.image(job.pages[k], { dpi: img.dpi, format: img.format === 'jpeg' ? 'jpeg' : 'png', quality: img.quality, grayscale: img.grayscale })
        files.push({ name: pageImageName(job.baseName, job.pages[k] + 1, img.format), data })
      }
      return { kind: 'images', files }
    }
  }
}

function emptyContent(index: number): PageContent {
  return { index, width: 612, height: 792, lines: [], images: [], rules: [], fills: [], drawings: [], links: [], decorations: [], comments: [] }
}
