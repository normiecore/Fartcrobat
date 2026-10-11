import type { ComponentType } from 'react'
import { CalendarDays, Check, PenLine, X } from 'lucide-react'
import type { FillSignKind } from './shared'

type IconProps = { size?: number | string; className?: string; strokeWidth?: number }

function Svg({ size = 24, className, children, label }: IconProps & { children: React.ReactNode; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {children}
    </svg>
  )
}

/** "Ab" with a caret: Acrobat's Add text icon. */
export function AddTextIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 17 6.5 7l3.5 10" />
      <path d="M4.2 13.5h4.6" />
      <path d="M13 9.5v7.5" />
      <path d="M13 13.2c.6-1.2 1.6-1.9 2.8-1.9 1.6 0 2.7 1.3 2.7 2.9s-1.1 2.9-2.7 2.9c-1.2 0-2.2-.7-2.8-1.9" />
      <path d="M21 5v14" strokeWidth={1.5} />
    </Svg>
  )
}

export function DotIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function LineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h16" />
    </Svg>
  )
}

export function RoundedBoxIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="18" height="10" rx="4" />
    </Svg>
  )
}

export function InitialsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 16c2-6 3-9 4-9s-1 6 0 8 3-6 4-6-1 5 0 6 2-1 3-2" />
      <path d="M4 20h16" strokeWidth={1.5} />
    </Svg>
  )
}

export const KIND_ICON: Record<FillSignKind, ComponentType<IconProps>> = {
  text: AddTextIcon,
  date: CalendarDays,
  cross: X,
  check: Check,
  dot: DotIcon,
  line: LineIcon,
  box: RoundedBoxIcon,
  signature: PenLine,
  initials: InitialsIcon
}
