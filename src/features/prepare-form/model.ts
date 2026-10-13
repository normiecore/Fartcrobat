/**
 * Types shared by the Prepare Form engine ops and UI. No DOM or MuPDF imports here.
 */
import type { Rect } from '@shared/geometry'

/** Field types that can be created ("date" is a text field with a date format). */
export type PFType = 'text' | 'checkbox' | 'radio' | 'list' | 'combo' | 'button' | 'signature' | 'date'

export type FieldKind = PFType | 'unknown'

export type Visibility = 'visible' | 'hidden' | 'visible-noprint' | 'hidden-print'
export type BorderStyle = 'solid' | 'dashed' | 'beveled' | 'inset' | 'underline'
export type CheckStyle = 'check' | 'circle' | 'cross' | 'diamond' | 'square' | 'star'
export type FontId = 'Helv' | 'HeBo' | 'TiRo' | 'TiBo' | 'Cour' | 'CoBo' | 'ZaDb'
export type ButtonHighlight = 'none' | 'invert' | 'outline' | 'push'

export const CHECK_CHARS: Record<CheckStyle, string> = {
  check: '4',
  circle: 'l',
  cross: '8',
  diamond: 'u',
  square: 'n',
  star: 'H'
}

export const FONTS: { id: FontId; label: string; base: string }[] = [
  { id: 'Helv', label: 'Helvetica', base: 'Helvetica' },
  { id: 'HeBo', label: 'Helvetica Bold', base: 'Helvetica-Bold' },
  { id: 'TiRo', label: 'Times Roman', base: 'Times-Roman' },
  { id: 'TiBo', label: 'Times Bold', base: 'Times-Bold' },
  { id: 'Cour', label: 'Courier', base: 'Courier' },
  { id: 'CoBo', label: 'Courier Bold', base: 'Courier-Bold' },
  { id: 'ZaDb', label: 'Zapf Dingbats', base: 'ZapfDingbats' }
]

export type ButtonAction =
  | { kind: 'none' }
  | { kind: 'reset' }
  | { kind: 'url'; url: string }
  | { kind: 'page'; page: number }
  | { kind: 'print' }
  /** An action this app does not edit (kept as is). */
  | { kind: 'other'; description: string }

export type FormatSpec =
  | { kind: 'none' }
  | {
      kind: 'number'
      decimals: number
      /** 0 "1,234.56", 1 "1234.56", 2 "1.234,56", 3 "1234,56", 4 "1'234.56" */
      separator: number
      /** 0 minus, 1 red minus, 2 parentheses, 3 red parentheses */
      negative: number
      currency: string
      currencyPrepend: boolean
    }
  | { kind: 'percent'; decimals: number; separator: number }
  | { kind: 'date'; pattern: string }
  /** 0 "HH:MM", 1 "h:MM tt", 2 "HH:MM:ss", 3 "h:MM:ss tt" */
  | { kind: 'time'; style: number }
  /** 0 ZIP, 1 ZIP+4, 2 phone, 3 social security number */
  | { kind: 'special'; style: number }
  | { kind: 'mask'; mask: string }
  | { kind: 'custom'; format: string; keystroke: string }

export type ValidateSpec =
  | { kind: 'none' }
  | { kind: 'range'; min: number | null; max: number | null }
  | { kind: 'custom'; script: string }

export type CalcOp = 'SUM' | 'PRD' | 'AVG' | 'MIN' | 'MAX'

export type CalculateSpec =
  | { kind: 'none' }
  | { kind: 'simple'; op: CalcOp; fields: string[] }
  /** Simplified field notation, e.g. "price * qty + shipping". */
  | { kind: 'notation'; expr: string }
  | { kind: 'custom'; script: string }

export interface ChoiceOption {
  label: string
  value: string
}

/** Everything the Prepare Form UI shows and edits about one widget and its field. */
export interface PFField {
  /** Widget annotation id (object number), same as core forms FieldInfo.id. */
  id: number
  page: number
  /** Fully qualified name ("address.city"). */
  name: string
  type: FieldKind
  rect: Rect
  /** Number of widgets sharing this field (radio buttons, copies on several pages). */
  widgetCount: number
  /** Position of this widget in the page's tab order (0-based). */
  tabIndex: number

  // General
  tooltip: string
  visibility: Visibility
  /** /MK /R: 0, 90, 180 or 270. */
  orientation: number
  readOnly: boolean
  required: boolean
  noExport: boolean

  // Appearance
  borderColor: string | null
  fillColor: string | null
  /** 0 none (thin border hidden), 1 thin, 2 medium, 3 thick. */
  borderWidth: number
  borderStyle: BorderStyle
  fontName: string
  /** 0 means Auto. */
  fontSize: number
  textColor: string

  // Text options
  alignment: number
  defaultValue: string
  value: string
  multiline: boolean
  doNotScroll: boolean
  password: boolean
  doNotSpellCheck: boolean
  /** 0 = unlimited. For comb fields, the number of cells. */
  maxLen: number
  comb: boolean

  // Check box / radio button options
  checkStyle: CheckStyle
  exportValue: string
  checkedByDefault: boolean
  radiosInUnison: boolean

  // Choice options
  options: ChoiceOption[]
  sort: boolean
  editable: boolean
  multiSelect: boolean
  commitOnSelChange: boolean
  /** Default selection(s) (export values). */
  defaultSelection: string[]

  // Button
  caption: string
  highlight: ButtonHighlight
  action: ButtonAction

  // Text and dropdown scripts
  format: FormatSpec
  validate: ValidateSpec
  calculate: CalculateSpec
}

/** Properties that can be changed with `prepare-form.update`. */
export type FieldProps = Partial<
  Omit<PFField, 'id' | 'page' | 'type' | 'widgetCount' | 'tabIndex' | 'name' | 'value' | 'rect'>
> & { rect?: Rect }

export interface CreateSpec {
  type: PFType
  page: number
  rect: Rect
  /** Defaults to an Acrobat-style automatic name ("Text1", "Check Box2"...). */
  name?: string
  props?: FieldProps
}

export type TabOrder = 'row' | 'column' | 'structure' | 'unspecified'

export interface PageTabs {
  page: number
  order: TabOrder
}

/** A field found by "Detect form fields automatically". */
export interface DetectedField {
  page: number
  type: PFType
  rect: Rect
  name: string
  /** Where the guess came from (for the summary): underscores, line, box, glyph... */
  source: 'underscores' | 'line' | 'box' | 'glyph' | 'brackets'
}

/** A copied field (Edit > Copy) that can be pasted onto any page. */
export interface FieldClip {
  type: PFType
  name: string
  rect: Rect
  props: FieldProps
}

export const TYPE_LABELS: Record<FieldKind, string> = {
  text: 'Text field',
  checkbox: 'Check box',
  radio: 'Radio button',
  list: 'List box',
  combo: 'Dropdown list',
  button: 'Button',
  signature: 'Digital signature',
  date: 'Date field',
  unknown: 'Field'
}

/** Acrobat's automatic name prefixes. */
export const NAME_PREFIX: Record<PFType, string> = {
  text: 'Text',
  checkbox: 'Check Box',
  radio: 'Group',
  list: 'List Box',
  combo: 'Dropdown',
  button: 'Button',
  signature: 'Signature',
  date: 'Date'
}

/** Default size (points) when a field is placed with a single click. */
export const DEFAULT_SIZE: Record<PFType, [number, number]> = {
  text: [150, 22],
  checkbox: [14, 14],
  radio: [14, 14],
  list: [150, 64],
  combo: [150, 22],
  button: [80, 24],
  signature: [180, 40],
  date: [100, 22]
}

export const DATE_PATTERNS = [
  'mm/dd/yyyy',
  'dd/mm/yyyy',
  'yyyy-mm-dd',
  'm/d/yy',
  'mm/dd/yy',
  'dd.mm.yyyy',
  'd-mmm-yyyy',
  'mmm d, yyyy',
  'mmmm d, yyyy',
  'dd-mmm-yy',
  'mm/yy',
  'mm/dd/yyyy HH:MM'
]

export const SELECTION_TYPE = 'prepare-form:fields'

export interface FieldSelectionData {
  ids: number[]
}
