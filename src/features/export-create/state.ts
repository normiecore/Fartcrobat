/**
 * UI state of Export a PDF and Create a PDF, and the remembered choices (stored with store:set so
 * they survive restarts).
 */
import { create } from 'zustand'
import { invoke, showError } from '@renderer/sdk'
import {
  DEFAULT_BLANK,
  DEFAULT_EXPORT_OPTIONS,
  DEFAULT_HTML_CONVERT_OPTIONS,
  DEFAULT_IMAGE_PAGE_OPTIONS,
  FEATURE_ID,
  normalizeExportOptions,
  normalizeHtmlConvertOptions,
  normalizeImagePageOptions,
  type BlankOptions,
  type ExportFormat,
  type ExportOptions,
  type HtmlConvertOptions,
  type ImagePageOptions
} from './shared'

export type PageScope = 'all' | 'current' | 'range'

export interface ExportOutcome {
  format: ExportFormat
  /** Saved file, or the folder of the images. */
  path: string
  /** Files written (one for most formats, one per page for images). */
  files: string[]
}

export type CreateSource = 'file' | 'files' | 'images' | 'clipboard' | 'blank' | 'html'

export interface CreateItem {
  path: string
  name: string
}


interface State {
  loaded: boolean
  options: ExportOptions
  scope: PageScope
  range: string
  /** Last export per document id. */
  outcomes: Record<string, ExportOutcome>
  busy: boolean
  source: CreateSource
  /** "Multiple files" list. */
  files: CreateItem[]
  /** "Images" list. */
  images: CreateItem[]
  imagePage: ImagePageOptions
  html: HtmlConvertOptions
  blank: BlankOptions
  creating: boolean
}

export const useExportCreate = create<State>(() => ({
  loaded: false,
  options: DEFAULT_EXPORT_OPTIONS,
  scope: 'all',
  range: '',
  outcomes: {},
  busy: false,
  source: 'file',
  files: [],
  images: [],
  imagePage: DEFAULT_IMAGE_PAGE_OPTIONS,
  html: DEFAULT_HTML_CONVERT_OPTIONS,
  blank: DEFAULT_BLANK,
  creating: false
}))

export const getState = () => useExportCreate.getState()
export const setState = (patch: Partial<State> | ((s: State) => Partial<State>)) => useExportCreate.setState(patch)

const KEYS = {
  options: `${FEATURE_ID}:options`,
  imagePage: `${FEATURE_ID}:imagePage`,
  html: `${FEATURE_ID}:html`,
  blank: `${FEATURE_ID}:blank`
}

function normalizeBlank(v: unknown): BlankOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<BlankOptions>
  const d = DEFAULT_BLANK
  const num = (x: unknown, def: number, lo: number, hi: number) => (typeof x === 'number' && x >= lo && x <= hi ? x : def)
  return {
    preset: typeof o.preset === 'string' ? o.preset : d.preset,
    width: num(o.width, d.width, 0.01, 20000),
    height: num(o.height, d.height, 0.01, 20000),
    unit: o.unit === 'mm' || o.unit === 'pt' || o.unit === 'in' ? o.unit : d.unit,
    landscape: typeof o.landscape === 'boolean' ? o.landscape : d.landscape,
    pages: Math.round(num(o.pages, d.pages, 1, 500))
  }
}

let loading: Promise<void> | null = null

/** Loads the remembered choices once. */
export function loadSettings(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const [options, imagePage, html, blank] = await Promise.all([
          invoke('store:get', KEYS.options),
          invoke('store:get', KEYS.imagePage),
          invoke('store:get', KEYS.html),
          invoke('store:get', KEYS.blank)
        ])
        setState({
          options: normalizeExportOptions(options),
          imagePage: normalizeImagePageOptions(imagePage),
          html: normalizeHtmlConvertOptions(html),
          blank: normalizeBlank(blank)
        })
      } catch (err) {
        console.warn('Could not read the export settings', err)
      } finally {
        setState({ loaded: true })
      }
    })()
  }
  return loading
}

async function persist(key: string, value: unknown) {
  try {
    await invoke('store:set', key, value)
  } catch (err) {
    showError(err, 'Could not remember the settings')
  }
}

export function setOptions(patch: Partial<ExportOptions> | ((o: ExportOptions) => ExportOptions)) {
  const next = typeof patch === 'function' ? patch(getState().options) : { ...getState().options, ...patch }
  setState({ options: next })
  void persist(KEYS.options, next)
}

export function setImagePage(patch: Partial<ImagePageOptions>) {
  const next = { ...getState().imagePage, ...patch }
  setState({ imagePage: next })
  void persist(KEYS.imagePage, next)
}

export function setHtmlConvert(patch: Partial<HtmlConvertOptions>) {
  const next = { ...getState().html, ...patch }
  setState({ html: next })
  void persist(KEYS.html, next)
}

export function setBlank(patch: Partial<BlankOptions>) {
  const next = { ...getState().blank, ...patch }
  setState({ blank: next })
  void persist(KEYS.blank, next)
}
