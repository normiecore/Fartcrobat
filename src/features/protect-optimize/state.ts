import { create } from 'zustand'
import { invoke } from '@renderer/sdk'
import { FEATURE_ID, presetOptions, type OptimizeOptions, type OptimizeReport, type QualityPreset } from './shared'

export interface CompressResult {
  /** "Reduced from 12.4 MB to 3.1 MB (75% smaller)" */
  summary: string
  before: number
  after: number
  smaller: boolean
  /** Where the compressed file was saved (null when opened as a new tab or not saved). */
  path: string | null
  /** The compressed copy was opened as a new, unsaved tab. */
  openedInTab: boolean
  name: string
  report: OptimizeReport
}

export type CompressOutput = 'save' | 'tab'

interface FeatureState {
  /** Last compression result per document id. */
  results: Record<string, CompressResult>
  /** Documents whose "restricted permissions" bar was closed (value: the permissions it was closed for). */
  dismissedBars: Record<string, string>
  preset: QualityPreset
  output: CompressOutput
  /** Last settings used in Advanced optimization (null: start from the chosen quality). */
  advanced: OptimizeOptions | null
}

export const useProtectOptimize = create<FeatureState>(() => ({
  results: {},
  dismissedBars: {},
  preset: 'medium',
  output: 'save',
  advanced: null
}))

const PREFS_KEY = `${FEATURE_ID}:compress`

interface StoredPrefs {
  preset?: QualityPreset
  output?: CompressOutput
  advanced?: OptimizeOptions | null
}

let loaded = false

/** Loads the remembered compression choices once. */
export async function loadCompressPrefs() {
  if (loaded) return
  loaded = true
  try {
    const v = (await invoke('store:get', PREFS_KEY)) as StoredPrefs | undefined
    if (!v) return
    const patch: Partial<FeatureState> = {}
    if (v.preset === 'high' || v.preset === 'medium' || v.preset === 'small') patch.preset = v.preset
    if (v.output === 'save' || v.output === 'tab') patch.output = v.output
    if (v.advanced && typeof v.advanced === 'object') patch.advanced = mergeOptions(v.advanced)
    useProtectOptimize.setState(patch)
  } catch (err) {
    console.warn('[protect-optimize] could not load compression settings', err)
  }
}

export function setCompressPrefs(patch: StoredPrefs) {
  useProtectOptimize.setState(patch as Partial<FeatureState>)
  const s = useProtectOptimize.getState()
  void invoke('store:set', PREFS_KEY, { preset: s.preset, output: s.output, advanced: s.advanced }).catch((err) =>
    console.warn('[protect-optimize] could not save compression settings', err)
  )
}

/** Fills in anything missing from stored options (older versions) with Medium defaults. */
export function mergeOptions(o: Partial<OptimizeOptions>): OptimizeOptions {
  const d = presetOptions('medium')
  return {
    images: {
      color: { ...d.images.color, ...o.images?.color },
      gray: { ...d.images.gray, ...o.images?.gray },
      mono: { ...d.images.mono, ...o.images?.mono }
    },
    fonts: { ...d.fonts, ...o.fonts },
    discard: { ...d.discard, ...o.discard },
    cleanup: { ...d.cleanup, ...o.cleanup }
  }
}
