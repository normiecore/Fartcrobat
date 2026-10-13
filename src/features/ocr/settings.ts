import { create } from 'zustand'
import { invoke, showError } from '@renderer/sdk'
import { DEFAULT_DPI, DPI_CHOICES } from './constants'

/**
 * Preferences > OCR (stored with store:set 'ocr:settings'). The default language is the core
 * preference `ocrLanguage`.
 */
export interface OcrSettings {
  /** Resolution pages are rendered at for recognition. */
  dpi: number
  /** Offer to recognize text when a document that looks scanned is opened. */
  detectScanned: boolean
  /** Skip pages that already have text. */
  skipPagesWithText: boolean
}

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  dpi: DEFAULT_DPI,
  detectScanned: true,
  skipPagesWithText: true
}

const KEY = 'ocr:settings'

export const useOcrSettings = create<OcrSettings & { loaded: boolean }>(() => ({ ...DEFAULT_OCR_SETTINGS, loaded: false }))

let loading: Promise<void> | null = null

function clean(saved: Partial<OcrSettings>): Partial<OcrSettings> {
  const out: Partial<OcrSettings> = {}
  if (typeof saved.dpi === 'number' && (DPI_CHOICES as readonly number[]).includes(saved.dpi)) out.dpi = saved.dpi
  if (typeof saved.detectScanned === 'boolean') out.detectScanned = saved.detectScanned
  if (typeof saved.skipPagesWithText === 'boolean') out.skipPagesWithText = saved.skipPagesWithText
  return out
}

export function loadOcrSettings(): Promise<void> {
  if (!loading) {
    loading = invoke('store:get', KEY)
      .then((v) => {
        const saved = (v && typeof v === 'object' ? v : {}) as Partial<OcrSettings>
        useOcrSettings.setState({ ...clean(saved), loaded: true })
      })
      .catch((err) => {
        useOcrSettings.setState({ loaded: true })
        console.warn('Could not load OCR settings', err)
      })
  }
  return loading
}

export function ocrSettings(): OcrSettings {
  const { loaded: _loaded, ...s } = useOcrSettings.getState()
  return s
}

export async function setOcrSettings(patch: Partial<OcrSettings>) {
  useOcrSettings.setState(clean(patch))
  try {
    await invoke('store:set', KEY, ocrSettings())
  } catch (err) {
    showError(err, 'Could not save OCR settings')
  }
}
