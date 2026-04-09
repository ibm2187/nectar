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
  sm: { icon: 'w-6 h-6', text: 'text-xs', gap: 'gap-2' },
  md: { icon: 'w-10 h-10', text: 'text-sm', gap: 'gap-3' },
  lg: { icon: 'w-16 h-16', text: 'text-base', gap: 'gap-4' },
}

function NectarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="nl-a" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FCD34D"/>
          <stop offset="100%" stopColor="#D97706"/>
        </linearGradient>
      </defs>
      <polygon points="16,8 22.5,11.5 22.5,18.5 16,22 9.5,18.5 9.5,11.5" fill="url(#nl-a)" opacity="0.9"/>
      <path d="M16,4 C17.5,6 18.5,7.5 18.5,9 C18.5,10.4 17.4,11 16,11 C14.6,11 13.5,10.4 13.5,9 C13.5,7.5 14.5,6 16,4Z" fill="#FCD34D" opacity="0.8"/>
      <polygon points="10,10 12.5,8.5 15,10 15,13 12.5,14.5 10,13" fill="#F59E0B" opacity="0.35"/>
      <polygon points="17,10 19.5,8.5 22,10 22,13 19.5,14.5 17,13" fill="#F59E0B" opacity="0.35"/>
      <polygon points="10,15 12.5,13.5 15,15 15,18 12.5,19.5 10,18" fill="#F59E0B" opacity="0.25"/>
      <polygon points="17,15 19.5,13.5 22,15 22,18 19.5,19.5 17,18" fill="#F59E0B" opacity="0.25"/>
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
