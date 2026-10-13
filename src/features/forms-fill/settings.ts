import { create } from 'zustand'
import { invoke, showError } from '@renderer/sdk'

/** Preferences > Forms (stored with store:set 'forms-fill:settings'). */
export interface FormsSettings {
  /** Fill colour used by "Highlight existing fields" (Acrobat's light blue by default). */
  highlightColor: string
  /** Outline colour of required fields. */
  requiredColor: string
  /** Show the "This document contains interactive form fields" bar. */
  showMessageBar: boolean
  /** Recalculate calculated fields after every change. */
  autoCalculate: boolean
}

export const DEFAULT_SETTINGS: FormsSettings = {
  highlightColor: '#ccd7ff',
  requiredColor: '#e0393e',
  showMessageBar: true,
  autoCalculate: true
}

const KEY = 'forms-fill:settings'

export const useFormsSettings = create<FormsSettings & { loaded: boolean }>(() => ({ ...DEFAULT_SETTINGS, loaded: false }))

let loading: Promise<void> | null = null

export function loadFormsSettings(): Promise<void> {
  if (!loading) {
    loading = invoke('store:get', KEY)
      .then((v) => {
        const saved = (v && typeof v === 'object' ? v : {}) as Partial<FormsSettings>
        const clean: Partial<FormsSettings> = {}
        for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof FormsSettings)[]) {
          if (typeof saved[k] === typeof DEFAULT_SETTINGS[k]) (clean as Record<string, unknown>)[k] = saved[k]
        }
        useFormsSettings.setState({ ...clean, loaded: true })
      })
      .catch((err) => {
        useFormsSettings.setState({ loaded: true })
        console.warn('Could not load form settings', err)
      })
  }
  return loading
}

export function formsSettings(): FormsSettings {
  const { loaded: _loaded, ...s } = useFormsSettings.getState()
  return s
}

export async function setFormsSettings(patch: Partial<FormsSettings>) {
  useFormsSettings.setState(patch)
  try {
    await invoke('store:set', KEY, formsSettings())
  } catch (err) {
    showError(err, 'Could not save form settings')
  }
}
