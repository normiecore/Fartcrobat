/** Mail parameters that make some mail apps attach a local file to the new message. */
const ATTACH_PARAMS = new Set(['attach', 'attachment', 'attachments'])

function paramName(part: string): string {
  const raw = part.split('=')[0]
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).trim().toLowerCase()
  } catch {
    return raw.trim().toLowerCase()
  }
}

/** A mailto: URL without attach= or attachment= parameters; other URLs are returned unchanged. */
export function stripMailtoAttachments(url: string): string {
  if (!/^\s*mailto:/i.test(url)) return url
  const q = url.indexOf('?')
  if (q < 0) return url
  const hash = url.indexOf('#', q)
  const query = url.slice(q + 1, hash < 0 ? undefined : hash)
  const kept = query.split('&').filter((part) => part && !ATTACH_PARAMS.has(paramName(part)))
  return url.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + (hash < 0 ? '' : url.slice(hash))
}

/** The URL to hand to the system for a web or mail link, or null when it is neither. */
export function externalUrlToOpen(url: string): string | null {
  if (!/^(https?|mailto):/i.test(url)) return null
  return stripMailtoAttachments(url)
}
