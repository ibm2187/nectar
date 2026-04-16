import { useEffect, useState } from 'react'
import { useAvailabilityStore } from '../stores/availabilityStore'
import { cn } from '../lib/utils'

const DISMISS_KEY = 'nectar-out-banner-dismissed'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Collapsed awareness banner:
 *   🌴 3 out today · 🎉 Good Friday in 2 days (CDN)
 * Expandable. Dismissible per-day (state resets overnight).
 * Not rendered when nothing to show.
 */
export function CurrentlyOutBanner() {
  const data = useAvailabilityStore(s => s.data)
  const load = useAvailabilityStore(s => s.load)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    load()
    // Check if dismissed today
    try {
      const raw = localStorage.getItem(DISMISS_KEY)
      if (raw === todayIso()) setDismissed(true)
    } catch { /* ignore */ }
  }, [load])

  const currentlyOut = data.currentlyOut || []
  const upcomingHolidays = (data.upcomingHolidays || []).filter(h => {
    // Only show holidays within the next 7 days
    const diff = (new Date(h.date).getTime() - Date.now()) / (24 * 3600 * 1000)
    return diff >= 0 && diff <= 7
  })

  if (dismissed) return null
  if (currentlyOut.length === 0 && upcomingHolidays.length === 0) return null

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDismissed(true)
    try { localStorage.setItem(DISMISS_KEY, todayIso()) } catch { /* ignore */ }
  }

  const outSummary = currentlyOut.length > 0
    ? `🌴 ${currentlyOut.length} out today`
    : null
  const holidaySummary = upcomingHolidays.length > 0
    ? `🎉 ${upcomingHolidays[0].name} ${daysFromNow(upcomingHolidays[0].date)}${upcomingHolidays[0].countries.length ? ' (' + upcomingHolidays[0].countries.join(', ') + ')' : ''}`
    : null

  return (
    <div
      role="button"
      onClick={() => setExpanded(v => !v)}
      className={cn(
        'flex items-start gap-3 rounded-md border border-border/40 bg-muted/10 px-3 py-2 cursor-pointer transition-colors hover:bg-muted/20',
      )}
    >
      <div className="flex-1 min-w-0">
        {!expanded ? (
          <div className="text-xs text-muted-foreground">
            {[outSummary, holidaySummary].filter(Boolean).join(' · ')}
            <span className="ml-2 opacity-50">click to expand</span>
          </div>
        ) : (
          <div className="space-y-2">
            {currentlyOut.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">🌴 Out today</div>
                <div className="flex flex-wrap gap-1.5">
                  {currentlyOut.map(e => (
                    <span
                      key={e.name + e.startDate}
                      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-border/40 bg-background/50"
                      title={e.summary}
                    >
                      <span>{e.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        → {e.endDate}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {upcomingHolidays.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1">🎉 Upcoming holidays</div>
                <div className="flex flex-wrap gap-1.5">
                  {upcomingHolidays.map(h => (
                    <span
                      key={h.date}
                      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border border-border/40 bg-background/50"
                    >
                      <span>{h.name}</span>
                      <span className="text-[10px] text-muted-foreground">{h.date}</span>
                      {h.countries.length > 0 && (
                        <span className="text-[10px] text-muted-foreground">({h.countries.join(', ')})</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="text-muted-foreground hover:text-foreground text-xs px-1"
        aria-label="Dismiss for today"
        title="Dismiss for today"
      >
        ✕
      </button>
    </div>
  )
}

function daysFromNow(isoDate: string): string {
  const diffDays = Math.round((new Date(isoDate).getTime() - Date.now()) / (24 * 3600 * 1000))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  if (diffDays < 7) return `in ${diffDays} days`
  return `on ${isoDate}`
}
