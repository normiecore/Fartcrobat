/** Remembered sign-dialog choices and the saved handwritten signature from Fill & Sign. */
import { invoke } from '@renderer/sdk'
import { fromBase64 } from '../lib/asn1'
import type { AppearanceOptions } from '../types'
import { STORE_FILLSIGN_SIGNATURE, STORE_PREFS } from '../types'

export interface SignPrefs {
  lastIdId: string | null
  reason: string
  location: string
  contactInfo: string
  appearance: Omit<AppearanceOptions, 'image'>
  subFilter: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached'
}

export const DEFAULT_APPEARANCE: Omit<AppearanceOptions, 'image'> = {
  graphic: 'name',
  showName: true,
  showDate: true,
  showReason: true,
  showLocation: true,
  showLabels: true,
  showDistinguishedName: false
}

export const DEFAULT_PREFS: SignPrefs = {
  lastIdId: null,
  reason: '',
  location: '',
  contactInfo: '',
  appearance: DEFAULT_APPEARANCE,
  subFilter: 'ETSI.CAdES.detached'
}

export const REASONS = [
  'I am the author of this document',
  'I have reviewed this document',
  'I am approving this document',
  'I attest to the accuracy and integrity of this document',
  'I agree to the terms defined by the placement of my signature on this document'
]

export async function loadSignPrefs(): Promise<SignPrefs> {
  try {
    const v = (await invoke('store:get', STORE_PREFS)) as Partial<SignPrefs> | undefined
    if (!v || typeof v !== 'object') return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...v, appearance: { ...DEFAULT_APPEARANCE, ...(v.appearance ?? {}) } }
  } catch {
    return DEFAULT_PREFS
  }
}

export async function saveSignPrefs(p: SignPrefs) {
  try {
    await invoke('store:set', STORE_PREFS, p)
  } catch {}
}

function dataUrlToBytes(s: string): Uint8Array | null {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(s.trim())
  if (!m) return null
  try {
    return fromBase64(m[2])
  } catch {
    return null
  }
}

/** Finds PNG/JPEG bytes in whatever shape a stored signature takes (data URL, bytes, object, list). */
export function imageFromStoreValue(v: unknown, depth = 0): Uint8Array | null {
  if (!v || depth > 3) return null
  if (typeof v === 'string') return dataUrlToBytes(v)
  if (v instanceof Uint8Array) return v.length ? v : null
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => typeof x === 'number')) return new Uint8Array(v as number[])
    for (const x of v) {
      const r = imageFromStoreValue(x, depth + 1)
      if (r) return r
    }
    return null
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['dataUrl', 'dataURL', 'png', 'image', 'src', 'url', 'data']) {
      const r = imageFromStoreValue(o[key], depth + 1)
      if (r) return r
    }
  }
  return null
}

/** The user's saved handwritten signature (Fill & Sign), if any. */
export async function loadSavedSignatureImage(): Promise<Uint8Array | null> {
  try {
    return imageFromStoreValue(await invoke('store:get', STORE_FILLSIGN_SIGNATURE))
  } catch {
    return null
  }
}
