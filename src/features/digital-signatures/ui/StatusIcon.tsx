import { BadgeCheck, CircleHelp, CircleX, PenLine, TriangleAlert } from 'lucide-react'
import type { StatusLevel } from '../status'

const LABELS: Record<StatusLevel, string> = {
  valid: 'Valid',
  'unknown-identity': 'Valid, signer identity unknown',
  warning: 'Has problems',
  unknown: 'Validity unknown',
  invalid: 'Invalid'
}

/** Coloured validity icon (green check, check with question, warning, X). */
export function StatusIcon({ level, size = 18 }: { level: StatusLevel | 'unsigned'; size?: number }) {
  if (level === 'unsigned') return <PenLine size={size} className="fc-digital-signatures-icon is-unsigned" aria-label="Unsigned" />
  const Icon = level === 'valid' || level === 'unknown-identity' ? BadgeCheck : level === 'invalid' ? CircleX : level === 'unknown' ? CircleHelp : TriangleAlert
  return <Icon size={size} className={`fc-digital-signatures-icon is-${level}`} aria-label={LABELS[level]} role="img" />
}
