import { cn } from '../lib/utils'

interface Props {
  /** Short message below the icon */
  message?: string
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
  /** Additional className */
  className?: string
}

const SIZES = {
  sm: { icon: 'w-10 h-10', text: 'text-xs', gap: 'gap-2' },
  md: { icon: 'w-16 h-16', text: 'text-sm', gap: 'gap-3' },
  lg: { icon: 'w-24 h-24', text: 'text-base', gap: 'gap-4' },
}

export function NectarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="nl-g1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FDE68A"/>
          <stop offset="100%" stopColor="#D97706"/>
        </linearGradient>
        <linearGradient id="nl-g2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FBBF24"/>
          <stop offset="100%" stopColor="#92400E"/>
        </linearGradient>
      </defs>
      {/* Center hex */}
      <polygon points="16,12.5 19,14 19,17 16,18.5 13,17 13,14" fill="url(#nl-g2)"/>
      {/* Outer source hexes */}
      <polygon points="16,5 17.8,6 17.8,8 16,9 14.2,8 14.2,6" fill="none" stroke="url(#nl-g1)" strokeWidth="0.8"/>
      <polygon points="8.5,8.5 10.3,9.5 10.3,11.5 8.5,12.5 6.7,11.5 6.7,9.5" fill="none" stroke="url(#nl-g1)" strokeWidth="0.8"/>
      <polygon points="23.5,8.5 25.3,9.5 25.3,11.5 23.5,12.5 21.7,11.5 21.7,9.5" fill="none" stroke="url(#nl-g1)" strokeWidth="0.8"/>
      <polygon points="8.5,19 10.3,20 10.3,22 8.5,23 6.7,22 6.7,20" fill="none" stroke="url(#nl-g1)" strokeWidth="0.8"/>
      <polygon points="23.5,19 25.3,20 25.3,22 23.5,23 21.7,22 21.7,20" fill="none" stroke="url(#nl-g1)" strokeWidth="0.8"/>
      {/* Connecting lines */}
      <line x1="16" y1="9" x2="16" y2="12.5" stroke="#FBBF24" strokeWidth="0.6" opacity="0.5"/>
      <line x1="10.3" y1="11.5" x2="13" y2="14" stroke="#FBBF24" strokeWidth="0.6" opacity="0.5"/>
      <line x1="21.7" y1="11.5" x2="19" y2="14" stroke="#FBBF24" strokeWidth="0.6" opacity="0.5"/>
      <line x1="10.3" y1="20" x2="13" y2="17" stroke="#FBBF24" strokeWidth="0.6" opacity="0.5"/>
      <line x1="21.7" y1="20" x2="19" y2="17" stroke="#FBBF24" strokeWidth="0.6" opacity="0.5"/>
      {/* Source dots */}
      <circle cx="16" cy="7" r="1" fill="#FBBF24" opacity="0.7"/>
      <circle cx="8.5" cy="10.5" r="1" fill="#FBBF24" opacity="0.7"/>
      <circle cx="23.5" cy="10.5" r="1" fill="#FBBF24" opacity="0.7"/>
      <circle cx="8.5" cy="21" r="1" fill="#FBBF24" opacity="0.7"/>
      <circle cx="23.5" cy="21" r="1" fill="#FBBF24" opacity="0.7"/>
    </svg>
  )
}

/**
 * Nectar-branded loading indicator. Uses the app icon with a pulse animation.
 * Drop-in replacement for plain "Loading..." text.
 */
export function NectarLoader({ message, size = 'md', className }: Props) {
  const s = SIZES[size]
  return (
    <div className={cn("flex flex-col items-center justify-center py-6", s.gap, className)}>
      <NectarIcon className={cn(s.icon, "animate-pulse")} />
      {message && (
        <span className={cn("text-muted-foreground", s.text)}>{message}</span>
      )}
    </div>
  )
}

/**
 * Inline loader — just the icon spinning next to text. Good for buttons/headers.
 */
export function NectarSpinner({ className }: { className?: string }) {
  return <NectarIcon className={cn("w-4 h-4 animate-pulse inline-block", className)} />
}
