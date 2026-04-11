import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import type { Release, EffectiveReleaseStatus } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

/**
 * Release Calendar — shows overdue, recently shipped, and upcoming releases
 * grouped by day or week. Uses the effective status from the backend which
 * considers prod environment deployments, not just JIRA's released flag.
 */

const STATUS_STYLE: Record<EffectiveReleaseStatus, { bg: string; text: string; dot: string; label: string }> = {
  shipped:    { bg: 'bg-green-500/10 border-green-500/30',  text: 'text-green-400',  dot: '🟢', label: 'Shipped' },
  'in-flight':{ bg: 'bg-blue-500/10 border-blue-500/30',    text: 'text-blue-400',   dot: '🔵', label: 'In Flight' },
  upcoming:   { bg: 'bg-muted border-border',               text: 'text-muted-foreground', dot: '⚪', label: 'Upcoming' },
  overdue:    { bg: 'bg-red-500/10 border-red-500/40',      text: 'text-red-400',    dot: '🔴', label: 'Overdue' },
  unknown:    { bg: 'bg-muted border-border',               text: 'text-muted-foreground', dot: '⚫', label: 'Unknown' },
}

type ViewMode = 'day' | 'week'

function formatDateShort(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function daysBetween(iso: string, now: Date): number {
  const d = new Date(iso)
  return Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function weekStart(iso: string): string {
  const d = new Date(iso)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Monday start
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

function weekLabel(weekStartIso: string, now: Date): string {
  const start = new Date(weekStartIso)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays <= 0 && diffDays > -7) return `This Week · ${startStr} – ${endStr}`
  if (diffDays >= 0 && diffDays < 7) return `This Week · ${startStr} – ${endStr}`
  if (diffDays >= 7 && diffDays < 14) return `Next Week · ${startStr} – ${endStr}`
  return `${startStr} – ${endStr}`
}

function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  if (diff === 0) return `Today · ${dateStr}`
  if (diff === 1) return `Tomorrow · ${dateStr}`
  if (diff === -1) return `Yesterday · ${dateStr}`
  return dateStr
}

// Navigation offset in days per view mode
const NAV_STEP: Record<ViewMode, number> = { day: 14, week: 28 }
const VISIBLE_GROUPS: Record<ViewMode, number> = { day: 14, week: 8 }

export function ReleaseCalendarPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const viewMode = (searchParams.get('view') as ViewMode) || 'week'
  const offsetDays = parseInt(searchParams.get('offset') || '0', 10)

  const [releases, setReleases] = useState<Release[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [repoFilter, setRepoFilter] = useState<string>('all')

  const now = useMemo(() => new Date(), [])

  function updateParams(updates: Record<string, string | null>) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '' || v === '0') next.delete(k)
        else next.set(k, v)
      }
      return next
    }, { replace: true })
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const from = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const data = await apiFetch<Release[]>(`/releases/calendar?from=${from}&to=${to}`)
      setReleases(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load calendar')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const repos = useMemo(() => {
    const set = new Set(releases.map(r => r.repo).filter(Boolean) as string[])
    return ['all', ...Array.from(set).sort()]
  }, [releases])

  const filtered = useMemo(() => {
    if (repoFilter === 'all') return releases
    return releases.filter(r => r.repo === repoFilter)
  }, [releases, repoFilter])

  // Bucket releases by status
  const buckets = useMemo(() => {
    const overdue: Release[] = []
    const inFlight: Release[] = []
    const shipped: Release[] = []
    const upcoming: Release[] = []
    for (const r of filtered) {
      const status = r.effectiveStatus?.status || 'unknown'
      if (status === 'overdue') overdue.push(r)
      else if (status === 'in-flight') inFlight.push(r)
      else if (status === 'shipped') shipped.push(r)
      else if (status === 'upcoming') upcoming.push(r)
    }
    overdue.sort((a, b) => (b.jiraReleaseDate || '').localeCompare(a.jiraReleaseDate || ''))
    shipped.sort((a, b) => (b.jiraReleaseDate || '').localeCompare(a.jiraReleaseDate || ''))
    upcoming.sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''))
    inFlight.sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''))
    return { overdue, inFlight, shipped, upcoming }
  }, [filtered])

  // Group upcoming + in-flight by day or week
  const upcomingGrouped = useMemo(() => {
    const combined = [...buckets.inFlight, ...buckets.upcoming]
      .sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''))
    const groups = new Map<string, Release[]>()
    for (const r of combined) {
      if (!r.jiraReleaseDate) continue
      const key = viewMode === 'day' ? r.jiraReleaseDate.slice(0, 10) : weekStart(r.jiraReleaseDate)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [buckets, viewMode])

  // Apply offset for navigation
  const visibleGroups = useMemo(() => {
    // Find the index of the first group at or after the offset point
    const offsetDate = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    let startIdx = upcomingGrouped.findIndex(([key]) => key >= offsetDate)
    if (startIdx < 0) startIdx = 0
    return upcomingGrouped.slice(startIdx, startIdx + VISIBLE_GROUPS[viewMode])
  }, [upcomingGrouped, offsetDays, viewMode, now])

  const canGoBack = offsetDays > 0
  const canGoForward = visibleGroups.length > 0 &&
    upcomingGrouped.indexOf(visibleGroups[visibleGroups.length - 1]) < upcomingGrouped.length - 1

  function goBack() {
    const next = Math.max(0, offsetDays - NAV_STEP[viewMode])
    updateParams({ offset: next === 0 ? null : String(next) })
  }
  function goForward() {
    updateParams({ offset: String(offsetDays + NAV_STEP[viewMode]) })
  }
  function goToday() {
    updateParams({ offset: null })
  }

  function openRelease(r: Release) {
    const key = r.repo ? `${r.repo}:${r.version}` : r.version
    navigate(`/releases/${encodeURIComponent(key)}`, { state: { from: 'calendar' } })
  }

  if (loading) {
    return <NectarLoader size="lg" message="Loading calendar..." className="mt-32" />
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={load} className="mt-2">Retry</Button>
        </CardContent>
      </Card>
    )
  }

  function groupLabel(key: string) {
    return viewMode === 'day' ? dayLabel(key, now) : weekLabel(key, now)
  }

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <h2 className="text-2xl font-bold">Release Calendar</h2>
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex rounded-md border text-xs">
              <button
                type="button"
                onClick={() => updateParams({ view: 'day', offset: null })}
                className={cn("px-3 py-1.5 rounded-l-md transition-colors", viewMode === 'day' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              >
                Day
              </button>
              <button
                type="button"
                onClick={() => updateParams({ view: null, offset: null })}
                className={cn("px-3 py-1.5 rounded-r-md border-l transition-colors", viewMode === 'week' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              >
                Week
              </button>
            </div>
            <select
              value={repoFilter}
              onChange={e => setRepoFilter(e.target.value)}
              className="text-sm border rounded px-2 py-1 bg-background"
            >
              {repos.map(r => (
                <option key={r} value={r}>{r === 'all' ? 'All repos' : r}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
          </div>
        </div>
        <div className="flex gap-4 text-sm flex-wrap">
          <span className="text-muted-foreground">
            <span className="text-red-400 font-semibold">{buckets.overdue.length}</span> overdue
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            <span className="text-blue-400 font-semibold">{buckets.inFlight.length}</span> in flight
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            <span className="text-foreground font-semibold">{buckets.upcoming.length}</span> upcoming
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            <span className="text-green-400 font-semibold">{buckets.shipped.length}</span> shipped
          </span>
        </div>
      </div>

      {/* Overdue — always shown first */}
      {buckets.overdue.length > 0 && (
        <Section title="Overdue" count={buckets.overdue.length} accent="red">
          {buckets.overdue.map(r => <ReleaseRow key={r.id} release={r} now={now} onClick={() => openRelease(r)} />)}
        </Section>
      )}

      {/* Recently shipped (collapsed by default) */}
      {buckets.shipped.length > 0 && (
        <CollapsibleSection title="Recently Shipped" count={buckets.shipped.length} accent="green">
          {buckets.shipped.slice(0, 10).map(r => <ReleaseRow key={r.id} release={r} now={now} onClick={() => openRelease(r)} />)}
        </CollapsibleSection>
      )}

      {/* Today divider */}
      <div className="flex items-center gap-3 my-2">
        <div className="flex-1 h-px bg-border"></div>
        <span className="text-xs uppercase tracking-widest text-muted-foreground px-2">
          Today · {now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
        <div className="flex-1 h-px bg-border"></div>
      </div>

      {/* Navigation bar */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={goBack} disabled={!canGoBack} className="text-xs">
          &larr; Back
        </Button>
        {offsetDays > 0 && (
          <Button variant="ghost" size="sm" onClick={goToday} className="text-xs">
            Today
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={goForward} disabled={!canGoForward} className="text-xs">
          Forward &rarr;
        </Button>
      </div>

      {/* Upcoming grouped by day or week */}
      {visibleGroups.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground italic">
            No upcoming releases scheduled in this range
          </CardContent>
        </Card>
      ) : (
        visibleGroups.map(([key, rels]) => (
          <Section key={key} title={groupLabel(key)} count={rels.length} accent="default">
            {rels.map(r => <ReleaseRow key={r.id} release={r} now={now} onClick={() => openRelease(r)} />)}
          </Section>
        ))
      )}

      {/* Bottom navigation */}
      {upcomingGrouped.length > VISIBLE_GROUPS[viewMode] && (
        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" size="sm" onClick={goBack} disabled={!canGoBack} className="text-xs">
            &larr; Back
          </Button>
          {offsetDays > 0 && (
            <Button variant="ghost" size="sm" onClick={goToday} className="text-xs">
              Today
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={goForward} disabled={!canGoForward} className="text-xs">
            Forward &rarr;
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Components ────────────────────────────────────────────

function Section({ title, count, accent, children }: {
  title: string
  count: number
  accent: 'red' | 'green' | 'default'
  children: React.ReactNode
}) {
  const titleColor = {
    red: 'text-red-400',
    green: 'text-green-400',
    default: 'text-foreground',
  }[accent]

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className={cn("text-sm font-semibold uppercase tracking-wider", titleColor)}>{title}</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
        <div className="flex-1 h-px bg-border ml-2"></div>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function CollapsibleSection({ title, count, accent, children }: {
  title: string
  count: number
  accent: 'red' | 'green' | 'default'
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const titleColor = {
    red: 'text-red-400',
    green: 'text-green-400',
    default: 'text-foreground',
  }[accent]

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 mb-2 w-full text-left group"
      >
        <span className="text-xs text-muted-foreground group-hover:text-foreground">{open ? '▾' : '▸'}</span>
        <h3 className={cn("text-sm font-semibold uppercase tracking-wider", titleColor)}>{title}</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
        <div className="flex-1 h-px bg-border ml-2"></div>
      </button>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  )
}

function ReleaseRow({ release, now, onClick }: {
  release: Release
  now: Date
  onClick: () => void
}) {
  const status = release.effectiveStatus?.status || 'unknown'
  const style = STATUS_STYLE[status]
  const days = release.jiraReleaseDate ? daysBetween(release.jiraReleaseDate, now) : null

  let timingText = ''
  if (status === 'overdue' && release.effectiveStatus?.daysOverdue) {
    timingText = `${release.effectiveStatus.daysOverdue}d overdue · no prod deployment detected`
  } else if (status === 'in-flight' && days !== null) {
    timingText = days <= 0 ? 'today' : `in ${days}d`
  } else if (status === 'upcoming' && days !== null) {
    timingText = `in ${days}d`
  }

  const proof = release.effectiveStatus?.shippedSignals?.[0]?.detail

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left border rounded-lg px-4 py-3 transition-colors hover:brightness-110",
        style.bg
      )}
    >
      <div className="flex items-center gap-3">
        <div className="text-xs font-mono text-muted-foreground w-16 shrink-0">
          {release.jiraReleaseDate ? formatDateShort(release.jiraReleaseDate) : '—'}
        </div>
        <span className="text-lg shrink-0">{style.dot}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-semibold truncate">{release.version}</span>
            {release.repo && (
              <Badge variant="outline" className="text-xs">{release.repo}</Badge>
            )}
            <Badge variant="outline" className={cn("text-xs", style.text)}>{style.label}</Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {(release.tickets || []).length} tickets · {release.state}
            {timingText && <span> · {timingText}</span>}
            {proof && status === 'shipped' && <span> · ✓ {proof}</span>}
          </div>
        </div>
      </div>
    </button>
  )
}
