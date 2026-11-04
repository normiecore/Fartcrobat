/** Structured CV/report layout: data only, escaped before the native HTML paginator sees it. */
import { EngineError } from '@engine/define'
export interface ReflowEntry {
  heading: string
  detail?: string
  date?: string
  paragraphs?: string[]
  bullets?: string[]
}
export interface ReflowSection {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
  entries?: ReflowEntry[]
}
export interface ReflowSpec {
  title: string
  subtitle?: string
  sections: ReflowSection[]
  page_size?: 'A4' | 'Letter'
  font_size?: number
  font?: 'sans' | 'serif'
}
const esc = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  )

/** The new design without the sections rejected in the review (0-based section numbers). */
export function reviseReflowSpec(spec: ReflowSpec, rejected: number[]): ReflowSpec {
  const sections = spec.sections.filter((_, i) => !rejected.includes(i))
  if (!sections.length) throw new EngineError('Keep at least one section of the new design.', 'BAD_REFLOW')
  return { ...spec, sections }
}

/** A section's text in reading order, one line per heading, paragraph or bullet. */
export function sectionText(s: ReflowSection): string {
  const body = (b: { paragraphs?: string[]; bullets?: string[] }) => [
    ...(b.paragraphs ?? []),
    ...(b.bullets ?? []).map((t) => '• ' + t)
  ]
  return [
    s.heading,
    ...body(s),
    ...(s.entries ?? []).flatMap((e) => [
      [e.heading, e.date].filter(Boolean).join(', '),
      ...(e.detail ? [e.detail] : []),
      ...body(e)
    ])
  ].join('\n')
}

export function reflowHtml(spec: ReflowSpec): string {
  const fail = (m: string): never => {
    throw new EngineError(m, 'BAD_REFLOW')
  }
  let chars = 0
  const text = (s: unknown, required = false): string => {
    if (typeof s !== 'string' || s.length > 10000 || (required && !s.trim()))
      fail('Headings and content must be plain text, at most 10000 characters per item.')
    chars += (s as string).length
    return esc(s as string)
  }
  const body = (s: { paragraphs?: string[]; bullets?: string[] }) => {
    let out = ''
    for (const key of ['paragraphs', 'bullets'] as const) {
      const list = s[key]
      if (list === undefined) continue
      if (!Array.isArray(list) || list.length > 100)
        fail('Each section or entry accepts at most 100 paragraphs or bullets.')
      const tag = key === 'bullets' ? 'li' : 'p'
      const content = list.map((v) => '<' + tag + '>' + text(v, true) + '</' + tag + '>').join('')
      out += key === 'bullets' ? '<ul>' + content + '</ul>' : content
    }
    return out
  }
  if (
    !spec ||
    typeof spec !== 'object' ||
    !Array.isArray(spec.sections) ||
    !spec.sections.length ||
    spec.sections.length > 100
  )
    fail('Give a title and from 1 to 100 sections.')
  if (spec.page_size !== undefined && !['A4', 'Letter'].includes(spec.page_size))
    fail('page_size must be A4 or Letter.')
  if (spec.font !== undefined && !['sans', 'serif'].includes(spec.font)) fail('font must be sans or serif.')
  const size = spec.font_size ?? 11
  if (!Number.isFinite(size) || size < 9 || size > 14)
    fail('font_size must be from 9 to 14 points. Text is not automatically shrunk.')
  const title = text(spec.title, true)
  const subtitle = spec.subtitle === undefined ? '' : '<p class="contact">' + text(spec.subtitle) + '</p>'
  const sections = spec.sections
    .map((s) => {
      if (!s || typeof s !== 'object') return fail('Each section must be an object.')
      const heading = '<h2>' + text(s.heading, true) + '</h2>'
      let entries = ''
      if (s.entries !== undefined) {
        if (!Array.isArray(s.entries) || s.entries.length > 100)
          fail('Each section accepts at most 100 entries.')
        entries = s.entries
          .map((e) => {
            if (!e || typeof e !== 'object') return fail('Each entry must be an object.')
            return (
              '<div class="entry"><h3>' +
              text(e.heading, true) +
              (e.date ? ' — ' + text(e.date) : '') +
              '</h3>' +
              (e.detail ? '<p class="detail">' + text(e.detail) + '</p>' : '') +
              body(e) +
              '</div>'
            )
          })
          .join('')
      }
      const content = body(s) + entries
      if (!content) fail('Each section needs paragraphs, bullets or entries.')
      return heading + content
    })
    .join('')
  if (chars > 90000) fail('The rewrite is limited to 90000 characters.')
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    '@page{margin:40pt 44pt}body{font-family:' +
    (spec.font === 'serif' ? 'serif' : 'sans-serif') +
    ';font-size:' +
    size +
    'pt;line-height:1.3;color:#17202a}' +
    'h1{font-size:24pt;margin:0 0 5pt}h2{font-size:13pt;margin:15pt 0 6pt;border-bottom:1pt solid #74818b;padding-bottom:3pt;page-break-after:avoid}' +
    'h3{font-size:' +
    size +
    'pt;margin:9pt 0 3pt;page-break-after:avoid}p{margin:0 0 6pt;widows:2;orphans:2}.contact{color:#43515d;margin-bottom:13pt}.detail{font-style:italic}' +
    'ul{margin:3pt 0 8pt;padding-left:15pt}li{margin:0 0 4pt;widows:2;orphans:2}' +
    '</style></head><body><h1>' +
    title +
    '</h1>' +
    subtitle +
    sections +
    '</body></html>'
  )
}
