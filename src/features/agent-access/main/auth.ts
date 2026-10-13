// The handshake's cryptography (see macInput in @shared/agent/protocol).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { macInput } from '@shared/agent/protocol'

const HEX_32_BYTES = /^[0-9a-f]{64}$/i

/** `bytes` random bytes as hex: tokens and nonces are 32 bytes. */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && HEX_32_BYTES.test(value)
}

/**
 * HMAC-SHA256 keyed with the token as written in endpoint.json (its 64 characters as UTF-8), over
 * macInput(role, nonce), as lowercase hex. The shim computes the same.
 */
export function computeMac(token: string, role: 'client' | 'server', nonce: string): string {
  return createHmac('sha256', token).update(macInput(role, nonce), 'utf8').digest('hex')
}

/** Constant-time check of a MAC the other side sent. */
export function verifyMac(token: string, role: 'client' | 'server', nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string' || !HEX_32_BYTES.test(mac)) return false
  const expected = createHmac('sha256', token).update(macInput(role, nonce), 'utf8').digest()
  return timingSafeEqual(expected, Buffer.from(mac, 'hex'))
}
