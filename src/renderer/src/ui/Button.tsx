import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { Icon } from '../app/registry'

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'accent'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  icon?: Icon
  size?: 'sm' | 'md'
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', icon: IconC, size = 'md', className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`ui-btn ui-btn-${variant} ui-btn-${size} ${className ?? ''}`}
      {...rest}
    >
      {IconC && <IconC size={size === 'sm' ? 14 : 16} />}
      {children !== undefined && <span>{children}</span>}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: Icon
  label: string
  active?: boolean
  size?: number
  shortcut?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: IconC, label, active, size = 18, shortcut, className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`ui-icon-btn ${active ? 'is-active' : ''} ${className ?? ''}`}
      {...rest}
    >
      <IconC size={size} />
    </button>
  )
})
