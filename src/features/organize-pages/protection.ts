/** Wording for files that keep the protection of the file they were made from (pure). */
import type { ProtectionSummary } from '@engine/util/protection'

/** "128-bit RC4 encryption, the same open password and the same restrictions" */
export function protectionDetails(p: ProtectionSummary): string {
  const parts = [`${p.method} encryption`]
  if (p.needsPassword) parts.push('the same open password')
  if (p.restricted) parts.push('the same restrictions')
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Sentence for the result message of a tool whose output kept the protection of `sourceName`:
 * "<subject> the protection of “a.pdf”: 256-bit AES encryption and the same open password."
 */
export function protectionNote(p: ProtectionSummary, sourceName: string, subject = 'It keeps'): string {
  return `${subject} the protection of “${sourceName}”: ${protectionDetails(p)}.`
}
