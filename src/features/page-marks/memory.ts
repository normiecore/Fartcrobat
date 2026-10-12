import { invoke } from '@renderer/sdk'
import {
  defaultBackground,
  defaultWatermark,
  normalizeSettings,
  type MarkSettings,
  type MarkType
} from './shared'

const LAST_KEY = (type: MarkType) => `page-marks:last:${type}`

/** Remembers the settings used last time (the Add dialogs start from them, like Acrobat's). */
export function rememberSettings(settings: MarkSettings) {
  let s: MarkSettings = JSON.parse(JSON.stringify(settings))
  if ((s.type === 'Watermark' || s.type === 'Background') && s.source.kind === 'file') {
    s = {
      ...s,
      source: s.type === 'Watermark' ? defaultWatermark().source : defaultBackground().source
    } as MarkSettings
  }
  // Page ranges belong to one document; start the next one on all pages.
  s = { ...s, range: { kind: 'all', subset: 'all' } }
  void invoke('store:set', LAST_KEY(settings.type), s).catch(() => {})
}

export async function lastSettings(type: MarkType): Promise<MarkSettings | null> {
  try {
    const v = await invoke('store:get', LAST_KEY(type))
    const s = normalizeSettings(v)
    return s && s.type === type ? s : null
  } catch {
    return null
  }
}
