import { clipboard } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MainContext } from '@main/context'

/** What is on the system clipboard, for Insert > From Clipboard (same shape as ./ipc.ts in the renderer). */
interface OrganizeClipboard {
  files: string[]
  image: Uint8Array | null
  text: string
}

declare module '@shared/ipc' {
  interface IpcApi {
    'feature:organize-pages:readClipboard': () => OrganizeClipboard
  }
}

/** Local file paths from a text/uri-list (or GNOME "copy" + URIs) payload. */
export function pathsFromUriList(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim()
    if (!l.startsWith('file://')) continue
    try {
      out.push(fileURLToPath(l))
    } catch {}
  }
  return [...new Set(out)].filter((p) => {
    try {
      return existsSync(p) && statSync(p).isFile()
    } catch {
      return false
    }
  })
}

async function blobText(value: unknown): Promise<string> {
  if (value instanceof Blob) return value.text()
  return typeof value === 'string' ? value : ''
}

export async function readClipboard(): Promise<OrganizeClipboard> {
  let files: string[] = []
  let image: Uint8Array | null = null
  let text = ''
  for (const item of await clipboard.read()) {
    const types = item.types
    if (!files.length) {
      const uriType = types.find((t) => t === 'text/uri-list' || t === 'x-special/gnome-copied-files')
      if (uriType) {
        try {
          files = pathsFromUriList(await blobText(await item.getType(uriType)))
        } catch {}
      }
    }
    if (!image) {
      const imageType = types.find((t) => t.startsWith('image/'))
      if (imageType) {
        try {
          const blob = await item.getType(imageType)
          if (blob instanceof Blob) image = new Uint8Array(await blob.arrayBuffer())
        } catch {}
      }
    }
    if (!text && types.includes('text/plain')) {
      try {
        text = await blobText(await item.getType('text/plain'))
      } catch {}
    }
  }
  if (!text && !files.length && !image) {
    try {
      text = await clipboard.readText()
    } catch {}
  }
  if (files.length) return { files, image: null, text: '' }
  if (image && image.length) return { files: [], image, text: '' }
  return { files: [], image: null, text }
}

export function register(ctx: MainContext) {
  ctx.handle('feature:organize-pages:readClipboard', () => readClipboard())
}
