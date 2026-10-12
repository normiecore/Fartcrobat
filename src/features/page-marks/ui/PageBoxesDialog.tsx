import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Point, Rect } from '@shared/geometry'
import { rectFromPoints } from '@shared/geometry'
import {
  Button,
  Checkbox,
  Dialog,
  drawResult,
  Select,
  showError,
  toast,
  useDocState,
  usePageVersion,
  type DocumentModel
} from '@renderer/sdk'
import type { BoxesView } from '../engine'
import { marksApi, useListing } from '../store'
import {
  describePages,
  resolvePageRange,
  toUnit,
  UNIT_LABELS,
  type Margins,
  type PageBox,
  type PageRange
} from '../shared'
import { Group, MarginsFields, NumberField, PageRangeFields, rangeError, Row, useUnit } from './common'

const BOX_LABELS: Record<PageBox, string> = {
  CropBox: 'Crop box',
  TrimBox: 'Trim box',
  BleedBox: 'Bleed box',
  ArtBox: 'Art box'
}

const BOX_COLORS: Record<'crop' | 'trim' | 'bleed' | 'art', string> = {
  crop: '#111111',
  trim: '#d7373f',
  bleed: '#1473e6',
  art: '#268e6c'
}

const PREVIEW_W = 330
const PREVIEW_H = 400

function marginsFor(view: BoxesView, rect: Rect): Margins {
  const m = view.media
  const r = (v: number) => Math.max(0, Math.round(v * 100) / 100)
  return {
    left: r(rect[0] - m[0]),
    top: r(rect[1] - m[1]),
    right: r(m[2] - rect[2]),
    bottom: r(m[3] - rect[3])
  }
}

function rectFor(view: BoxesView, margins: Margins): Rect {
  const m = view.media
  return [m[0] + margins.left, m[1] + margins.top, m[2] - margins.right, m[3] - margins.bottom]
}

function existingBox(view: BoxesView, box: PageBox): Rect | null {
  switch (box) {
    case 'CropBox':
      return view.crop
    case 'TrimBox':
      return view.trim
    case 'BleedBox':
      return view.bleed
    case 'ArtBox':
      return view.art
  }
}

export function PageBoxesDialog({
  doc,
  initialPage,
  selection,
  close
}: {
  doc: DocumentModel
  initialPage: number
  /** Rectangle dragged with the Crop tool (page space of `initialPage`). */
  selection?: Rect
  close: (ok?: boolean) => void
}) {
  const pageCount = useDocState(doc, (s) => s.info.pageCount)
  const listing = useListing(doc)
  const unit = useUnit()
  const [box, setBox] = useState<PageBox>('CropBox')
  const [margins, setMargins] = useState<Margins | null>(null)
  const [removeWhite, setRemoveWhite] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [range, setRange] = useState<PageRange>(
    selection
      ? { kind: 'range', from: initialPage + 1, to: initialPage + 1, subset: 'all' }
      : { kind: 'all', subset: 'all' }
  )
  const [page, setPage] = useState(initialPage)
  const [view, setView] = useState<BoxesView | null>(null)
  const [white, setWhite] = useState<Rect | null | 'none'>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null)
  const version = usePageVersion(doc, page)
  const initialised = useRef(false)

  const pg = doc.state.info.pages[page]
  // The preview shows the whole MediaBox, which may be larger than the visible page.
  const mediaW = view ? view.media[2] - view.media[0] : pg.width
  const mediaH = view ? view.media[3] - view.media[1] : pg.height
  const cssScale = Math.min(PREVIEW_W / mediaW, PREVIEW_H / mediaH)
  const dpr = window.devicePixelRatio || 1

  // Render the page's MediaBox and read its boxes.
  useEffect(() => {
    let alive = true
    const first = !view
    const scale = first ? Math.min(PREVIEW_W / pg.width, PREVIEW_H / pg.height) * dpr : cssScale * dpr
    marksApi(doc)
      .boxes(page, scale)
      .then(async (v) => {
        if (!alive) {
          v.bitmap?.close()
          return
        }
        // If the MediaBox is larger than the visible page, render again at the right scale.
        const wanted =
          Math.min(PREVIEW_W / (v.media[2] - v.media[0]), PREVIEW_H / (v.media[3] - v.media[1])) * dpr
        if (Math.abs(wanted - v.scale) / wanted > 0.02) {
          v.bitmap?.close()
          v = await marksApi(doc).boxes(page, wanted)
          if (!alive) {
            v.bitmap?.close()
            return
          }
        }
        setView(v)
      })
      .catch((err) => showError(err, 'Could not show the page'))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, version])

  useEffect(() => {
    if (!view || !canvasRef.current) return
    drawResult(canvasRef.current, view)
    canvasRef.current.style.width = `${view.width / dpr}px`
    canvasRef.current.style.height = `${view.height / dpr}px`
  }, [view, dpr])

  // Initial margins: the dragged rectangle, else the page's current box.
  useEffect(() => {
    if (!view || initialised.current) return
    initialised.current = true
    if (selection) setMargins(marginsFor(view, selection))
    else setMargins(marginsFor(view, existingBox(view, box) ?? view.media))
  }, [view, selection, box])

  // Content bounds for "Remove white margins".
  useEffect(() => {
    if (!removeWhite) return
    let alive = true
    setWhite(null)
    marksApi(doc)
      .contentBounds(page)
      .then((r) => alive && setWhite(r ?? 'none'))
      .catch((err) => showError(err, 'Could not find the page content'))
    return () => {
      alive = false
    }
  }, [doc, page, removeWhite, version])

  const changeBox = (b: PageBox) => {
    setBox(b)
    if (view) setMargins(marginsFor(view, existingBox(view, b) ?? view.media))
  }

  const newRect: Rect | null = !view
    ? null
    : removeWhite
      ? white && white !== 'none'
        ? white
        : null
      : margins
        ? rectFor(view, margins)
        : null
  const tooSmall = !!newRect && (newRect[2] - newRect[0] < 1 || newRect[3] - newRect[1] < 1)
  const rangeErr = rangeError(range, pageCount)
  const error =
    rangeErr ??
    (tooSmall
      ? 'The margins are larger than the page'
      : removeWhite && white === 'none'
        ? 'This page is blank'
        : null)
  const canApply = !!view && !!margins && !error && !busy

  const pages = rangeErr ? [] : resolvePageRange(range, pageCount)

  const apply = async (remove: boolean) => {
    setBusy(true)
    try {
      const res = await doc.busyWhile(remove ? 'Removing crop…' : 'Cropping…', () =>
        marksApi(doc).setBoxes({
          pages,
          box,
          margins: remove || removeWhite ? null : margins,
          removeWhiteMargins: !remove && removeWhite
        })
      )
      const n = res.pages
      const what =
        box === 'CropBox'
          ? remove
            ? 'Removed the crop from'
            : 'Cropped'
          : remove
            ? `Removed the ${BOX_LABELS[box].toLowerCase()} from`
            : `Set the ${BOX_LABELS[box].toLowerCase()} of`
      toast(`${what} ${n} ${n === 1 ? 'page' : 'pages'}`, { kind: 'success', timeout: 2500 })
      close(true)
    } catch (err) {
      showError(err, remove ? 'Could not remove the crop' : 'Could not crop the pages')
    } finally {
      setBusy(false)
    }
  }

  // ---- preview geometry ----
  const toCss = (p: Point): Point =>
    view ? [(p[0] * view.scale - view.x) / dpr, (p[1] * view.scale - view.y) / dpr] : [0, 0]
  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const b = overlayRef.current!.getBoundingClientRect()
    return [
      ((e.clientX - b.left) * dpr + view!.x) / view!.scale,
      ((e.clientY - b.top) * dpr + view!.y) / view!.scale
    ]
  }
  const rectPath = (r: Rect) => {
    const a = toCss([r[0], r[1]])
    const b = toCss([r[2], r[3]])
    return `M${a[0]},${a[1]}H${b[0]}V${b[1]}H${a[0]}Z`
  }
  const shown: Rect | null = drag ? rectFromPoints(drag.a, drag.b) : newRect
  const cssW = view ? view.width / dpr : pg.width * cssScale
  const cssH = view ? view.height / dpr : pg.height * cssScale
  const sizeLabel = (r: Rect) =>
    `${toUnit(r[2] - r[0], unit)} × ${toUnit(r[3] - r[1], unit)} ${UNIT_LABELS[unit]}`

  return (
    <Dialog
      title="Set Page Boxes"
      onClose={() => close(false)}
      width={900}
      className="fc-page-marks-dialog"
      onSubmit={() => canApply && void apply(false)}
      footer={
        <>
          <Button
            variant="quiet"
            className="fc-page-marks-footer-left"
            disabled={busy || !!rangeErr}
            onClick={() => void apply(true)}
            title={box === 'CropBox' ? 'Show the whole page again (reset to the MediaBox)' : undefined}
          >
            {box === 'CropBox' ? 'Remove crop' : `Remove ${BOX_LABELS[box].toLowerCase()}`}
          </Button>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!canApply} onClick={() => void apply(false)}>
            {busy ? 'Applying…' : 'OK'}
          </Button>
        </>
      }
    >
      <div className="fc-page-marks-layout">
        <div className="fc-page-marks-form">
          <Group title="Margins">
            <Row label="Page box">
              <Select<PageBox>
                aria-label="Page box"
                value={box}
                onChange={changeBox}
                options={(Object.keys(BOX_LABELS) as PageBox[]).map((b) => ({
                  value: b,
                  label: BOX_LABELS[b]
                }))}
              />
            </Row>
            {margins ? (
              <div className={removeWhite ? 'fc-page-marks-disabled' : ''} aria-disabled={removeWhite}>
                <MarginsFields
                  margins={
                    removeWhite && view && white && white !== 'none' ? marginsFor(view, white) : margins
                  }
                  onChange={setMargins}
                />
              </div>
            ) : (
              <div className="shell-muted">Loading…</div>
            )}
            <div className="fc-page-marks-inline">
              <Checkbox checked={removeWhite} onChange={setRemoveWhite} label="Remove white margins" />
              <Button
                size="sm"
                disabled={removeWhite}
                onClick={() => setMargins({ top: 0, bottom: 0, left: 0, right: 0 })}
              >
                Set to zero
              </Button>
              {selection && view && (
                <Button
                  size="sm"
                  disabled={removeWhite}
                  onClick={() => setMargins(marginsFor(view, selection))}
                >
                  Revert to selection
                </Button>
              )}
            </div>
            {removeWhite && (
              <div className="fc-page-marks-hint">Each page is cropped to its own content.</div>
            )}
            <div className="fc-page-marks-hint">
              Margins are measured from the edges of the full page (MediaBox). Tip: drag on the preview.
            </div>
          </Group>
          <Group title="Page range">
            <PageRangeFields range={range} onChange={setRange} pageCount={pageCount} currentPage={page} />
            {listing.croppedPages.length > 0 && (
              <div className="fc-page-marks-hint">
                Already cropped: page{listing.croppedPages.length === 1 ? '' : 's'}{' '}
                {describePages(listing.croppedPages)}.
              </div>
            )}
          </Group>
          {error && view && (
            <div className="ui-field-error fc-page-marks-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="fc-page-marks-preview" aria-label="Preview">
          <div className="fc-page-marks-preview-title">
            Preview <Checkbox checked={showAll} onChange={setShowAll} label="Show all boxes" />
          </div>
          <div
            className="fc-page-marks-preview-frame fc-page-marks-boxes-frame"
            style={{ width: cssW + 2, height: cssH + 2 }}
          >
            <canvas ref={canvasRef} className="fc-page-marks-preview-canvas" />
            {view && (
              <svg
                ref={overlayRef}
                className="fc-page-marks-boxes-overlay"
                width={cssW}
                height={cssH}
                onPointerDown={(e) => {
                  if (e.button !== 0 || removeWhite) return
                  const p = toPage(e)
                  setDrag({ a: p, b: p })
                  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => drag && setDrag({ a: drag.a, b: toPage(e) })}
                onPointerUp={() => {
                  if (!drag) return
                  const r = rectFromPoints(drag.a, drag.b)
                  setDrag(null)
                  if ((r[2] - r[0]) * view.scale < 8 || (r[3] - r[1]) * view.scale < 8) return
                  const m = view.media
                  const clamped: Rect = [
                    Math.max(m[0], r[0]),
                    Math.max(m[1], r[1]),
                    Math.min(m[2], r[2]),
                    Math.min(m[3], r[3])
                  ]
                  setMargins(marginsFor(view, clamped))
                }}
              >
                {showAll &&
                  (['crop', 'trim', 'bleed', 'art'] as const).map((k) => {
                    const r = view[k]
                    return r ? (
                      <path
                        key={k}
                        d={rectPath(r)}
                        fill="none"
                        stroke={BOX_COLORS[k]}
                        strokeWidth={1}
                        strokeDasharray="3 2"
                      />
                    ) : null
                  })}
                {!showAll && box === 'CropBox' && (
                  <path
                    d={rectPath(view.crop)}
                    fill="none"
                    stroke="#777"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                )}
                {shown && (
                  <>
                    <path
                      d={`${rectPath(view.media)} ${rectPath(shown)}`}
                      fillRule="evenodd"
                      fill="rgba(0,0,0,0.45)"
                    />
                    <path d={rectPath(shown)} fill="none" stroke="var(--accent)" strokeWidth={2} />
                  </>
                )}
              </svg>
            )}
          </div>
          {showAll && (
            <div className="fc-page-marks-legend">
              {(['crop', 'trim', 'bleed', 'art'] as const).map((k) => (
                <span key={k}>
                  <i style={{ borderColor: BOX_COLORS[k] }} />
                  {k[0].toUpperCase() + k.slice(1)}
                </span>
              ))}
            </div>
          )}
          <div className="fc-page-marks-preview-size">
            {newRect && !tooSmall ? `New size: ${sizeLabel(newRect)}` : ' '}
          </div>
          <div className="fc-page-marks-preview-nav">
            <button
              type="button"
              className="ui-icon-btn"
              aria-label="Previous page"
              disabled={page <= 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              Page{' '}
              <NumberField
                label="Preview page"
                value={page + 1}
                min={1}
                max={pageCount}
                width={56}
                onChange={(v) => setPage(Math.round(v) - 1)}
              />{' '}
              of {pageCount}
            </span>
            <button
              type="button"
              className="ui-icon-btn"
              aria-label="Next page"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
