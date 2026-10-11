import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { Point } from '@shared/geometry'
import { invoke, showError, useDocState, usePageVersion, usePrefs, type DocumentModel } from '@renderer/sdk'
import {
  angleDegrees,
  defaultScale,
  formatMeasure,
  formatNumber,
  isPageUnit,
  measureShape,
  sanitizeScale,
  toRealLength,
  type MeasureKind,
  type MeasureScale
} from './measureMath'
import type { MeasurementInfo, SnapTargets } from './engine'

type MeasureOps = typeof import('./engine').default

export const SETTINGS_KEY = 'stamps-measure:settings'

export const TOOL_KIND: Record<string, MeasureKind> = {
  'measure.distance': 'distance',
  'measure.perimeter': 'perimeter',
  'measure.area': 'area'
}

export const KIND_TOOL: Record<MeasureKind, string> = {
  distance: 'measure.distance',
  perimeter: 'measure.perimeter',
  area: 'measure.area'
}

export interface MeasureSettings {
  /** Snap to end points, midpoints and text corners. */
  snap: boolean
  color: string
  /** Show the value on the page (caption / label). */
  showLabels: boolean
}

export const DEFAULT_SETTINGS: MeasureSettings = { snap: true, color: '#D32F2F', showLabels: true }

/** A measurement being drawn. */
export interface LiveMeasure {
  docId: string
  page: number
  kind: MeasureKind
  points: Point[]
  /** Pointer position (after snapping), or null when the pointer left the page. */
  cursor: Point | null
  snapped: boolean
}

interface MeasureState {
  settings: MeasureSettings
  settingsLoaded: boolean
  /** Scale stored in each open document (null: none stored yet). */
  scales: Record<string, MeasureScale | null>
  live: LiveMeasure | null
  /** The next distance drawn sets the scale ("Calibrate") instead of adding a measurement. */
  calibrating: boolean
}

export const useMeasure = create<MeasureState>(() => ({
  settings: { ...DEFAULT_SETTINGS },
  settingsLoaded: false,
  scales: {},
  live: null,
  calibrating: false
}))

export function measureOps(doc: DocumentModel) {
  return doc.ops<MeasureOps>('stamps-measure')
}

// ---- settings (per user) ---------------------------------------------------------------------

export async function loadMeasureSettings() {
  if (useMeasure.getState().settingsLoaded) return
  try {
    const v = (await invoke('store:get', SETTINGS_KEY)) as Partial<MeasureSettings> | undefined
    const s = { ...DEFAULT_SETTINGS }
    if (v && typeof v === 'object') {
      if (typeof v.snap === 'boolean') s.snap = v.snap
      if (typeof v.showLabels === 'boolean') s.showLabels = v.showLabels
      if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) s.color = v.color
    }
    useMeasure.setState({ settings: s, settingsLoaded: true })
  } catch {
    useMeasure.setState({ settingsLoaded: true })
  }
}

export function setMeasureSettings(patch: Partial<MeasureSettings>) {
  const settings = { ...useMeasure.getState().settings, ...patch }
  useMeasure.setState({ settings })
  void invoke('store:set', SETTINGS_KEY, settings).catch((err) => showError(err, 'Could not save measuring settings'))
}

// ---- scale (per document) --------------------------------------------------------------------

/** Scale used when a document has none: 1:1 in the units chosen in Preferences. */
export function fallbackScale(units: string): MeasureScale {
  return defaultScale(isPageUnit(units) ? units : 'in')
}

/** The document's measurement scale (reloaded after undo/redo). */
export function useDocScale(doc: DocumentModel): MeasureScale {
  const prefs = usePrefs()
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const stored = useMeasure((s) => s.scales[doc.id])
  useEffect(() => {
    let alive = true
    measureOps(doc)
      .getScale()
      .then((scale) => {
        if (alive) useMeasure.setState((s) => ({ scales: { ...s.scales, [doc.id]: scale } }))
      })
      .catch((err) => console.warn('Could not read the measurement scale', err))
    return () => {
      alive = false
    }
  }, [doc, docVersion])
  return stored ?? fallbackScale(prefs.measurementUnits)
}

/** Current scale for a document outside React. */
export function currentScale(doc: DocumentModel, units: string): MeasureScale {
  return useMeasure.getState().scales[doc.id] ?? fallbackScale(units)
}

export async function setDocScale(doc: DocumentModel, scale: MeasureScale): Promise<boolean> {
  const sc = sanitizeScale(scale)
  if (!sc) {
    showError(new Error('Use positive numbers for both sides of the scale'), 'Scale not changed')
    return false
  }
  try {
    const saved = await measureOps(doc).setScale(sc)
    useMeasure.setState((s) => ({ scales: { ...s.scales, [doc.id]: saved } }))
    return true
  } catch (err) {
    showError(err, 'Could not set the scale')
    return false
  }
}

// ---- page data -------------------------------------------------------------------------------

/** Measurements on a page (refetched when the page changes). */
export function usePageMeasurements(doc: DocumentModel, page: number): MeasurementInfo[] {
  const version = usePageVersion(doc, page)
  const [list, setList] = useState<{ key: string; items: MeasurementInfo[] }>({ key: '', items: [] })
  const key = `${doc.id}:${page}:${version}`
  useEffect(() => {
    let alive = true
    if (page < 0 || page >= doc.pageCount) return
    measureOps(doc)
      .listMeasurements(page)
      .then((items) => {
        if (alive) setList({ key, items })
      })
      .catch((err) => console.warn('Could not list measurements', err))
    return () => {
      alive = false
    }
  }, [doc, page, key])
  return list.items
}

const snapCache = new Map<string, Promise<SnapTargets>>()

/** Points to snap to on a page (cached per page version). */
export function useSnapTargets(doc: DocumentModel, page: number, enabled: boolean): SnapTargets | null {
  const version = usePageVersion(doc, page)
  const [targets, setTargets] = useState<{ key: string; t: SnapTargets } | null>(null)
  const key = `${doc.id}:${page}:${version}`
  useEffect(() => {
    if (!enabled) return
    let p = snapCache.get(key)
    if (!p) {
      p = measureOps(doc).snapPoints(page)
      snapCache.set(key, p)
      p.catch(() => snapCache.delete(key))
      // keep the cache small
      if (snapCache.size > 40) snapCache.delete(snapCache.keys().next().value!)
    }
    let alive = true
    p.then((t) => alive && setTargets({ key, t })).catch((err) => console.warn('Snap points unavailable', err))
    return () => {
      alive = false
    }
  }, [doc, page, key, enabled])
  return enabled && targets?.key === key ? targets.t : null
}

// ---- live readout ----------------------------------------------------------------------------

export interface ReadoutRow {
  label: string
  value: string
}

/** Rows shown in "Measurement info" and next to the pointer while measuring. */
export function liveReadout(live: LiveMeasure | null, scale: MeasureScale): { headline: string; rows: ReadoutRow[] } | null {
  if (!live) return null
  const pts = live.cursor ? [...live.points, live.cursor] : live.points
  if (!pts.length) return null
  const unit = scale.realUnit
  const fmt = (v: number) => formatMeasure(v, unit, scale.precision)
  const rows: ReadoutRow[] = []
  const last = pts.length >= 2 ? [pts[pts.length - 2], pts[pts.length - 1]] : null
  let headline = ''
  if (live.kind === 'distance') {
    const r = measureShape('distance', pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : [pts[0], pts[0]], scale)
    headline = r.label
    rows.push({ label: 'Distance', value: r.label })
  } else if (live.kind === 'perimeter') {
    const r = measureShape('perimeter', pts, scale)
    headline = r.label
    rows.push({ label: 'Perimeter', value: r.label })
  } else {
    const r = measureShape('area', pts, scale)
    headline = pts.length >= 3 ? r.label : fmt(r.length)
    rows.push({ label: 'Area', value: pts.length >= 3 ? r.label : '—' })
    rows.push({ label: 'Perimeter', value: fmt(r.length) })
  }
  if (last) {
    const [a, b] = last
    if (live.kind !== 'distance') rows.push({ label: 'Segment', value: fmt(toRealLength(Math.hypot(b[0] - a[0], b[1] - a[1]), scale)) })
    rows.push({ label: 'Angle', value: `${formatNumber(angleDegrees(a, b), 1)}°` })
    rows.push({ label: 'Δ X', value: fmt(toRealLength(Math.abs(b[0] - a[0]), scale)) })
    rows.push({ label: 'Δ Y', value: fmt(toRealLength(Math.abs(b[1] - a[1]), scale)) })
  }
  return { headline, rows }
}
