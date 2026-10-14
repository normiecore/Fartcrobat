// The /Recipients envelopes of one certkeys request, checked and parsed once. A file chooses what it
// lists, so the work is bounded before anything is parsed: the request's size (handlers.ts), the
// ASN.1 elements read across all its envelopes, and the RecipientInfos of each (ENVELOPE_LIMITS).
// Identical envelopes (a file may list one many times) are parsed once.
import { createHash } from 'node:crypto'
import {
  ENVELOPE_LIMITS,
  EnvelopeLimitError,
  parseEnvelope,
  type ParsedEnvelope
} from '@features/digital-signatures/lib/envelope'

/**
 * ASN.1 elements read across the distinct envelopes of one request (an RSA recipient has about 30).
 * An envelope over its own limit (ENVELOPE_LIMITS) uses up at most that much, so it takes several
 * distinct crafted envelopes to use up a request.
 */
export const REQUEST_ELEMENTS = 4 * ENVELOPE_LIMITS.elements

export interface RequestEnvelopes {
  /** One per blob: the parsed envelope, or null when it is damaged or over the limits. */
  parsed: (ParsedEnvelope | null)[]
  /**
   * The blobs for the Windows helper: those over the limits are replaced by empty ones, which it
   * reports as unreadable too, so a crafted list never reaches PowerShell. Indexes are unchanged.
   */
  forStore: Uint8Array[]
}

const EMPTY = new Uint8Array()

// By the request's blobs array: certkeys:probe and certkeys:decrypt hand the same array to every
// source and to the summary, so each request is parsed once.
const cache = new WeakMap<readonly Uint8Array[], RequestEnvelopes>()

function parseAll(blobs: readonly Uint8Array[]): RequestEnvelopes {
  let left = REQUEST_ELEMENTS
  const seen = new Map<string, { parsed: ParsedEnvelope | null; tooLarge: boolean }>()
  const parsed: (ParsedEnvelope | null)[] = []
  const forStore: Uint8Array[] = []
  for (const blob of blobs) {
    const key = createHash('sha256').update(blob).digest('hex')
    let entry = seen.get(key)
    if (!entry) {
      entry = { parsed: null, tooLarge: false }
      const elements = { left: Math.min(ENVELOPE_LIMITS.elements, left) }
      const given = elements.left
      try {
        entry.parsed = parseEnvelope(blob, { elements })
      } catch (err) {
        entry.tooLarge = err instanceof EnvelopeLimitError
      }
      left -= given - Math.max(elements.left, 0)
      seen.set(key, entry)
    }
    parsed.push(entry.parsed)
    forStore.push(entry.tooLarge ? EMPTY : blob)
  }
  return { parsed, forStore }
}

/** The request's envelopes, parsed once per blobs array. */
export function requestEnvelopes(blobs: readonly Uint8Array[]): RequestEnvelopes {
  let out = cache.get(blobs)
  if (!out) {
    out = parseAll(blobs)
    cache.set(blobs, out)
  }
  return out
}
