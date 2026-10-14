// Certificate encryption: a crafted /Recipients list cannot stall or exhaust the main process. A file
// chooses its envelopes, so certkeys:* bounds the request (envelopes, bytes), the ASN.1 elements read
// across it and the RecipientInfos of each envelope, parses each distinct envelope once per request,
// and hands the Windows helper only what it parsed, once, up to STORE_RECIPIENT_INFOS recipients.
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  countAsn1Elements,
  ENVELOPE_LIMITS,
  EnvelopeLimitError,
  parseEnvelope
} from '@features/digital-signatures/lib/envelope'
import { createDigitalIdSource } from '@main/certkeys/digitalIdSource'
import { REQUEST_ELEMENTS, requestEnvelopes, STORE_RECIPIENT_INFOS } from '@main/certkeys/envelopes'
import { certKeyHandlers, CERTKEY_LIMITS } from '@main/certkeys/handlers'
import type { WindowsStore } from '@main/certkeys/windowsStoreSource'
import { idRecord, recipientsOf } from './certkeys-fixtures'

// Counts parses, to check that a request parses each distinct envelope once.
vi.mock('@features/digital-signatures/lib/envelope', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@features/digital-signatures/lib/envelope')>()
  return { ...orig, parseEnvelope: vi.fn(orig.parseEnvelope) }
})
const parses = vi.mocked(parseEnvelope)

const ok = { allowed: true } as unknown as IpcMainInvokeEvent
const allowed = (e: IpcMainInvokeEvent) => (e as unknown as { allowed: boolean }).allowed

/** A DER element: one identifier byte, the definite length, the content. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length
  const len =
    n < 0x80
      ? [n]
      : n < 0x100
        ? [0x81, n]
        : n < 0x10000
          ? [0x82, n >> 8, n & 255]
          : [0x83, n >> 16, (n >> 8) & 255, n & 255]
  const out = new Uint8Array(1 + len.length + n)
  out[0] = tag
  out.set(len, 1)
  out.set(content, 1 + len.length)
  return out
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const OID_DATA = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01)
const OID_ENVELOPED = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x03)
const OID_AES256 = Uint8Array.of(0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a)

/** A ContentInfo with EnvelopedData whose recipientInfos SET holds `infos` (raw DER). */
function envelopeWith(infos: Uint8Array, salt = 0): Uint8Array {
  const eci = tlv(
    0x30,
    cat(
      OID_DATA,
      tlv(0x30, cat(OID_AES256, tlv(0x04, new Uint8Array(16).fill(salt)))),
      tlv(0x80, new Uint8Array(32))
    )
  )
  const ed = tlv(0x30, cat(Uint8Array.of(0x02, 0x01, 0x00), tlv(0x31, infos), eci))
  return tlv(0x30, cat(OID_ENVELOPED, tlv(0xa0, ed)))
}

/** `n` two-byte RecipientInfos (`80 00`, an unknown kind), the cheapest a file can list. */
const tiny = (n: number): Uint8Array => {
  const b = new Uint8Array(2 * n)
  for (let i = 0; i < n; i++) b[2 * i] = 0x80
  return b
}

/** A Windows store that records what it was given and finds nothing. */
function recordingStore() {
  const given: Uint8Array[][] = []
  const store: WindowsStore = {
    kind: 'windows-store',
    state: async () => 'available',
    running: () => false,
    probe: async (blobs) => {
      given.push(blobs)
      return []
    },
    decrypt: async () => {
      throw new Error('not used')
    },
    listEncryptionCertificates: async () => [],
    stop: () => undefined
  }
  return { store, given }
}

function setup() {
  const { store, given } = recordingStore()
  const digitalIds = createDigitalIdSource({
    records: () => ['alice', 'bob', 'stranger', 'ec'].map((n) => idRecord(n)),
    passwords: () => ({}) as never,
    remembering: () => false
  })
  return { handlers: certKeyHandlers({ allowed, digitalIds, windowsStore: store }), given }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - t0 }
}

// Generous for a 2-CPU CI runner; before the limits these requests took tens of seconds.
const QUICK_MS = 3000

describe('envelope limits', () => {
  it('counts ASN.1 elements from the headers alone, and stops when the budget runs out', () => {
    const blob = envelopeWith(tiny(10))
    const budget = { left: 1000 }
    expect(countAsn1Elements(blob, budget)).toBe(true)
    // ContentInfo, OID, [0], EnvelopedData, version, SET + 10, eci, OID, alg, OID, IV, content
    expect(1000 - budget.left).toBe(22)
    expect(countAsn1Elements(blob, { left: 21 })).toBe(false)
    expect(() => countAsn1Elements(Uint8Array.of(0x30, 0x05, 0x02), { left: 10 })).toThrow('Damaged envelope')
  })

  it('refuses an envelope with too many RecipientInfos or elements before building it', () => {
    const max = ENVELOPE_LIMITS.recipientInfos
    expect(parseEnvelope(envelopeWith(tiny(max))).recipientInfos).toHaveLength(max)
    expect(() => parseEnvelope(envelopeWith(tiny(max + 1)))).toThrow(EnvelopeLimitError)
    const big = envelopeWith(tiny(500_000))
    expect(big.length).toBeGreaterThan(1_000_000)
    const t0 = performance.now()
    expect(() => parseEnvelope(big)).toThrow(EnvelopeLimitError)
    expect(() => parseEnvelope(big, { recipientInfos: Infinity })).toThrow('too large')
    expect(performance.now() - t0).toBeLessThan(QUICK_MS)
  })

  it('refuses deep nesting and indefinite lengths without running out of stack', () => {
    // 100 000 nested indefinite-length [0] elements
    const deep = new Uint8Array(400_000)
    for (let i = 0; i < 100_000; i++) {
      deep[2 * i] = 0xa0
      deep[2 * i + 1] = 0x80
    }
    expect(() => countAsn1Elements(deep, { left: 1e9 })).toThrow('nesting too deep')
    expect(() => parseEnvelope(deep)).toThrow('Damaged envelope')
  })

  it('shares one element budget between the envelopes of a request', () => {
    // 250 distinct envelopes of 1000 RecipientInfos: 253 000 elements, more than a request may read
    const blobs = Array.from({ length: 250 }, (_, i) => envelopeWith(tiny(ENVELOPE_LIMITS.recipientInfos), i))
    const t0 = performance.now()
    const { parsed, forStore } = requestEnvelopes(blobs)
    expect(performance.now() - t0).toBeLessThan(QUICK_MS)
    const read = parsed.filter(Boolean).length
    expect(read).toBe(Math.floor(REQUEST_ELEMENTS / 1012))
    expect(parsed.slice(0, read).every(Boolean)).toBe(true)
    // the Windows helper gets the first envelope: its 1000 recipients are all it may be given
    expect(STORE_RECIPIENT_INFOS).toBe(1000)
    expect(forStore.map((b) => b.length > 0)).toEqual(blobs.map((_, i) => i === 0))
    // identical envelopes are read once and cost nothing more
    const same = requestEnvelopes(new Array(250).fill(blobs[0]))
    expect(same.parsed.every((p) => p === same.parsed[0] && p !== null)).toBe(true)
  })

  it('an envelope over its own limit uses up only that much of the request', () => {
    const crafted = Array.from({ length: 3 }, (_, i) => envelopeWith(tiny(200_000), i))
    const real = recipientsOf('v5-classic.pdf')
    const { parsed, forStore } = requestEnvelopes([...crafted, ...real])
    expect(parsed.map(Boolean)).toEqual([false, false, false, true])
    expect(forStore.map((b) => b.length > 0)).toEqual([false, false, false, true])
  })

  it('gives the Windows helper each envelope once, only what was parsed, and at most 1000 recipients', () => {
    const real = recipientsOf('v5-two-envelopes.pdf')
    const nineHundred = envelopeWith(tiny(900))
    // 97 copies of one envelope: the helper walked every copy (97 000 recipients took 40 s)
    const copies = requestEnvelopes([...real, ...new Array(97).fill(nineHundred)])
    expect(copies.parsed.every(Boolean)).toBe(true)
    expect(copies.forStore.map((b) => b.length > 0)).toEqual([true, true, true, ...new Array(96).fill(false)])
    // the same real envelope twice: the second copy is left out (it gives the same answers)
    expect(requestEnvelopes([real[0], real[1], real[0]]).forStore.map((b) => b.length > 0)).toEqual([true, true, false])
    // a long-form length with leading zero bytes: refused here, but .NET would read all 3000
    const valid = envelopeWith(tiny(3000))
    const lead = valid[1] & 0x7f
    const padded = cat(Uint8Array.of(0x30, 0x80 | (lead + 4), 0, 0, 0, 0), valid.subarray(2))
    const damaged = requestEnvelopes([padded, ...real])
    expect(damaged.parsed.map(Boolean)).toEqual([false, true, true])
    expect(damaged.forStore.map((b) => b.length > 0)).toEqual([false, true, true])
    // distinct envelopes past 1000 recipients in all are left out too
    const many = requestEnvelopes([...real, ...Array.from({ length: 5 }, (_, i) => envelopeWith(tiny(400), i))])
    expect(many.forStore.map((b) => b.length > 0)).toEqual([true, true, true, true, false, false, false])
  })
})

describe('certkeys:* with crafted /Recipients', () => {
  it('refuses requests over the envelope count or total size', async () => {
    const { handlers, given } = setup()
    const probe = (blobs: Uint8Array[]) => handlers['certkeys:probe'](ok, { blobs })
    const one = new Uint8Array(CERTKEY_LIMITS.blobBytes)
    await expect(probe(new Array(CERTKEY_LIMITS.blobs + 1).fill(new Uint8Array(1)))).rejects.toThrow(
      'Invalid request for certificates.'
    )
    const overTotal = Array.from(
      { length: CERTKEY_LIMITS.totalBytes / CERTKEY_LIMITS.blobBytes + 1 },
      () => one
    )
    await expect(probe(overTotal)).rejects.toThrow('Invalid request for certificates.')
    await expect(
      handlers['certkeys:decrypt'](ok, {
        blobs: overTotal,
        candidate: `digital-id:${idRecord('alice').id}`,
        actor: 'person'
      })
    ).rejects.toThrow('Invalid request for certificates.')
    expect(given).toEqual([])
    // At the limits is fine.
    const atTotal = overTotal.slice(1)
    await expect(probe(atTotal)).resolves.toMatchObject({ candidates: [], recipients: [] })
    await expect(probe(new Array(CERTKEY_LIMITS.blobs).fill(new Uint8Array(1)))).resolves.toMatchObject({
      candidates: []
    })
  })

  it('answers quickly when one 1 MB envelope of 500 000 RecipientInfos is listed four times', async () => {
    const { handlers, given } = setup()
    const hostile = envelopeWith(tiny(500_000))
    const real = recipientsOf('v5-classic.pdf')
    const blobs = [hostile, hostile, ...real, hostile, hostile]
    expect(blobs.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(CERTKEY_LIMITS.totalBytes)
    parses.mockClear()
    const { value, ms } = await timed(() => handlers['certkeys:probe'](ok, { blobs }))
    expect(ms).toBeLessThan(QUICK_MS)
    // the real recipient is still found, and only it is described
    expect(value.candidates.map((c) => [c.label, c.envelope])).toEqual([['Alice Test', 2]])
    expect(value.recipients.map((r) => r.envelope)).toEqual([2])
    // each distinct envelope was parsed once, for both the Digital IDs and the summary
    expect(parses).toHaveBeenCalledTimes(2)
    // the Windows helper got empty envelopes in place of the crafted ones, indexes unchanged
    expect(given).toHaveLength(1)
    expect(given[0].map((b) => b.length)).toEqual([0, 0, real[0].length, 0, 0])
  })

  it('97 copies of a 1000-recipient envelope reach the Windows helper once', async () => {
    const { handlers, given } = setup()
    const thousand = envelopeWith(tiny(1000))
    const blobs = new Array(97).fill(thousand)
    expect(blobs.reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(CERTKEY_LIMITS.totalBytes)
    await handlers['certkeys:probe'](ok, { blobs })
    expect(given).toHaveLength(1)
    expect(given[0].filter((b) => b.length > 0)).toHaveLength(1)
  })

  it('caps the recipients described, and decrypts after one parse of the request', async () => {
    const { handlers } = setup()
    // the real envelope, then 99 envelopes of 1000 'other' RecipientInfos each (99 000 recipients)
    const real = recipientsOf('v5-classic.pdf')
    const blobs = [...real, ...Array.from({ length: 99 }, (_, i) => envelopeWith(tiny(1000), i))]
    const { value, ms } = await timed(() => handlers['certkeys:probe'](ok, { blobs }))
    expect(ms).toBeLessThan(QUICK_MS)
    expect(value.candidates.map((c) => c.label)).toEqual(['Alice Test'])
    expect(value.recipients.length).toBe(CERTKEY_LIMITS.recipients)
    expect(value.recipients[0]).toMatchObject({ envelope: 0, idType: 'issuerAndSerialNumber' })
    parses.mockClear()
    const { value: r, ms: decryptMs } = await timed(() =>
      handlers['certkeys:decrypt'](ok, {
        // a new request: IPC gives every request its own array
        blobs: [...blobs],
        candidate: `digital-id:${idRecord('alice').id}`,
        password: 'alice-pass',
        actor: 'person'
      })
    )
    expect(decryptMs).toBeLessThan(QUICK_MS)
    expect(r).toMatchObject({ ok: true, envelope: 0 })
    // probing again and decrypting share one parse of each envelope
    expect(parses).toHaveBeenCalledTimes(blobs.length)
  })
})
