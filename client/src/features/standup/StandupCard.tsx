import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { cn } from '../../lib/utils'

interface StandupSummary {
  people: Array<{ name: string; totalItems: number; isOoo: boolean }>
  releasesDueThisWeek: Array<{ version: string; ticketsRemaining: number }>
}

/**
 * Time-aware "Start Standup" card shown on the HomePage.
 * Highlights at 10 AM ET (standup time) with a pulse animation.
 * Shows quick summary: how many people, how many action items.
 */
export function StandupCard() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<StandupSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch<StandupSummary>('/standup')
      .then(d => { if (!cancelled) setSummary(d) })
      .catch(() => {}) // silent — non-critical
    return () => { cancelled = true }
  }, [])

  // Check if we're near standup time (10 AM ET ± 30 min)
  const isStandupTime = useMemo(() => {
    const now = new Date()
    const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false })
    const [h, m] = etString.split(':').map(Number)
    const minutesSince10am = (h - 10) * 60 + m
    return minutesSince10am >= -30 && minutesSince10am <= 30
  }, [])

  if (!summary || summary.people.length === 0) return null

  const activePeople = summary.people.filter(p => !p.isOoo)
  const totalItems = activePeople.reduce((sum, p) => sum + p.totalItems, 0)

  return (
    <button
      onClick={() => navigate('/standup')}
      className={cn(
        'w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-all text-left',
        'hover:bg-accent/50 hover:border-primary/30',
        isStandupTime
          ? 'border-primary/50 bg-primary/5 shadow-sm shadow-primary/10'
          : 'border-border bg-card'
      )}
    >
      <div className="flex items-center gap-3">
        <span className={cn('text-xl', isStandupTime && 'animate-pulse')}>🎯</span>
        <div>
          <div className="font-medium text-sm">
            {isStandupTime ? 'Standup Time' : 'Daily Standup'}
          </div>
          <div className="text-xs text-muted-foreground">
            {activePeople.length} people &middot; {totalItems} action items
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Start →</span>
      </div>
    </button>
  )
}
