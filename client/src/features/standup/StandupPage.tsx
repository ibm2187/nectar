import { useEffect, useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { cn } from '../../lib/utils'
import { JiraLink } from '../../components/JiraLink'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'

// ── Types ─────────────────────────────────────────────────

interface StandupPrItem {
  prNumber: number
  repo: string
  prUrl: string
  reviewDecision: string | null
  prAuthor: string | null
  linkedTicket?: string
}

interface StandupTicketItem {
  key: string
  summary: string
  jiraStatus: string
  type: string
  priority: string | null
  role: string
  release: {
    version: string
    dueDate: string
    state: string
  }
  prs: StandupPrItem[]
  health: string | null
  healthCategory: string | null
  originalBucket?: string
}

interface PersonBuckets {
  releaseCritical: StandupTicketItem[]
  awaitingCherryPick: StandupTicketItem[]
  reviewChangesRequested: StandupPrItem[]
  reviewApproved: StandupPrItem[]
  blocked: StandupTicketItem[]
  pendingTesting: StandupTicketItem[]
  inDev: StandupTicketItem[]
}

interface PersonRelease {
  version: string
  dueDate: string | null
  state: string
  ticketCount: number
}

type Team = 'qa' | 'mobile' | 'web'

interface StandupPerson {
  name: string
  slackId: string | null
  roles: string[]
  teams: Team[]
  isOoo: boolean
  buckets: PersonBuckets
  urgencyScore: number
  totalItems: number
  releases: PersonRelease[]
  defaultFilter: 'imminent' | 'all'
  imminentVersions: string[]
}

interface ReleaseSummary {
  version: string
  dueDate: string
  state: string
  repo: string | null
  ticketsRemaining: number
}

interface StandupData {
  people: StandupPerson[]
  releasesDueThisWeek: ReleaseSummary[]
  generatedAt: string
}

// ── Bucket config ──────────────────────────────────────────

const BUCKET_CONFIG: Record<keyof PersonBuckets, { label: string; icon: string; color: string }> = {
  releaseCritical:        { label: 'Release-Critical',            icon: '🔴', color: 'border-red-500/40 bg-red-500/5' },
  awaitingCherryPick:     { label: 'Awaiting Cherry-Pick',        icon: '⏳', color: 'border-amber-500/40 bg-amber-500/5' },
  reviewChangesRequested: { label: 'Reviews — Changes Requested', icon: '🟠', color: 'border-orange-500/40 bg-orange-500/5' },
  reviewApproved:         { label: 'Reviews — Approved',          icon: '✅', color: 'border-green-500/40 bg-green-500/5' },
  blocked:                { label: 'Blocked',                     icon: '🚫', color: 'border-red-500/30 bg-red-500/5' },
  pendingTesting:         { label: 'Pending Testing',             icon: '🧪', color: 'border-purple-500/30 bg-purple-500/5' },
  inDev:                  { label: 'In Development',              icon: '🛠', color: 'border-blue-500/30 bg-blue-500/5' },
}

const BUCKET_ORDER: (keyof PersonBuckets)[] = [
  'releaseCritical', 'awaitingCherryPick', 'reviewChangesRequested',
  'reviewApproved', 'blocked', 'pendingTesting', 'inDev',
]

const INITIAL_SHOW_COUNT = 10

// ── Sort options ───────────────────────────────────────────

type SortMode = 'urgency' | 'name' | 'items'

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: 'urgency', label: 'Urgency' },
  { key: 'name',    label: 'Name' },
  { key: 'items',   label: 'Most Items' },
]

// ── Team filters ──────────────────────────────────────────

type TeamFilter = 'all' | Team

const TEAM_FILTERS: { key: TeamFilter; label: string }[] = [
  { key: 'all',    label: 'All' },
  { key: 'qa',     label: 'QA' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'web',    label: 'Web' },
]

function matchesTeam(person: StandupPerson, filter: TeamFilter): boolean {
  if (filter === 'all') return true
  return person.teams.includes(filter)
}

function sortPeople(people: StandupPerson[], mode: SortMode): StandupPerson[] {
  const sorted = [...people]
  switch (mode) {
    case 'urgency':
      // OOO last, then urgency desc
      sorted.sort((a, b) => {
        if (a.isOoo !== b.isOoo) return a.isOoo ? 1 : -1
        return b.urgencyScore - a.urgencyScore
      })
      break
    case 'name':
      // OOO last, then alphabetical
      sorted.sort((a, b) => {
        if (a.isOoo !== b.isOoo) return a.isOoo ? 1 : -1
        return a.name.localeCompare(b.name)
      })
      break
    case 'items':
      // OOO last, then by total items desc
      sorted.sort((a, b) => {
        if (a.isOoo !== b.isOoo) return a.isOoo ? 1 : -1
        return b.totalItems - a.totalItems
      })
      break
  }
  return sorted
}

// ── Component ─────────────────────────────────────────────

export function StandupPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<StandupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>('urgency')
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null) // null = per-bucket default

  // Team filter — read from URL so it persists across reloads and is shareable
  const teamFilter = (searchParams.get('team') as TeamFilter | null) || 'all'
  const setTeamFilter = useCallback((next: TeamFilter) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'all') params.delete('team')
    else params.set('team', next)
    // Reset person position when switching team — current index is meaningless
    // against a different filtered list.
    params.delete('person')
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  // Current person index from URL (0-based), with localStorage resume
  const personIdx = useMemo(() => {
    const urlParam = searchParams.get('person')
    if (urlParam !== null) return parseInt(urlParam, 10)
    try {
      const saved = localStorage.getItem('nectar:standup:position')
      if (saved) {
        const { idx, date } = JSON.parse(saved)
        if (date === new Date().toISOString().slice(0, 10)) return idx
      }
    } catch {}
    return 0
  }, [searchParams])

  // Fetch standup data
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch<StandupData>('/standup')
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  // Team counts (pre-filter) — used to label filter pills
  const teamCounts = useMemo(() => {
    const counts: Record<TeamFilter, number> = { all: 0, qa: 0, mobile: 0, web: 0 }
    if (!data) return counts
    counts.all = data.people.length
    for (const p of data.people) {
      for (const t of p.teams) counts[t]++
    }
    return counts
  }, [data])

  // Filter then sort
  const sortedPeople = useMemo(() => {
    if (!data) return []
    const filtered = data.people.filter(p => matchesTeam(p, teamFilter))
    return sortPeople(filtered, sortMode)
  }, [data, sortMode, teamFilter])

  // Navigate between people — persists position to localStorage for resume
  const goTo = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, sortedPeople.length - 1))
    const params = new URLSearchParams(searchParams)
    params.set('person', String(clamped))
    setSearchParams(params, { replace: true })
    setAllExpanded(null) // reset expand/collapse when switching person
    try {
      localStorage.setItem('nectar:standup:position', JSON.stringify({
        idx: clamped,
        date: new Date().toISOString().slice(0, 10),
      }))
    } catch {}
  }, [sortedPeople.length, setSearchParams, searchParams])

  const goNext = useCallback(() => goTo(personIdx + 1), [goTo, personIdx])
  const goPrev = useCallback(() => goTo(personIdx - 1), [goTo, personIdx])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [goNext, goPrev])

  // ── Render ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-muted-foreground animate-pulse">Loading standup data...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-red-400">Failed to load: {error}</div>
      </div>
    )
  }

  if (!data || data.people.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <p className="text-3xl">All clear!</p>
        <p className="text-muted-foreground">No team members found for this week.</p>
      </div>
    )
  }

  const safeIdx = Math.min(personIdx, Math.max(0, sortedPeople.length - 1))
  const currentPerson = sortedPeople[safeIdx] ?? null
  const hasNext = safeIdx < sortedPeople.length - 1
  const hasPrev = safeIdx > 0

  // Count non-empty buckets for expand/collapse visibility
  const nonEmptyBuckets = currentPerson
    ? BUCKET_ORDER.filter(k => (currentPerson.buckets[k] || []).length > 0).length
    : 0

  return (
    <div className="flex gap-4 h-[calc(100vh-7rem)]">
      {/* ── Left sidebar: People list ────────────────────── */}
      <div className="w-56 shrink-0 flex flex-col border rounded-lg bg-card overflow-hidden">
        <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Team ({sortedPeople.length}{teamFilter !== 'all' ? `/${teamCounts.all}` : ''})
          </span>
          {/* Sort selector */}
          <select
            value={sortMode}
            onChange={e => setSortMode(e.target.value as SortMode)}
            className="text-[10px] bg-transparent border border-border rounded px-1 py-0.5 text-muted-foreground"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>
        {/* Team filter pills */}
        <div className="px-2 py-2 border-b bg-muted/10 flex flex-wrap gap-1">
          {TEAM_FILTERS.map(f => {
            const active = teamFilter === f.key
            const count = teamCounts[f.key]
            return (
              <button
                key={f.key}
                onClick={() => setTeamFilter(f.key)}
                className={cn(
                  'text-[10px] font-medium px-2 py-0.5 rounded border transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
                )}
              >
                {f.label} <span className="opacity-70">({count})</span>
              </button>
            )
          })}
        </div>
        <div className="flex-1 overflow-y-auto">
          {sortedPeople.map((person, i) => {
            const isOooSection = person.isOoo && (i === 0 || !sortedPeople[i - 1].isOoo)
            return (
              <div key={person.name}>
                {/* OOO divider */}
                {isOooSection && (
                  <div className="px-3 py-1.5 text-[10px] font-medium text-amber-400 uppercase tracking-wider border-t border-amber-500/20 bg-amber-500/5">
                    Out of Office
                  </div>
                )}
                <button
                  onClick={() => goTo(i)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors border-l-2',
                    i === safeIdx
                      ? 'bg-accent border-l-primary text-foreground'
                      : 'border-l-transparent hover:bg-accent/50 text-foreground/80',
                    person.isOoo && i !== safeIdx && 'opacity-50'
                  )}
                >
                  {person.isOoo && (
                    <span className="shrink-0 w-2 h-2 rounded-full bg-amber-500" title="Out of Office" />
                  )}
                  <span className={cn('truncate flex-1', person.isOoo && 'italic text-amber-300/70')}>
                    {person.name}
                  </span>
                  <div className="shrink-0 flex items-center gap-1">
                    {person.buckets.releaseCritical.length > 0 && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                        {person.buckets.releaseCritical.length}
                      </span>
                    )}
                    <span className={cn(
                      'text-[10px] font-mono px-1.5 py-0.5 rounded',
                      person.totalItems > 0 ? 'bg-muted text-muted-foreground' : 'text-muted-foreground/30'
                    )}>
                      {person.totalItems}
                    </span>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Main content area ────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar: Nav + expand/collapse + releases */}
        <div className="flex items-center justify-between gap-3 pb-3">
          <div className="flex items-center gap-2">
            <button
              onClick={goPrev}
              disabled={!hasPrev}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                hasPrev ? 'hover:bg-accent border-border text-foreground' : 'border-transparent text-muted-foreground/30 cursor-not-allowed'
              )}
            >
              ← Prev
            </button>
            <button
              onClick={goNext}
              disabled={!hasNext}
              className={cn(
                'px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                hasNext
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
                  : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
              )}
            >
              Next →
            </button>
            <span className="text-xs text-muted-foreground font-mono ml-2">
              {sortedPeople.length > 0 ? `${safeIdx + 1}/${sortedPeople.length}` : '0/0'}
            </span>

            {/* Expand all / Collapse all */}
            {nonEmptyBuckets > 0 && (
              <div className="flex gap-1 ml-3 border-l pl-3 border-border">
                <button
                  onClick={() => setAllExpanded(true)}
                  className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent/50"
                >
                  Expand all
                </button>
                <button
                  onClick={() => setAllExpanded(false)}
                  className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent/50"
                >
                  Collapse all
                </button>
              </div>
            )}
          </div>

        </div>

        {/* Person content */}
        <div className="flex-1 overflow-y-auto">
          {currentPerson ? (
            <PersonSlide person={currentPerson} forceExpanded={allExpanded} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-12">
              <p className="text-lg">No team members match this filter.</p>
              <button
                onClick={() => setTeamFilter('all')}
                className="text-xs text-primary hover:underline"
              >
                Clear filter
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────

function PersonSlide({ person, forceExpanded }: { person: StandupPerson; forceExpanded: boolean | null }) {
  // Release filter: 'thisweek' = releases due Mon-Sun of current week,
  // 'imminent' = within 5 biz days, 'all' = everything, or a specific version
  const thisWeekVersions = useMemo(() => {
    const now = new Date()
    const day = now.getDay() // 0=Sun
    const monday = new Date(now)
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
    monday.setHours(0, 0, 0, 0)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    const monStr = monday.toISOString().slice(0, 10)
    const sunStr = sunday.toISOString().slice(0, 10)
    return person.releases
      .filter(r => r.dueDate && r.dueDate >= monStr && r.dueDate <= sunStr)
      .map(r => r.version)
  }, [person.releases])

  const defaultFilter = thisWeekVersions.length > 0 ? 'thisweek' : (person.defaultFilter === 'imminent' && person.imminentVersions.length > 0 ? 'imminent' : 'all')
  const [filter, setFilter] = useState<string>(defaultFilter)

  // Reset filter when person changes
  useEffect(() => {
    const df = thisWeekVersions.length > 0 ? 'thisweek' : (person.defaultFilter === 'imminent' && person.imminentVersions.length > 0 ? 'imminent' : 'all')
    setFilter(df)
  }, [person.name, person.defaultFilter, thisWeekVersions.length])

  // Apply filter to buckets
  const filteredBuckets = useMemo(() => {
    if (filter === 'all') return person.buckets

    // Determine which versions to show
    let filterVersions: string[]
    if (filter === 'thisweek') filterVersions = thisWeekVersions
    else if (filter === 'imminent') filterVersions = person.imminentVersions
    else filterVersions = [filter]
    const allowedVersions = new Set<string>(filterVersions)

    const filterTickets = (items: StandupTicketItem[]) =>
      items.filter(t => allowedVersions.has(t.release.version))

    const filterPrs = (items: StandupPrItem[]) =>
      items.filter(pr => !pr.linkedTicket || true) // PRs always shown (they're cross-release)

    return {
      releaseCritical: filterTickets(person.buckets.releaseCritical),
      awaitingCherryPick: filterTickets(person.buckets.awaitingCherryPick),
      reviewChangesRequested: filterPrs(person.buckets.reviewChangesRequested),
      reviewApproved: filterPrs(person.buckets.reviewApproved),
      blocked: filterTickets(person.buckets.blocked),
      pendingTesting: filterTickets(person.buckets.pendingTesting),
      inDev: filterTickets(person.buckets.inDev),
    }
  }, [person, filter])

  const filteredTotal = Object.values(filteredBuckets).reduce((sum, b) => sum + b.length, 0)
  const hasBuckets = filteredTotal > 0

  return (
    <Card className={cn('transition-all', person.isOoo && 'opacity-60 border-amber-500/30')}>
      <CardContent className="p-5 space-y-3">
        {/* Person header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg font-medium">{person.name}</span>
            {person.roles.map(r => (
              <Badge key={r} variant="outline" className="text-xs capitalize">{r}</Badge>
            ))}
            {person.isOoo && (
              <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-xs">
                Out of Office
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {filteredTotal} item{filteredTotal !== 1 ? 's' : ''}
            </span>
            {person.totalItems > 0 && (
              <SendReminderButton personName={person.name} />
            )}
          </div>
        </div>

        {/* Release filters */}
        {person.releases.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Filter:</span>
            {/* This Week pill */}
            {thisWeekVersions.length > 0 && (
              <FilterPill
                label="This Week"
                count={countForVersions(person, thisWeekVersions)}
                active={filter === 'thisweek'}
                onClick={() => setFilter('thisweek')}
              />
            )}
            {/* Next 5 biz days pill (only if different from this week) */}
            {person.imminentVersions.length > 0 && (
              <FilterPill
                label="Next 5 days"
                count={countForFilter(person, 'imminent')}
                active={filter === 'imminent'}
                onClick={() => setFilter('imminent')}
              />
            )}
            {/* All pill */}
            <FilterPill
              label="All releases"
              count={person.totalItems}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            {/* Per-release pills */}
            {person.releases.slice(0, 5).map(r => (
              <FilterPill
                key={r.version}
                label={r.version}
                count={r.ticketCount}
                active={filter === r.version}
                onClick={() => setFilter(r.version)}
                dimmed={!person.imminentVersions.includes(r.version)}
              />
            ))}
          </div>
        )}

        {/* Priority buckets */}
        {hasBuckets ? (
          <div className="space-y-2">
            {BUCKET_ORDER.map(bucketKey => {
              const items = filteredBuckets[bucketKey]
              const config = BUCKET_CONFIG[bucketKey]
              if (!items || items.length === 0) return null
              return (
                <CollapsibleBucket
                  key={bucketKey}
                  bucketKey={bucketKey}
                  items={items}
                  config={config}
                  forceExpanded={forceExpanded}
                />
              )
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            {person.totalItems === 0
              ? 'All clear — no action items'
              : 'No items for this filter'
            }
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FilterPill({ label, count, active, onClick, dimmed }: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  dimmed?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-md text-xs font-medium transition-colors border',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : dimmed
            ? 'border-border/50 text-muted-foreground/60 hover:text-muted-foreground hover:border-border'
            : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30'
      )}
    >
      {label} <span className="opacity-70">({count})</span>
    </button>
  )
}

function countForFilter(person: StandupPerson, filter: string): number {
  if (filter === 'all') return person.totalItems
  const versions = new Set(filter === 'imminent' ? person.imminentVersions : [filter])
  return countForVersions(person, [...versions])
}

function countForVersions(person: StandupPerson, versions: string[]): number {
  const versionSet = new Set(versions)
  let count = 0
  for (const bucketKey of BUCKET_ORDER) {
    const items = person.buckets[bucketKey]
    if (!items) continue
    for (const item of items) {
      if ('release' in item && versionSet.has((item as StandupTicketItem).release.version)) count++
      else if (!('release' in item)) count++ // PRs always counted
    }
  }
  return count
}

function CollapsibleBucket({ bucketKey, items, config, forceExpanded }: {
  bucketKey: string
  items: (StandupTicketItem | StandupPrItem)[]
  config: { label: string; icon: string; color: string }
  forceExpanded: boolean | null
}) {
  const [localExpanded, setLocalExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const isPrBucket = bucketKey === 'reviewChangesRequested' || bucketKey === 'reviewApproved'

  // forceExpanded overrides local state when set
  const expanded = forceExpanded !== null ? forceExpanded : localExpanded

  // Reset showAll when collapsing
  const toggle = () => {
    const next = !expanded
    setLocalExpanded(next)
    if (!next) setShowAll(false)
  }

  const hasMore = items.length > INITIAL_SHOW_COUNT
  const visibleItems = expanded && !showAll && hasMore ? items.slice(0, INITIAL_SHOW_COUNT) : items
  const hiddenCount = items.length - INITIAL_SHOW_COUNT

  return (
    <div className={cn('rounded-md border transition-colors', config.color)}>
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        <span>{config.icon}</span>
        <span className="font-medium text-sm">{config.label}</span>
        <Badge variant="secondary" className="text-xs ml-auto">{items.length}</Badge>
      </button>
      {expanded && (
        <div className="border-t border-white/5">
          <table className="w-full text-sm">
            <tbody>
              {isPrBucket
                ? (visibleItems as StandupPrItem[]).map(pr => <PrRow key={pr.prNumber} pr={pr} />)
                : (visibleItems as StandupTicketItem[]).map(item => <TicketRow key={item.key + item.role} item={item} />)
              }
            </tbody>
          </table>
          {hasMore && !showAll && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAll(true) }}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-white/5 transition-colors"
            >
              Show {hiddenCount} more...
            </button>
          )}
          {hasMore && showAll && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAll(false) }}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-white/5 transition-colors"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TicketRow({ item }: { item: StandupTicketItem }) {
  return (
    <tr className="border-t border-white/5">
      <td className="py-1.5 px-3 w-[90px]">
        <JiraLink jiraKey={item.key} className="font-mono text-xs" />
      </td>
      <td className="py-1.5 pr-2 text-foreground/80 text-sm">
        <span className="line-clamp-1">{item.summary}</span>
      </td>
      <td className="py-1.5 px-2 w-[110px] text-right">
        <Badge variant="outline" className="text-[10px]">{item.release.version}</Badge>
      </td>
      <td className="py-1.5 px-3 w-[140px] text-right text-xs text-muted-foreground whitespace-nowrap">
        {item.jiraStatus}
      </td>
    </tr>
  )
}

function PrRow({ pr }: { pr: StandupPrItem }) {
  const repoShort = pr.repo.split('/').pop() || pr.repo
  return (
    <tr className="border-t border-white/5">
      <td className="py-1.5 px-3 w-[90px]">
        <a href={pr.prUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-blue-400 hover:underline">
          #{pr.prNumber}
        </a>
      </td>
      <td className="py-1.5 pr-2 text-sm">
        <span className="text-xs text-muted-foreground">{repoShort}</span>
        {pr.linkedTicket && (
          <JiraLink jiraKey={pr.linkedTicket} className="font-mono text-[10px] ml-2" />
        )}
      </td>
      <td className="py-1.5 px-2 w-[110px]" />
      <td className="py-1.5 px-3 w-[140px] text-right text-xs text-muted-foreground whitespace-nowrap">
        {pr.prAuthor && <>by @{pr.prAuthor}</>}
      </td>
    </tr>
  )
}

// ── Send Reminder button + dialog ─────────────────────────

const REMINDER_CANNED = [
  { id: 'standup-list', label: 'Send ticket list',           text: 'Here are your current tickets — please review.' },
  { id: 'cherry-pick',  label: 'Cherry-pick request',       text: 'Can you cherry-pick your changes?' },
  { id: 'status',       label: 'Status update request',     text: 'Can you provide a status update?' },
  { id: 'blocker',      label: 'Release blocker',           text: 'You have items blocking the release — please prioritize.' },
  { id: 'custom',       label: 'Custom message',            text: '' },
]

function SendReminderButton({ personName }: { personName: string }) {
  const [open, setOpen] = useState(false)
  const [selectedCanned, setSelectedCanned] = useState('standup-list')
  const [messageText, setMessageText] = useState(REMINDER_CANNED[0].text)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ sent: boolean; error?: string } | null>(null)

  useEffect(() => {
    if (open) { setResult(null); setSending(false) }
  }, [open])

  const handleCannedChange = (id: string) => {
    setSelectedCanned(id)
    const msg = REMINDER_CANNED.find(m => m.id === id)
    if (msg) setMessageText(msg.text)
  }

  const handleSend = async () => {
    if (sending) return
    setSending(true)
    try {
      const res = await apiFetch<{ sent: boolean; error?: string }>('/notify/standup', {
        method: 'POST',
        body: JSON.stringify({
          personName,
          message: messageText.trim() || undefined,
        }),
      })
      setResult(res)
    } catch (err) {
      setResult({ sent: false, error: (err as Error).message })
    }
    setSending(false)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded border border-border hover:border-foreground/30 transition-colors"
        title={`Send reminder to ${personName} via Slack`}
      >
        <SlackIcon className="w-3 h-3" />
        Remind
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send reminder to {personName}</DialogTitle>
          </DialogHeader>

          {result ? (
            <div className="space-y-3 py-2">
              {result.sent ? (
                <div className="flex items-center gap-2 text-green-400">
                  <span className="text-lg">✓</span>
                  <span>Reminder sent to {personName}</span>
                </div>
              ) : (
                <div className="text-red-400">
                  Failed to send{result.error && `: ${result.error}`}
                </div>
              )}
              <DialogFooter>
                <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-accent">
                  Close
                </button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                This will DM {personName} their full ticket list (like the daily digest) with your message.
              </p>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Message</label>
                <select
                  value={selectedCanned}
                  onChange={e => handleCannedChange(e.target.value)}
                  className="w-full h-8 px-2 text-sm rounded-md border bg-background text-foreground"
                >
                  {REMINDER_CANNED.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <textarea
                  value={messageText}
                  onChange={e => setMessageText(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground resize-none"
                  placeholder="Type your message (optional)..."
                />
              </div>

              <DialogFooter>
                <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-accent">
                  Cancel
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending}
                  className={cn(
                    'px-4 py-2 rounded-md text-sm font-medium transition-colors',
                    !sending ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
                  )}
                >
                  {sending ? 'Sending...' : 'Send Reminder'}
                </button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
    </svg>
  )
}
