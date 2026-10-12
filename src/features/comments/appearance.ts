/** Mapping between comment appearance controls and annotation properties. */
import type { AnnotInfo, AnnotSpec } from '@engine/ops/annots'
import { invoke, showError } from '@renderer/sdk'
import { capabilities } from './model'
import { defaultsKind } from './shared'
import { defaultsKey } from './state'

export type LineStyle = 'solid' | 'dashed' | 'cloudy'

export function lineStyleOf(a: Pick<AnnotInfo, 'cloudy' | 'borderStyle' | 'dashes'>): LineStyle {
  if (a.cloudy) return 'cloudy'
  return a.borderStyle === 'Dashed' || a.dashes.length ? 'dashed' : 'solid'
}

export function lineStyleSpec(style: LineStyle, width = 1): AnnotSpec {
  if (style === 'cloudy') return { borderStyle: 'Solid', dashes: [], cloudy: true }
  if (style === 'dashed') {
    const d = Math.max(2, Math.round(width * 3))
    return { borderStyle: 'Dashed', dashes: [d, d], cloudy: false }
  }
  return { borderStyle: 'Solid', dashes: [], cloudy: false }
}

/** The fill control: interior colour, or the background of a text box. */
export function fillOf(a: Pick<AnnotInfo, 'type' | 'color' | 'interiorColor'>): string | null {
  const v = a.type === 'FreeText' ? a.color : a.interiorColor
  return v && v !== 'transparent' ? v : null
}

export function fillSpec(a: Pick<AnnotInfo, 'type'>, v: string | null): AnnotSpec {
  return a.type === 'FreeText' ? { color: v } : { interiorColor: v }
}

export const WIDTHS = [0.5, 1, 2, 3, 4, 6, 8, 12]
export const FONT_SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]

/** Appearance properties of a comment that can serve as defaults for new comments of its type. */
export function appearanceDefaults(a: AnnotInfo): Partial<AnnotSpec> {
  const caps = capabilities(a)
  const out: Partial<AnnotSpec> = {}
  if (caps.color) out.color = a.color
  if (caps.fill) Object.assign(out, fillSpec(a, fillOf(a)))
  if (caps.opacity) out.opacity = a.opacity
  if (caps.width) out.borderWidth = a.borderWidth
  if (caps.dash || caps.cloud) Object.assign(out, lineStyleSpec(lineStyleOf(a), a.borderWidth))
  if (caps.arrows && a.lineEndings) out.lineEndings = a.lineEndings
  if (caps.font) {
    if (a.fontSize) out.fontSize = a.fontSize
    if (a.textColor) out.textColor = a.textColor
    out.quadding = a.quadding
  }
  if (caps.icon && a.icon) out.icon = a.icon
  return out
}

/**
 * Stores the comment's appearance as the default for new comments of the same kind
 * (store key `comments:defaults:<kind>`, see defaultsKind). Returns false when saving failed.
 */
export async function saveAsDefault(a: AnnotInfo, extra: Partial<AnnotSpec> = {}): Promise<boolean> {
  try {
    const key = defaultsKey(defaultsKind(a))
    const prev = ((await invoke('store:get', key)) as Partial<AnnotSpec> | undefined) ?? {}
    await invoke('store:set', key, { ...prev, ...appearanceDefaults(a), ...extra })
    return true
  } catch (err) {
    showError(err, 'Could not save the default properties')
    return false
  }
}
