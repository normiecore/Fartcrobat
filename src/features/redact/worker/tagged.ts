/**
 * Replacement text that would survive a redaction. Tagged PDFs repeat what a page shows in places
 * MuPDF's redaction filter leaves alone: /ActualText, /Alt and /E entries of marked-content
 * property lists in the page content, and the same entries on structure elements (the alternate
 * description of a figure, the spoken text of a span...). After redacting a page, every
 * marked-content sequence whose content changed loses those entries, and so do the structure
 * elements (and their ancestors) that own the changed content. Unchanged content keeps them.
 */
import type { PDFObject, Session } from '@engine/session'
import { isNull, readName } from '@engine/util/pdf'
import {
  binaryToBytes,
  bytesToBinary,
  decodeName,
  dictEntries,
  operandStrings,
  PAINT,
  removeDictKeys,
  SHOW_TEXT,
  tokenize,
  type ContentOp
} from './contentFilter'

/** Entries that carry text standing in for content. */
export const REPLACEMENT_KEYS = new Set(['ActualText', 'Alt', 'E'])

function dict(obj: PDFObject | null | undefined): PDFObject | null {
  if (!obj || isNull(obj)) return null
  const o = obj.resolve()
  return o.isDictionary() ? o : null
}

function objNum(obj: PDFObject | null | undefined): number {
  return obj && !isNull(obj) && obj.isIndirect() ? obj.asIndirect() : 0
}

/** One marked-content sequence (BDC ... EMC) of a content stream. */
export interface MarkedSequence {
  /** Position among the BDC operators of the stream. */
  index: number
  op: ContentOp
  /** Inline property list ("<< ... >>"), or null. */
  dict: string | null
  /** Name of a /Properties resource, or null. */
  resource: string | null
  mcid: number | null
  /** Whether the property list carries replacement text. */
  hasReplacement: boolean
  /** What the sequence draws: the bytes of the strings it shows and the objects it paints. */
  signature: string
}

export interface ContentContext {
  /** Identity of an XObject resource (its object number), so a redacted copy reads as a change. */
  xobject(name: string): string
  /** The /Properties resource with this name. */
  property(name: string): PDFObject | null
}

/** Lists the marked-content sequences of a content stream with what each one draws. */
export function markedSequences(src: string, ctx: ContentContext): MarkedSequence[] {
  const ops = tokenize(src)
  const out: MarkedSequence[] = []
  const open: (MarkedSequence | null)[] = []
  // shown text and painted objects are kept apart: the redaction filter may split or merge
  // text-showing operators without changing what they show
  const text = new Map<MarkedSequence, string>()
  const marks = new Map<MarkedSequence, string>()
  const addText = (piece: string) => {
    for (const seq of open) if (seq) text.set(seq, (text.get(seq) ?? '') + piece)
  }
  const add = (piece: string) => {
    for (const seq of open) if (seq) marks.set(seq, (marks.get(seq) ?? '') + piece)
  }
  for (const op of ops) {
    if (op.op === 'BMC') {
      open.push(null)
      continue
    }
    if (op.op === 'BDC') {
      const prop = op.operands[1]
      let d: string | null = null
      let resource: string | null = null
      let mcid: number | null = null
      let hasReplacement = false
      if (prop?.kind === 'dict') {
        d = prop.text
        for (const e of dictEntries(d)) {
          if (REPLACEMENT_KEYS.has(e.key)) hasReplacement = true
          if (e.key === 'MCID') {
            const v = parseInt(d.slice(e.start + 5, e.end).trim(), 10)
            if (Number.isFinite(v)) mcid = v
          }
        }
      } else if (prop?.kind === 'name') {
        resource = decodeName(prop.text.slice(1))
        const p = dict(ctx.property(resource))
        if (p) {
          for (const k of REPLACEMENT_KEYS) if (!isNull(p.get(k))) hasReplacement = true
          const m = p.get('MCID')
          if (!isNull(m) && m.isNumber()) mcid = m.asNumber()
        }
      }
      const seq: MarkedSequence = { index: out.length, op, dict: d, resource, mcid, hasReplacement, signature: '' }
      out.push(seq)
      open.push(seq)
      continue
    }
    if (op.op === 'EMC') {
      open.pop()
      continue
    }
    if (!open.some(Boolean)) continue
    if (SHOW_TEXT.has(op.op)) {
      addText(op.operands.map(operandStrings).join(''))
    } else if (op.op === 'Do') {
      const name = op.operands[0]
      add(`D${name?.kind === 'name' ? ctx.xobject(decodeName(name.text.slice(1))) : '?'};`)
    } else if (op.op === 'BI') {
      add(`I${op.end - op.start};`)
    } else if (op.op === 'sh') {
      add('H')
    } else if (PAINT.has(op.op)) {
      add('P')
    }
  }
  for (const seq of out) seq.signature = `${text.get(seq) ?? ''}\u0000${marks.get(seq) ?? ''}`
  return out
}

function readContents(s: Session, owner: PDFObject): { src: string; streams: PDFObject[] } {
  const contents = owner.get('Contents')
  if (isNull(contents)) return { src: '', streams: [] }
  const c = contents.resolve()
  const streams: PDFObject[] = []
  if (c.isArray()) for (let i = 0; i < c.length; i++) streams.push(c.get(i))
  else streams.push(contents)
  return { src: streams.map((st) => bytesToBinary(st.readStream().asUint8Array())).join('\n'), streams }
}

function pageContext(s: Session, pageIndex: number): ContentContext {
  const res = dict(s.pdf.findPage(pageIndex).getInheritable('Resources'))
  const xobjects = dict(res?.get('XObject'))
  const props = dict(res?.get('Properties'))
  return {
    xobject: (name) => {
      const ref = xobjects?.get(name)
      return ref && !isNull(ref) ? String(objNum(ref) || name) : name
    },
    property: (name) => props?.get(name) ?? null
  }
}

/** XObjects the page draws (directly or through forms), by object number. */
function xobjectNumbers(s: Session, pageIndex: number): Set<number> {
  const out = new Set<number>()
  const visit = (res: PDFObject | null, depth: number) => {
    const xobjects = dict(res?.get('XObject'))
    if (!xobjects || depth > 12) return
    xobjects.forEach((ref) => {
      const n = objNum(ref)
      if (!n || out.has(n)) return
      out.add(n)
      const x = dict(ref)
      if (x && readName(x.get('Subtype')) === 'Form') visit(dict(x.get('Resources')), depth + 1)
    })
  }
  visit(dict(s.pdf.findPage(pageIndex).getInheritable('Resources')), 0)
  return out
}

export interface TaggedSnapshot {
  sequences: MarkedSequence[]
  xobjects: Set<number>
}

/** Records what each marked-content sequence of a page draws (call before redacting it). */
export function snapshotPage(s: Session, pageIndex: number): TaggedSnapshot {
  const { src } = readContents(s, s.pdf.findPage(pageIndex))
  return { sequences: markedSequences(src, pageContext(s, pageIndex)), xobjects: xobjectNumbers(s, pageIndex) }
}

/** Removes replacement text from every marked-content property list of a form XObject (and the forms it draws). */
function stripForm(s: Session, ref: PDFObject, done: Set<number>, depth = 0): void {
  const n = objNum(ref)
  if (!n || done.has(n) || depth > 12) return
  done.add(n)
  const x = dict(ref)
  if (!x || readName(x.get('Subtype')) !== 'Form') return
  const res = dict(x.get('Resources'))
  const src = bytesToBinary(ref.readStream().asUint8Array())
  const props = dict(res?.get('Properties'))
  let out = ''
  let last = 0
  for (const op of tokenize(src)) {
    if (op.op !== 'BDC') continue
    const prop = op.operands[1]
    if (prop?.kind === 'dict' && dictEntries(prop.text).some((e) => REPLACEMENT_KEYS.has(e.key))) {
      const at = src.indexOf(prop.text, op.start)
      if (at >= 0) {
        out += src.slice(last, at) + removeDictKeys(prop.text, REPLACEMENT_KEYS)
        last = at + prop.text.length
      }
    } else if (prop?.kind === 'name') {
      const p = dict(props?.get(decodeName(prop.text.slice(1))))
      if (p) for (const k of REPLACEMENT_KEYS) if (!isNull(p.get(k))) p.delete(k)
    }
  }
  if (last > 0) ref.writeStream(binaryToBytes(out + src.slice(last)))
  dict(res?.get('XObject'))?.forEach((child) => stripForm(s, child, done, depth + 1))
}

/**
 * After a page was redacted: removes replacement text from the marked-content sequences whose
 * content changed (and from redacted copies of form XObjects). Returns the MCIDs whose content
 * changed or disappeared ('all' when sequences can no longer be matched one to one).
 */
export function cleanRedactedPage(s: Session, pageIndex: number, before: TaggedSnapshot): Set<number> | 'all' {
  const pageObj = s.pdf.findPage(pageIndex)
  const { src, streams } = readContents(s, pageObj)
  const ctx = pageContext(s, pageIndex)
  const after = markedSequences(src, ctx)
  const matched = after.length === before.sequences.length
  const beforeByMcid = new Map<number, string>()
  for (const q of before.sequences) if (q.mcid !== null) beforeByMcid.set(q.mcid, (beforeByMcid.get(q.mcid) ?? '') + '|' + q.signature)
  const afterByMcid = new Map<number, string>()
  for (const q of after) if (q.mcid !== null) afterByMcid.set(q.mcid, (afterByMcid.get(q.mcid) ?? '') + '|' + q.signature)
  const changedMcids = new Set<number>()
  for (const [mcid, sig] of beforeByMcid) if (afterByMcid.get(mcid) !== sig) changedMcids.add(mcid)

  const changed = (q: MarkedSequence) => {
    if (q.mcid !== null && changedMcids.has(q.mcid)) return true
    return !matched || before.sequences[q.index].signature !== q.signature
  }

  // rewrite inline property lists; edit /Properties resources in place
  let out = ''
  let last = 0
  for (const q of after) {
    if (!q.hasReplacement || !changed(q)) continue
    if (q.dict !== null) {
      const at = src.indexOf(q.dict, q.op.start)
      if (at < 0) continue
      out += src.slice(last, at) + removeDictKeys(q.dict, REPLACEMENT_KEYS)
      last = at + q.dict.length
    } else if (q.resource !== null) {
      const p = dict(ctx.property(q.resource))
      if (p) for (const k of REPLACEMENT_KEYS) if (!isNull(p.get(k))) p.delete(k)
    }
  }
  if (last > 0) {
    const bytes = binaryToBytes(out + src.slice(last))
    if (streams.length === 1) streams[0].writeStream(bytes)
    else pageObj.put('Contents', s.pdf.addStream(bytes, s.pdf.newDictionary()))
  }

  // form XObjects the redaction rewrote are new objects: their tagged text goes too
  const done = new Set<number>()
  const xobjects = dict(dict(pageObj.getInheritable('Resources'))?.get('XObject'))
  xobjects?.forEach((ref) => {
    const n = objNum(ref)
    if (n && !before.xobjects.has(n)) stripForm(s, ref, done)
  })

  return matched ? changedMcids : 'all'
}

/**
 * Removes /Alt, /ActualText and /E from structure elements that own changed content (and from
 * their ancestors, whose text describes the whole subtree). `changed` maps page object numbers to
 * the MCIDs whose content changed on that page.
 */
export function cleanStructureTree(s: Session, changed: Map<number, Set<number> | 'all'>): number {
  if (!changed.size) return 0
  const root = dict(s.pdf.getTrailer().get('Root').get('StructTreeRoot'))
  if (!root) return 0
  const seen = new Set<number>()
  let cleaned = 0
  const hits = (page: number, mcid: number) => {
    const c = changed.get(page)
    return !!c && (c === 'all' || c.has(mcid))
  }
  const strip = (elem: PDFObject) => {
    let any = false
    for (const k of REPLACEMENT_KEYS) {
      if (!isNull(elem.get(k))) {
        elem.delete(k)
        any = true
      }
    }
    if (any) cleaned++
  }
  /** Returns true when the element's subtree owns changed content. */
  const visit = (node: PDFObject, page: number, depth: number): boolean => {
    if (depth > 200) return false
    const n = objNum(node)
    if (n) {
      if (seen.has(n)) return false
      seen.add(n)
    }
    const elem = dict(node)
    if (!elem) return false
    const pg = objNum(elem.get('Pg')) || page
    let hit = false
    const visitKid = (kid: PDFObject) => {
      const k = kid.resolve()
      if (k.isNumber()) {
        if (hits(pg, k.asNumber())) hit = true
        return
      }
      if (!k.isDictionary()) return
      const type = readName(k.get('Type'))
      if (type === 'MCR') {
        const mcid = k.get('MCID')
        const mpg = objNum(k.get('Pg')) || pg
        if (!isNull(mcid) && mcid.isNumber() && hits(mpg, mcid.asNumber())) hit = true
        return
      }
      if (type === 'OBJR') return
      if (visit(kid, pg, depth + 1)) hit = true
    }
    const kids = elem.get('K')
    if (!isNull(kids)) {
      const k = kids.resolve()
      if (k.isArray()) for (let i = 0; i < k.length; i++) visitKid(k.get(i))
      else visitKid(kids)
    }
    if (hit) strip(elem)
    return hit
  }
  const top = root.get('K')
  if (!isNull(top)) {
    const k = top.resolve()
    if (k.isArray()) for (let i = 0; i < k.length; i++) visit(k.get(i), 0, 0)
    else visit(top, 0, 0)
  }
  return cleaned
}
