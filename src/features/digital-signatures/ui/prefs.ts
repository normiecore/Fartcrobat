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

const IMAGE_KEYS = ['dataUrl', 'dataURL', 'png', 'image', 'imageData', 'src', 'url', 'data', 'signature', 'value']

function isPngOrJpeg(b: Uint8Array): boolean {
  return (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b.length > 3 && b[0] === 0xff && b[1] === 0xd8)
}

/** A stored image: PNG/JPEG bytes, or any other image data URL (SVG, WebP...) to rasterise. */
type FoundImage = { bytes: Uint8Array } | { dataUrl: string }

function dataUrlImage(s: string): FoundImage | null {
  const m = /^data:image\/([\w.+-]+)(;base64)?,(.*)$/is.exec(s.trim())
  if (!m) return null
  const kind = m[1].toLowerCase()
  if ((kind === 'png' || kind === 'jpeg' || kind === 'jpg') && m[2]) {
    try {
      const bytes = fromBase64(m[3])
      if (isPngOrJpeg(bytes)) return { bytes }
    } catch {
      return null
    }
  }
  return { dataUrl: s.trim() }
}

/**
 * Finds an image in whatever shape a stored signature takes (data URL, bytes, an object or a list
 * of them). Initials are skipped: the appearance shows the full signature.
 */
export function imageFromStoreValue(v: unknown, depth = 0): FoundImage | null {
  if (!v || depth > 4) return null
  if (typeof v === 'string') return dataUrlImage(v)
  if (v instanceof Uint8Array) return isPngOrJpeg(v) ? { bytes: v } : null
  if (Array.isArray(v)) {
    if (v.length && v.every((x) => typeof x === 'number')) {
      const bytes = new Uint8Array(v as number[])
      return isPngOrJpeg(bytes) ? { bytes } : null
    }
    for (const x of v) {
      const r = imageFromStoreValue(x, depth + 1)
      if (r) return r
    }
    return null
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of IMAGE_KEYS) {
      const r = imageFromStoreValue(o[key], depth + 1)
      if (r) return r
    }
    for (const [key, value] of Object.entries(o)) {
      if (IMAGE_KEYS.includes(key) || /initial/i.test(key)) continue
      const r = imageFromStoreValue(value, depth + 1)
      if (r) return r
    }
  }
  return null
}

/** Draws an image data URL onto a canvas and returns PNG bytes (keeps transparency). */
async function rasterise(dataUrl: string): Promise<Uint8Array | null> {
  const img = new Image()
  img.src = dataUrl
  try {
    await img.decode()
  } catch {
    return null
  }
  const scale = Math.min(4, Math.max(1, 1200 / Math.max(1, img.naturalWidth || 300)))
  const w = Math.max(1, Math.round((img.naturalWidth || 300) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || 100) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

/** The user's saved handwritten signature (Fill & Sign), as PNG or JPEG bytes, if any. */
export async function loadSavedSignatureImage(): Promise<Uint8Array | null> {
  try {
    const found = imageFromStoreValue(await invoke('store:get', STORE_FILLSIGN_SIGNATURE))
    if (!found) return null
    return 'bytes' in found ? found.bytes : await rasterise(found.dataUrl)
  } catch {
    return null
  }
}
