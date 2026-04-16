import { useAvailabilityStore } from '../stores/availabilityStore'
import { cn } from '../lib/utils'

/**
 * Renders a person's name with an OOO indicator when they're out.
 *
 * Regular 🌴 for awareness; 🔴🌴 (red palm tree) when their absence is
 * release-impacting (release due today/tomorrow + they're blocking it).
 */
export function PersonBadge({
  name,
  blockingRelease = false,
  className,
  muted = false,
}: {
  name: string | null | undefined
  /** If true, render a red palm tree (they're blocking an imminent release) */
  blockingRelease?: boolean
  className?: string
  /** Render name in muted style (for tables where name is secondary info) */
  muted?: boolean
}) {
  const getOut = useAvailabilityStore(s => s.getOut)
  if (!name) return <span className="text-muted-foreground italic">—</span>

  const out = getOut(name)
  const nameClass = cn(muted ? 'text-muted-foreground' : '', className)

  if (!out) {
    return <span className={nameClass}>{name}</span>
  }

  const emoji = blockingRelease ? '🔴🌴' : '🌴'
  const tooltip = `Out through ${out.endDate}${out.summary ? ' — ' + out.summary : ''}`

  return (
    <span className={cn('inline-flex items-center gap-1', nameClass)} title={tooltip}>
      <span>{name}</span>
      <span aria-label="out of office" className={blockingRelease ? 'text-red-400' : 'text-yellow-400'}>
        {emoji}
      </span>
    </span>
  )
}

/**
 * Plain icon — useful in tight spaces where you already have the name rendered.
 */
export function OutIcon({ name, blockingRelease = false, className }: {
  name: string | null | undefined
  blockingRelease?: boolean
  className?: string
}) {
  const getOut = useAvailabilityStore(s => s.getOut)
  if (!name) return null
  const out = getOut(name)
  if (!out) return null
  const emoji = blockingRelease ? '🔴🌴' : '🌴'
  const tooltip = `Out through ${out.endDate}${out.summary ? ' — ' + out.summary : ''}`
  return (
    <span
      aria-label="out of office"
      title={tooltip}
      className={cn('ml-1', blockingRelease ? 'text-red-400' : 'text-yellow-400', className)}
    >
      {emoji}
    </span>
  )
}
