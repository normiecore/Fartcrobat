import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import { createLocalEngine } from '@engine/local'
import type ops from '@features/stamps-measure/engine'
import {
  angleDegrees,
  convertReal,
  defaultScale,
  formatNumber,
  measureShape,
  nearestPoint,
  parseFraction,
  parseScale,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  polylineLength,
  realPerPoint,
  sameScale,
  sanitizeScale,
  scaleToString,
  snap45,
  toRealArea,
  toRealLength,
  type MeasureScale
} from '@features/stamps-measure/measureMath'
import { customStampDef, stampNameFor, BUILTIN_STAMPS, MUPDF_STAMP_NAMES } from '@features/stamps-measure/stampCatalog'
import { clickRect, dragRect } from '@features/stamps-measure/stampGeometry'
import { fixture, openFixture, roundTrip, type OpenedEngine } from './helpers'

const IN_FT: MeasureScale = { pageValue: 1, pageUnit: 'in', realValue: 1, realUnit: 'ft', precision: 2 }

function sm(e: { ops: OpenedEngine['ops'] }) {
  return e.ops<typeof ops>('stamps-measure')
}

function annots(e: { ops: OpenedEngine['ops'] }) {
  return e.ops<typeof annotOps>('annots')
}

/** A two-page drawing: a 288 x 144 pt room outline, a diagonal wall and a label; page 2 is rotated. */
function planPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument()
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'))
  const res = doc.newDictionary()
  const fonts = doc.newDictionary()
  fonts.put('F1', font)
  res.put('Font', fonts)
  // PDF user space: y up. Room from (72, 504) to (360, 648) -> page space y 144..288.
  const content = '1 w 72 504 288 144 re S 400 500 m 500 600 l S BT /F1 12 Tf 90 600 Td (Room 1) Tj ET'
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content))
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 90, doc.newDictionary(), '72 72 100 100 re S'))
  const buf = doc.saveToBuffer('')
  const bytes = buf.asUint8Array().slice()
  doc.destroy()
  return bytes
}

async function openBytes(bytes: Uint8Array, name = 'plan.pdf'): Promise<OpenedEngine> {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const res = await doc.open(bytes, { fileName: name })
  if (!res.ok) throw new Error('needs password')
  return Object.assign(engine, { info: res.info, doc })
}

function isPng(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}

describe('measuring maths', () => {
  it('converts page distances to real units with a scale', () => {
    expect(realPerPoint(IN_FT)).toBeCloseTo(1 / 72, 10)
    expect(toRealLength(144, IN_FT)).toBeCloseTo(2, 10)
    expect(toRealArea(72 * 72, IN_FT)).toBeCloseTo(1, 10)
    const metric: MeasureScale = { pageValue: 1, pageUnit: 'cm', realValue: 1, realUnit: 'm', precision: 2 }
    expect(toRealLength(72 / 2.54, metric)).toBeCloseTo(1, 10)
    const quarter: MeasureScale = { pageValue: 0.25, pageUnit: 'in', realValue: 1, realUnit: 'ft', precision: 2 }
    expect(toRealLength(18, quarter)).toBeCloseTo(1, 10)
    expect(toRealLength(10, { pageValue: 1, pageUnit: 'pt', realValue: 1, realUnit: 'pt', precision: 0 })).toBe(10)
    expect(convertReal(1, 'ft', 'in')).toBeCloseTo(12, 10)
    expect(convertReal(1, 'mi', 'km')).toBeCloseTo(1.609344, 8)
  })

  it('measures distance, perimeter and area', () => {
    const square: [number, number][] = [
      [0, 0],
      [72, 0],
      [72, 72],
      [0, 72]
    ]
    expect(polylineLength(square)).toBe(216)
    expect(polygonPerimeter(square)).toBe(288)
    expect(polygonArea(square)).toBe(5184)
    expect(polygonArea([...square].reverse())).toBe(5184)
    expect(polygonArea([[0, 0], [10, 0]])).toBe(0)
    expect(polygonCentroid(square)).toEqual([36, 36])
    const tri: [number, number][] = [
      [0, 0],
      [90, 0],
      [0, 90]
    ]
    const c = polygonCentroid(tri)
    expect(c[0]).toBeCloseTo(30, 6)
    expect(c[1]).toBeCloseTo(30, 6)

    const d = measureShape('distance', [[100, 100], [244, 100]], IN_FT)
    expect(d.value).toBeCloseTo(2, 10)
    expect(d.label).toBe('2 ft')
    expect(d.unit).toBe('ft')
    const p = measureShape('perimeter', square, IN_FT)
    expect(p.label).toBe('3 ft')
    const a = measureShape('area', square, IN_FT)
    expect(a.label).toBe('1 sq ft')
    expect(a.unit).toBe('sq ft')
    expect(a.length).toBeCloseTo(4, 10)
    const precise = measureShape('distance', [[0, 0], [100, 0]], { ...IN_FT, precision: 3 })
    expect(precise.label).toBe('1.389 ft')
  })

  it('formats numbers, scales and angles', () => {
    expect(formatNumber(2, 2)).toBe('2')
    expect(formatNumber(2.5, 2)).toBe('2.5')
    expect(formatNumber(1.999, 2)).toBe('2')
    expect(formatNumber(12345.678, 2)).toBe('12,345.68')
    expect(formatNumber(0.00004, 2)).toBe('0')
    expect(scaleToString(IN_FT)).toBe('1 in = 1 ft')
    expect(scaleToString({ ...IN_FT, pageValue: 0.25 })).toBe('0.25 in = 1 ft')
    expect(parseScale('1 in = 1 ft')).toEqual(IN_FT)
    expect(parseScale('1/4in=1ft', 3)).toEqual({ pageValue: 0.25, pageUnit: 'in', realValue: 1, realUnit: 'ft', precision: 3 })
    expect(parseScale('1:100')).toEqual({ pageValue: 1, pageUnit: 'cm', realValue: 1, realUnit: 'm', precision: 2 })
    expect(parseScale('2 parsecs = 1 ft')).toBeNull()
    expect(parseScale('0 in = 1 ft')).toBeNull()
    expect(parseFraction('3/8')).toBeCloseTo(0.375)
    expect(Number.isNaN(parseFraction('abc'))).toBe(true)
    expect(sanitizeScale({ pageValue: -1, pageUnit: 'in', realValue: 1, realUnit: 'ft' })).toBeNull()
    expect(sanitizeScale({ pageValue: 1, pageUnit: 'in', realValue: 1, realUnit: 'ft', precision: 9 })?.precision).toBe(4)
    expect(defaultScale('mm')).toEqual({ pageValue: 1, pageUnit: 'mm', realValue: 1, realUnit: 'mm', precision: 2 })
    expect(sameScale(IN_FT, { ...IN_FT })).toBe(true)
    expect(sameScale(IN_FT, { ...IN_FT, precision: 1 })).toBe(false)
    expect(angleDegrees([0, 0], [10, 0])).toBe(0)
    expect(angleDegrees([0, 0], [0, -10])).toBe(90)
    expect(angleDegrees([0, 0], [-10, 0])).toBe(180)
    expect(angleDegrees([0, 0], [0, 10])).toBe(270)
  })

  it('snaps to 45 degrees and to nearby points', () => {
    expect(snap45([0, 0], [100, 7])).toEqual([100, 0])
    const diag = snap45([0, 0], [100, 90])
    expect(diag[0]).toBeCloseTo(95, 6)
    expect(diag[1]).toBeCloseTo(95, 6)
    expect(snap45([10, 10], [12, 200])).toEqual([10, 200])
    const pts = new Float32Array([0, 0, 50, 50, 100, 100])
    expect(nearestPoint(pts, [52, 49], 5)?.point).toEqual([50, 50])
    expect(nearestPoint(pts, [75, 75], 5)).toBeNull()
  })

  it('describes the stamp catalog', () => {
    const approved = BUILTIN_STAMPS.find((s) => s.id === 'standard:approved')!
    expect(approved.shape).toBe('builtin')
    expect(BUILTIN_STAMPS.find((s) => s.id === 'standard:void')!.shape).toBe('box')
    for (const s of BUILTIN_STAMPS) if (s.shape === 'builtin') expect(MUPDF_STAMP_NAMES.has(s.name)).toBe(true)
    expect(BUILTIN_STAMPS.filter((s) => s.category === 'standard').length).toBe(17)
    expect(BUILTIN_STAMPS.filter((s) => s.category === 'signhere').map((s) => s.label)).toEqual([
      'Sign Here',
      'Witness',
      'Initial Here',
      'Accepted',
      'Rejected'
    ])
    expect(BUILTIN_STAMPS.filter((s) => s.category === 'dynamic').length).toBe(5)
    expect(stampNameFor('My logo (v2)')).toBe('CMylogov2')
    const def = customStampDef({ id: 'x', name: 'Logo', dataUrl: '', width: 300, height: 150, created: 0 })
    expect(def.aspect).toBe(2)
    expect(def.width).toBeCloseTo(144)
  })

  it('places stamps by click (default size, kept on the page) and by drag (proportional)', () => {
    const approved = BUILTIN_STAMPS.find((s) => s.id === 'standard:approved')!
    const r = clickRect(approved, [300, 400], 612, 792)
    expect(r[2] - r[0]).toBeCloseTo(150, 6)
    expect((r[2] - r[0]) / (r[3] - r[1])).toBeCloseTo(3.8, 6)
    expect((r[0] + r[2]) / 2).toBeCloseTo(300, 6)
    expect((r[1] + r[3]) / 2).toBeCloseTo(400, 6)
    // near a corner it slides back onto the page
    const corner = clickRect(approved, [5, 5], 612, 792)
    expect(corner[0]).toBe(0)
    expect(corner[1]).toBe(0)
    // a page smaller than the stamp shrinks it
    const small = clickRect(approved, [50, 50], 100, 100)
    expect(small[2] - small[0]).toBeCloseTo(90, 6)

    // drag right/down from the anchor: the larger of width and height (in proportion) wins
    const d = dragRect(approved, [100, 100], [280, 110], 612, 792)
    expect(d).toEqual([100, 100, 280, 100 + 180 / 3.8])
    const tall = dragRect(approved, [100, 100], [110, 150], 612, 792)
    expect(tall[2] - tall[0]).toBeCloseTo(50 * 3.8, 6)
    // dragging up/left anchors at the start point
    const back = dragRect(approved, [300, 300], [150, 290], 612, 792)
    expect(back[2]).toBe(300)
    expect(back[3]).toBe(300)
    expect(back[0]).toBeCloseTo(150, 6)
    // never larger than the room left on the page, never smaller than 12 pt
    const edge = dragRect(approved, [500, 100], [900, 100], 612, 792)
    expect(edge[2]).toBeCloseTo(612, 6)
    const tiny = dragRect(approved, [100, 100], [102, 101], 612, 792)
    expect(tiny[2] - tiny[0]).toBeCloseTo(12, 6)
  })
})

describe('stamps-measure engine', () => {
  it('reads and writes the document measurement scale (undoable, saved)', async () => {
    const e = await openFixture('text.pdf')
    expect(await sm(e).getScale()).toBeNull()
    const sc = await sm(e).setScale(IN_FT)
    expect(sc).toEqual(IN_FT)
    expect(e.lastChanges?.journal.undoLabel).toBe('Set Measurement Scale')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(await sm(e).getScale()).toEqual(IN_FT)
    await expect(sm(e).setScale({ ...IN_FT, pageValue: 0 })).rejects.toThrow(/not valid/)
    const again = await roundTrip(e)
    expect(await sm(again).getScale()).toEqual(IN_FT)
    await e.doc.undo()
    expect(await sm(e).getScale()).toBeNull()
  })

  it('creates a distance measurement as a captioned LineDimension line', async () => {
    const e = await openFixture('text.pdf')
    await annots(e).setAuthor('Tester')
    // drawn right-to-left: stored left-to-right so the caption reads upright
    const m = await sm(e).addMeasurement(0, { kind: 'distance', points: [[244, 600], [100, 600]], scale: IN_FT })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Distance Measurement')
    expect(e.lastChanges?.pages).toEqual([0])
    expect(m.kind).toBe('distance')
    expect(m.type).toBe('Line')
    expect(m.label).toBe('2 ft')
    expect(m.value).toBeCloseTo(2, 6)
    expect(m.points[0][0]).toBe(100)
    expect(m.showLabel).toBe(true)
    expect(m.ours).toBe(true)
    const a = await annots(e).get(m.id)
    expect(a.type).toBe('Line')
    expect(a.intent).toBe('LineDimension')
    expect(a.contents).toBe('2 ft')
    expect(a.subject).toBe('Distance Measurement')
    expect(a.author).toBe('Tester')
    expect(a.lineEndings).toEqual({ start: 'OpenArrow', end: 'OpenArrow' })
    expect(a.extra).toMatchObject({ fartcrobat: 'measure', kind: 'distance', value: '2', unit: 'ft', scale: '1 in = 1 ft', label: '2 ft' })
    const { annot } = e.session.requireAnnotation(m.id)
    expect(!!annot.getLineCaption()).toBe(true)
    const measure = annot.getObject().get('Measure')
    expect(measure.get('R').asString()).toBe('1 in = 1 ft')
    expect(measure.get('X').get(0).get('C').asNumber()).toBeCloseTo(1 / 72, 6)

    await sm(e).setLineCaption(m.id, false)
    expect(e.lastChanges?.journal.undoLabel).toBe('Hide Measurement Label')
    expect((await sm(e).listMeasurements(0))[0].showLabel).toBe(false)
    await e.doc.undo()
    expect((await sm(e).listMeasurements(0))[0].showLabel).toBe(true)
    await e.doc.undo()
    expect(await sm(e).listMeasurements(0)).toEqual([])
  })

  it('creates perimeter and area measurements with a drawn label', async () => {
    const e = await openFixture('text.pdf')
    const square: [number, number][] = [
      [100, 520],
      [172, 520],
      [172, 592],
      [100, 592]
    ]
    const p = await sm(e).addMeasurement(0, { kind: 'perimeter', points: square, scale: IN_FT, color: '#0000ff' })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Perimeter Measurement')
    expect(p.label).toBe('3 ft')
    expect(p.type).toBe('PolyLine')
    const area = await sm(e).addMeasurement(0, { kind: 'area', points: square, scale: IN_FT })
    expect(area.label).toBe('1 sq ft')
    expect(area.unit).toBe('sq ft')
    expect(area.type).toBe('Polygon')
    const info = await annots(e).get(area.id)
    expect(info.contents).toBe('1 sq ft')
    expect(info.subject).toBe('Area Measurement')
    expect(info.color).toBe('#d32f2f')
    const { annot } = e.session.requireAnnotation(area.id)
    expect(annot.getObject().get('IT').asName()).toBe('PolygonDimension')
    const pl = e.session.requireAnnotation(p.id).annot
    expect(pl.getObject().get('IT').asName()).toBe('PolyLineDimension')
    // our appearance with the label: marker present, text drawn
    const ap = annot.getObject().get('AP').get('N').readStream().asString()
    expect(ap).toContain('/FartcrobatAP BMC')
    expect(ap).toContain('(1 sq ft) Tj')
    // label lives inside the annotation rectangle
    expect(area.rect[0]).toBeLessThanOrEqual(100)
    expect(area.rect[2]).toBeGreaterThanOrEqual(172)
    const list = await sm(e).listMeasurements(0)
    expect(list.map((m) => m.kind)).toEqual(['perimeter', 'area'])
    await expect(sm(e).addMeasurement(0, { kind: 'area', points: square.slice(0, 2), scale: IN_FT })).rejects.toThrow(/at least 3/)
    // survives saving
    const again = await roundTrip(e)
    const reloaded = await sm(again).listMeasurements(0)
    expect(reloaded.map((m) => m.label)).toEqual(['3 ft', '1 sq ft'])
    expect(await sm(again).refreshMeasurements(0)).toBe(0)
  })

  it('redraws labels and recalculates values after other tools change a measurement', async () => {
    const e = await openFixture('text.pdf')
    const square: [number, number][] = [
      [100, 520],
      [172, 520],
      [172, 592],
      [100, 592]
    ]
    const area = await sm(e).addMeasurement(0, { kind: 'area', points: square, scale: IN_FT })
    const line = await sm(e).addMeasurement(0, { kind: 'distance', points: [[100, 650], [244, 650]], scale: IN_FT })
    expect(await sm(e).refreshMeasurements(0)).toBe(0)

    // moving: MuPDF redraws the polygon without its label
    await annots(e).move([area.id], 50, 10)
    const position = e.lastChanges!.journal.position
    const content = () => e.session.requireAnnotation(area.id).annot.getObject().get('AP').get('N').readStream().asString()
    expect(content()).not.toContain('FartcrobatAP')
    expect(await sm(e).refreshMeasurements(0)).toBe(1)
    expect(e.lastChanges?.journal.position).toBe(position)
    expect(e.lastChanges?.journal.undoLabel).toBe('Move Annotation')
    expect(content()).toContain('/FartcrobatAP BMC')
    expect(content()).toContain('(1 sq ft) Tj')
    expect((await annots(e).get(area.id)).contents).toBe('1 sq ft')

    // stretching a line: the value follows the new length
    await annots(e).update(line.id, { line: [[100, 650], [316, 650]] })
    expect(await sm(e).refreshMeasurements(0)).toBe(1)
    const l = (await sm(e).listMeasurements(0)).find((m) => m.id === line.id)!
    expect(l.label).toBe('3 ft')
    expect((await annots(e).get(line.id)).contents).toBe('3 ft')

    // a user note in the contents is kept
    await annots(e).update(line.id, { contents: 'Wall A' })
    await annots(e).update(line.id, { line: [[100, 650], [172, 650]] })
    await sm(e).refreshMeasurements(0)
    expect((await annots(e).get(line.id)).contents).toBe('Wall A')
    expect((await sm(e).listMeasurements(0)).find((m) => m.id === line.id)!.label).toBe('1 ft')

    // undo reverts the change and its fix-up together
    await e.doc.undo()
    await e.doc.undo()
    const back = (await sm(e).listMeasurements(0)).find((m) => m.id === line.id)!
    expect(back.label).toBe('3 ft')
    // never touches history while redo is possible
    await annots(e).move([area.id], 5, 5)
    await e.doc.undo()
    expect(await sm(e).refreshMeasurements(0)).toBe(0)
  })

  it('rescales existing measurements', async () => {
    const e = await openFixture('text.pdf')
    const m = await sm(e).addMeasurement(0, { kind: 'distance', points: [[100, 650], [244, 650]], scale: IN_FT })
    const n = await sm(e).rescaleMeasurements([m.id], { pageValue: 1, pageUnit: 'in', realValue: 10, realUnit: 'ft', precision: 1 })
    expect(n).toBe(1)
    expect(e.lastChanges?.journal.undoLabel).toBe('Change Measurement Scale')
    const after = (await sm(e).listMeasurements(0))[0]
    expect(after.label).toBe('20 ft')
    expect(after.scale).toBe('1 in = 10 ft')
    expect(after.precision).toBe(1)
  })

  it('lists measurements made by other applications', async () => {
    const e = await openFixture('text.pdf')
    await annots(e).create(0, { type: 'Line', line: [[10, 10], [100, 10]], intent: 'LineDimension', contents: '3.5 in' })
    await annots(e).create(0, { type: 'Line', line: [[10, 30], [100, 30]] })
    const list = await sm(e).listMeasurements(0)
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ kind: 'distance', value: 3.5, unit: 'in', label: '3.5 in', ours: false })
    expect(await sm(e).refreshMeasurements(0)).toBe(0)
    const all = await sm(e).listAllMeasurements()
    expect(all.length).toBe(1)
  })

  it('finds snap points: path ends, midpoints, text corners and annotation points', async () => {
    const e = await openBytes(planPdf())
    await sm(e).addMeasurement(0, { kind: 'distance', points: [[100, 700], [200, 700]], scale: IN_FT })
    const t = await sm(e).snapPoints(0)
    expect(t.points.length).toBe(t.kinds.length * 2)
    const has = (x: number, y: number, kind?: number) => {
      for (let i = 0; i < t.kinds.length; i++) {
        if (Math.abs(t.points[i * 2] - x) < 0.01 && Math.abs(t.points[i * 2 + 1] - y) < 0.01 && (kind === undefined || t.kinds[i] === kind)) return true
      }
      return false
    }
    // room corners (page space) and the middle of its top wall
    expect(has(72, 144, 0)).toBe(true)
    expect(has(360, 144, 0)).toBe(true)
    expect(has(360, 288, 0)).toBe(true)
    expect(has(216, 288, 1)).toBe(true)
    // diagonal wall ends
    expect(has(400, 292, 0)).toBe(true)
    expect(has(500, 192, 0)).toBe(true)
    // the measurement we added
    expect(has(100, 700, 3)).toBe(true)
    // a text corner exists
    expect(Array.from(t.kinds).includes(2)).toBe(true)
  })

  it('adds stamps drawn by MuPDF and from images, upright on rotated pages', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    await annots(e).setAuthor('Tester')
    const approved = await sm(e).addStamp(0, {
      rect: [100, 100, 252, 140],
      name: 'Approved',
      label: 'Approved',
      color: '#1E7B34',
      extra: { stamp: 'standard:approved' }
    })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Stamp')
    expect(approved.type).toBe('Stamp')
    expect(approved.icon).toBe('Approved')
    expect(approved.subject).toBe('Approved')
    expect(approved.author).toBe('Tester')
    expect(approved.color).toBe('#1e7b34')
    expect(approved.extra).toEqual({ fartcrobat: 'stamp', stamp: 'standard:approved' })
    const w = approved.rect[2] - approved.rect[0]
    const h = approved.rect[3] - approved.rect[1]
    expect(w / h).toBeCloseTo(3.8, 1)

    const png = fixture('scan.png') // 1275 x 1650
    const img = await sm(e).addStamp(0, { rect: [300, 300, 375, 397], name: 'CScan', label: 'Scan', image: png })
    expect(img.icon).toBe('CScan')
    const xobjectSize = (id: number) => {
      const { annot } = e.session.requireAnnotation(id)
      const xo = annot.getObject().get('AP').get('N').get('Resources').get('XObject')
      let size: [number, number] = [0, 0]
      xo.forEach((v) => {
        size = [v.get('Width').asNumber(), v.get('Height').asNumber()]
      })
      return size
    }
    expect(xobjectSize(img.id)).toEqual([1275, 1650])

    // page 3 is rotated 90 degrees: the image is turned so it reads upright
    const info = e.info.pages[2]
    expect(info.rotation).toBe(90)
    const rotated = await sm(e).addStamp(2, { rect: [100, 100, 175, 197], name: 'CScan', label: 'Scan', image: png })
    expect(xobjectSize(rotated.id)).toEqual([1650, 1275])
    const named = await sm(e).addStamp(2, { rect: [300, 100, 452, 140], name: 'Draft', label: 'Draft', color: '#1F4E9C' })
    expect(named.icon).toBe('Draft')
    const [nw, nh] = xobjectSize(named.id)
    expect(nh).toBeGreaterThan(nw) // drawn as a picture turned a quarter
    expect((await annots(e).list(2)).length).toBe(2)

    await expect(sm(e).addStamp(0, { rect: [0, 0, 0, 0], name: 'Approved', label: 'Approved' })).rejects.toThrow(/too small/)
    await expect(sm(e).addStamp(0, { rect: [0, 0, 50, 50], name: 'X', label: 'X', image: new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      /could not be read/
    )
    const again = await roundTrip(e)
    expect((await again.ops<typeof annotOps>('annots').list(0)).map((a) => a.icon)).toEqual(['Approved', 'CScan'])
  })

  it('renders stamp previews and trimmed page images for custom stamps', async () => {
    const e = await openFixture('text.pdf')
    const prev = await sm(e).stampPreview('Approved', '#1E7B34', 2)
    expect(isPng(prev)).toBe(true)
    const full = await sm(e).pageImage(0, { maxPx: 400 })
    const trimmed = await sm(e).pageImage(0, { maxPx: 400, trim: true })
    expect(isPng(trimmed.png)).toBe(true)
    expect(full.height).toBe(400)
    expect(trimmed.width).toBeLessThan(full.width)
    expect(trimmed.height).toBeLessThan(full.height)
    expect(trimmed.empty).toBe(false)
    const blank = await openBytes(
      (() => {
        const d = new mupdf.PDFDocument()
        d.insertPage(-1, d.addPage([0, 0, 200, 200], 0, d.newDictionary(), ''))
        const b = d.saveToBuffer('').asUint8Array().slice()
        d.destroy()
        return b
      })()
    )
    expect((await sm(blank).pageImage(0, { trim: true })).empty).toBe(true)
  })
})
