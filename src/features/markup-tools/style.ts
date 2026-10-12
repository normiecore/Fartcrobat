/**
 * Tool appearance defaults: built-in values, remembered per tool in the store under
 * 'markup-tools:defaults', and updated from the comments feature's "Make current properties
 * default" ('comments:defaults:<AnnotType>') whenever that value changes.
 */
import { create } from 'zustand'
import { invoke, showError, toast } from '@renderer/sdk'
import { TOOLS, type MarkupTool } from './tools'
import { builtinStyle, defaultsApply, fromAnnotDefaults, sanitize, type ToolStyle } from './styleModel'

export * from './styleModel'

interface StoredDefaults {
  tools: Record<string, Partial<ToolStyle>>
  /** Last seen JSON of each 'comments:defaults:<type>' value, to apply only new ones. */
  seen: Record<string, string>
}

interface DefaultsState {
  loaded: boolean
  styles: Record<string, ToolStyle>
  stored: StoredDefaults
}

export const useToolStyles = create<DefaultsState>(() => ({
  loaded: false,
  styles: Object.fromEntries(TOOLS.map((t) => [t.key, builtinStyle(t.key)])),
  stored: { tools: {}, seen: {} }
}))

export const STORE_KEY = 'markup-tools:defaults'

let saveTimer: ReturnType<typeof setTimeout> | null = null

function persist() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    invoke('store:set', STORE_KEY, useToolStyles.getState().stored).catch((err) => showError(err, 'Could not remember the tool settings'))
  }, 300)
}

function recompute(stored: StoredDefaults): Record<string, ToolStyle> {
  return Object.fromEntries(TOOLS.map((t) => [t.key, { ...builtinStyle(t.key), ...(stored.tools[t.key] ?? {}) }]))
}

let loading: Promise<void> | null = null

/** Loads the remembered tool settings (once). */
export function loadToolStyles(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      let raw: unknown
      try {
        raw = await invoke('store:get', STORE_KEY)
      } catch (err) {
        console.warn('Could not read markup tool defaults', err)
        toast('Your comment tool settings could not be loaded, so the standard settings are used for now.', { kind: 'warning' })
      }
      const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredDefaults>
      const tools: Record<string, Partial<ToolStyle>> = {}
      for (const [k, v] of Object.entries(src.tools ?? {})) tools[k] = sanitize(v)
      const stored: StoredDefaults = { tools, seen: { ...(src.seen ?? {}) } }
      useToolStyles.setState({ loaded: true, stored, styles: recompute(stored) })
    })()
  }
  return loading
}

/** Picks up a new "Make current properties default" from the comments feature for this tool. */
export async function syncCommentDefaults(tool: MarkupTool): Promise<void> {
  await loadToolStyles()
  let value: unknown
  try {
    value = await invoke('store:get', `comments:defaults:${tool.annotType}`)
  } catch (err) {
    // optional: the tool keeps its own remembered settings
    console.warn('Could not read the comment defaults', err)
    return
  }
  if (value === undefined || value === null) return
  const json = JSON.stringify(value)
  const seenKey = `${tool.annotType}|${tool.key}`
  const { stored } = useToolStyles.getState()
  if (stored.seen[seenKey] === json) return
  const patch = defaultsApply(tool, value) ? fromAnnotDefaults(tool, value) : {}
  const next: StoredDefaults = {
    tools: { ...stored.tools, [tool.key]: { ...(stored.tools[tool.key] ?? {}), ...patch } },
    seen: { ...stored.seen, [seenKey]: json }
  }
  useToolStyles.setState({ stored: next, styles: recompute(next) })
  persist()
}

export function getToolStyle(key: string): ToolStyle {
  return useToolStyles.getState().styles[key] ?? builtinStyle(key)
}

/** Changes a tool's settings and remembers them as its defaults. */
export function setToolStyle(key: string, patch: Partial<ToolStyle>) {
  const { stored } = useToolStyles.getState()
  const next: StoredDefaults = { ...stored, tools: { ...stored.tools, [key]: { ...(stored.tools[key] ?? {}), ...patch } } }
  useToolStyles.setState({ stored: next, styles: recompute(next) })
  persist()
}

/** Restores the built-in settings of a tool. */
export function resetToolStyle(key: string) {
  const { stored } = useToolStyles.getState()
  const tools = { ...stored.tools }
  delete tools[key]
  const next: StoredDefaults = { ...stored, tools }
  useToolStyles.setState({ stored: next, styles: recompute(next) })
  persist()
}

export function useToolStyle(key: string): ToolStyle {
  return useToolStyles((s) => s.styles[key]) ?? builtinStyle(key)
}

