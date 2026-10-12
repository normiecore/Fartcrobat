/**
 * Form data files: XFDF (Acrobat's XML format), FDF (Acrobat's PDF-syntax format) and a simple
 * JSON format. Pure functions so they can be unit tested; FDF parsing itself happens in the engine.
 */
import type { ExportedField } from './engine'

export interface DataEntry {
  name: string
  value: string | string[]
}

// ---- XML ------------------------------------------------------------------------------------

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: (XmlElement | string)[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

/** A small, non-validating XML parser (elements, attributes, text, CDATA, comments). */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  let i = 0
  const n = xml.length
  while (i < n) {
    const lt = xml.indexOf('<', i)
    const textEnd = lt < 0 ? n : lt
    if (textEnd > i) {
      const text = decodeEntities(xml.slice(i, textEnd))
      if (text) stack[stack.length - 1].children.push(text)
    }
    if (lt < 0) break
    i = lt
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4)
      if (end < 0) throw new Error('Unterminated comment')
      i = end + 3
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9)
      if (end < 0) throw new Error('Unterminated CDATA section')
      stack[stack.length - 1].children.push(xml.slice(i + 9, end))
      i = end + 3
    } else if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2)
      if (end < 0) throw new Error('Unterminated processing instruction')
      i = end + 2
    } else if (xml.startsWith('<!', i)) {
      // DOCTYPE: skip, including an internal subset
      let depth = 0
      let j = i + 2
      for (; j < n; j++) {
        if (xml[j] === '[') depth++
        else if (xml[j] === ']') depth--
        else if (xml[j] === '>' && depth <= 0) break
      }
      i = j + 1
    } else if (xml[i + 1] === '/') {
      const end = xml.indexOf('>', i)
      if (end < 0) throw new Error('Unterminated tag')
      const name = xml.slice(i + 2, end).trim()
      const top = stack.pop()
      if (!top || top.name !== name || stack.length === 0) throw new Error(`Unexpected closing tag </${name}>`)
      i = end + 1
    } else {
      const m = /^<([A-Za-z_][\w:.-]*)/.exec(xml.slice(i, i + 200))
      if (!m) throw new Error('Invalid tag')
      const el: XmlElement = { name: m[1], attrs: {}, children: [] }
      let j = i + m[0].length
      const attrRe = /\s*([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/y
      for (;;) {
        attrRe.lastIndex = j
        const a = attrRe.exec(xml)
        if (!a) break
        el.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '')
        j = attrRe.lastIndex
      }
      while (j < n && /\s/.test(xml[j])) j++
      const selfClosing = xml[j] === '/'
      if (selfClosing) j++
      if (xml[j] !== '>') throw new Error(`Malformed tag <${el.name}>`)
      stack[stack.length - 1].children.push(el)
      if (!selfClosing) stack.push(el)
      i = j + 1
    }
  }
  if (stack.length !== 1) throw new Error(`Missing closing tag </${stack[stack.length - 1].name}>`)
  return root
}

function localName(name: string): string {
  const i = name.indexOf(':')
  return i >= 0 ? name.slice(i + 1) : name
}

function elements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && (!name || localName(c.name) === name))
}

function textOf(el: XmlElement): string {
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // characters XML 1.0 cannot carry
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

// ---- XFDF -----------------------------------------------------------------------------------

interface TreeNode {
  children: Map<string, TreeNode>
  value?: string | string[]
}

function toTree(entries: DataEntry[]): TreeNode {
  const root: TreeNode = { children: new Map() }
  for (const e of entries) {
    let node = root
    for (const part of e.name.split('.')) {
      let next = node.children.get(part)
      if (!next) {
        next = { children: new Map() }
        node.children.set(part, next)
      }
      node = next
    }
    node.value = e.value
  }
  return root
}

/** Values to export: everything except fields marked "do not export". */
export function exportEntries(fields: ExportedField[]): DataEntry[] {
  return fields.filter((f) => !f.noExport).map((f) => ({ name: f.name, value: f.value }))
}

export function buildXfdf(entries: DataEntry[], pdfFileName: string): string {
  const lines: string[] = []
  const write = (node: TreeNode, indent: string) => {
    for (const [name, child] of node.children) {
      lines.push(`${indent}<field name="${escapeXml(name)}">`)
      if (child.value !== undefined) {
        const values = Array.isArray(child.value) ? child.value : [child.value]
        for (const v of values) lines.push(`${indent}  <value>${escapeXml(v)}</value>`)
      }
      write(child, indent + '  ')
      lines.push(`${indent}</field>`)
    }
  }
  write(toTree(entries), '    ')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
    `  <f href="${escapeXml(pdfFileName)}"/>`,
    '  <fields>',
    ...lines,
    '  </fields>',
    '</xfdf>',
    ''
  ].join('\n')
}

export function parseXfdf(xml: string): DataEntry[] {
  const doc = parseXml(xml.replace(/^\ufeff/, ''))
  const root = elements(doc).find((e) => localName(e.name) === 'xfdf')
  if (!root) throw new Error('This is not an XFDF file')
  const out: DataEntry[] = []
  const visit = (el: XmlElement, prefix: string) => {
    for (const f of elements(el, 'field')) {
      const name = prefix ? `${prefix}.${f.attrs.name ?? ''}` : (f.attrs.name ?? '')
      const values = elements(f, 'value').map(textOf)
      const rich = elements(f, 'value-richtext')
      if (values.length > 1) out.push({ name, value: values })
      else if (values.length === 1) out.push({ name, value: values[0] })
      else if (rich.length) out.push({ name, value: textOf(rich[0]).trim() })
      visit(f, name)
    }
  }
  for (const fields of elements(root, 'fields')) visit(fields, '')
  return out
}

// ---- JSON -----------------------------------------------------------------------------------

export function buildJson(entries: DataEntry[], pdfFileName: string): string {
  const fields: Record<string, string | string[]> = {}
  for (const e of entries) fields[e.name] = e.value
  return JSON.stringify({ format: 'fartcrobat-form-data', version: 1, source: pdfFileName, fields }, null, 2) + '\n'
}

function jsonValue(v: unknown): string | string[] | null {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'true' : 'Off'
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? '' : String(x)))
  return null
}

/** Accepts {fields: {...}} or a plain object; nested objects become dotted names. */
export function parseJsonData(text: string): DataEntry[] {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ''))
  } catch (err) {
    throw new Error(`This is not valid JSON (${(err as Error).message})`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The JSON file must contain an object of field values')
  const obj = data as Record<string, unknown>
  const fields = obj.fields && typeof obj.fields === 'object' && !Array.isArray(obj.fields) ? (obj.fields as Record<string, unknown>) : obj
  const out: DataEntry[] = []
  const visit = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (fields === obj && prefix === '' && (k === 'format' || k === 'version' || k === 'source')) continue
      const name = prefix ? `${prefix}.${k}` : k
      const value = jsonValue(v)
      if (value !== null) out.push({ name, value })
      else if (v && typeof v === 'object' && depth < 32) visit(v as Record<string, unknown>, name, depth + 1)
    }
  }
  visit(fields, '', 0)
  return out
}

// ---- FDF ------------------------------------------------------------------------------------

function pdfString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'
  let hex = 'FEFF'
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return `<${hex}>`
}

function pdfName(s: string): string {
  return '/' + [...new TextEncoder().encode(s)].map((b) => (b > 0x20 && b < 0x7f && !'#()<>[]{}/%'.includes(String.fromCharCode(b)) ? String.fromCharCode(b) : '#' + b.toString(16).padStart(2, '0'))).join('')
}

/** FDF with values as strings, check box / radio states as names. */
export function buildFdf(fields: ExportedField[], pdfFileName: string): Uint8Array {
  const items = fields
    .filter((f) => !f.noExport)
    .map((f) => {
      let v: string
      if (Array.isArray(f.value)) v = `[${f.value.map(pdfString).join(' ')}]`
      else if (f.type === 'checkbox' || f.type === 'radio') v = pdfName(f.value || 'Off')
      else v = pdfString(f.value)
      return `<< /T ${pdfString(f.name)} /V ${v} >>`
    })
  const body = `%FDF-1.2\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /FDF << /F ${pdfString(pdfFileName)} /Fields [\n${items.join('\n')}\n] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`
  const out = new Uint8Array(body.length)
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff
  return out
}

/** Guesses the format of a data file from its name and content. */
export function dataFormat(path: string, bytes: Uint8Array): 'xfdf' | 'fdf' | 'json' | null {
  const ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase()
  if (ext === 'xfdf' || ext === 'xml') return 'xfdf'
  if (ext === 'fdf') return 'fdf'
  if (ext === 'json') return 'json'
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^\ufeff/, '').trimStart()
  if (head.startsWith('%FDF')) return 'fdf'
  if (head.startsWith('<')) return 'xfdf'
  if (head.startsWith('{')) return 'json'
  return null
}
