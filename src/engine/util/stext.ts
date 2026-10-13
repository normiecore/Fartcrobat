import type * as MuPDF from 'mupdf'

export type StructuredTextWalker = Parameters<MuPDF.StructuredText['walk']>[0]

/**
 * `stext.walk(walker)`, but characters outside the Basic Multilingual Plane (emoji, CJK Extension B,
 * math alphanumerics...) reach `onChar` whole, as two UTF-16 units. mupdf.js builds each character
 * with String.fromCharCode, which drops the bits above U+FFFF (U+1F600 arrives as U+F600). The
 * JSON output is formatted by MuPDF itself and lists the same lines in the same order, so the
 * full code points are taken from there. Use this instead of calling `walk` directly.
 */
export function walkStructuredText(stext: MuPDF.StructuredText, walker: StructuredTextWalker) {
  const lines = walker.onChar ? astralLines(stext) : null
  if (!lines) return stext.walk(walker)
  let line = -1
  let k = 0
  stext.walk({
    ...walker,
    beginLine(bbox, wmode, dir) {
      line++
      k = 0
      walker.beginLine?.(bbox, wmode, dir)
    },
    onChar(c, ...rest) {
      const cp = lines[line]?.[k++]
      // only replace a character that is the truncated form of the code point at that position
      const whole = cp !== undefined && cp > 0xffff && (cp & 0xffff) === c.charCodeAt(0)
      walker.onChar!(whole ? String.fromCodePoint(cp) : c, ...rest)
    }
  })
}

/** The code points of every text line, or null when the page has none above U+FFFF. */
function astralLines(stext: MuPDF.StructuredText): number[][] | null {
  const json = stext.asJSON()
  if (!/[\ud800-\udbff]|\\u[dD][89abAB]/.test(json)) return null
  const lines: number[][] = []
  for (const block of JSON.parse(json).blocks ?? []) {
    if (block.type !== 'text') continue
    for (const l of block.lines ?? [])
      lines.push(Array.from(String(l.text ?? ''), (ch) => ch.codePointAt(0)!))
  }
  return lines
}
