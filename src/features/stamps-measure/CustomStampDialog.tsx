import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileImage, Upload } from 'lucide-react'
import {
  basename,
  Button,
  Checkbox,
  Dialog,
  EngineClient,
  Field,
  IconButton,
  invoke,
  openDialog,
  readFile,
  setTool,
  stripExtension,
  TextInput,
  toast
} from '@renderer/sdk'
import type { CustomStamp } from './stampCatalog'
import type { StampBitmap } from './stampRender'
import { addCustomStamp, selectStamp } from './stampStore'

type StampOps = typeof import('./engine').default
type DocOps = typeof import('@engine/ops/doc').default

/** Longest side of a stored custom stamp, in pixels (keeps the settings file small). */
const MAX_STAMP_PX = 1200

interface Source {
  fileName: string
  kind: 'image' | 'pdf'
  bytes: Uint8Array
}

function detectKind(bytes: Uint8Array, fileName: string): 'image' | 'pdf' | null {
  const head = String.fromCharCode(...bytes.subarray(0, 5))
  if (head.startsWith('%PDF')) return 'pdf'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image'
  if (/\.(png|jpe?g)$/i.test(fileName)) return 'image'
  if (/\.pdf$/i.test(fileName)) return 'pdf'
  return null
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? void b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('Could not encode the image'))), 'image/png')
  )
}

/**
 * Turns picture bytes into a stamp image: optionally makes a white background transparent, trims
 * empty margins and limits the size.
 */
export async function prepareStampImage(bytes: Uint8Array, opts: { removeWhite: boolean }): Promise<StampBitmap> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]))
  } catch {
    throw new Error('This file is not a PNG or JPEG image that can be read')
  }
  const w = bmp.width
  const h = bmp.height
  const src = document.createElement('canvas')
  src.width = w
  src.height = h
  const sctx = src.getContext('2d', { willReadFrequently: true })!
  sctx.drawImage(bmp, 0, 0)
  bmp.close()
  const img = sctx.getImageData(0, 0, w, h)
  const d = img.data
  if (opts.removeWhite) {
    for (let i = 0; i < d.length; i += 4) {
      const light = Math.min(d[i], d[i + 1], d[i + 2])
      if (light >= 245) d[i + 3] = 0
      else if (light > 200) d[i + 3] = Math.round((d[i + 3] * (245 - light)) / 45)
    }
    sctx.putImageData(img, 0, 0)
  }
  // trim transparent margins
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < x0 || y1 < y0) throw new Error('The picture is empty (only white or transparent pixels)')
  const pad = 2
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(w - 1, x1 + pad)
  y1 = Math.min(h - 1, y1 + pad)
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const scale = Math.min(1, MAX_STAMP_PX / Math.max(bw, bh))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(bw * scale))
  out.height = Math.max(1, Math.round(bh * scale))
  const octx = out.getContext('2d')!
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(src, x0, y0, bw, bh, 0, 0, out.width, out.height)
  const png = await canvasToPng(out)
  return { png, dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height }
}

function CustomStampDialog({ onClose }: { onClose: (c?: CustomStamp) => void }) {
  const [source, setSource] = useState<Source | null>(null)
  const [pdf, setPdf] = useState<{ engine: EngineClient; pageCount: number } | null>(null)
  const [page, setPage] = useState(0)
  const [removeWhite, setRemoveWhite] = useState(true)
  const [name, setName] = useState('')
  const [result, setResult] = useState<StampBitmap | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const engineRef = useRef<EngineClient | null>(null)

  useEffect(
    () => () => {
      engineRef.current?.terminate()
      engineRef.current = null
    },
    []
  )

  const load = async (bytes: Uint8Array, fileName: string) => {
    setError(null)
    setResult(null)
    const kind = detectKind(bytes, fileName)
    if (!kind) {
      setError('Choose a PNG or JPEG image, or a PDF.')
      return
    }
    engineRef.current?.terminate()
    engineRef.current = null
    setPdf(null)
    if (kind === 'pdf') {
      setWorking(true)
      const engine = new EngineClient()
      try {
        await engine.ready()
        const res = await engine.ops<DocOps>('doc').open(bytes, { fileName })
        if (!res.ok) throw new Error('This PDF is password protected. Remove its password first.')
        engineRef.current = engine
        setPdf({ engine, pageCount: res.info.pageCount })
      } catch (err) {
        engine.terminate()
        setWorking(false)
        setError(err instanceof Error ? err.message : String(err))
        return
      }
      setRemoveWhite(false)
    } else {
      setRemoveWhite(true)
    }
    setPage(0)
    setSource({ fileName, kind, bytes })
    setName((n) => n || stripExtension(fileName))
  }

  // (Re)build the stamp picture whenever the source, page or options change.
  useEffect(() => {
    if (!source) return
    let alive = true
    setWorking(true)
    setError(null)
    void (async () => {
      try {
        let bytes = source.bytes
        if (source.kind === 'pdf') {
          const engine = engineRef.current
          if (!engine) return
          const img = await engine.ops<StampOps>('stamps-measure').pageImage(page, { maxPx: 1600, trim: true })
          if (img.empty) throw new Error(`Page ${page + 1} is blank`)
          bytes = img.png
        }
        const r = await prepareStampImage(bytes, { removeWhite })
        if (alive) setResult(r)
      } catch (err) {
        if (alive) {
          setResult(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (alive) setWorking(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [source, page, removeWhite, pdf])

  const choose = async () => {
    try {
      const paths = await invoke('file:openDialog', {
        title: 'Choose an image or PDF for your stamp',
        filters: [
          { name: 'Images and PDF files', extensions: ['png', 'jpg', 'jpeg', 'pdf'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg'] },
          { name: 'PDF files', extensions: ['pdf'] }
        ]
      })
      if (!paths?.length) return
      await load(await readFile(paths[0]), basename(paths[0]))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const create = async () => {
    if (!result || !name.trim()) return
    try {
      const c = await addCustomStamp({ name: name.trim(), dataUrl: result.dataUrl, width: result.width, height: result.height })
      selectStamp(`custom:${c.id}`)
      setTool('stamps.stamp')
      toast(`Stamp “${c.name}” created. Click on a page to place it.`, { kind: 'success' })
      onClose(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const canCreate = !!result && !!name.trim() && !working

  return (
    <Dialog
      title="Create custom stamp"
      width={520}
      onClose={() => onClose()}
      onSubmit={() => void create()}
      className="fc-stamps-measure-custom-dialog"
      footer={
        <>
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div
        className={`fc-stamps-measure-drop ${dragOver ? 'is-over' : ''} ${result ? 'has-image' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const f = e.dataTransfer.files[0]
          if (f) void f.arrayBuffer().then((b) => load(new Uint8Array(b), f.name))
        }}
      >
        {result ? (
          <img className="fc-stamps-measure-custom-preview" src={result.dataUrl} alt="Stamp preview" />
        ) : (
          <div className="fc-stamps-measure-drop-hint">
            <FileImage size={32} />
            <div>{working ? 'Preparing…' : 'Drop a PNG, JPEG or PDF here'}</div>
          </div>
        )}
      </div>
      <div className="fc-stamps-measure-custom-row">
        <Button icon={Upload} onClick={() => void choose()} data-autofocus>
          {source ? 'Choose another file…' : 'Choose image or PDF…'}
        </Button>
        {source && <span className="fc-stamps-measure-filename" title={source.fileName}>{source.fileName}</span>}
      </div>
      {pdf && pdf.pageCount > 1 && (
        <div className="fc-stamps-measure-custom-row" role="group" aria-label="Page of the PDF">
          <IconButton icon={ChevronLeft} label="Previous page" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} />
          <span>
            Page {page + 1} of {pdf.pageCount}
          </span>
          <IconButton
            icon={ChevronRight}
            label="Next page"
            disabled={page >= pdf.pageCount - 1}
            onClick={() => setPage((p) => Math.min(pdf.pageCount - 1, p + 1))}
          />
        </div>
      )}
      {source && (
        <Checkbox checked={removeWhite} onChange={setRemoveWhite} label="Make the white background transparent" />
      )}
      <Field label="Stamp name">
        <TextInput value={name} placeholder="e.g. Company logo" onChange={(e) => setName(e.target.value)} aria-label="Stamp name" />
      </Field>
      {error && (
        <div className="fc-stamps-measure-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  )
}

/** Opens "Create custom stamp"; resolves with the new stamp, or undefined when cancelled. */
export function openCustomStampDialog(): Promise<CustomStamp | undefined> {
  return openDialog<CustomStamp>((close) => <CustomStampDialog onClose={close} />)
}
