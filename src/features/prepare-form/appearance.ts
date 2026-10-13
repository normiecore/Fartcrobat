/**
 * Appearance streams for form fields. MuPDF synthesises good appearances for text, choice and
 * push-button fields; check boxes, radio buttons, unsigned signature fields and the border styles
 * MuPDF does not draw (dashed, beveled, inset, underline) are written here, the way Acrobat draws
 * them.
 */
import { hexToRgb } from '@shared/geometry'
import type { PDFObject, PDFWidget, Session } from '@engine/session'
import { isNull, readName, readNumber, readString } from '@engine/util/pdf'
import { CHECK_CHARS, type BorderStyle, type CheckStyle } from './model'
import {
  colorOps,
  ensureFont,
  fieldOf,
  formatDA,
  kindOf,
  mkColor,
  newArray,
  onStateName,
  readDA,
  readNumberArray
} from './fieldDict'

/** ZapfDingbats advance widths (1/1000 em) of the check-style glyphs. */
const ZADB_WIDTH: Record<string, number> = { '4': 846, l: 791, '8': 760, u: 788, n: 761, H: 816 }

const f = (v: number) => {
  const s = v.toFixed(3)
  return s.replace(/\.?0+$/, '') || '0'
}

export function borderStyleOf(w: PDFObject): BorderStyle {
  const s = readName(w.get('BS', 'S'))
  switch (s) {
    case 'D':
      return 'dashed'
    case 'B':
      return 'beveled'
    case 'I':
      return 'inset'
    case 'U':
      return 'underline'
    default:
      return 'solid'
  }
}

export function borderWidthOf(w: PDFObject): number {
  const bs = w.get('BS')
  if (!isNull(bs) && !isNull(bs.get('W'))) return readNumber(bs.get('W'), 1)
  const border = readNumberArray(w.get('Border'))
  if (border && border.length >= 3) return border[2]
  return 1
}

export function checkStyleOf(w: PDFObject): CheckStyle {
  const ca = readString(w.get('MK', 'CA'))
  for (const [k, v] of Object.entries(CHECK_CHARS) as [CheckStyle, string][]) if (v === ca) return k
  return kindOf(w) === 'radio' ? 'circle' : 'check'
}

function orientationOf(w: PDFObject): number {
  const r = Math.round(readNumber(w.get('MK', 'R'), 0))
  return ((r % 360) + 360) % 360
}

/** Size of the widget in its own (unrotated) appearance space, and the /Matrix for /MK /R. */
function appearanceBox(w: PDFObject): { width: number; height: number; matrix: number[] } {
  const r = readNumberArray(w.get('Rect')) ?? [0, 0, 0, 0]
  const rw = Math.abs(r[2] - r[0])
  const rh = Math.abs(r[3] - r[1])
  switch (orientationOf(w)) {
    case 90:
      return { width: rh, height: rw, matrix: [0, 1, -1, 0, rw, 0] }
    case 180:
      return { width: rw, height: rh, matrix: [-1, 0, 0, -1, rw, rh] }
    case 270:
      return { width: rh, height: rw, matrix: [0, -1, 1, 0, 0, rh] }
    default:
      return { width: rw, height: rh, matrix: [1, 0, 0, 1, 0, 0] }
  }
}

function shade(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex)
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v * factor)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Content stream operators for a rectangular border in the given style. */
export function borderOps(
  style: BorderStyle,
  width: number,
  height: number,
  bw: number,
  color: string | null,
  fill: string | null
): string {
  if (!color || bw <= 0) return ''
  const h = bw / 2
  const out: string[] = ['q', `${f(bw)} w`, colorOps(color, true)]
  if (style === 'underline') {
    out.push(`0 ${f(h)} m ${f(width)} ${f(h)} l S`)
  } else {
    if (style === 'dashed') out.push(`[${f(Math.max(2, bw * 3))}] 0 d`)
    out.push(`${f(h)} ${f(h)} ${f(width - bw)} ${f(height - bw)} re S`)
    if (style === 'beveled' || style === 'inset') {
      const base = fill ?? '#ffffff'
      const light = style === 'beveled' ? '#ffffff' : '#808080'
      const dark = style === 'beveled' ? shade(base, 0.5) : '#bfbfbf'
      const a = bw
      const b = bw * 2
      out.push(
        colorOps(light),
        `${f(a)} ${f(a)} m ${f(a)} ${f(height - a)} l ${f(width - a)} ${f(height - a)} l ${f(width - b)} ${f(height - b)} l ${f(b)} ${f(height - b)} l ${f(b)} ${f(b)} l f`,
        colorOps(dark),
        `${f(width - a)} ${f(height - a)} m ${f(width - a)} ${f(a)} l ${f(a)} ${f(a)} l ${f(b)} ${f(b)} l ${f(width - b)} ${f(b)} l ${f(width - b)} ${f(height - b)} l f`
      )
    }
  }
  out.push('Q')
  return out.join('\n')
}

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  const k = 0.5523
  return [
    `${f(cx + rx)} ${f(cy)} m`,
    `${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c`,
    `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c`,
    `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c`,
    `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c`
  ].join(' ')
}

function formStream(
  s: Session,
  content: string,
  width: number,
  height: number,
  matrix: number[],
  fonts: boolean
): PDFObject {
  const doc = s.pdf
  const dict = doc.newDictionary()
  dict.put('Type', doc.newName('XObject'))
  dict.put('Subtype', doc.newName('Form'))
  dict.put('BBox', newArray(doc, [0, 0, Math.round(width * 1000) / 1000, Math.round(height * 1000) / 1000]))
  if (matrix.some((v, i) => v !== [1, 0, 0, 1, 0, 0][i])) dict.put('Matrix', newArray(doc, matrix))
  const res = doc.newDictionary()
  if (fonts) {
    const zadb = ensureFont(s, 'ZaDb')
    const fd = doc.newDictionary()
    if (zadb) fd.put('ZaDb', zadb)
    res.put('Font', fd)
  }
  dict.put('Resources', res)
  return doc.addStream(content, dict)
}

/** Writes Acrobat-style On/Off (normal and down) appearances for a check box or radio button. */
export function writeToggleAppearance(s: Session, w: PDFObject) {
  const doc = s.pdf
  const kind = kindOf(w)
  const radio = kind === 'radio'
  const { width, height, matrix } = appearanceBox(w)
  const bc = mkColor(w, 'BC')
  const bg = mkColor(w, 'BG')
  const bw = bc ? borderWidthOf(w) : 0
  const style = borderStyleOf(w)
  const da = readDA(s, w)
  const ch = readString(w.get('MK', 'CA')) || (radio ? CHECK_CHARS.circle : CHECK_CHARS.check)
  const on = onStateName(w) ?? (radio ? 'Choice1' : 'Yes')

  const frame = (down: boolean): string => {
    const parts: string[] = []
    const fill = down ? shade(bg ?? '#ffffff', 0.75) : bg
    if (radio) {
      const cx = width / 2
      const cy = height / 2
      const r = Math.min(width, height) / 2
      if (fill) parts.push('q', colorOps(fill), ellipse(cx, cy, r, r), 'f', 'Q')
      if (bc && bw > 0) {
        parts.push('q', `${f(bw)} w`, colorOps(bc, true))
        if (style === 'dashed') parts.push(`[${f(Math.max(2, bw * 3))}] 0 d`)
        parts.push(ellipse(cx, cy, r - bw / 2, r - bw / 2), 'S', 'Q')
      }
    } else {
      if (fill) parts.push('q', colorOps(fill), `0 0 ${f(width)} ${f(height)} re f`, 'Q')
      parts.push(borderOps(style, width, height, bw, bc, fill))
    }
    return parts.filter(Boolean).join('\n')
  }

  const glyph = (): string => {
    const inner = Math.max(1, Math.min(width, height) - 2 * bw - (radio ? 2 : 1))
    let size = da.size > 0 ? da.size : inner * (radio && ch === CHECK_CHARS.circle ? 0.62 : 0.86)
    if (radio && ch === CHECK_CHARS.circle && da.size <= 0)
      size = Math.max(1, (Math.min(width, height) - 2 * bw) * 0.62)
    const gw = ((ZADB_WIDTH[ch] ?? 800) / 1000) * size
    const x = (width - gw) / 2
    const y = height / 2 - 0.345 * size
    return [
      'q',
      'BT',
      colorOps(da.color),
      `/ZaDb ${f(size)} Tf`,
      `${f(x)} ${f(y)} Td`,
      `(${ch.replace(/([()\\])/g, '\\$1')}) Tj`,
      'ET',
      'Q'
    ].join('\n')
  }

  const nDict = doc.newDictionary()
  nDict.put(on, formStream(s, frame(false) + '\n' + glyph(), width, height, matrix, true))
  nDict.put('Off', formStream(s, frame(false), width, height, matrix, false))
  const dDict = doc.newDictionary()
  dDict.put(on, formStream(s, frame(true) + '\n' + glyph(), width, height, matrix, true))
  dDict.put('Off', formStream(s, frame(true), width, height, matrix, false))
  const ap = doc.newDictionary()
  ap.put('N', nDict)
  ap.put('D', dDict)
  w.put('AP', ap)
  // keep /AS in line with the field value
  const field = fieldOf(w)
  const v = readName(field.get('V'))
  w.put('AS', doc.newName(v === on ? on : 'Off'))
}

/** Export value -> label of a choice field's options (only where they differ). */
function choiceLabels(field: PDFObject): Map<string, string> {
  const out = new Map<string, string>()
  const opt = field.getInheritable('Opt')
  if (isNull(opt) || !opt.isArray()) return out
  for (let i = 0; i < opt.length; i++) {
    const o = opt.get(i).resolve()
    if (o.isArray() && o.length >= 2) {
      const value = readString(o.get(0))
      const label = readString(o.get(1))
      if (value !== label) out.set(value, label)
    }
  }
  return out
}

/** Appearance of an unsigned signature field: just its fill and border (like Acrobat). */
export function writeBoxAppearance(s: Session, w: PDFObject) {
  const { width, height, matrix } = appearanceBox(w)
  const bc = mkColor(w, 'BC')
  const bg = mkColor(w, 'BG')
  const bw = bc ? borderWidthOf(w) : 0
  const parts: string[] = []
  if (bg) parts.push('q', colorOps(bg), `0 0 ${f(width)} ${f(height)} re f`, 'Q')
  parts.push(borderOps(borderStyleOf(w), width, height, bw, bc, bg))
  const ap = s.pdf.newDictionary()
  ap.put('N', formStream(s, parts.filter(Boolean).join('\n'), width, height, matrix, false))
  w.put('AP', ap)
}

/**
 * Regenerates the appearance of one widget after its properties changed. `widget` must be the
 * loaded MuPDF widget for `w`.
 */
export function refreshAppearance(s: Session, widget: PDFWidget) {
  const w = widget.getObject()
  const kind = kindOf(w)
  if (kind === 'checkbox' || kind === 'radio') {
    // let MuPDF settle its own state first, then replace the appearance with ours
    try {
      widget.update()
    } catch {}
    writeToggleAppearance(s, w)
    return
  }
  if (kind === 'signature') {
    if (!isNull(fieldOf(w).get('V'))) return // signed: keep the signature appearance
    try {
      widget.update()
    } catch {}
    writeBoxAppearance(s, w)
    return
  }
  const style = borderStyleOf(w)
  const mk = w.get('MK')
  const custom = kind !== 'button' && style !== 'solid' && !isNull(mk) && !!mkColor(w, 'BC')
  const savedBC = custom ? mk.get('BC') : null
  if (custom) mk.delete('BC')
  // Temporary tweaks so MuPDF draws what Acrobat draws; undone right after the update.
  const restore: (() => void)[] = []
  const field = fieldOf(w)
  if (kind === 'combo' || kind === 'list') {
    // show option labels rather than export values
    const labels = choiceLabels(field)
    const v = field.get('V')
    if (!isNull(v) && labels.size) {
      const r = v.resolve()
      const vals = r.isArray()
        ? Array.from({ length: r.length }, (_, i) => readString(r.get(i)))
        : [readString(r)]
      const shown = vals.map((x) => labels.get(x) ?? x)
      if (shown.some((x, i) => x !== vals[i])) {
        const doc = s.pdf
        field.put(
          'V',
          shown.length === 1
            ? doc.newString(shown[0])
            : newArray(
                doc,
                shown.map((x) => doc.newString(x))
              )
        )
        restore.push(() => field.put('V', v))
      }
    }
  }
  if ((kind === 'text' || kind === 'date') && readNumber(w.getInheritable('Ff'), 0) & (1 << 24)) {
    // MuPDF sizes automatic comb text too large; pick the size Acrobat would use
    const da = readDA(s, w)
    const cells = Math.max(1, readNumber(w.getInheritable('MaxLen'), 0))
    if (da.size <= 0 && cells > 1) {
      const { width, height } = appearanceBox(w)
      const bw = mkColor(w, 'BC') ? borderWidthOf(w) : 0
      const size = Math.max(4, Math.min(72, (height - 2 * bw - 2) * 0.72, (width / cells) * 1.1))
      const own = w.get('DA')
      w.put('DA', s.pdf.newString(formatDA({ ...da, size })))
      restore.push(() => (isNull(own) ? w.delete('DA') : w.put('DA', own)))
    }
  }
  try {
    widget.setRect(widget.getRect()) // marks the widget as needing a new appearance
    widget.update()
  } finally {
    if (savedBC) mk.put('BC', savedBC)
    for (const r of restore) r()
  }
  if (custom) {
    const n = w.get('AP', 'N')
    if (!isNull(n) && n.isStream()) {
      const bbox = readNumberArray(n.get('BBox')) ?? [0, 0, 0, 0]
      const width = bbox[2] - bbox[0]
      const height = bbox[3] - bbox[1]
      const content = n.readStream().asString()
      const extra = borderOps(style, width, height, borderWidthOf(w), mkColor(w, 'BC'), mkColor(w, 'BG'))
      n.writeStream(`${content}\n${extra}\n`)
    }
  }
}
