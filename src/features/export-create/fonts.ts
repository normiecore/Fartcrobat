import { FONT_BOLD, FONT_ITALIC, FONT_MONO, FONT_SERIF } from './content'

const KNOWN: Record<string, string> = {
  helvetica: 'Arial',
  helveticaneue: 'Helvetica Neue',
  arial: 'Arial',
  arialmt: 'Arial',
  arialnarrow: 'Arial Narrow',
  arialblack: 'Arial Black',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  timesnewroman: 'Times New Roman',
  courier: 'Courier New',
  couriernew: 'Courier New',
  symbol: 'Symbol',
  zapfdingbats: 'Zapf Dingbats',
  dingbats: 'Zapf Dingbats',
  calibri: 'Calibri',
  calibrilight: 'Calibri Light',
  cambria: 'Cambria',
  cambriamath: 'Cambria Math',
  candara: 'Candara',
  consolas: 'Consolas',
  constantia: 'Constantia',
  corbel: 'Corbel',
  georgia: 'Georgia',
  verdana: 'Verdana',
  tahoma: 'Tahoma',
  trebuchetms: 'Trebuchet MS',
  trebuchet: 'Trebuchet MS',
  garamond: 'Garamond',
  bookantiqua: 'Book Antiqua',
  palatino: 'Palatino Linotype',
  palatinolinotype: 'Palatino Linotype',
  centurygothic: 'Century Gothic',
  century: 'Century',
  segoeui: 'Segoe UI',
  lucidaconsole: 'Lucida Console',
  lucidasans: 'Lucida Sans',
  lucidagrande: 'Lucida Grande',
  gillsans: 'Gill Sans',
  gillsansmt: 'Gill Sans MT',
  futura: 'Futura',
  impact: 'Impact',
  comicsansms: 'Comic Sans MS',
  wingdings: 'Wingdings',
  aptos: 'Aptos',
  liberationsans: 'Liberation Sans',
  liberationserif: 'Liberation Serif',
  liberationmono: 'Liberation Mono',
  dejavusans: 'DejaVu Sans',
  dejavuserif: 'DejaVu Serif',
  dejavusansmono: 'DejaVu Sans Mono',
  opensans: 'Open Sans',
  roboto: 'Roboto',
  sourcesanspro: 'Source Sans Pro',
  minionpro: 'Minion Pro',
  myriadpro: 'Myriad Pro'
}

/** Style suffixes: whole words may be glued to the name ("Arial-BoldMT", "HelveticaBold"). */
const STYLE_WORDS =
  /[-_,\s]?(Bold|Italic|Oblique|Regular|Roman|Medium|Light|Semibold|SemiBold|Demibold|DemiBold|Demi|Black|Heavy|Book|Condensed|Cond|Narrow|ExtraBold|UltraBold|Extra|Ultra|Thin|PSMT|MT|PS)$/
/** Abbreviated suffixes need a separator ("Minion-It", not "Transit"). */
const STYLE_ABBREVIATIONS = /[-_,\s](Bd|It|BdIt|BoldIt|Bi|Lt|Md|Rg|Std|Pro|bold|italic)$/

/** The font family to use in an editable document for a font name found in a PDF. */
export function fontFamily(pdfName: string, flags = 0): string {
  const name = (pdfName || '').replace(/^[A-Z]{6}\+/, '').trim()
  // Generated names ("F1", "T1_0", "Type3") and the glyph-less font of recognized text carry no family.
  if (!name || /^(F|T|TT|C|R)\d+(_\d+)?$/i.test(name) || /^type3/i.test(name) || /^glyph-?less/i.test(name)) return fallbackFamily(flags)
  const exact = KNOWN[name.toLowerCase().replace(/[^a-z]/g, '')]
  if (exact) return exact
  let base = name.split(/[,+]/)[0]
  for (let i = 0; i < 8; i++) {
    const known = KNOWN[base.toLowerCase().replace(/[^a-z]/g, '')]
    if (known) return known
    const next = base.replace(STYLE_WORDS, '').replace(STYLE_ABBREVIATIONS, '')
    if (next === base || !next) break
    base = next
  }
  base = base.replace(/[-_]+$/, '')
  const key = base.toLowerCase().replace(/[^a-z]/g, '')
  if (KNOWN[key]) return KNOWN[key]
  for (const [k, v] of Object.entries(KNOWN)) if (key.startsWith(k) && k.length >= 5) return v
  if (!key) return fallbackFamily(flags)
  // "TimesNewRoman" -> "Times New Roman"
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fallbackFamily(flags: number): string {
  if (flags & FONT_MONO) return 'Courier New'
  if (flags & FONT_SERIF) return 'Times New Roman'
  return 'Arial'
}

export const isBold = (flags: number) => (flags & FONT_BOLD) !== 0
export const isItalic = (flags: number) => (flags & FONT_ITALIC) !== 0

/** CSS font stack for a family. */
export function cssFontStack(family: string, flags: number): string {
  const generic = flags & FONT_MONO ? 'monospace' : flags & FONT_SERIF || /times|georgia|garamond|cambria|serif|palatino|antiqua/i.test(family) ? 'serif' : 'sans-serif'
  return `"${family.replace(/"/g, '')}", ${generic}`
}
