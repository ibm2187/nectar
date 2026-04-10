import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

// ── Types ──────────────────────────────────────────────

interface ReleaseCard {
  repo: string
  version: string
  state: string
  jiraReleaseDate: string | null
  customers: string[]
  tickets: number
  done: number
  inProgress: number
  pending: number
  missingPlan: number
  progress: number
}

interface MonthColumn {
  key: string
  label: string
  start: string
  end: string
}

interface Theme {
  name: string
  icon: string | null
  months: Record<string, ReleaseCard[]>
  totalTickets: number
  totalDone: number
  progress: number
}

interface RoadmapResponse {
  months: MonthColumn[]
  themes: Theme[]
  customers: string[]
  unmappedComponents: string[]
  stats: {
    totalThemes: number
    totalReleases: number
    totalTickets: number
  }
}

// ── Page ───────────────────────────────────────────────

export function RoadmapPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('q') || ''
  const customerFilter = searchParams.get('customer') || ''
  const zoom = (searchParams.get('zoom') as 'month' | 'quarter') || 'month'

  const [data, setData] = useState<RoadmapResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsedThemes, setCollapsedThemes] = useState<Set<string>>(new Set())

  function updateParams(updates: Record<string, string | null>) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      return next
    }, { replace: true })
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = customerFilter ? `?customer=${encodeURIComponent(customerFilter)}` : ''
      const result = await apiFetch<RoadmapResponse>(`/roadmap${params}`)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roadmap')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [customerFilter])

  // ── Filter themes by search ───────────────────────────
  const filteredThemes = useMemo(() => {
    if (!data) return []
    const q = search.toLowerCase().trim()
    if (!q) return data.themes
    return data.themes.filter(t => {
      if (t.name.toLowerCase().includes(q)) return true
      // Search inside release cards
      for (const cards of Object.values(t.months)) {
        if (cards.some(c => c.version.toLowerCase().includes(q))) return true
      }
      return false
    })
  }, [data, search])

  // ── Determine visible month columns ───────────────────
  const visibleMonths = useMemo(() => {
    if (!data) return []
    if (zoom === 'quarter') {
      // Group months into quarters
      const quarters: MonthColumn[] = []
      for (let i = 0; i < data.months.length; i += 3) {
        const batch = data.months.slice(i, i + 3)
        if (batch.length === 0) continue
        quarters.push({
          key: batch.map(m => m.key).join(','),
          label: `${batch[0].label.split(' ')[0]}–${batch[batch.length - 1].label}`,
          start: batch[0].start,
          end: batch[batch.length - 1].end,
        })
      }
      return quarters
    }
    // Show 6 months by default (24 weeks)
    return data.months.slice(0, 6)
  }, [data, zoom])

  function toggleTheme(name: string) {
    setCollapsedThemes(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // ── Render ────────────────────────────────────────────

  if (loading) {
    return <NectarLoader size="lg" message="Building roadmap..." className="mt-32" />
  }

  if (error) {
    return (
      <div className="w-full flex justify-center mt-32">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Roadmap</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {data.stats.totalTickets} tickets across {filteredThemes.length} themes · {data.stats.totalReleases} active releases
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border text-xs">
            <button
              type="button"
              onClick={() => updateParams({ zoom: null })}
              className={cn("px-3 py-1.5 rounded-l-md transition-colors", zoom === 'month' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
            >
              Month
            </button>
            <button
              type="button"
              onClick={() => updateParams({ zoom: 'quarter' })}
              className={cn("px-3 py-1.5 rounded-r-md border-l transition-colors", zoom === 'quarter' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
            >
              Quarter
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search themes, releases..."
          value={search}
          onChange={e => updateParams({ q: e.target.value || null })}
          className="max-w-xs"
        />
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => updateParams({ customer: null })}
            className={cn(
              "px-2.5 py-1 rounded-md border text-xs transition-colors",
              !customerFilter ? "bg-primary text-primary-foreground" : "bg-muted/30 hover:bg-accent/50"
            )}
          >
            All
          </button>
          {data.customers.filter(c => c !== 'All').map(c => (
            <button
              key={c}
              type="button"
              onClick={() => updateParams({ customer: customerFilter === c ? null : c })}
              className={cn(
                "px-2.5 py-1 rounded-md border text-xs transition-colors",
                customerFilter === c ? "bg-primary text-primary-foreground" : "bg-muted/30 hover:bg-accent/50"
              )}
            >
              {c}
            </button>
          ))}
        </div>
        {(search || customerFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateParams({ q: null, customer: null })}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto">
        <div className="min-w-[800px]">
          {/* Month header row */}
          <div className="flex border-b sticky top-0 bg-background z-10">
            <div className="w-52 shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Theme
            </div>
            {visibleMonths.map(m => (
              <div
                key={m.key}
                className="flex-1 min-w-[140px] px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center border-l"
              >
                {m.label}
              </div>
            ))}
            {/* Unscheduled column */}
            <div className="w-36 shrink-0 px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/50 text-center border-l">
              Unscheduled
            </div>
          </div>

          {/* Theme rows */}
          {filteredThemes.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground text-sm">
              No themes match the current filters.
            </div>
          ) : (
            filteredThemes.map(theme => (
              <ThemeRow
                key={theme.name}
                theme={theme}
                months={visibleMonths}
                collapsed={collapsedThemes.has(theme.name)}
                onToggle={() => toggleTheme(theme.name)}
              />
            ))
          )}
        </div>
      </div>

      {/* Unmapped components notice */}
      {data.unmappedComponents.length > 0 && (
        <div className="text-xs text-muted-foreground border-t pt-3 mt-4">
          <span className="font-medium">Unmapped components:</span>{' '}
          {data.unmappedComponents.join(', ')}
          {' · '}
          <Link to="/config" className="text-primary hover:underline">Configure themes</Link>
        </div>
      )}
    </div>
  )
}

// ── Theme row ──────────────────────────────────────────

function ThemeRow({ theme, months, collapsed, onToggle }: {
  theme: Theme
  months: MonthColumn[]
  collapsed: boolean
  onToggle: () => void
}) {
  // Check which month keys have cards
  function getCardsForMonth(monthCol: MonthColumn): ReleaseCard[] {
    if (!theme.months) return []
    // For quarter view, monthCol.key is "2026-04,2026-05,2026-06"
    const keys = monthCol.key.split(',')
    const cards: ReleaseCard[] = []
    for (const k of keys) {
      cards.push(...(theme.months[k] || []))
    }
    return cards
  }

  const unscheduledCards = theme.months['unscheduled'] || []

  return (
    <div className="flex border-b hover:bg-accent/10 transition-colors">
      {/* Theme label */}
      <button
        type="button"
        onClick={onToggle}
        className="w-52 shrink-0 px-3 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{collapsed ? '▸' : '▾'}</span>
          <div>
            <div className="text-sm font-medium leading-tight">
              {theme.icon && <span className="mr-1">{theme.icon}</span>}
              {theme.name}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {theme.totalTickets} tickets · {theme.progress}% done
            </div>
          </div>
        </div>
        {/* Mini progress bar */}
        <div className="mt-1.5 h-1 rounded-full bg-muted/30 overflow-hidden">
          <div
            className="h-full rounded-full bg-green-500/60 transition-all"
            style={{ width: `${theme.progress}%` }}
          />
        </div>
      </button>

      {/* Month cells */}
      {months.map(m => {
        const cards = getCardsForMonth(m)
        return (
          <div
            key={m.key}
            className="flex-1 min-w-[140px] px-1.5 py-2 border-l"
          >
            {!collapsed && cards.map(card => (
              <ReleaseCardView key={`${card.repo}:${card.version}`} card={card} />
            ))}
            {collapsed && cards.length > 0 && (
              <div className="text-[10px] text-muted-foreground text-center py-1">
                {cards.reduce((s, c) => s + c.tickets, 0)} tickets
              </div>
            )}
          </div>
        )
      })}

      {/* Unscheduled cell */}
      <div className="w-36 shrink-0 px-1.5 py-2 border-l">
        {!collapsed && unscheduledCards.map(card => (
          <ReleaseCardView key={`${card.repo}:${card.version}`} card={card} />
        ))}
        {collapsed && unscheduledCards.length > 0 && (
          <div className="text-[10px] text-muted-foreground text-center py-1">
            {unscheduledCards.reduce((s, c) => s + c.tickets, 0)} tickets
          </div>
        )}
      </div>
    </div>
  )
}

// ── Release card ───────────────────────────────────────

function ReleaseCardView({ card }: { card: ReleaseCard }) {
  const statusColor = card.progress === 100
    ? 'border-green-500/40 bg-green-500/5'
    : card.missingPlan > 0
    ? 'border-yellow-500/40 bg-yellow-500/5'
    : card.progress > 0
    ? 'border-blue-500/40 bg-blue-500/5'
    : 'border-muted/50 bg-muted/5'

  const statusGlyph = card.progress === 100 ? '✅' :
    card.missingPlan > 0 ? '⚠' :
    card.progress > 0 ? '🟡' : '🔵'

  // Build release detail URL — includes repo prefix if not webplatform
  const releaseKey = card.repo && card.repo !== 'webplatform'
    ? `${card.repo}:${card.version}`
    : card.version

  return (
    <Link
      to={`/releases/${encodeURIComponent(releaseKey)}`}
      state={{ from: 'roadmap' }}
      className={cn(
        "block rounded-md border p-2 mb-1.5 transition-all hover:scale-[1.02] hover:shadow-sm cursor-pointer",
        statusColor
      )}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="font-mono text-xs font-medium truncate">{card.version}</span>
        <span className="text-[10px] shrink-0">{statusGlyph}</span>
      </div>

      {/* Progress bar */}
      <div className="mt-1 h-1 rounded-full bg-muted/30 overflow-hidden">
        <div
          className="h-full rounded-full bg-green-500/60"
          style={{ width: `${card.progress}%` }}
        />
      </div>

      <div className="mt-1 text-[10px] text-muted-foreground leading-tight">
        {card.done}/{card.tickets} done
        {card.missingPlan > 0 && (
          <span className="text-yellow-400 ml-1">· {card.missingPlan} missing</span>
        )}
      </div>

      {/* Customer tags */}
      {card.customers.length > 0 && card.customers[0] !== 'All' && (
        <div className="flex flex-wrap gap-0.5 mt-1">
          {card.customers.map(c => (
            <span
              key={c}
              className="px-1 py-px rounded text-[9px] bg-muted/30 text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </Link>
  )
}
