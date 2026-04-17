import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import type { Release, EffectiveReleaseStatus } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'
import { SavedViews } from '../../components/SavedViews'
import { useAvailabilityStore } from '../../stores/availabilityStore'

/**
 * Combined Releases page with two view modes:
 * - Calendar (default): grid layout with repos on Y-axis and time columns on X-axis
 * - Agenda: overdue section, today divider, upcoming releases grouped by day/week
 */

// ── Types ──────────────────────────────────────────────

type ViewMode = 'calendar' | 'agenda'
type ZoomLevel = 'day' | 'week' | 'month'
type AgendaGroupMode = 'day' | 'week'

interface TimeColumn {
  key: string
  label: string
  start: string
  end: string
}

// ── Status styles (shared by both views) ──────────────

const STATUS_STYLE: Record<EffectiveReleaseStatus, { bg: string; text: string; dot: string; label: string }> = {
  shipped:    { bg: 'bg-green-500/10 border-green-500/30',  text: 'text-green-400',  dot: '🟢', label: 'Shipped' },
  'in-flight':{ bg: 'bg-blue-500/10 border-blue-500/30',    text: 'text-blue-400',   dot: '🔵', label: 'In Flight' },
  upcoming:   { bg: 'bg-muted border-border',               text: 'text-muted-foreground', dot: '⚪', label: 'Upcoming' },
  overdue:    { bg: 'bg-red-500/10 border-red-500/40',      text: 'text-red-400',    dot: '🔴', label: 'Overdue' },
  unknown:    { bg: 'bg-muted border-border',               text: 'text-muted-foreground', dot: '⚫', label: 'Unknown' },
}

// ── Shared helpers ─────────────────────────────────────

function formatDateShort(iso: string) {
  // JIRA dates are "YYYY-MM-DD" — append T12:00 to prevent timezone shift
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Parse a date-only string ("YYYY-MM-DD") as local, not UTC */
function parseLocalDate(iso: string): Date {
  return new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)
}

function daysBetween(iso: string, now: Date): number {
  const d = parseLocalDate(iso)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const rel = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((rel.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

function weekStart(iso: string): string {
  const d = parseLocalDate(iso)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function weekLabel(weekStartIso: string, now: Date): string {
  const start = parseLocalDate(weekStartIso)
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
  const d = parseLocalDate(iso)
  const diff = daysBetween(iso, now)

  const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  if (diff === 0) return `Today · ${dateStr}`
  if (diff === 1) return `Tomorrow · ${dateStr}`
  if (diff === -1) return `Yesterday · ${dateStr}`
  return dateStr
}

// ── Navigation constants ──────────────────────────────

const CALENDAR_NAV_STEP: Record<ZoomLevel, number> = { day: 14, week: 4, month: 3 }
const CALENDAR_VISIBLE_COUNT: Record<ZoomLevel, number> = { day: 14, week: 8, month: 6 }

const AGENDA_NAV_STEP: Record<AgendaGroupMode, number> = { day: 14, week: 28 }
const AGENDA_VISIBLE_GROUPS: Record<AgendaGroupMode, number> = { day: 14, week: 8 }

// ── Main page component ───────────────────────────────

export function ReleasesPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const viewMode = (searchParams.get('view') as ViewMode) || 'agenda'
  const zoom = (searchParams.get('zoom') as ZoomLevel) || 'day'
  const offsetParam = parseInt(searchParams.get('offset') || '0', 10)

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
      setError(err instanceof Error ? err.message : 'Failed to load releases')
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

  function openRelease(r: Release) {
    const key = r.repo ? `${r.repo}:${r.version}` : r.version
    navigate(`/releases/${encodeURIComponent(key)}`, { state: { from: 'releases' } })
  }

  // ── Bucket releases by status (used for stats + agenda) ──

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
      else inFlight.push(r) // unknown status — put in in-flight so it's visible
    }
    overdue.sort((a, b) => (b.jiraReleaseDate || '').localeCompare(a.jiraReleaseDate || ''))
    shipped.sort((a, b) => (b.jiraReleaseDate || '').localeCompare(a.jiraReleaseDate || ''))
    upcoming.sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''))
    inFlight.sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''))
    return { overdue, inFlight, shipped, upcoming }
  }, [filtered])

  // ── Loading / error states ──────────────────────────────

  if (loading) {
    return <NectarLoader size="lg" message="Loading releases..." className="mt-32" />
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

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Releases</h2>
          <div className="flex gap-4 text-sm flex-wrap mt-1">
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
        <div className="flex items-center gap-2">
          {/* View mode toggle: Calendar | Agenda */}
          <div className="flex rounded-md border text-xs">
            <button
              type="button"
              onClick={() => updateParams({ view: 'calendar', offset: null })}
              className={cn("px-3 py-1.5 rounded-l-md transition-colors", viewMode === 'calendar' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => updateParams({ view: 'agenda', zoom: null, offset: null })}
              className={cn("px-3 py-1.5 rounded-r-md border-l transition-colors", viewMode === 'agenda' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
            >
              Agenda
            </button>
          </div>

          {/* Zoom toggle (Calendar view) or Day/Week toggle (Agenda view) */}
          {viewMode === 'calendar' ? (
            <>
              {/* Navigation arrows */}
              <Button variant="ghost" size="sm" onClick={() => {
                const next = Math.max(0, offsetParam - CALENDAR_NAV_STEP[zoom])
                updateParams({ offset: next === 0 ? null : String(next) })
              }} disabled={offsetParam <= 0} className="text-xs h-7 px-2">
                &larr;
              </Button>
              {offsetParam > 0 && (
                <Button variant="ghost" size="sm" onClick={() => updateParams({ offset: null })} className="text-xs h-7 px-2">
                  Today
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => {
                updateParams({ offset: String(offsetParam + CALENDAR_NAV_STEP[zoom]) })
              }} className="text-xs h-7 px-2">
                &rarr;
              </Button>
              {/* Zoom levels */}
              <div className="flex rounded-md border text-xs">
                <button
                  type="button"
                  onClick={() => updateParams({ zoom: 'day', offset: null })}
                  className={cn("px-3 py-1.5 rounded-l-md transition-colors", zoom === 'day' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  Day
                </button>
                <button
                  type="button"
                  onClick={() => updateParams({ zoom: null, offset: null })}
                  className={cn("px-3 py-1.5 border-l transition-colors", zoom === 'week' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  Week
                </button>
                <button
                  type="button"
                  onClick={() => updateParams({ zoom: 'month', offset: null })}
                  className={cn("px-3 py-1.5 rounded-r-md border-l transition-colors", zoom === 'month' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                >
                  Month
                </button>
              </div>
            </>
          ) : (
            <div className="flex rounded-md border text-xs">
              <button
                type="button"
                onClick={() => updateParams({ zoom: 'day', offset: null })}
                className={cn("px-3 py-1.5 rounded-l-md transition-colors", zoom === 'day' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              >
                Day
              </button>
              <button
                type="button"
                onClick={() => updateParams({ zoom: null, offset: null })}
                className={cn("px-3 py-1.5 rounded-r-md border-l transition-colors", (zoom === 'week' || zoom === 'month') ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
              >
                Week
              </button>
            </div>
          )}

          {/* Repo filter */}
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
          <SavedViews storageKey="nectar-saved-views-releases" />
        </div>
      </div>

      {/* View content */}
      {viewMode === 'calendar' ? (
        <CalendarView
          releases={filtered}
          zoom={zoom}
          offsetParam={offsetParam}
          now={now}
          onOpenRelease={openRelease}
        />
      ) : (
        <AgendaView
          buckets={buckets}
          zoom={zoom === 'month' ? 'week' : zoom as AgendaGroupMode}
          offsetParam={offsetParam}
          now={now}
          onOpenRelease={openRelease}
          updateParams={updateParams}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// ══ CALENDAR VIEW ════════════════════════════════════════
// ══════════════════════════════════════════════════════════

function CalendarView({ releases, zoom, offsetParam, now, onOpenRelease }: {
  releases: Release[]
  zoom: ZoomLevel
  offsetParam: number
  now: Date
  onOpenRelease: (r: Release) => void
}) {
  const today = useMemo(() => now.toISOString().slice(0, 10), [now])

  // ── Derive repos from release data for Y-axis rows ────
  const repoRows = useMemo(() => {
    const set = new Set(releases.map(r => r.repo || 'unknown').filter(Boolean))
    return Array.from(set).sort()
  }, [releases])

  // ── Generate day columns ────────────────────────────────
  const dayColumns = useMemo((): TimeColumn[] => {
    const base = new Date(now)
    base.setHours(0, 0, 0, 0)
    const days: TimeColumn[] = []
    for (let i = 0; i < 60; i++) {
      const d = new Date(base)
      d.setDate(base.getDate() + i)
      const iso = d.toISOString().slice(0, 10)
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      days.push({ key: `d-${iso}`, label, start: iso, end: iso })
    }
    return days
  }, [now])

  // ── Generate week columns ───────────────────────────────
  const weekColumns = useMemo((): TimeColumn[] => {
    const day = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - ((day + 6) % 7))
    monday.setHours(0, 0, 0, 0)

    const weeks: TimeColumn[] = []
    for (let i = 0; i < 52; i++) {
      const start = new Date(monday)
      start.setDate(monday.getDate() + i * 7)
      const end = new Date(start)
      end.setDate(start.getDate() + 6)

      const startStr = start.toISOString().slice(0, 10)
      const endStr = end.toISOString().slice(0, 10)
      const label = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      weeks.push({ key: `w-${startStr}`, label, start: startStr, end: endStr })
    }
    return weeks
  }, [now])

  // ── Generate month columns ──────────────────────────────
  const monthColumns = useMemo((): TimeColumn[] => {
    const base = new Date(now)
    base.setDate(1)
    base.setHours(0, 0, 0, 0)

    const months: TimeColumn[] = []
    for (let i = 0; i < 24; i++) {
      const start = new Date(base)
      start.setMonth(base.getMonth() + i)
      const end = new Date(start)
      end.setMonth(end.getMonth() + 1)
      end.setDate(end.getDate() - 1)

      const startStr = start.toISOString().slice(0, 10)
      const endStr = end.toISOString().slice(0, 10)
      const label = start.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      months.push({ key: `m-${startStr}`, label, start: startStr, end: endStr })
    }
    return months
  }, [now])

  // ── Visible columns based on zoom + offset ─────────────
  const visibleColumns = useMemo(() => {
    const count = CALENDAR_VISIBLE_COUNT[zoom]
    if (zoom === 'day') return dayColumns.slice(offsetParam, offsetParam + count)
    if (zoom === 'week') return weekColumns.slice(offsetParam, offsetParam + count)
    return monthColumns.slice(offsetParam, offsetParam + count)
  }, [zoom, offsetParam, dayColumns, weekColumns, monthColumns])

  // ── Group releases by repo ──────────────────────────────
  const releasesByRepo = useMemo(() => {
    const map = new Map<string, Release[]>()
    for (const r of releases) {
      const repo = r.repo || 'unknown'
      if (!map.has(repo)) map.set(repo, [])
      map.get(repo)!.push(r)
    }
    return map
  }, [releases])

  // ── Check for overdue and unscheduled releases ─────────
  const { hasOverdue, hasUnscheduled } = useMemo(() => {
    let overdue = false
    let unscheduled = false
    for (const r of releases) {
      if (!r.jiraReleaseDate) {
        // Only consider non-shipped releases as unscheduled
        const status = r.effectiveStatus?.status || 'unknown'
        if (status !== 'shipped') unscheduled = true
      } else if (r.jiraReleaseDate < today) {
        const status = r.effectiveStatus?.status || 'unknown'
        if (status !== 'shipped') overdue = true
      }
      if (overdue && unscheduled) break
    }
    return { hasOverdue: overdue, hasUnscheduled: unscheduled }
  }, [releases, today])

  // ── Get releases for a repo in a given column ──────────
  function getReleasesForCell(repo: string, col: TimeColumn): Release[] {
    const repoReleases = releasesByRepo.get(repo) || []
    return repoReleases.filter(r => {
      if (!r.jiraReleaseDate) return false
      const date = r.jiraReleaseDate.slice(0, 10)
      // Exclude overdue from time columns
      const status = r.effectiveStatus?.status || 'unknown'
      if (status === 'overdue') return false
      return date >= col.start && date <= col.end
    })
  }

  // ── Overdue releases for a repo ────────────────────────
  function getOverdueForRepo(repo: string): Release[] {
    const repoReleases = releasesByRepo.get(repo) || []
    return repoReleases.filter(r => {
      const status = r.effectiveStatus?.status || 'unknown'
      return status === 'overdue'
    })
  }

  // ── Unscheduled releases for a repo ────────────────────
  function getUnscheduledForRepo(repo: string): Release[] {
    const repoReleases = releasesByRepo.get(repo) || []
    return repoReleases.filter(r => {
      if (r.jiraReleaseDate) return false
      const status = r.effectiveStatus?.status || 'unknown'
      return status !== 'shipped'
    })
  }

  if (repoRows.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground italic">
          No releases found
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px]">
        {/* Header row */}
        <div className="flex border-b sticky top-0 bg-background z-10">
          <div className="w-28 md:w-48 shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Repo
          </div>
          {hasOverdue && (
            <div className="w-36 shrink-0 px-2 py-2 text-xs font-semibold uppercase tracking-wider text-red-400/70 text-center border-l bg-red-500/[0.03]">
              Overdue
            </div>
          )}
          {hasUnscheduled && (
            <div className="w-36 shrink-0 px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/50 text-center border-l">
              Unscheduled
            </div>
          )}
          {visibleColumns.map(col => (
            <div
              key={col.key}
              className={cn(
                "flex-1 px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center border-l",
                zoom === 'day' ? "min-w-[70px] md:min-w-[90px]" : zoom === 'week' ? "min-w-[90px] md:min-w-[110px]" : "min-w-[110px] md:min-w-[140px]"
              )}
            >
              <div>{col.label}</div>
              {zoom === 'day' && <CalendarDayChips isoDate={col.start} />}
            </div>
          ))}
        </div>

        {/* Repo rows */}
        {repoRows.map(repo => (
          <RepoRow
            key={repo}
            repo={repo}
            columns={visibleColumns}
            zoom={zoom}
            showOverdue={hasOverdue}
            showUnscheduled={hasUnscheduled}
            overdueReleases={getOverdueForRepo(repo)}
            unscheduledReleases={getUnscheduledForRepo(repo)}
            getReleasesForCell={(col) => getReleasesForCell(repo, col)}
            onOpenRelease={onOpenRelease}
          />
        ))}
      </div>
    </div>
  )
}

// ── Repo row in calendar grid ──────────────────────────

function RepoRow({ repo, columns, zoom, showOverdue, showUnscheduled, overdueReleases, unscheduledReleases, getReleasesForCell, onOpenRelease }: {
  repo: string
  columns: TimeColumn[]
  zoom: ZoomLevel
  showOverdue: boolean
  showUnscheduled: boolean
  overdueReleases: Release[]
  unscheduledReleases: Release[]
  getReleasesForCell: (col: TimeColumn) => Release[]
  onOpenRelease: (r: Release) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  // Count total releases for this repo across all visible cells
  const totalReleases = useMemo(() => {
    let count = overdueReleases.length + unscheduledReleases.length
    for (const col of columns) {
      count += getReleasesForCell(col).length
    }
    return count
  }, [columns, overdueReleases, unscheduledReleases, getReleasesForCell])

  function renderCell(releases: Release[]) {
    return (
      <>
        {!collapsed && releases.map(r => (
          <CalendarReleaseCard key={r.id} release={r} onClick={() => onOpenRelease(r)} />
        ))}
        {collapsed && releases.length > 0 && (
          <div className="text-[10px] text-muted-foreground text-center py-1">
            {releases.length} release{releases.length !== 1 ? 's' : ''}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="flex border-b hover:bg-accent/10 transition-colors">
      {/* Repo label */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-28 md:w-48 shrink-0 px-3 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{collapsed ? '▸' : '▾'}</span>
          <div>
            <div className="text-sm font-medium leading-tight">{repo}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {totalReleases} release{totalReleases !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      </button>

      {/* Overdue cell */}
      {showOverdue && (
        <div className="w-36 shrink-0 px-1.5 py-2 border-l bg-red-500/[0.02]">
          {renderCell(overdueReleases)}
        </div>
      )}

      {/* Unscheduled cell */}
      {showUnscheduled && (
        <div className="w-36 shrink-0 px-1.5 py-2 border-l">
          {renderCell(unscheduledReleases)}
        </div>
      )}

      {/* Time cells */}
      {columns.map(col => {
        const cellReleases = getReleasesForCell(col)
        return (
          <div
            key={col.key}
            className={cn("flex-1 px-1.5 py-2 border-l", zoom === 'day' ? "min-w-[70px] md:min-w-[90px]" : zoom === 'week' ? "min-w-[90px] md:min-w-[110px]" : "min-w-[110px] md:min-w-[140px]")}
          >
            {renderCell(cellReleases)}
          </div>
        )
      })}
    </div>
  )
}

// ── Release card for calendar grid ────────────────────

function CalendarReleaseCard({ release, onClick }: { release: Release; onClick: () => void }) {
  const status = release.effectiveStatus?.status || 'unknown'
  const style = STATUS_STYLE[status]

  const stateColor = release.state === 'done'
    ? 'border-green-500/40 bg-green-500/5'
    : release.state === 'stabilizing' || release.state === 'approved'
    ? 'border-blue-500/40 bg-blue-500/5'
    : release.state === 'deploying'
    ? 'border-yellow-500/40 bg-yellow-500/5'
    : 'border-muted/50 bg-muted/5'

  const riskGlyph = release.risk.score === 'high' ? '🔴' :
    release.risk.score === 'medium' ? '🟡' : null

  // Ticket progress
  const tickets = release.tickets || []
  const doneCount = tickets.filter(t => t.state === 'done' || t.state === 'closed' || t.state === 'cherry-picked').length
  const totalCount = tickets.length
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0

  // Risk badge styling
  const riskScore = release.risk.score
  const riskBadge = riskScore === 'high'
    ? { label: 'HIGH', cls: 'bg-red-500/20 text-red-400' }
    : riskScore === 'medium'
    ? { label: 'MED', cls: 'bg-yellow-500/20 text-yellow-400' }
    : riskScore === 'low'
    ? { label: 'LOW', cls: 'bg-green-500/20 text-green-400' }
    : null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full text-left rounded-md border p-2 mb-1.5 transition-all hover:scale-[1.02] hover:shadow-sm cursor-pointer",
        stateColor
      )}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="font-mono text-xs font-medium truncate">{release.version}</span>
        <div className="flex items-center gap-1 shrink-0">
          {riskBadge && (
            <span className={cn("text-[9px] px-1 rounded font-semibold", riskBadge.cls)}>
              {riskBadge.label}
            </span>
          )}
          {riskGlyph && !riskBadge && <span className="text-[10px]">{riskGlyph}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1 mt-1">
        <Badge variant="outline" className={cn("text-[9px] px-1 py-0", style.text)}>{style.label}</Badge>
      </div>
      {/* Progress bar + count */}
      {totalCount > 0 && (
        <div className="mt-1.5">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
            <span>{doneCount}/{totalCount} done</span>
          </div>
          <div className="w-full h-1 rounded-full bg-muted/50 overflow-hidden">
            <div
              className="h-full rounded-full bg-green-500/60 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}
      {totalCount === 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground leading-tight">
          0 tickets
        </div>
      )}
    </button>
  )
}

// ══════════════════════════════════════════════════════════
// ══ AGENDA VIEW ══════════════════════════════════════════
// ══════════════════════════════════════════════════════════

function AgendaView({ buckets, zoom, offsetParam, now, onOpenRelease, updateParams }: {
  buckets: { overdue: Release[]; inFlight: Release[]; shipped: Release[]; upcoming: Release[] }
  zoom: AgendaGroupMode
  offsetParam: number
  now: Date
  onOpenRelease: (r: Release) => void
  updateParams: (updates: Record<string, string | null>) => void
}) {
  const offsetDays = offsetParam

  // Group upcoming + in-flight by day or week
  const upcomingGrouped = useMemo(() => {
    const combined = [...buckets.inFlight, ...buckets.upcoming]
      .sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''))
    const groups = new Map<string, Release[]>()
    for (const r of combined) {
      if (!r.jiraReleaseDate) continue
      const key = zoom === 'day' ? r.jiraReleaseDate.slice(0, 10) : weekStart(r.jiraReleaseDate)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [buckets, zoom])

  // Apply offset for navigation
  const visibleGroups = useMemo(() => {
    const offsetDate = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    let startIdx = upcomingGrouped.findIndex(([key]) => key >= offsetDate)
    if (startIdx < 0) startIdx = 0
    return upcomingGrouped.slice(startIdx, startIdx + AGENDA_VISIBLE_GROUPS[zoom])
  }, [upcomingGrouped, offsetDays, zoom, now])

  const canGoBack = offsetDays > 0
  const canGoForward = visibleGroups.length > 0 &&
    upcomingGrouped.indexOf(visibleGroups[visibleGroups.length - 1]) < upcomingGrouped.length - 1

  function goBack() {
    const next = Math.max(0, offsetDays - AGENDA_NAV_STEP[zoom])
    updateParams({ offset: next === 0 ? null : String(next) })
  }
  function goForward() {
    updateParams({ offset: String(offsetDays + AGENDA_NAV_STEP[zoom]) })
  }
  function goToday() {
    updateParams({ offset: null })
  }

  function groupLabel(key: string) {
    return zoom === 'day' ? dayLabel(key, now) : weekLabel(key, now)
  }

  return (
    <div className="space-y-6">
      {/* Overdue -- always shown first */}
      {buckets.overdue.length > 0 && (
        <AgendaSection title="Overdue" count={buckets.overdue.length} accent="red">
          {buckets.overdue.map(r => <AgendaReleaseRow key={r.id} release={r} now={now} onClick={() => onOpenRelease(r)} />)}
        </AgendaSection>
      )}

      {/* Recently shipped (collapsed by default) */}
      {buckets.shipped.length > 0 && (
        <AgendaCollapsibleSection title="Recently Shipped" count={buckets.shipped.length} accent="green">
          {buckets.shipped.slice(0, 10).map(r => <AgendaReleaseRow key={r.id} release={r} now={now} onClick={() => onOpenRelease(r)} />)}
        </AgendaCollapsibleSection>
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
          <AgendaSection key={key} title={groupLabel(key)} count={rels.length} accent="default">
            {rels.map(r => <AgendaReleaseRow key={r.id} release={r} now={now} onClick={() => onOpenRelease(r)} />)}
          </AgendaSection>
        ))
      )}

      {/* Bottom navigation */}
      {upcomingGrouped.length > AGENDA_VISIBLE_GROUPS[zoom] && (
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

// ── Agenda sub-components ─────────────────────────────

function AgendaSection({ title, count, accent, children }: {
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

function AgendaCollapsibleSection({ title, count, accent, children }: {
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

function AgendaReleaseRow({ release, now, onClick }: {
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

  // Ticket progress
  const tickets = release.tickets || []
  const doneCount = tickets.filter(t => t.state === 'done' || t.state === 'closed' || t.state === 'cherry-picked').length
  const totalCount = tickets.length

  // Risk badge
  const riskScore = release.risk.score
  const riskBadge = riskScore === 'high'
    ? { label: 'HIGH', cls: 'bg-red-500/20 text-red-400 border-red-500/30' }
    : riskScore === 'medium'
    ? { label: 'MED', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' }
    : riskScore === 'low'
    ? { label: 'LOW', cls: 'bg-green-500/20 text-green-400 border-green-500/30' }
    : null

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
            {riskBadge && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-semibold", riskBadge.cls)}>
                {riskBadge.label}
              </span>
            )}
            {totalCount > 0 && (
              <span className="text-[10px] text-muted-foreground font-mono">
                {doneCount}/{totalCount} done
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {totalCount} tickets · {release.state}
            {timingText && <span> · {timingText}</span>}
            {proof && status === 'shipped' && <span> · ✓ {proof}</span>}
          </div>
        </div>
      </div>
    </button>
  )
}

// ── Calendar day chips — OOO count + holidays ────────────

function CalendarDayChips({ isoDate }: { isoDate: string }) {
  const load = useAvailabilityStore(s => s.load)
  const data = useAvailabilityStore(s => s.data)

  useEffect(() => { if (!data.loaded) load() }, [data.loaded, load])

  const holiday = data.upcomingHolidays.find(h => h.date === isoDate)
  const outOnDate = (data.currentlyOut || []).filter(e => e.startDate <= isoDate && isoDate <= e.endDate)

  if (!holiday && outOnDate.length === 0) return null

  return (
    <div className="mt-1 flex items-center justify-center gap-1 text-[10px] font-normal normal-case tracking-normal">
      {holiday && (
        <span
          className="inline-flex items-center px-1 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30"
          title={`${holiday.name}${holiday.countries.length ? ' (' + holiday.countries.join(', ') + ')' : ''}`}
        >
          🎉
        </span>
      )}
      {outOnDate.length > 0 && (
        <span
          className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/30"
          title={outOnDate.map(e => `${e.name} → ${e.endDate}`).join('\n')}
        >
          🌴 {outOnDate.length}
        </span>
      )}
    </div>
  )
}
