// The /Recipients envelopes of one certkeys request, checked and parsed once. A file chooses what it
// lists, so the work is bounded before anything is parsed: the request's size (handlers.ts), the
// ASN.1 elements read across all its envelopes, and the RecipientInfos of each (ENVELOPE_LIMITS).
// Identical envelopes (a file may list one many times) are parsed once, and the Windows helper only
// gets what was parsed here, once, up to STORE_RECIPIENT_INFOS recipients in all.
import { createHash } from 'node:crypto'
import {
  ENVELOPE_LIMITS,
  parseEnvelope,
  type ParsedEnvelope
} from '@features/digital-signatures/lib/envelope'

/**
 * ASN.1 elements read across the distinct envelopes of one request (an RSA recipient has about 30).
 * An envelope over its own limit (ENVELOPE_LIMITS) uses up at most that much, so it takes several
 * distinct crafted envelopes to use up a request.
 */
export const REQUEST_ELEMENTS = 4 * ENVELOPE_LIMITS.elements

/**
 * RecipientInfos given to the Windows helper per request, across its envelopes. The helper walks
 * each one in PowerShell (about half a millisecond each), so this bounds a probe to well under its
 * timeout. Real files have a few recipients.
 */
export const STORE_RECIPIENT_INFOS = ENVELOPE_LIMITS.recipientInfos

export interface RequestEnvelopes {
  /** One per blob: the parsed envelope, or null when it is damaged or over the limits. */
  parsed: (ParsedEnvelope | null)[]
  /**
   * The blobs for the Windows helper, indexes unchanged. Replaced by empty ones (which it reports as
   * unreadable): envelopes not parsed here (damaged or over the limits; .NET accepts some encodings
   * this parser refuses, such as lengths with leading zero bytes), the second and later copies of
   * an envelope (they give the same answers as the first), and envelopes past
   * STORE_RECIPIENT_INFOS. So a crafted list never makes PowerShell do more than a real file.
   */
  forStore: Uint8Array[]
}

const EMPTY = new Uint8Array()

// By the request's blobs array: certkeys:probe and certkeys:decrypt hand the same array to every
// source and to the summary, so each request is parsed once.
const cache = new WeakMap<readonly Uint8Array[], RequestEnvelopes>()

function parseAll(blobs: readonly Uint8Array[]): RequestEnvelopes {
  let left = REQUEST_ELEMENTS
  let storeRecipients = STORE_RECIPIENT_INFOS
  const seen = new Map<string, ParsedEnvelope | null>()
  const parsed: (ParsedEnvelope | null)[] = []
  const forStore: Uint8Array[] = []
  for (const blob of blobs) {
    const key = createHash('sha256').update(blob).digest('hex')
    if (seen.has(key)) {
      parsed.push(seen.get(key) ?? null)
      forStore.push(EMPTY)
      continue
    }
    let envelope: ParsedEnvelope | null = null
    const elements = { left: Math.min(ENVELOPE_LIMITS.elements, left) }
    const given = elements.left
    try {
      envelope = parseEnvelope(blob, { elements })
    } catch {
      // Damaged, or over the limits (EnvelopeLimitError): unreadable for every source.
    }
    left -= given - Math.max(elements.left, 0)
    seen.set(key, envelope)
    parsed.push(envelope)
    let toStore = false
    if (envelope && envelope.recipientInfos.length <= storeRecipients) {
      storeRecipients -= envelope.recipientInfos.length
      toStore = true
    }
    forStore.push(toStore ? blob : EMPTY)
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
