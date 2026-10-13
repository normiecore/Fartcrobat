import { create } from 'zustand'
import { invoke, showError } from '@renderer/sdk'
import { BUILTIN_STAMPS, customStampDef, DEFAULT_STAMP_ID, findBuiltinStamp, type CustomStamp, type StampDef } from './stampCatalog'

/** Store keys (see CONTRACTS: '<feature-id>:<key>'). */
export const CUSTOM_KEY = 'stamps-measure:custom'
export const LAST_KEY = 'stamps-measure:last'

interface StampState {
  custom: CustomStamp[]
  loaded: boolean
  /** Stamp placed by the Stamp tool (the last one used). */
  selectedId: string
}

export const useStamps = create<StampState>(() => ({ custom: [], loaded: false, selectedId: DEFAULT_STAMP_ID }))

function isCustomStamp(v: unknown): v is CustomStamp {
  const c = v as CustomStamp
  return (
    !!c &&
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.dataUrl === 'string' &&
    c.dataUrl.startsWith('data:image/') &&
    Number.isFinite(c.width) &&
    Number.isFinite(c.height)
  )
}

let loading: Promise<void> | null = null

/** Loads custom stamps and the last used stamp from the settings store (once). */
export function loadStamps(): Promise<void> {
  if (useStamps.getState().loaded) return Promise.resolve()
  if (!loading) {
    loading = (async () => {
      try {
        const [custom, last] = await Promise.all([invoke('store:get', CUSTOM_KEY), invoke('store:get', LAST_KEY)])
        const list = Array.isArray(custom) ? custom.filter(isCustomStamp) : []
        const selected =
          typeof last === 'string' && (findBuiltinStamp(last) || list.some((c) => `custom:${c.id}` === last)) ? last : DEFAULT_STAMP_ID
        useStamps.setState({ custom: list, selectedId: selected, loaded: true })
      } catch (err) {
        useStamps.setState({ loaded: true })
        showError(err, 'Could not load your stamps')
      } finally {
        loading = null
      }
    })()
  }
  return loading
}

async function persistCustom(list: CustomStamp[]) {
  useStamps.setState({ custom: list })
  try {
    await invoke('store:set', CUSTOM_KEY, list)
  } catch (err) {
    showError(err, 'Could not save your stamps')
  }
}

export function selectStamp(id: string) {
  useStamps.setState({ selectedId: id })
  void invoke('store:set', LAST_KEY, id).catch(() => {})
}

export function resolveStamp(id: string, custom: CustomStamp[] = useStamps.getState().custom): StampDef | null {
  if (id.startsWith('custom:')) {
    const c = custom.find((x) => `custom:${x.id}` === id)
    return c ? customStampDef(c) : null
  }
  return findBuiltinStamp(id) ?? null
}

export function customById(id: string): CustomStamp | undefined {
  return useStamps.getState().custom.find((x) => `custom:${x.id}` === id)
}

/** The stamp the tool will place (falls back to Approved when the chosen one was deleted). */
export function useCurrentStamp(): StampDef {
  const selectedId = useStamps((s) => s.selectedId)
  const custom = useStamps((s) => s.custom)
  return resolveStamp(selectedId, custom) ?? BUILTIN_STAMPS.find((s) => s.id === DEFAULT_STAMP_ID)!
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export async function addCustomStamp(stamp: Omit<CustomStamp, 'id' | 'created'>): Promise<CustomStamp> {
  await loadStamps()
  const c: CustomStamp = { ...stamp, id: newId(), created: Date.now() }
  await persistCustom([...useStamps.getState().custom, c])
  return c
}

export async function renameCustomStamp(id: string, name: string) {
  const list = useStamps.getState().custom.map((c) => (c.id === id ? { ...c, name } : c))
  await persistCustom(list)
}

export async function deleteCustomStamp(id: string) {
  const list = useStamps.getState().custom.filter((c) => c.id !== id)
  if (useStamps.getState().selectedId === `custom:${id}`) selectStamp(DEFAULT_STAMP_ID)
  await persistCustom(list)
}
