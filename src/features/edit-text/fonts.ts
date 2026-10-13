/** CSS fonts that approximate PDF fonts in the in-place editor. */
import {
  classifyFont,
  isOrigFont,
  STANDARD_FAMILIES,
  stripSubset,
  type FontChoice,
  type FontClass,
  type StandardFamily
} from './model'

const STACKS: Record<FontClass, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", "Nimbus Sans L", "DejaVu Sans", sans-serif',
  serif:
    '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", "Nimbus Roman No9 L", "DejaVu Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", "DejaVu Sans Mono", monospace'
}

const FAMILY_CLASS: Record<StandardFamily, FontClass> = { Helvetica: 'sans', Times: 'serif', Courier: 'mono' }

export const STANDARD_LABELS: Record<StandardFamily, string> = {
  Helvetica: 'Helvetica',
  Times: 'Times New Roman',
  Courier: 'Courier'
}

const TOKEN = 'fc-font-'

/**
 * CSS font-family for a font key. The first family is a marker that never matches a real font:
 * it lets the editor read the font key back from the browser's computed style.
 */
export function cssFamily(key: string, fonts: FontChoice[]): string {
  const cls = fontClassOf(key, fonts)
  const own = isOrigFont(key) ? localFamilies(key.slice(5)) : []
  return [`"${TOKEN}${encodeURIComponent(key)}"`, ...own.map((f) => `"${f}"`), STACKS[cls]].join(', ')
}

/**
 * Family names to try for a PDF font name, so the editor shows the real typeface when it is
 * installed: "ABCDEF+TimesNewRomanPS-BoldMT" -> "TimesNewRomanPS", "Times New Roman".
 */
export function localFamilies(pdfName: string): string[] {
  let base = stripSubset(pdfName).split(/[-,]/)[0]
  base = base.replace(/(PSMT|PS|MT)$/, '')
  if (!base || /[^A-Za-z0-9 ]/.test(base)) return []
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2')
  return [...new Set([base, spaced])]
}

export function fontClassOf(key: string, fonts: FontChoice[]): FontClass {
  if (isOrigFont(key)) return fonts.find((f) => f.key === key)?.cls ?? classifyFont(key.slice(5))
  return FAMILY_CLASS[key as StandardFamily] ?? 'sans'
}

/** Font key from a computed font-family value, or null. */
export function fontKeyFromCss(family: string): string | null {
  const first =
    family
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  if (!first.startsWith(TOKEN)) return null
  try {
    return decodeURIComponent(first.slice(TOKEN.length))
  } catch {
    return null
  }
}

export function fontLabel(key: string, fonts: FontChoice[]): string {
  if (isOrigFont(key))
    return fonts.find((f) => f.key === key)?.label ?? key.slice(5).replace(/^[A-Z]{6}\+/, '')
  return STANDARD_LABELS[key as StandardFamily] ?? key
}

/** Options for a font list: the document's own fonts first, then the standard ones. */
export function fontOptions(fonts: FontChoice[]): { value: string; label: string }[] {
  return [
    ...fonts.map((f) => ({ value: f.key, label: `${f.label} (from document)` })),
    ...STANDARD_FAMILIES.map((f) => ({ value: f as string, label: STANDARD_LABELS[f] }))
  ]
}

const baselineCache = new Map<string, number>()

/**
 * Distance in CSS px from the top of a line box to its baseline, for a font, size and unitless
 * line height. Used to line the editor's text up with the PDF baseline.
 */
export function cssBaseline(
  family: string,
  sizePx: number,
  lineHeight: number,
  bold: boolean,
  italic: boolean
): number {
  const key = `${family}|${sizePx.toFixed(2)}|${lineHeight}|${bold}|${italic}`
  const hit = baselineCache.get(key)
  if (hit !== undefined) return hit
  const host = document.createElement('div')
  host.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;margin:0;padding:0;border:0;font-family:${family};font-size:${sizePx}px;line-height:${lineHeight};font-weight:${bold ? 700 : 400};font-style:${italic ? 'italic' : 'normal'}`
  const text = document.createElement('span')
  text.textContent = 'Hg'
  const marker = document.createElement('span')
  marker.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline'
  host.append(text, marker)
  document.body.append(host)
  const off = marker.getBoundingClientRect().top - host.getBoundingClientRect().top
  host.remove()
  if (baselineCache.size > 200) baselineCache.clear()
  baselineCache.set(key, off)
  return off
}
