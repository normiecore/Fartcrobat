/**
 * Engine operations of "Prepare a form": creating and editing AcroForm fields with low-level PDF
 * objects (MuPDF has no API to create widgets), tab and calculation order, and automatic field
 * detection.
 */
import type { Point, Rect } from '@shared/geometry'
import { normalizeRect, quadToRect } from '@shared/geometry'
import { defineOps, EngineError, mutation } from '@engine/define'
import type { PDFObject, Session } from '@engine/session'
import { extractPageText } from '@engine/ops/text'
import { isNull, readName, readNumber } from '@engine/util/pdf'
import {
  NAME_PREFIX,
  TYPE_LABELS,
  type CreateSpec,
  type DetectedField,
  type FieldClip,
  type FieldProps,
  type PageTabs,
  type PFField,
  type PFType,
  type TabOrder
} from './model'
import { refreshAppearance } from './appearance'
import {
  FF_NO_TOGGLE_TO_OFF,
  FF_PUSHBUTTON,
  FF_RADIO,
  F_PRINT,
  acroForm,
  detachWidget,
  ensureAcroForm,
  fieldOf,
  fieldsByName,
  fullName,
  indexOfRef,
  joinWidgetToField,
  kindOf,
  loadWidget,
  locateWidget,
  newArray,
  num,
  onStateName,
  pageOfWidget,
  pageWidgets,
  placeFieldAtName,
  putRect,
  removeRef,
  sameObj,
  validateFieldName,
  widgetsOf
} from './fieldDict'
import {
  applyProps,
  nextAutoName,
  nextChoiceName,
  readField,
  readPage,
  rectWithin,
  renameInCalculations,
  tabOrderedWidgets,
  tabOrderOf,
  uniqueName
} from './fields'
import { detectFields, type DetectLine, type DetectShape } from './detect'

/** Widget-level keys copied when a widget is duplicated. */
const WIDGET_COPY_KEYS = ['F', 'MK', 'BS', 'Border', 'DA', 'Q', 'H', 'A']

function clampToPage(s: Session, pageIndex: number, rect: Rect): Rect {
  const b = s.pageBounds(pageIndex)
  let r = normalizeRect(rect)
  if (r[2] - r[0] < 4) r = [r[0], r[1], r[0] + 4, r[3]]
  if (r[3] - r[1] < 4) r = [r[0], r[1], r[2], r[1] + 4]
  return rectWithin(r, [0, 0, b[2] - b[0], b[3] - b[1]])
}

function addToPage(s: Session, pageIndex: number, w: PDFObject) {
  const pageObj = s.pdf.findPage(pageIndex)
  let annots = pageObj.get('Annots')
  if (isNull(annots) || !annots.isArray()) {
    pageObj.put('Annots', s.pdf.newArray())
    annots = pageObj.get('Annots')
  }
  annots.push(w)
  // New forms tab left to right, top to bottom unless the page says otherwise.
  if (isNull(pageObj.get('Tabs'))) pageObj.put('Tabs', s.pdf.newName('R'))
}

function placeholderAP(s: Session, w: PDFObject, on: string) {
  const doc = s.pdf
  const n = doc.newDictionary()
  n.put(on, doc.addStream('', doc.newDictionary()))
  n.put('Off', doc.addStream('', doc.newDictionary()))
  const ap = doc.newDictionary()
  ap.put('N', n)
  w.put('AP', ap)
}

interface Created {
  obj: PDFObject
  pageIndex: number
  /** A radio button added to an existing group. */
  joined?: boolean
}

/** Builds one new field (without appearance); `taken` holds the names in use. */
function buildField(s: Session, spec: CreateSpec, taken: Set<string>): Created {
  const doc = s.pdf
  const pageIndex = spec.page
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= s.pageCount()) {
    throw new EngineError(`Page ${pageIndex + 1} does not exist`, 'BAD_PAGE')
  }
  if (!TYPE_LABELS[spec.type] || spec.type === ('unknown' as PFType)) throw new EngineError(`Unknown field type ${spec.type}`, 'BAD_SPEC')
  ensureAcroForm(s)
  const rect = clampToPage(s, pageIndex, spec.rect)
  const pageObj = doc.findPage(pageIndex)
  const rotation = readNumber(pageObj.getInheritable('Rotate'), 0)
  const rot = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360

  const d = doc.newDictionary()
  d.put('Type', doc.newName('Annot'))
  d.put('Subtype', doc.newName('Widget'))
  d.put('F', F_PRINT)
  d.put('P', pageObj)
  const mk = doc.newDictionary()
  if (rot) mk.put('R', rot)
  const bs = doc.newDictionary()
  bs.put('Type', doc.newName('Border'))
  bs.put('W', 1)
  bs.put('S', doc.newName('S'))
  d.put('BS', bs)
  let da = '/Helv 0 Tf 0 g'

  switch (spec.type) {
    case 'text':
    case 'date':
      d.put('FT', doc.newName('Tx'))
      break
    case 'checkbox':
      d.put('FT', doc.newName('Btn'))
      mk.put('CA', doc.newString('4'))
      mk.put('BC', newArray(doc, [0]))
      d.put('V', doc.newName('Off'))
      d.put('AS', doc.newName('Off'))
      da = '/ZaDb 0 Tf 0 g'
      break
    case 'radio':
      mk.put('CA', doc.newString('l'))
      mk.put('BC', newArray(doc, [0]))
      d.put('AS', doc.newName('Off'))
      da = '/ZaDb 0 Tf 0 g'
      break
    case 'list':
      d.put('FT', doc.newName('Ch'))
      d.put('Ff', 0)
      break
    case 'combo':
      d.put('FT', doc.newName('Ch'))
      d.put('Ff', 1 << 17)
      break
    case 'button':
      d.put('FT', doc.newName('Btn'))
      d.put('Ff', FF_PUSHBUTTON)
      mk.put('CA', doc.newString('Button'))
      mk.put('BG', newArray(doc, [0.85]))
      mk.put('BC', newArray(doc, [0.4]))
      bs.put('S', doc.newName('B'))
      d.put('H', doc.newName('P'))
      break
    case 'signature':
      d.put('FT', doc.newName('Sig'))
      break
  }
  d.put('MK', mk)
  d.put('DA', doc.newString(da))
  const w = doc.addObject(d)
  putRect(s, pageIndex, w, rect)
  addToPage(s, pageIndex, w)

  if (spec.type === 'radio') {
    const groupName = spec.name?.trim() || nextAutoName(s, 'radio', taken)
    const existing = fieldsByName(s).get(groupName)
    if (existing && kindOf(widgetsOf(existing)[0] ?? existing) === 'radio') {
      const choice = nextChoiceName(existing)
      placeholderAP(s, w, choice)
      joinWidgetToField(s, w, existing)
      return { obj: w, pageIndex, joined: true }
    } else {
      const name = existing || taken.has(groupName) ? uniqueName(groupName, taken) : groupName
      const parent = doc.addObject(doc.newDictionary())
      parent.put('FT', doc.newName('Btn'))
      parent.put('Ff', FF_RADIO | FF_NO_TOGGLE_TO_OFF)
      parent.put('V', doc.newName('Off'))
      parent.put('Kids', newArray(doc, [w]))
      w.put('Parent', parent)
      placeholderAP(s, w, 'Choice1')
      placeFieldAtName(s, parent, name)
      taken.add(name)
    }
  } else {
    if (spec.type === 'checkbox') placeholderAP(s, w, 'Yes')
    let name = spec.name?.trim() || nextAutoName(s, spec.type, taken)
    if (taken.has(name)) {
      // "Text3" pasted again becomes the next automatic name; "Email" becomes "Email_2"
      const prefix = NAME_PREFIX[spec.type]
      const auto = name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))
      name = auto ? nextAutoName(s, spec.type, taken) : uniqueName(name, taken)
    }
    placeFieldAtName(s, w, name)
    taken.add(name)
  }
  return { obj: w, pageIndex }
}

/** Deep copy of a direct object (indirect references are kept as references). */
function deepCopy(s: Session, v: PDFObject): PDFObject {
  if (v.isIndirect()) return v
  if (v.isArray()) {
    const a = s.pdf.newArray()
    for (let i = 0; i < v.length; i++) a.push(deepCopy(s, v.get(i)))
    return a
  }
  if (v.isDictionary()) {
    const d = s.pdf.newDictionary()
    v.forEach((val, k) => d.put(k, deepCopy(s, val)))
    return d
  }
  return v
}

function defaultProps(spec: CreateSpec): FieldProps {
  const props: FieldProps = {}
  if (spec.type === 'date') props.format = { kind: 'date', pattern: 'mm/dd/yyyy' }
  if (spec.type === 'text' && spec.rect[3] - spec.rect[1] > 40) props.multiline = true
  return { ...props, ...(spec.props ?? {}) }
}

/** Regenerates the appearance of every widget of the given fields. */
function refreshFields(s: Session, fields: PDFObject[]): Set<number> {
  const pages = new Set<number>()
  const seen = new Set<number>()
  s.invalidatePages()
  for (const field of fields) {
    for (const w of widgetsOf(field)) {
      const id = num(w)
      if (seen.has(id)) continue
      seen.add(id)
      const p = pageOfWidget(s, w)
      if (p < 0) continue
      refreshAppearance(s, loadWidget(s, p, id))
      pages.add(p)
    }
  }
  return pages
}

function createFields(s: Session, specs: CreateSpec[]): PFField[] {
  const taken = new Set(fieldsByName(s).keys())
  const created: Created[] = []
  for (const spec of specs) {
    const c = buildField(s, spec, taken)
    const props = defaultProps(spec)
    if (c.joined) {
      // the group decides the new button's export value and the default choice
      delete props.exportValue
      delete props.checkedByDefault
    }
    if (Object.keys(props).length) applyProps(s, c.obj, c.pageIndex, props)
    created.push(c)
  }
  const pages = refreshFields(
    s,
    created.map((c) => fieldOf(c.obj))
  )
  s.touch(...pages)
  s.documentChanged()
  return created.map((c) => readField(s, c.obj, c.pageIndex, tabIndexOf(s, c.pageIndex, num(c.obj))))
}

function tabIndexOf(s: Session, pageIndex: number, id: number): number {
  return tabOrderedWidgets(s, pageIndex).findIndex((w) => num(w) === id)
}

/** Editable properties of a field (for copy/paste and duplicate). */
function propsOf(f: PFField): FieldProps {
  const { id: _id, page: _page, type: _type, widgetCount: _wc, tabIndex: _ti, name: _name, value: _value, rect: _rect, ...props } = f
  if (props.action.kind === 'other') delete (props as FieldProps).action
  return props
}

function pdfLineShapes(s: Session, pageIndex: number): DetectShape[] {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const shapes: DetectShape[] = []
  const handle = (path: InstanceType<typeof m.Path>, ctm: number[], stroked: boolean, lineWidth: number) => {
    const tp = (x: number, y: number): Point => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]
    const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
    const lw = Math.max(0.5, lineWidth * scale)
    const subs: { pts: Point[]; closed: boolean; curved: boolean }[] = []
    let cur: { pts: Point[]; closed: boolean; curved: boolean } | null = null
    path.walk({
      moveTo(x, y) {
        if (cur) subs.push(cur)
        cur = { pts: [tp(x, y)], closed: false, curved: false }
      },
      lineTo(x, y) {
        if (!cur) cur = { pts: [], closed: false, curved: false }
        cur.pts.push(tp(x, y))
      },
      curveTo(_x1, _y1, _x2, _y2, x3, y3) {
        if (!cur) cur = { pts: [], closed: false, curved: false }
        cur.pts.push(tp(x3, y3))
        cur.curved = true
      },
      closePath() {
        if (cur) {
          cur.closed = true
          subs.push(cur)
          cur = null
        }
      }
    })
    if (cur) subs.push(cur)
    for (const sp of subs) {
      if (sp.curved || sp.pts.length < 2) continue
      const pts = sp.pts
      const xs = [...new Set(pts.map((p) => Math.round(p[0] * 10) / 10))]
      const ys = [...new Set(pts.map((p) => Math.round(p[1] * 10) / 10))]
      const isRect = (pts.length === 4 || pts.length === 5) && xs.length <= 2 && ys.length <= 2 && xs.length * ys.length === 4
      if (isRect) {
        const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        const h = r[3] - r[1]
        if (!stroked) {
          if (h <= 2.5 && r[2] - r[0] >= 30) shapes.push({ kind: 'hline', rect: r })
        } else shapes.push({ kind: 'rect', rect: r })
        continue
      }
      if (!stroked) continue
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]]
        if (Math.abs(a[1] - b[1]) < 1 && Math.abs(a[0] - b[0]) >= 30) {
          const y = (a[1] + b[1]) / 2
          shapes.push({ kind: 'hline', rect: [Math.min(a[0], b[0]), y - lw / 2, Math.max(a[0], b[0]), y + lw / 2] })
        }
      }
    }
  }
  const dev = new m.Device({
    fillPath(path, _evenOdd, ctm) {
      handle(path, ctm as number[], false, 0)
    },
    strokePath(path, stroke, ctm) {
      handle(path, ctm as number[], true, stroke.getLineWidth())
    }
  })
  try {
    page.runPageContents(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  return shapes
}

function textLines(s: Session, pageIndex: number): DetectLine[] {
  const t = extractPageText(s, pageIndex, 'preserve-whitespace')
  return t.lines.map((l) => {
    const chars = []
    for (let i = l.start; i < l.end; i++) {
      const k = i * 8
      const q = t.quads
      chars.push({ c: t.text[i], rect: quadToRect([q[k], q[k + 1], q[k + 2], q[k + 3], q[k + 4], q[k + 5], q[k + 6], q[k + 7]]) })
    }
    return { bbox: l.bbox, chars }
  })
}

/**
 * Renames the field of widget `id`. Dotted names create a hierarchy ("address.city"). A radio
 * button renamed to another radio group's name joins that group; other fields may share a name
 * (and value) with a field of the same type when `join` is set. Returns the pages to refresh.
 */
function renameField(s: Session, id: number, name: string, join: boolean): number[] {
  const err = validateFieldName(name)
  if (err) throw new EngineError(err, 'BAD_NAME')
  const { obj } = locateWidget(s, id)
  const field = fieldOf(obj)
  const oldName = fullName(field)
  if (oldName === name) return []
  const kind = kindOf(obj)
  const existing = fieldsByName(s).get(name)
  const touched: PDFObject[] = [field]
  if (existing && !sameObj(existing, field)) {
    const otherKind = kindOf(widgetsOf(existing)[0] ?? existing)
    const textLike = (k: string) => k === 'text' || k === 'date'
    if (otherKind !== kind && !(textLike(otherKind) && textLike(kind))) {
      throw new EngineError(`A ${TYPE_LABELS[otherKind].toLowerCase()} named “${name}” already exists. Choose another name.`, 'NAME_EXISTS')
    }
    if (kind !== 'radio' && !join) {
      throw new EngineError(`A field named “${name}” already exists. Fields with the same name always show the same value.`, 'NAME_SHARED')
    }
    const used = new Set(widgetsOf(existing).map((w) => onStateName(w)))
    for (const w of widgetsOf(field)) {
      const on = onStateName(w)
      if (kind === 'radio' && (on === null || used.has(on))) {
        // give the joining button its own choice so it does not switch on with another one
        const choice = nextChoiceName(existing)
        const n = w.get('AP', 'N')
        if (!isNull(n) && on) {
          const st = n.get(on)
          n.delete(on)
          n.put(choice, st)
        }
        used.add(choice)
      }
      joinWidgetToField(s, w, existing)
    }
    touched.push(fieldsByName(s).get(name)!)
  } else {
    placeFieldAtName(s, field, name)
  }
  renameInCalculations(s, oldName, name)
  return [...refreshFields(s, touched)]
}

export default defineOps('prepare-form', {
  /** Fields (widgets) of one page in tab order. */
  listPage(s, pageIndex: number): PFField[] {
    return readPage(s, pageIndex)
  },

  /** Every field of the document, page by page in tab order, plus each page's tab order setting. */
  listAll(s): { fields: PFField[]; tabs: PageTabs[] } {
    const fields: PFField[] = []
    const tabs: PageTabs[] = []
    const n = s.pageCount()
    for (let i = 0; i < n; i++) {
      tabs.push({ page: i, order: tabOrderOf(s, i) })
      fields.push(...readPage(s, i))
    }
    return { fields, tabs }
  },

  get(s, id: number, hintPage?: number): PFField {
    const { obj, pageIndex } = locateWidget(s, id, hintPage)
    return readField(s, obj, pageIndex, tabIndexOf(s, pageIndex, id))
  },

  /** Names of every field. */
  fieldNames(s): string[] {
    return [...fieldsByName(s).keys()].sort((a, b) => a.localeCompare(b))
  },

  nextName(s, type: PFType): string {
    return nextAutoName(s, type)
  },

  /** Fields with a calculation, in /CO order (first widget id and name). */
  calculationOrder(s): { id: number; name: string }[] {
    const acro = acroForm(s)
    const out: { id: number; name: string }[] = []
    if (!acro) return out
    const co = acro.get('CO')
    if (isNull(co) || !co.isArray()) return out
    for (let i = 0; i < co.length; i++) {
      const f = co.get(i)
      const w = widgetsOf(f)[0]
      if (!w) continue
      out.push({ id: num(w), name: fullName(f) })
    }
    return out
  },

  /** Finds likely form fields on pages without creating them. */
  detect(s, pages?: number[]): DetectedField[] {
    const list = pages ?? Array.from({ length: s.pageCount() }, (_, i) => i)
    const out: DetectedField[] = []
    const taken = new Set(fieldsByName(s).keys())
    list.forEach((p, k) => {
      const b = s.pageBounds(p)
      const existing = pageWidgets(s, p).map((w) => readField(s, w, p, 0).rect)
      const found = detectFields({
        page: p,
        width: b[2] - b[0],
        height: b[3] - b[1],
        lines: textLines(s, p),
        shapes: pdfLineShapes(s, p),
        existing
      })
      for (const f of found) {
        const name = f.name ? uniqueName(f.name, taken) : nextAutoName(s, f.type, taken)
        taken.add(name)
        out.push({ ...f, name })
      }
      s.progress((k + 1) / list.length, `Looking for fields on page ${p + 1}`)
    })
    return out
  },

  /** Copies fields (Edit > Copy) so they can be pasted on any page. */
  copy(s, ids: number[]): FieldClip[] {
    return ids.map((id) => {
      const { obj, pageIndex } = locateWidget(s, id)
      const f = readField(s, obj, pageIndex, 0)
      if (f.type === 'unknown') throw new EngineError('This field type cannot be copied', 'BAD_FIELD')
      return { type: f.type as PFType, name: f.name, rect: f.rect, props: propsOf(f) }
    })
  },

  create: mutation(
    (spec: CreateSpec) => `Add ${TYPE_LABELS[spec.type] ?? 'Field'}`,
    (s, spec: CreateSpec): PFField => createFields(s, [spec])[0]
  ),

  createMany: mutation(
    (_specs: CreateSpec[], label?: string) => label ?? 'Add Form Fields',
    (s, specs: CreateSpec[], _label?: string): PFField[] => createFields(s, specs)
  ),

  /** Pastes copied fields onto a page (offset in points, e.g. to avoid covering the originals). */
  paste: mutation('Paste Fields', (s, pageIndex: number, clips: FieldClip[], offset: [number, number] = [0, 0]): PFField[] => {
    const specs: CreateSpec[] = clips.map((c) => ({
      type: c.type,
      page: pageIndex,
      rect: [c.rect[0] + offset[0], c.rect[1] + offset[1], c.rect[2] + offset[0], c.rect[3] + offset[1]],
      name: c.name,
      props: c.props
    }))
    return createFields(s, specs)
  }),

  update: mutation(
    (ids: number[]) => (ids.length > 1 ? 'Edit Properties of Fields' : 'Edit Field Properties'),
    (s, ids: number[], props: FieldProps, rename?: { name: string; join?: boolean }): PFField[] => {
      const fields: PDFObject[] = []
      const extraPages: number[] = []
      if (rename && ids.length === 1) extraPages.push(...renameField(s, ids[0], rename.name, !!rename.join))
      const located = ids.map((id) => locateWidget(s, id))
      for (const { obj, pageIndex } of located) {
        let p = props
        if (props.rect) p = { ...props, rect: clampToPage(s, pageIndex, props.rect) }
        fields.push(applyProps(s, obj, pageIndex, p))
      }
      const pages = refreshFields(s, fields)
      s.touch(...pages, ...extraPages)
      s.documentChanged()
      return located.map(({ obj, pageIndex }) => readField(s, obj, pageIndex, tabIndexOf(s, pageIndex, num(obj))))
    }
  ),

  /**
   * Renames a field. Dotted names create a hierarchy ("address.city"). Renaming a radio button
   * to the name of another radio group moves it into that group; other fields can share a name
   * (and value) with a field of the same type when `join` is set.
   */
  rename: mutation('Rename Field', (s, id: number, name: string, opts: { join?: boolean } = {}): PFField => {
    const { pageIndex } = locateWidget(s, id)
    const pages = renameField(s, id, name, !!opts.join)
    s.touch(pageIndex, ...pages)
    s.documentChanged()
    const again = locateWidget(s, id, pageIndex)
    return readField(s, again.obj, again.pageIndex, tabIndexOf(s, again.pageIndex, id))
  }),

  /** Moves/resizes widgets to new page-space rectangles. */
  setRects: mutation(
    (moves: { id: number; rect: Rect }[]) => (moves.length > 1 ? 'Move Fields' : 'Move Field'),
    (s, moves: { id: number; rect: Rect }[]) => {
      const resized: PDFObject[] = []
      const pages = new Set<number>()
      for (const m of moves) {
        const { obj, pageIndex } = locateWidget(s, m.id)
        const before = readField(s, obj, pageIndex, 0).rect
        const rect = clampToPage(s, pageIndex, m.rect)
        putRect(s, pageIndex, obj, rect)
        const sameSize = Math.abs(before[2] - before[0] - (rect[2] - rect[0])) < 0.01 && Math.abs(before[3] - before[1] - (rect[3] - rect[1])) < 0.01
        if (!sameSize) resized.push(obj)
        pages.add(pageIndex)
      }
      s.invalidatePages()
      for (const w of resized) {
        const p = pageOfWidget(s, w)
        refreshAppearance(s, loadWidget(s, p, num(w)))
      }
      s.touch(...pages)
      s.documentChanged()
    }
  ),

  /** Moves widgets by an offset in points. */
  move: mutation(
    (ids: number[]) => (ids.length > 1 ? 'Move Fields' : 'Move Field'),
    (s, ids: number[], dx: number, dy: number) => {
      const pages = new Set<number>()
      for (const id of ids) {
        const { obj, pageIndex } = locateWidget(s, id)
        const r = readField(s, obj, pageIndex, 0).rect
        putRect(s, pageIndex, obj, clampToPage(s, pageIndex, [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]))
        pages.add(pageIndex)
      }
      s.invalidatePages()
      s.touch(...pages)
      s.documentChanged()
    }
  ),

  /**
   * Duplicates fields. With `pages`, copies each widget onto those pages at the same place as part
   * of the same field (same name, shared value), like Acrobat's "Duplicate across pages". With
   * `offset`, makes independent copies on the same page with new names.
   */
  duplicate: mutation(
    (_ids: number[], opts: { pages?: number[]; offset?: [number, number] }) => (opts.pages ? 'Duplicate Field Across Pages' : 'Duplicate Field'),
    (s, ids: number[], opts: { pages?: number[]; offset?: [number, number] }): PFField[] => {
      const doc = s.pdf
      if (opts.pages) {
        const created: { obj: PDFObject; pageIndex: number }[] = []
        const fields: PDFObject[] = []
        for (const id of ids) {
          const { obj, pageIndex } = locateWidget(s, id)
          const rect = readField(s, obj, pageIndex, 0).rect
          const kind = kindOf(obj)
          for (const target of opts.pages) {
            if (target === pageIndex || target < 0 || target >= s.pageCount()) continue
            const d = doc.newDictionary()
            d.put('Type', doc.newName('Annot'))
            d.put('Subtype', doc.newName('Widget'))
            d.put('P', doc.findPage(target))
            const w = doc.addObject(d)
            for (const key of WIDGET_COPY_KEYS) {
              const v = obj.get(key)
              if (!isNull(v)) w.put(key, deepCopy(s, v))
            }
            putRect(s, target, w, clampToPage(s, target, rect))
            if (kind === 'checkbox' || kind === 'radio') placeholderAP(s, w, onStateName(obj) ?? 'Yes')
            addToPage(s, target, w)
            const field = joinWidgetToField(s, w, fieldOf(obj))
            fields.push(field)
            created.push({ obj: w, pageIndex: target })
          }
        }
        const pages = refreshFields(s, fields)
        s.touch(...pages)
        s.documentChanged()
        return created.map((c) => readField(s, c.obj, c.pageIndex, tabIndexOf(s, c.pageIndex, num(c.obj))))
      }
      const offset = opts.offset ?? [12, 12]
      const specs: CreateSpec[] = ids.map((id) => {
        const { obj, pageIndex } = locateWidget(s, id)
        const f = readField(s, obj, pageIndex, 0)
        if (f.type === 'unknown') throw new EngineError('This field type cannot be duplicated', 'BAD_FIELD')
        return {
          type: f.type as PFType,
          page: pageIndex,
          rect: [f.rect[0] + offset[0], f.rect[1] + offset[1], f.rect[2] + offset[0], f.rect[3] + offset[1]],
          // radio buttons join their group; other fields get a new automatic name
          name: f.type === 'radio' ? f.name : undefined,
          props: propsOf(f)
        }
      })
      return createFields(s, specs)
    }
  ),

  delete: mutation(
    (ids: number[]) => (ids.length > 1 ? 'Delete Fields' : 'Delete Field'),
    (s, ids: number[]) => {
      const pages = new Set<number>()
      const radioFields: PDFObject[] = []
      for (const id of ids) {
        let found
        try {
          found = locateWidget(s, id)
        } catch {
          continue
        }
        const { obj, pageIndex } = found
        const field = fieldOf(obj)
        const kind = kindOf(obj)
        const on = onStateName(obj)
        removeRef(s.pdf.findPage(pageIndex).get('Annots'), obj)
        detachWidget(s, obj)
        if (kind === 'radio' && !sameObj(field, obj) && widgetsOf(field).length) {
          if (on && readName(field.get('V')) === on && !widgetsOf(field).some((w) => onStateName(w) === on)) field.put('V', s.pdf.newName('Off'))
          radioFields.push(field)
        }
        pages.add(pageIndex)
      }
      const more = refreshFields(s, radioFields)
      s.touch(...pages, ...more)
      s.documentChanged()
    }
  ),

  /** Deletes every field except signed signatures. */
  deleteAll: mutation('Delete All Fields', (s): number => {
    let count = 0
    const n = s.pageCount()
    for (let p = 0; p < n; p++) {
      for (const w of pageWidgets(s, p)) {
        if (kindOf(w) === 'signature' && !isNull(fieldOf(w).get('V'))) continue
        removeRef(s.pdf.findPage(p).get('Annots'), w)
        detachWidget(s, w)
        count++
      }
      s.touch(p)
    }
    s.invalidatePages()
    s.documentChanged()
    return count
  }),

  /**
   * Sets a page's tab order. With `ids`, the widgets are put in that order (manual order: the
   * /Annots order with /Tabs /S).
   */
  setTabOrder: mutation('Set Tab Order', (s, pageIndex: number, order: TabOrder, ids?: number[]) => {
    const doc = s.pdf
    const pageObj = doc.findPage(pageIndex)
    if (ids && ids.length) {
      const annots = pageObj.get('Annots')
      if (isNull(annots) || !annots.isArray()) throw new EngineError('This page has no fields', 'NO_FIELD')
      const entries: PDFObject[] = []
      for (let i = 0; i < annots.length; i++) entries.push(annots.get(i))
      const widgetSlots = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.isIndirect() && readName(e.get('Subtype')) === 'Widget')
      const wanted = ids.map((id) => widgetSlots.find(({ e }) => e.asIndirect() === id)?.e).filter((e): e is PDFObject => !!e)
      const rest = widgetSlots.map(({ e }) => e).filter((e) => !wanted.some((w) => sameObj(w, e)))
      const ordered = [...wanted, ...rest]
      const next = doc.newArray()
      let k = 0
      for (let i = 0; i < entries.length; i++) {
        const isWidget = widgetSlots.some((ws) => ws.i === i)
        next.push(isWidget ? ordered[k++] : entries[i])
      }
      pageObj.put('Annots', next)
      pageObj.put('Tabs', doc.newName('S'))
    } else {
      const name = { row: 'R', column: 'C', structure: 'S', unspecified: null }[order]
      if (name) pageObj.put('Tabs', doc.newName(name))
      else pageObj.delete('Tabs')
    }
    s.invalidatePages()
    s.touch(pageIndex)
    s.documentChanged()
  }),

  /** Sets the calculation order (/CO) from field widget ids, first calculated first. */
  setCalculationOrder: mutation('Set Calculation Order', (s, ids: number[]) => {
    const acro = ensureAcroForm(s)
    const co = s.pdf.newArray()
    for (const id of ids) {
      const { obj } = locateWidget(s, id)
      const field = fieldOf(obj)
      if (indexOfRef(co, field) < 0) co.push(field)
    }
    if (co.length) acro.put('CO', co)
    else acro.delete('CO')
    s.documentChanged()
  })
})
