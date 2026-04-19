import { useEffect, useState, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useHomeStore, type HomeView, type HomeRange } from '../../stores/homeStore'
import { apiFetch } from '../../api/client'
import type { Release } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { cn } from '../../lib/utils'
import { STATUS_GROUPS, getStatusBadgeColor, getStatusGroup, displayAssignee, type StatusGroup } from '../../lib/status-colors'
import { JiraLink } from '../../components/JiraLink'
import { ZohoImpactBadge } from '../releases/CustomerImpact'
import { PipelineBadge } from '../releases/PipelineView'
import { PrDetailPanel, type PrInfo } from '../../components/PrDetailPanel'
import { ReleaseBadge, TicketDeployedCell as SharedDeployedCell, PriorityBadge, RiskBadge, HealthBadge, getNextRelease, priorityOrdinal, riskOrdinal, NextReleaseVersionCell, NextReleaseDateCell, type TicketRowData } from '../../components/TicketRow'
import { SortableHeader, useSortableData, useSortState } from '../../components/SortableHeader'
import { CustomerPills } from '../../components/CustomerPill'
import { CurrentlyOutBanner } from '../../components/CurrentlyOutBanner'
import { OutIcon } from '../../components/PersonBadge'
import { useAvailabilityStore } from '../../stores/availabilityStore'

// ── Types ────────────────────────────────────────────────

interface Person {
  name: string
  roles: string[]
}

interface HomeRelease extends Release {
  ticketCount: number
  totalTicketCount: number
  zohoTicketCount: number
  zohoTickets: Array<{ id: string; ticketNumber: string | null; subject: string; status: string; priority: string | null; departmentId: string | null; webUrl: string | null }>
  isOverdue: boolean
  oooRisk?: Array<{
    name: string
    role: 'dev' | 'qa'
    endDate: string
    blockingTickets: string[]
  }>
}

// ── View config ──────────────────────────────────────────

const VIEW_CONFIG: Record<HomeView, { label: string; description: string; personField: string | null }> = {
  dev:     { label: 'Dev',              description: 'Tickets assigned to you, grouped by release',       personField: 'assignee' },
  qa:      { label: 'QA',              description: 'Tickets you are testing, grouped by release',       personField: 'qaAssignee' },
  pm:      { label: 'PM',              description: 'All tickets across releases — full picture',        personField: null },
  support: { label: 'Support',         description: 'Customer impact — Zoho tickets linked to releases', personField: null },
  cs:      { label: 'Customer Success', description: 'Per-customer release impact and health',           personField: null },
}

const VIEW_ORDER: HomeView[] = ['dev', 'qa', 'pm', 'support', 'cs']

// ── Status colors (matches TruthView) ────────────────────

const STATE_COLORS: Record<string, string> = {
  planning:    'bg-slate-500/20 text-slate-300',
  cutting:     'bg-blue-500/20 text-blue-300',
  stabilizing: 'bg-amber-500/20 text-amber-300',
  approved:    'bg-green-500/20 text-green-300',
  deploying:   'bg-purple-500/20 text-purple-300',
  done:        'bg-emerald-500/20 text-emerald-300',
}

const DEPT_NAMES: Record<string, string> = {
  '1078812000000006907': 'Viv Technologies',
  '1078812000000503059': 'Comfort Keepers',
  '1078812000000547039': 'Tribute Home Care',
  '1078812000000553358': 'Bayada',
  '1078812000011550519': 'Help-at-Home',
}

// ── Date helpers ─────────────────────────────────────────

function daysFromNow(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function relativeDate(dateStr: string): { label: string; color: string } {
  const days = daysFromNow(dateStr)
  if (days < -1) return { label: `${Math.abs(days)} days overdue`, color: 'text-red-400 font-semibold' }
  if (days === -1) return { label: 'Yesterday', color: 'text-red-400 font-semibold' }
  if (days === 0) return { label: 'Today', color: 'text-amber-400 font-semibold' }
  if (days === 1) return { label: 'Tomorrow', color: 'text-amber-400 font-semibold' }
  if (days <= 3) return { label: `in ${days} days`, color: 'text-amber-400' }
  if (days <= 7) return { label: `in ${days} days`, color: 'text-blue-400' }
  return { label: `in ${days} days`, color: 'text-muted-foreground' }
}

// getStatusBadgeColor imported from lib/status-colors

// ── Component ────────────────────────────────────────────

export function HomePage() {
  const { view, person, groupBy, range, isFirstVisit, setView, setPerson, setGroupBy, setRange, dismissFirstVisit } = useHomeStore()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // URL params take precedence over localStorage on mount — lets external links
  // (e.g. from Slack digest DMs) deep-link to a specific role + person.
  useEffect(() => {
    const urlView = searchParams.get('view') as HomeView | null
    const urlPerson = searchParams.get('person')
    let changed = false
    const VALID_VIEWS: HomeView[] = ['dev', 'qa', 'pm', 'support', 'cs']
    if (urlView && VALID_VIEWS.includes(urlView) && urlView !== view) {
      setView(urlView)
      dismissFirstVisit()
      changed = true
    }
    if (urlPerson !== null && urlPerson !== person) {
      setPerson(urlPerson || null)
      changed = true
    }
    // Strip params from URL after applying so reloads use the persisted localStorage state
    if (changed && (urlView || urlPerson !== null)) {
      const next = new URLSearchParams(searchParams)
      next.delete('view')
      next.delete('person')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [releases, setReleases] = useState<HomeRelease[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [tickets, setTickets] = useState<TicketRowData[]>([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandedTickets, setExpandedTickets] = useState<Set<string>>(new Set())
  const [prPanel, setPrPanel] = useState<{ jiraKey: string; summary: string; prs: PrInfo[]; repo: string; version: string } | null>(null)
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('not-done')
  const [repoFilter, setRepoFilter] = useState('')
  const [ticketSearch, setTicketSearch] = useState('')

  // Fetch home data — releases-grouped uses /releases/home, tickets-grouped uses /tickets/home
  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (view) params.set('view', view)
    if (person) params.set('person', person)
    params.set('range', range)

    if (groupBy === 'tickets') {
      Promise.all([
        apiFetch<{ tickets: TicketRowData[] }>(`/tickets/home?${params}`),
        apiFetch<Person[]>('/people'),
      ])
        .then(([data, ppl]) => {
          setTickets(data.tickets || [])
          setPeople(ppl)
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    } else {
      // Both 'releases' and 'people' use the same API — just grouped differently
      Promise.all([
        apiFetch<HomeRelease[]>(`/releases/home?${params}`),
        apiFetch<Person[]>('/people'),
      ])
        .then(([rels, ppl]) => {
          setReleases(rels)
          setPeople(ppl)
          setCollapsed(new Set())
          setExpandedTickets(new Set())
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
  }, [view, person, groupBy, range])

  const toggleCollapse = (id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const collapseAll = () => setCollapsed(new Set(releases.map(r => r.id)))
  const expandAll = () => setCollapsed(new Set())

  const toggleExpandTickets = (id: string) => {
    setExpandedTickets(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Count tickets per status group — works for both releases and tickets mode
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0, 'not-done': 0 }
    for (const g of STATUS_GROUPS) counts[g.key] = 0
    const doneStatuses = new Set(STATUS_GROUPS.find(g => g.key === 'done')?.statuses || [])
    const allTickets = groupBy === 'tickets'
      ? tickets
      : releases.flatMap(r => r.tickets || [])
    for (const t of allTickets) {
      counts.all++
      const g = getStatusGroup(t.jiraStatus || '')
      if (counts[g] !== undefined) counts[g]++
      if (!doneStatuses.has(t.jiraStatus || '')) counts['not-done']++
    }
    return counts
  }, [releases, tickets, groupBy])

  // Available repos
  const repos = useMemo(() => {
    const set = new Set<string>()
    if (groupBy === 'tickets') {
      for (const t of tickets) {
        for (const r of (t.releases || [])) {
          if (r.repo) set.add(r.repo)
        }
      }
    } else {
      for (const r of releases) if (r.repo) set.add(r.repo)
    }
    return Array.from(set).sort()
  }, [releases, tickets, groupBy])

  // Apply filters
  const filteredReleases = useMemo(() => {
    if (statusGroup === 'all' && !repoFilter && !ticketSearch) return releases
    const search = ticketSearch.toLowerCase().trim()
    const groupDef = STATUS_GROUPS.find(g => g.key === statusGroup)
    const groupStatuses = groupDef && groupDef.statuses.length > 0 ? new Set(groupDef.statuses) : null
    // "Not Done" = exclude Done statuses
    const doneStatuses = statusGroup === 'not-done'
      ? new Set(STATUS_GROUPS.find(g => g.key === 'done')?.statuses || [])
      : null

    return releases.map(r => {
      if (repoFilter && r.repo !== repoFilter) return null
      let tickets = r.tickets || []
      if (groupStatuses) {
        tickets = tickets.filter((t: any) => groupStatuses.has(t.jiraStatus || ''))
      } else if (doneStatuses) {
        tickets = tickets.filter((t: any) => !doneStatuses.has(t.jiraStatus || ''))
      }
      if (search) {
        tickets = tickets.filter((t: any) =>
          (t.key || '').toLowerCase().includes(search) ||
          (t.summary || '').toLowerCase().includes(search) ||
          (t.assignee || '').toLowerCase().includes(search) ||
          (t.qaAssignee || '').toLowerCase().includes(search) ||
          (t.jiraStatus || '').toLowerCase().includes(search)
        )
      }
      if (tickets.length === 0) return null
      return { ...r, tickets, ticketCount: tickets.length }
    }).filter(Boolean) as HomeRelease[]
  }, [releases, statusGroup, repoFilter, ticketSearch])

  // Apply same filters to tickets list (for Tickets group mode)
  const filteredTickets = useMemo(() => {
    const search = ticketSearch.toLowerCase().trim()
    const groupDef = STATUS_GROUPS.find(g => g.key === statusGroup)
    const groupStatuses = groupDef && groupDef.statuses.length > 0 ? new Set(groupDef.statuses) : null
    const doneStatuses = statusGroup === 'not-done'
      ? new Set(STATUS_GROUPS.find(g => g.key === 'done')?.statuses || [])
      : null

    return tickets.filter(t => {
      // Repo filter — match if any of the ticket's releases is in that repo
      if (repoFilter && !(t.releases || []).some(r => r.repo === repoFilter)) return false
      // Status group filter
      if (groupStatuses && !groupStatuses.has(t.jiraStatus || '')) return false
      if (doneStatuses && doneStatuses.has(t.jiraStatus || '')) return false
      // Search
      if (search) {
        const matches =
          (t.key || '').toLowerCase().includes(search) ||
          (t.summary || '').toLowerCase().includes(search) ||
          (t.assignee || '').toLowerCase().includes(search) ||
          (t.qaAssignee || '').toLowerCase().includes(search) ||
          (t.jiraStatus || '').toLowerCase().includes(search)
        if (!matches) return false
      }
      return true
    })
  }, [tickets, statusGroup, repoFilter, ticketSearch])

  // Split releases
  const { overdue, upcoming, unscheduled } = useMemo(() => {
    const overdue: HomeRelease[] = []
    const upcoming: HomeRelease[] = []
    const unscheduled: HomeRelease[] = []
    for (const r of filteredReleases) {
      if (!r.jiraReleaseDate) unscheduled.push(r)
      else if (r.isOverdue) overdue.push(r)
      else upcoming.push(r)
    }
    return { overdue, upcoming, unscheduled }
  }, [filteredReleases])

  // Filter people for person selector
  const filteredPeople = useMemo(() => {
    if (view === 'support' || view === 'cs') return []
    if (view === 'pm') {
      // PM picker shows anyone who's a dev OR qa — searches both fields
      return people.filter(p => p.roles.includes('dev') || p.roles.includes('qa'))
    }
    const roleKey = view === 'dev' ? 'dev' : view === 'qa' ? 'qa' : null
    if (!roleKey) return people
    return people.filter(p => p.roles.includes(roleKey))
  }, [people, view])

  const personEnabled = view === 'dev' || view === 'qa' || view === 'pm'

  // ── First visit ────────────────────────────────────────

  if (isFirstVisit) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4">
        <h1 className="text-2xl font-bold mb-2">Welcome to Nectar</h1>
        <p className="text-muted-foreground mb-8">Choose your default view. You can switch anytime.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {VIEW_ORDER.map(v => (
            <Card
              key={v}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => { setView(v); dismissFirstVisit() }}
            >
              <CardContent className="p-4">
                <div className="font-semibold mb-1">{VIEW_CONFIG[v].label}</div>
                <div className="text-sm text-muted-foreground">{VIEW_CONFIG[v].description}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  // ── Main dashboard ─────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* OOO awareness banner — dismissible, only renders when relevant */}
      <CurrentlyOutBanner />

      {/* OOO release-impact warning — only for releases due today/tomorrow */}
      <OooReleaseRiskBanner releases={releases} />

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          {VIEW_ORDER.map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                view === v
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {VIEW_CONFIG[v].label}
            </button>
          ))}
        </div>

        {personEnabled && (
          <select
            value={person || ''}
            onChange={e => setPerson(e.target.value || null)}
            className="h-8 px-2 text-sm rounded-md border bg-background text-foreground"
          >
            <option value="">All people</option>
            {filteredPeople.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        )}

        {(groupBy === 'releases' || groupBy === 'people') && filteredReleases.length > 1 && (
          <div className="flex gap-1 ml-auto">
            <button onClick={expandAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50">Expand all</button>
            <button onClick={collapseAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50">Collapse all</button>
          </div>
        )}

        {/* Group by toggle */}
        <div className={cn(
          'flex items-center gap-0.5 bg-muted rounded-lg p-0.5',
          !((groupBy === 'releases' || groupBy === 'people') && filteredReleases.length > 1) && 'ml-auto'
        )}>
          <button
            onClick={() => setGroupBy('releases')}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              groupBy === 'releases' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            title="Group by release — see what tickets each release has"
          >
            Releases
          </button>
          <button
            onClick={() => setGroupBy('tickets')}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              groupBy === 'tickets' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            title="Group by ticket — see what releases each ticket goes to"
          >
            Tickets
          </button>
          <button
            onClick={() => setGroupBy('people')}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              groupBy === 'people' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            title="Group by assignee — see what's on each person's plate"
          >
            People
          </button>
        </div>

        {/* Date range toggle */}
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          {([
            { key: 'today', label: 'Today' },
            { key: 'week', label: 'This Week' },
            { key: '2w', label: '2 Weeks' },
            { key: '4w', label: '4 Weeks' },
          ] as { key: HomeRange; label: string }[]).map(r => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'px-2 py-1.5 text-sm font-medium rounded-md transition-colors',
                range === r.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Status group pills + filters */}
      {!loading && (releases.length > 0 || tickets.length > 0) && (
        <div className="space-y-2">
          <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5 flex-wrap">
            {STATUS_GROUPS.map(g => (
              <button
                key={g.key}
                onClick={() => setStatusGroup(g.key)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  statusGroup === g.key ? g.pillActive : g.pillInactive,
                  groupCounts[g.key] === 0 && g.key !== 'all' && 'opacity-40'
                )}
              >
                {g.label}
                {groupCounts[g.key] > 0 && (
                  <span className="ml-1 text-xs opacity-70">{groupCounts[g.key]}</span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              placeholder="Search tickets..."
              value={ticketSearch}
              onChange={e => setTicketSearch(e.target.value)}
              className="h-8 px-3 text-sm rounded-md border bg-background text-foreground w-48"
            />
            {repos.length > 1 && (
              <select
                value={repoFilter}
                onChange={e => setRepoFilter(e.target.value)}
                className="h-8 px-2 text-sm rounded-md border bg-background text-foreground"
              >
                <option value="">All repos</option>
                {repos.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            )}
            {(statusGroup !== 'all' || repoFilter || ticketSearch) && (
              <button
                onClick={() => { setStatusGroup('all'); setRepoFilter(''); setTicketSearch('') }}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
      ) : groupBy === 'tickets' ? (
        filteredTickets.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center italic">
            {tickets.length === 0
              ? `No tickets in scope${person ? ` for ${person}` : ''}`
              : 'No tickets match the current filters'}
          </div>
        ) : (
          <TicketsTable tickets={filteredTickets} />
        )
      ) : groupBy === 'people' ? (
        filteredReleases.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center italic">
            {releases.length === 0
              ? `No tickets in scope${person ? ` for ${person}` : ''}`
              : 'No tickets match the current filters'}
          </div>
        ) : (
          <PeopleGroupView
            releases={filteredReleases}
            view={view}
            navigate={navigate}
            onClickPr={(jiraKey, summary, prs, repo, version) => setPrPanel({ jiraKey, summary, prs, repo, version })}
          />
        )
      ) : filteredReleases.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center italic">
          {releases.length === 0
            ? `No releases in scope${person ? ` for ${person}` : ''}`
            : 'No tickets match the current filters'}
        </div>
      ) : (
        <>
          {(view === 'support' || view === 'cs') ? (
            <CustomerGroupedView releases={releases} />
          ) : (
            <>
              {overdue.length > 0 && (
                <ReleaseGroup
                  title="Overdue"
                  titleColor="text-red-400"
                  releases={overdue}
                  view={view}
                  person={person}
                  navigate={navigate}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
                  expandedTickets={expandedTickets}
                  onToggleExpandTickets={toggleExpandTickets}
                  onClickPr={(jiraKey, summary, prs, repo, version) => setPrPanel({ jiraKey, summary, prs, repo, version })}
                />
              )}
              {upcoming.length > 0 && (
                <ReleaseGroup
                  title={`Upcoming (${range === 'today' ? 'today' : range === 'week' ? 'this week' : range === '2w' ? 'next 2 weeks' : 'next 4 weeks'})`}
                  releases={upcoming}
                  view={view}
                  person={person}
                  navigate={navigate}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
                  expandedTickets={expandedTickets}
                  onToggleExpandTickets={toggleExpandTickets}
                  onClickPr={(jiraKey, summary, prs, repo, version) => setPrPanel({ jiraKey, summary, prs, repo, version })}
                />
              )}
              {unscheduled.length > 0 && (
                <ReleaseGroup
                  title="Unscheduled"
                  titleColor="text-muted-foreground"
                  releases={unscheduled}
                  view={view}
                  person={person}
                  navigate={navigate}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
                  expandedTickets={expandedTickets}
                  onToggleExpandTickets={toggleExpandTickets}
                  onClickPr={(jiraKey, summary, prs, repo, version) => setPrPanel({ jiraKey, summary, prs, repo, version })}
                />
              )}
            </>
          )}
        </>
      )}

      <PrDetailPanel
        open={!!prPanel}
        onClose={() => setPrPanel(null)}
        jiraKey={prPanel?.jiraKey || ''}
        summary={prPanel?.summary || ''}
        prs={prPanel?.prs || []}
        githubSearchUrl={prPanel ? `https://github.com/mavencare/${prPanel.repo || 'webplatform'}/pulls?q=${prPanel.jiraKey}` : undefined}
        releaseVersion={prPanel?.version || null}
      />
    </div>
  )
}

// ── People group view ────────────────────────────────────

interface PersonGroup {
  name: string
  tickets: Array<any & { _release: { repo: string; version: string; branch?: string | null } }>
  statusCounts: Record<string, number>
}

function PeopleGroupView({
  releases, view, navigate, onClickPr,
}: {
  releases: HomeRelease[]
  view: HomeView
  navigate: (path: string, opts?: any) => void
  onClickPr: (jiraKey: string, summary: string, prs: PrInfo[], repo: string, version: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (name: string) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  // Determine which assignee field to group by based on role view
  const assigneeField = view === 'qa' ? 'qaAssignee' : 'assignee'

  // Build person groups from releases
  const groups = useMemo(() => {
    const map = new Map<string, PersonGroup>()
    const doneStatuses = new Set(STATUS_GROUPS.find(g => g.key === 'done')?.statuses || [])

    for (const r of releases) {
      for (const t of (r.tickets || [])) {
        const name = (t as any)[assigneeField] || 'Not Assigned'
        if (!map.has(name)) map.set(name, { name, tickets: [], statusCounts: {} })
        const group = map.get(name)!
        group.tickets.push({ ...t, _release: { repo: r.repo || '', version: r.version, branch: r.branch } })
        const status = t.jiraStatus || 'Unknown'
        group.statusCounts[status] = (group.statusCounts[status] || 0) + 1
      }
    }

    // Sort: people with most not-done tickets first, "Not Assigned" last
    return Array.from(map.values()).sort((a, b) => {
      if (a.name === 'Not Assigned') return 1
      if (b.name === 'Not Assigned') return -1
      const aNotDone = a.tickets.filter(t => !doneStatuses.has(t.jiraStatus || '')).length
      const bNotDone = b.tickets.filter(t => !doneStatuses.has(t.jiraStatus || '')).length
      return bNotDone - aNotDone
    })
  }, [releases, assigneeField])

  if (groups.length === 0) {
    return <div className="text-sm text-muted-foreground py-8 text-center italic">No assignees found</div>
  }

  return (
    <div className="space-y-2">
      {groups.map(group => (
        <PersonPanel
          key={group.name}
          group={group}
          view={view}
          navigate={navigate}
          isCollapsed={collapsed.has(group.name)}
          onToggle={() => toggle(group.name)}
          onClickPr={onClickPr}
        />
      ))}
    </div>
  )
}

function PersonPanel({
  group, view, navigate, isCollapsed, onToggle, onClickPr,
}: {
  group: PersonGroup
  view: HomeView
  navigate: (path: string, opts?: any) => void
  isCollapsed: boolean
  onToggle: () => void
  onClickPr: (jiraKey: string, summary: string, prs: PrInfo[], repo: string, version: string) => void
}) {
  // Summarize status counts for the header
  const statusSummary = useMemo(() => {
    const buckets: Array<{ label: string; count: number; color: string }> = []
    const grouped: Record<string, number> = {}
    for (const t of group.tickets) {
      const sg = getStatusGroup(t.jiraStatus || '')
      grouped[sg] = (grouped[sg] || 0) + 1
    }
    for (const g of STATUS_GROUPS) {
      if (g.key === 'all' || g.key === 'not-done') continue
      if (grouped[g.key]) buckets.push({ label: g.label, count: grouped[g.key], color: g.pillActive })
    }
    return buckets
  }, [group.tickets])

  // Sort tickets: not-done first, then by release version
  type PersonTicketSortKey = 'key' | 'summary' | 'status' | 'release' | 'cherryPick' | 'prs' | 'build'
  const otherAssigneeField = view === 'qa' ? 'assignee' : 'qaAssignee'
  const otherLabel = view === 'qa' ? 'Dev' : 'QA'
  const [ticketSort, onTicketSort] = useSortState<PersonTicketSortKey>(null)
  const ticketAccessors = useMemo(() => ({
    key:        (t: any) => t.key,
    summary:    (t: any) => t.summary,
    status:     (t: any) => t.jiraStatus,
    release:    (t: any) => t._release?.version || '',
    cherryPick: (t: any) => (t.prs || []).filter((p: PrInfo) => {
      const base = p.baseBranch || ''
      return base.startsWith('releases/') || base.startsWith('VIV/') || base.startsWith('release/')
    }).length,
    prs:        (t: any) => (t.prs || []).length,
    build:      (t: any) => t.build?.status || '',
  }), [])
  const sortedTickets = useSortableData(group.tickets, ticketSort, ticketAccessors)

  return (
    <Card className="overflow-hidden">
      {/* Person header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/30">
        <button onClick={onToggle} className="text-muted-foreground hover:text-foreground text-xs w-4 shrink-0">
          {isCollapsed ? '▸' : '▾'}
        </button>

        <span className="font-semibold text-foreground">{group.name}</span>
        {group.name !== 'Not Assigned' && <OutIcon name={group.name} className="shrink-0" />}

        <span className="text-xs text-muted-foreground">
          {group.tickets.length} ticket{group.tickets.length !== 1 ? 's' : ''}
        </span>

        <div className="flex items-center gap-2 ml-2">
          {statusSummary.map(s => (
            <span key={s.label} className="text-[10px] text-muted-foreground">
              {s.count} {s.label.toLowerCase()}
            </span>
          ))}
        </div>

        <span className="ml-auto text-xs text-muted-foreground">
          across {new Set(group.tickets.map(t => t._release.version)).size} release{new Set(group.tickets.map(t => t._release.version)).size !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Tickets table */}
      {!isCollapsed && group.tickets.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col style={{ width: '130px' }} />
              <col style={{ width: '100px' }} />
              <col />
              <col style={{ width: '155px' }} />
              <col style={{ width: '75px' }} />
              <col style={{ width: '35px' }} />
              <col style={{ width: '50px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border/20 text-left">
                <SortableHeader label="Release"    sortKey="release"    state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} className="pl-4 pr-2 py-1.5 text-[10px]" />
                <SortableHeader label="Key"        sortKey="key"        state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} className="px-2 py-1.5 text-[10px]" />
                <SortableHeader label="Summary"    sortKey="summary"    state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} className="px-2 py-1.5 text-[10px]" />
                <SortableHeader label="Status"     sortKey="status"     state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} align="right" className="px-2 py-1.5 text-[10px]" />
                <SortableHeader label="Cherry Pick" sortKey="cherryPick" state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} align="center" className="px-1 py-1.5 text-[10px]" />
                <SortableHeader label="PRs"        sortKey="prs"        state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} align="center" className="px-0.5 py-1.5 text-[10px]" />
                <SortableHeader label="Build"      sortKey="build"      state={ticketSort} onSort={k => onTicketSort(k as PersonTicketSortKey)} align="center" className="px-1 py-1.5 text-[10px]" />
                <th className="px-2 pr-4 py-1.5 text-[10px] font-medium text-muted-foreground text-right">{otherLabel}</th>
              </tr>
            </thead>
            <tbody>
              {sortedTickets.map((ticket: any) => {
                const releaseKey = ticket._release.repo ? `${ticket._release.repo}:${ticket._release.version}` : ticket._release.version
                const other = displayAssignee((ticket as any)[otherAssigneeField])
                return (
                  <tr key={`${ticket.key}-${ticket._release.version}`} className="border-b border-border/10 hover:bg-accent/20 transition-colors">
                    <td className="pl-4 pr-2 py-1.5 align-middle whitespace-nowrap">
                      <button
                        onClick={() => navigate(`/releases/${releaseKey}`, { state: { from: 'home' } })}
                        className="text-xs font-mono text-primary hover:underline"
                        title={ticket._release.repo}
                      >
                        {ticket._release.repo && ticket._release.repo !== 'webplatform' && (
                          <Badge variant="secondary" className="text-[9px] mr-1 px-1 py-0">{ticket._release.repo}</Badge>
                        )}
                        {ticket._release.version}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 align-middle whitespace-nowrap">
                      <JiraLink jiraKey={ticket.key} className="text-xs" />
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <div className="text-foreground truncate" title={ticket.summary}>{ticket.summary}</div>
                    </td>
                    <td className="px-2 py-1.5 align-middle text-right whitespace-nowrap">
                      {ticket.jiraStatus && (
                        <span className={cn(
                          'inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border',
                          getStatusBadgeColor(ticket.jiraStatus)
                        )}>
                          {ticket.jiraStatus}
                        </span>
                      )}
                    </td>
                    <PrCountCells
                      prs={ticket.prs || []}
                      releaseBranch={ticket._release.branch}
                      onClick={() => onClickPr(ticket.key, ticket.summary, ticket.prs || [], ticket._release.repo || 'webplatform', ticket._release.version)}
                    />
                    <BuildStatusCell build={ticket.build} />
                    <td className="px-2 pr-4 py-1.5 align-middle whitespace-nowrap">
                      <div className="flex items-center justify-end gap-0.5">
                        <span className={cn('text-xs truncate', other.className)} title={other.text}>{other.text}</span>
                        <OutIcon name={(ticket as any)[otherAssigneeField]} className="ml-0 shrink-0" />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {isCollapsed && group.tickets.length > 0 && (
        <button onClick={onToggle} className="w-full px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 text-left">
          {group.tickets.length} ticket{group.tickets.length !== 1 ? 's' : ''} — click to expand
        </button>
      )}
    </Card>
  )
}

// ── Release group ────────────────────────────────────────

function ReleaseGroup({
  title, titleColor, releases, view, person, navigate, collapsed, onToggle, expandedTickets, onToggleExpandTickets, onClickPr,
}: {
  title: string
  titleColor?: string
  releases: HomeRelease[]
  view: HomeView
  person: string | null
  navigate: (path: string, opts?: any) => void
  collapsed: Set<string>
  onToggle: (id: string) => void
  expandedTickets: Set<string>
  onToggleExpandTickets: (id: string) => void
  onClickPr: (jiraKey: string, summary: string, prs: PrInfo[], repo: string, version: string) => void
}) {
  return (
    <div>
      <h2 className={cn('text-xs font-semibold uppercase tracking-wider mb-2', titleColor || 'text-foreground')}>
        {title} ({releases.length})
      </h2>
      <div className="space-y-2">
        {releases.map(release => (
          <ReleasePanel
            key={release.id}
            release={release}
            view={view}
            person={person}
            navigate={navigate}
            isCollapsed={collapsed.has(release.id)}
            onToggle={() => onToggle(release.id)}
            allTicketsExpanded={expandedTickets.has(release.id)}
            onToggleAllTickets={() => onToggleExpandTickets(release.id)}
            onClickPr={onClickPr}
          />
        ))}
      </div>
    </div>
  )
}

// ── Release panel with collapsible tickets ───────────────

function ReleasePanel({
  release: r, view, person, navigate, isCollapsed, onToggle, allTicketsExpanded, onToggleAllTickets, onClickPr,
}: {
  release: HomeRelease
  view: HomeView
  person: string | null
  navigate: (path: string, opts?: any) => void
  isCollapsed: boolean
  onToggle: () => void
  allTicketsExpanded: boolean
  onToggleAllTickets: () => void
  onClickPr: (jiraKey: string, summary: string, prs: PrInfo[], repo: string, version: string) => void
}) {
  const releaseKey = r.repo ? `${r.repo}:${r.version}` : r.version
  const dateInfo = r.jiraReleaseDate ? relativeDate(r.jiraReleaseDate) : null

  // Per-card sort state for the tickets table
  type ReleaseTicketSortKey = 'key' | 'summary' | 'status' | 'cherryPick' | 'prs' | 'build' | 'dev' | 'qa'
  const [ticketSort, onTicketSort] = useSortState<ReleaseTicketSortKey>(null)
  const ticketAccessors = useMemo(() => ({
    key:        (t: any) => t.key,
    summary:    (t: any) => t.summary,
    status:     (t: any) => t.jiraStatus,
    cherryPick: (t: any) => (t.prs || []).filter((p: PrInfo) => {
      const base = p.baseBranch || ''
      return base.startsWith('releases/') || base.startsWith('VIV/') || base.startsWith('release/')
    }).length,
    prs:        (t: any) => (t.prs || []).length,
    build:      (t: any) => t.build?.status || '',
    dev:        (t: any) => t.assignee,
    qa:         (t: any) => t.qaAssignee,
  }), [])
  const sortedTickets = useSortableData<any, ReleaseTicketSortKey>(r.tickets || [], ticketSort, ticketAccessors)

  return (
    <Card className="overflow-hidden">
      {/* Release header — always visible */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/30">
        {/* Collapse toggle */}
        <button
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground text-xs w-4 shrink-0"
        >
          {isCollapsed ? '▸' : '▾'}
        </button>

        {/* Repo badge */}
        {r.repo && (
          <Badge variant="secondary" className="text-xs shrink-0">{r.repo}</Badge>
        )}

        {/* Version — clickable to release detail */}
        <button
          onClick={() => navigate(`/releases/${releaseKey}`, { state: { from: 'home' } })}
          className="font-bold font-mono text-primary hover:underline"
        >
          {r.version}
        </button>

        {/* State */}
        <span className={cn('text-xs px-2 py-0.5 rounded shrink-0', STATE_COLORS[r.state] || '')}>
          {r.state}
        </span>

        {/* Date — prominent */}
        {dateInfo && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">{r.jiraReleaseDate}</span>
            <span className={cn('text-xs font-medium', dateInfo.color)}>{dateInfo.label}</span>
          </div>
        )}

        {/* Pipeline badge */}
        <PipelineBadge pipeline={(r as any).pipeline} />

        {/* Zoho badge */}
        <ZohoImpactBadge count={r.zohoTicketCount} />

        {/* Ticket count — right aligned */}
        <span className="ml-auto text-xs text-muted-foreground shrink-0">
          {person ? (
            <><span className="text-foreground font-medium">{r.ticketCount}</span> / {r.totalTicketCount} tickets</>
          ) : (
            <><span className="text-foreground font-medium">{r.ticketCount}</span> tickets</>
          )}
        </span>
      </div>

      {/* Target customers — separate row below header */}
      {r.targetCustomers != null && (
        <div className="flex items-center gap-1.5 px-4 pb-2">
          <CustomerPills customerIds={r.targetCustomers} />
        </div>
      )}

      {/* Tickets table — collapsible */}
      {!isCollapsed && r.tickets.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col style={{ width: '100px' }} />
              <col />
              <col style={{ width: '155px' }} />
              <col style={{ width: '75px' }} />
              <col style={{ width: '35px' }} />
              <col style={{ width: '50px' }} />
              <col style={{ width: '130px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border/20 text-left">
                <SortableHeader label="Key"        sortKey="key"        state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} className="pl-4 pr-2 py-1.5 text-[10px]" />
                <SortableHeader label="Summary"    sortKey="summary"    state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} className="px-2 py-1.5 text-[10px]" />
                <SortableHeader label="Status"     sortKey="status"     state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} align="right" className="px-2 py-1.5 text-[10px]" />
                <SortableHeader label="Cherry Pick" sortKey="cherryPick" state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} align="center" className="px-1 py-1.5 text-[10px]" title="Cherry-Pick PRs" />
                <SortableHeader label="PRs"        sortKey="prs"        state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} align="center" className="px-0.5 py-1.5 text-[10px]" title="Original PRs" />
                <SortableHeader label="Build"      sortKey="build"      state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} align="center" className="px-1 py-1.5 text-[10px]" />
                <SortableHeader label="Dev"        sortKey="dev"        state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} align="right" className="px-2 py-1.5 text-[10px]" />
                <SortableHeader label="QA"         sortKey="qa"         state={ticketSort} onSort={k => onTicketSort(k as ReleaseTicketSortKey)} align="right" className="px-2 pr-4 py-1.5 text-[10px]" />
              </tr>
            </thead>
            <tbody>
              {(() => {
                const limit = view === 'pm' ? 50 : 25
                const hasMore = sortedTickets.length > limit
                const visibleTickets = (hasMore && !allTicketsExpanded) ? sortedTickets.slice(0, limit) : sortedTickets
                const hiddenCount = sortedTickets.length - limit
                return (
                  <>
                    {visibleTickets.map((ticket: any) => {
                      const dev = displayAssignee(ticket.assignee)
                      const qa = displayAssignee(ticket.qaAssignee)
                      return (
                        <tr key={ticket.key} className="border-b border-border/10 hover:bg-accent/20 transition-colors">
                          <td className="pl-4 pr-2 py-1.5 align-middle whitespace-nowrap">
                            <JiraLink jiraKey={ticket.key} className="text-xs" />
                          </td>
                          <td className="px-2 py-1.5 align-middle">
                            <div className="text-foreground truncate" title={ticket.summary}>{ticket.summary}</div>
                          </td>
                          <td className="px-2 py-1.5 align-middle text-right whitespace-nowrap">
                            {ticket.jiraStatus && (
                              <span className={cn(
                                'inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border',
                                getStatusBadgeColor(ticket.jiraStatus)
                              )}>
                                {ticket.jiraStatus}
                              </span>
                            )}
                          </td>
                          <PrCountCells
                            prs={ticket.prs || []}
                            releaseBranch={r.branch}
                            onClick={() => onClickPr(ticket.key, ticket.summary, ticket.prs || [], r.repo || 'webplatform', r.version)}
                          />
                          <BuildStatusCell build={ticket.build} />
                          <td className="px-2 py-1.5 align-middle whitespace-nowrap">
                            <div className="flex items-center justify-end gap-0.5">
                              <span className={cn('text-xs truncate', dev.className)} title={dev.text}>{dev.text}</span>
                              <OutIcon name={ticket.assignee} blockingRelease={ticket.assigneeOut?.blockingRelease} className="ml-0 shrink-0" />
                            </div>
                          </td>
                          <td className="px-2 pr-4 py-1.5 align-middle whitespace-nowrap">
                            <div className="flex items-center justify-end gap-0.5">
                              <span className={cn('text-xs truncate', qa.className)} title={qa.text}>{qa.text}</span>
                              <OutIcon name={ticket.qaAssignee} blockingRelease={ticket.qaAssigneeOut?.blockingRelease} className="ml-0 shrink-0" />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {hasMore && (
                      <tr>
                        <td colSpan={8} className="pl-4 py-1">
                          <button
                            onClick={onToggleAllTickets}
                            className="text-xs text-blue-400 hover:text-blue-300 hover:underline cursor-pointer"
                          >
                            {allTicketsExpanded ? `Show fewer tickets` : `+${hiddenCount} more tickets`}
                          </button>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })()}
            </tbody>
          </table>
        </div>
      )}

      {/* Collapsed hint */}
      {isCollapsed && r.tickets.length > 0 && (
        <button onClick={onToggle} className="w-full px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/20 text-left">
          {r.ticketCount} ticket{r.ticketCount !== 1 ? 's' : ''} — click to expand
        </button>
      )}
    </Card>
  )
}

// ── Build status cell ────────────────────────────────────

function BuildStatusCell({ build }: { build: { buildNumber: number; status: string; startTime: string; branch: string } | null }) {
  if (!build) return <td className="px-1 py-1.5 align-middle text-center"><span className="text-muted-foreground/20 text-sm">—</span></td>

  const succeeded = build.status === 'SUCCEEDED'
  const failed = build.status === 'FAILED'
  const inProgress = build.status === 'IN_PROGRESS'

  return (
    <td className="px-1 py-1.5 align-middle text-center">
      <span
        className={cn(
          'text-sm cursor-default',
          succeeded ? 'text-green-400' : failed ? 'text-red-400' : inProgress ? 'text-blue-400 animate-pulse' : 'text-muted-foreground'
        )}
        title={`Build #${build.buildNumber} ${build.status}${build.startTime ? ` · ${new Date(build.startTime).toLocaleString()}` : ''}${build.branch ? ` · ${build.branch}` : ''}`}
      >
        {succeeded ? '✓' : failed ? '✗' : inProgress ? '...' : '?'}
      </span>
    </td>
  )
}

// ── PR count cells (two columns: CPs and PRs) ───────────

function PrCountCells({ prs, onClick, releaseBranch }: { prs: PrInfo[]; onClick: () => void; releaseBranch?: string | null }) {
  const cherryPicks = prs.filter(p => {
    const b = p.baseBranch || ''
    if (!(b.startsWith('releases/') || b.startsWith('VIV/') || b.startsWith('release/'))) return false
    // If we know the release branch, only count CPs targeting THIS branch
    if (releaseBranch && b !== releaseBranch) return false
    return true
  })
  const originals = prs.filter(p => {
    const b = p.baseBranch || ''
    return b === 'master' || b === 'main' || b === 'develop'
  })

  // CP status: any merged? any open? or none?
  const cpMerged = cherryPicks.some(p => p.status === 'merged')
  const cpOpen = cherryPicks.some(p => p.status === 'open')

  return (
    <>
      <td className="px-0.5 py-1.5 align-middle text-center">
        {cpMerged ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onClick() }}
            className="cursor-pointer hover:opacity-80 transition-opacity"
            title={`${cherryPicks.length} cherry-pick PR${cherryPicks.length !== 1 ? 's' : ''} — merged`}
          >
            <span className="text-green-400 text-sm">✓</span>
          </button>
        ) : cpOpen ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onClick() }}
            className="cursor-pointer hover:opacity-80 transition-opacity"
            title={`${cherryPicks.length} cherry-pick PR${cherryPicks.length !== 1 ? 's' : ''} — open`}
          >
            <span className="text-yellow-400 text-sm">○</span>
          </button>
        ) : (
          <span className="text-muted-foreground/20 text-sm">—</span>
        )}
      </td>
      <td className="px-0.5 py-1.5 align-middle text-center">
        {originals.length > 0 ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); onClick() }}
            className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-400 cursor-pointer hover:bg-blue-500/30 transition-colors"
            title={`${originals.length} original PR${originals.length !== 1 ? 's' : ''}`}
          >{originals.length}</button>
        ) : (
          <span className="text-[10px] text-muted-foreground/25">—</span>
        )}
      </td>
    </>
  )
}

// ── Customer-grouped view (Support/CS) ───────────────────

function CustomerGroupedView({ releases }: { releases: HomeRelease[] }) {
  const groups = useMemo(() => {
    const byDept: Record<string, {
      departmentId: string
      customerName: string
      tickets: Array<{ zohoTicket: any; release: HomeRelease; jiraKey?: string }>
    }> = {}

    for (const release of releases) {
      const zohoByJira = (release as any).zohoByJiraKey || {}
      for (const zt of (release.zohoTickets || [])) {
        const deptId = zt.departmentId || 'unknown'
        if (!byDept[deptId]) {
          byDept[deptId] = {
            departmentId: deptId,
            customerName: DEPT_NAMES[deptId] || 'Unknown Customer',
            tickets: [],
          }
        }
        let linkedJiraKey: string | undefined
        for (const [jiraKey, zohoTickets] of Object.entries(zohoByJira)) {
          if ((zohoTickets as any[]).some((z: any) => z.id === zt.id)) {
            linkedJiraKey = jiraKey
            break
          }
        }
        byDept[deptId].tickets.push({ zohoTicket: zt, release, jiraKey: linkedJiraKey })
      }
    }

    return Object.values(byDept).sort((a, b) => b.tickets.length - a.tickets.length)
  }, [releases])

  if (groups.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center italic">
        No linked support tickets found across upcoming releases
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider">
        Customer Impact ({groups.reduce((s, g) => s + g.tickets.length, 0)} support tickets)
      </h2>
      {groups.map(group => (
        <Card key={group.departmentId}>
          <div className="px-4 py-2.5 border-b border-border/30 flex items-center gap-2">
            <span className="font-semibold">{group.customerName}</span>
            <Badge variant="secondary" className="text-xs">{group.tickets.length}</Badge>
          </div>
          <CardContent className="pt-2 pb-2">
            <div className="divide-y divide-border/30">
              {group.tickets.map(({ zohoTicket: zt, release, jiraKey }) => (
                <div key={`${zt.id}-${release.version}`} className="flex items-start gap-2 py-1.5 text-sm">
                  <span className="text-xs text-muted-foreground font-mono shrink-0 mt-0.5">
                    {zt.ticketNumber || zt.id.slice(-6)}
                  </span>
                  {zt.webUrl ? (
                    <a href={zt.webUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex-1 min-w-0 truncate">
                      {zt.subject}
                    </a>
                  ) : (
                    <span className="flex-1 min-w-0 truncate">{zt.subject}</span>
                  )}
                  {jiraKey && <JiraLink jiraKey={jiraKey} className="text-xs shrink-0" />}
                  <Badge variant="secondary" className="text-xs shrink-0">{release.version}</Badge>
                  {zt.priority && (
                    <span className={cn('text-xs shrink-0',
                      zt.priority === 'High' ? 'text-red-400' :
                      zt.priority === 'Medium' ? 'text-yellow-400' : 'text-muted-foreground'
                    )}>
                      {zt.priority}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ── Tickets Table (group-by-tickets mode) ──────────────

/**
 * Extract the "next release" — the earliest non-shipped release for a ticket.
 * Releases come pre-sorted from /api/tickets/home (overdue first, then upcoming, shipped last).
 */
// getNextRelease, priorityOrdinal, riskOrdinal — imported from ../../components/TicketRow

function TicketsTable({ tickets }: { tickets: TicketRowData[] }) {
  type TicketSortKey = 'key' | 'summary' | 'status' | 'health' | 'priority' | 'risk' | 'customerPriority' | 'assignee' | 'qa' | 'deployed' | 'nextRelease' | 'nextDate' | 'releases'
  // Default: earliest release date first
  const [sortState, onSort] = useSortState<TicketSortKey>('nextDate', 'asc')

  // Release filter chips — multi-select with OR semantics
  const [selectedReleases, setSelectedReleases] = useState<Set<string>>(new Set())
  const toggleRelease = (version: string) => {
    setSelectedReleases(prev => {
      const next = new Set(prev)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  // All non-shipped releases that appear across tickets — for the chip bar
  const releaseChips = useMemo(() => {
    const seen = new Map<string, { version: string; jiraReleaseDate: string | null; isOverdue: boolean }>()
    for (const t of tickets) {
      for (const r of (t.releases || [])) {
        if (r.isShipped) continue
        if (!seen.has(r.version)) {
          seen.set(r.version, {
            version: r.version,
            jiraReleaseDate: r.jiraReleaseDate || null,
            isOverdue: !!r.isOverdue,
          })
        }
      }
    }
    return Array.from(seen.values()).sort((a, b) => {
      const aDate = a.jiraReleaseDate || 'zzzz'
      const bDate = b.jiraReleaseDate || 'zzzz'
      return aDate.localeCompare(bDate)
    })
  }, [tickets])

  const filteredByChips = useMemo(() => {
    if (selectedReleases.size === 0) return tickets
    return tickets.filter(t => (t.releases || []).some(r => selectedReleases.has(r.version)))
  }, [tickets, selectedReleases])

  const HEALTH_SORT_PRIORITY: Record<string, number> = { attention: 0, 'in-dev': 1, 'awaiting-cp': 2, 'in-qa': 3, done: 4 }
  const worstHealthOrdinal = (t: TicketRowData): number => {
    if (!t.truth || t.truth.length === 0) return 99
    return t.truth.reduce((w, e) => Math.min(w, HEALTH_SORT_PRIORITY[e.healthCategory] ?? 5), 99)
  }
  const accessors = useMemo(() => ({
    key:              (t: TicketRowData) => t.key,
    summary:          (t: TicketRowData) => t.summary,
    status:           (t: TicketRowData) => t.jiraStatus,
    health:           (t: TicketRowData) => worstHealthOrdinal(t),
    priority:         (t: TicketRowData) => priorityOrdinal(t.priority),
    risk:             (t: TicketRowData) => riskOrdinal(t.riskLevel),
    customerPriority: (t: TicketRowData) => priorityOrdinal(t.customerPriority),
    assignee:         (t: TicketRowData) => t.assignee,
    qa:               (t: TicketRowData) => t.qaAssignee,
    deployed:         (t: TicketRowData) => (t.deployedEnvironments || []).length,
    nextRelease:      (t: TicketRowData) => getNextRelease(t)?.version || null,
    nextDate:         (t: TicketRowData) => getNextRelease(t)?.jiraReleaseDate || null,
    releases:         (t: TicketRowData) => (t.releases || []).length,
  }), [])
  const sorted = useSortableData<TicketRowData, TicketSortKey>(filteredByChips, sortState, accessors)

  return (
    <div className="space-y-3">
      {/* Release filter chips */}
      {releaseChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
          {releaseChips.map(c => {
            const isSelected = selectedReleases.has(c.version)
            return (
              <button
                key={c.version}
                type="button"
                onClick={() => toggleRelease(c.version)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-colors font-mono',
                  isSelected
                    ? 'bg-primary text-primary-foreground border-primary'
                    : c.isOverdue
                      ? 'bg-red-500/10 text-red-400 border-red-500/40 hover:bg-red-500/20'
                      : 'bg-muted/30 border-muted hover:bg-accent/50'
                )}
                title={c.jiraReleaseDate ? `${c.version} — ${c.jiraReleaseDate}${c.isOverdue ? ' (OVERDUE)' : ''}` : c.version}
              >
                <span>{c.version}</span>
                {c.jiraReleaseDate && (
                  <span className="text-[10px] opacity-70">{c.jiraReleaseDate.slice(5)}</span>
                )}
              </button>
            )
          })}
          {selectedReleases.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedReleases(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <colgroup>
                <col className="w-28" />
                <col />{/* summary */}
                <col className="w-40" />
                <col className="w-20" />{/* health */}
                <col className="w-20" />{/* priority */}
                <col className="w-24" />{/* risk */}
                <col className="w-28" />{/* customer priority */}
                <col className="w-32" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-24" />{/* next release version */}
                <col className="w-24" />{/* next release date */}
                <col />{/* releases */}
              </colgroup>
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b text-left">
                  <SortableHeader label="Key"          sortKey="key"              state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Summary"      sortKey="summary"          state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Status"       sortKey="status"           state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Health"       sortKey="health"           state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Priority"     sortKey="priority"         state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Risk"         sortKey="risk"             state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Cust Prio"    sortKey="customerPriority" state={sortState} onSort={k => onSort(k as TicketSortKey)} className="hidden md:table-cell" title="Primary Customer Priority" />
                  <SortableHeader label="Assignee"     sortKey="assignee"         state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="QA"           sortKey="qa"               state={sortState} onSort={k => onSort(k as TicketSortKey)} className="hidden md:table-cell" />
                  <SortableHeader label="Deployed"     sortKey="deployed"         state={sortState} onSort={k => onSort(k as TicketSortKey)} className="hidden md:table-cell" />
                  <SortableHeader label="Next Release" sortKey="nextRelease"      state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Date"         sortKey="nextDate"         state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                  <SortableHeader label="Releases"     sortKey="releases"         state={sortState} onSort={k => onSort(k as TicketSortKey)} />
                </tr>
              </thead>
              <tbody>
                {sorted.map(t => (
                  <HomeTicketRow key={t.key} ticket={t} onReleaseClick={toggleRelease} />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// HomeTicketRow — wraps TicketRow but injects a Next Release column.
// Inlined here (not in shared TicketRow) because the column relies on
// /api/tickets/home enrichment fields that the /tickets page doesn't carry.
function HomeTicketRow({ ticket: t, onReleaseClick }: {
  ticket: TicketRowData
  onReleaseClick: (version: string) => void
}) {
  const next = getNextRelease(t)
  return (
    <tr className="border-b border-border/30 hover:bg-accent/30 transition-colors">
      <td className="px-3 py-2 align-top">
        <JiraLink jiraKey={t.key} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="line-clamp-2" title={t.summary}>{t.summary}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{t.type || 'Task'}</div>
      </td>
      <td className="px-3 py-2 align-top">
        <span className="text-xs">{t.jiraStatus}</span>
      </td>
      <td className="px-3 py-2 align-top"><HealthBadge truth={t.truth} /></td>
      <td className="px-3 py-2 align-top"><PriorityBadge value={t.priority} /></td>
      <td className="px-3 py-2 align-top"><RiskBadge value={t.riskLevel} /></td>
      <td className="px-3 py-2 align-top hidden md:table-cell"><PriorityBadge value={t.customerPriority} /></td>
      <td className="px-3 py-2 align-top whitespace-nowrap">
        <span className="text-xs inline-flex items-center gap-0.5">
          <span>{t.assignee || <span className="text-muted-foreground italic">—</span>}</span>
          <OutIcon name={t.assignee} blockingRelease={(t as any).assigneeOut?.blockingRelease} className="ml-0" />
        </span>
      </td>
      <td className="px-3 py-2 align-top whitespace-nowrap hidden md:table-cell">
        <span className="text-xs text-muted-foreground inline-flex items-center gap-0.5">
          <span>{t.qaAssignee || '—'}</span>
          <OutIcon name={t.qaAssignee} blockingRelease={(t as any).qaAssigneeOut?.blockingRelease} className="ml-0" />
        </span>
      </td>
      <td className="px-3 py-2 align-top hidden md:table-cell">
        <SharedDeployedCell envs={t.deployedEnvironments} jiraStatus={t.jiraStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <NextReleaseVersionCell next={next} onClick={onReleaseClick} />
      </td>
      <td className="px-3 py-2 align-top">
        <NextReleaseDateCell next={next} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {t.releases.map(r => (
            <ReleaseBadge
              key={`${r.repo}:${r.version}`}
              release={r}
              onClick={() => onReleaseClick(r.version)}
            />
          ))}
        </div>
      </td>
    </tr>
  )
}

// PriorityBadge, RiskBadge, NextReleaseVersionCell, NextReleaseDateCell — imported from ../../components/TicketRow

// ── OOO release-risk banner ──────────────────────────────
// Renders a red banner when any release due today/tomorrow has an assignee
// or QA who's out and blocking. Single conspicuous warning at the top of Home.

function OooReleaseRiskBanner({ releases }: { releases: HomeRelease[] }) {
  // Ensure availability data is loaded (CurrentlyOutBanner triggers it too —
  // using the same store means this re-renders when that fetch completes).
  useAvailabilityStore(s => s.data)

  const atRisk = releases.filter(r => (r.oooRisk || []).length > 0)
  if (atRisk.length === 0) return null

  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0" aria-hidden="true">🚨</span>
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-sm font-semibold text-red-400">
            {atRisk.length === 1
              ? `Release ${atRisk[0].version} is at risk — assignees are OOO`
              : `${atRisk.length} imminent releases have OOO assignees`}
          </p>
          {atRisk.map(r => (
            <div key={r.id} className="text-xs">
              <span className="font-semibold text-foreground">{r.version}</span>
              <span className="text-muted-foreground ml-1">
                {r.jiraReleaseDate && `(${r.jiraReleaseDate})`} —
              </span>
              <ul className="ml-5 mt-1 space-y-0.5">
                {(r.oooRisk || []).map(risk => (
                  <li key={risk.name + risk.role} className="text-muted-foreground">
                    <span className="font-medium text-foreground">{risk.name}</span>
                    {' '}
                    ({risk.role === 'dev' ? 'dev' : 'QA'})
                    {' — back '}<span className="font-medium">{risk.endDate}</span>
                    {risk.blockingTickets.length > 0 && (
                      <span className="text-[11px] opacity-70 ml-1">
                        · {risk.blockingTickets.slice(0, 5).join(', ')}
                        {risk.blockingTickets.length > 5 && ` +${risk.blockingTickets.length - 5}`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
