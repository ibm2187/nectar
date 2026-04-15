import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useHomeStore, type HomeView } from '../../stores/homeStore'
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
  const { view, person, isFirstVisit, setView, setPerson, dismissFirstVisit } = useHomeStore()
  const navigate = useNavigate()

  const [releases, setReleases] = useState<HomeRelease[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [prPanel, setPrPanel] = useState<{ jiraKey: string; summary: string; prs: PrInfo[]; repo: string; version: string } | null>(null)
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('all')
  const [repoFilter, setRepoFilter] = useState('')
  const [ticketSearch, setTicketSearch] = useState('')

  // Fetch home data
  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (view) params.set('view', view)
    if (person) params.set('person', person)

    Promise.all([
      apiFetch<HomeRelease[]>(`/releases/home?${params}`),
      apiFetch<Person[]>('/people'),
    ])
      .then(([rels, ppl]) => {
        setReleases(rels)
        setPeople(ppl)
        setCollapsed(new Set()) // reset collapse state on data change
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [view, person])

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

  // Count tickets per status group
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0, 'not-done': 0 }
    for (const g of STATUS_GROUPS) counts[g.key] = 0
    const doneStatuses = new Set(STATUS_GROUPS.find(g => g.key === 'done')?.statuses || [])
    for (const r of releases) {
      for (const t of (r.tickets || [])) {
        counts.all++
        const g = getStatusGroup(t.jiraStatus || '')
        if (counts[g] !== undefined) counts[g]++
        if (!doneStatuses.has(t.jiraStatus || '')) counts['not-done']++
      }
    }
    return counts
  }, [releases])

  // Available repos
  const repos = useMemo(() => {
    const set = new Set<string>()
    for (const r of releases) if (r.repo) set.add(r.repo)
    return Array.from(set).sort()
  }, [releases])

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
    if (view === 'pm' || view === 'support' || view === 'cs') return []
    const roleKey = view === 'dev' ? 'dev' : view === 'qa' ? 'qa' : null
    if (!roleKey) return people
    return people.filter(p => p.roles.includes(roleKey))
  }, [people, view])

  const personEnabled = view === 'dev' || view === 'qa'

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

        {filteredReleases.length > 1 && (
          <div className="flex gap-1 ml-auto">
            <button onClick={expandAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50">Expand all</button>
            <button onClick={collapseAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50">Collapse all</button>
          </div>
        )}
      </div>

      {/* Status group pills + filters */}
      {!loading && releases.length > 0 && (
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
                  onClickPr={(jiraKey, summary, prs, repo, version) => setPrPanel({ jiraKey, summary, prs, repo, version })}
                />
              )}
              {upcoming.length > 0 && (
                <ReleaseGroup
                  title={`Upcoming (next 2 weeks)`}
                  releases={upcoming}
                  view={view}
                  person={person}
                  navigate={navigate}
                  collapsed={collapsed}
                  onToggle={toggleCollapse}
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

// ── Release group ────────────────────────────────────────

function ReleaseGroup({
  title, titleColor, releases, view, person, navigate, collapsed, onToggle, onClickPr,
}: {
  title: string
  titleColor?: string
  releases: HomeRelease[]
  view: HomeView
  person: string | null
  navigate: (path: string, opts?: any) => void
  collapsed: Set<string>
  onToggle: (id: string) => void
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
            onClickPr={onClickPr}
          />
        ))}
      </div>
    </div>
  )
}

// ── Release panel with collapsible tickets ───────────────

function ReleasePanel({
  release: r, view, person, navigate, isCollapsed, onToggle, onClickPr,
}: {
  release: HomeRelease
  view: HomeView
  person: string | null
  navigate: (path: string, opts?: any) => void
  isCollapsed: boolean
  onToggle: () => void
  onClickPr: (jiraKey: string, summary: string, prs: PrInfo[], repo: string, version: string) => void
}) {
  const releaseKey = r.repo ? `${r.repo}:${r.version}` : r.version
  const dateInfo = r.jiraReleaseDate ? relativeDate(r.jiraReleaseDate) : null

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
              <col style={{ width: '110px' }} />
              <col style={{ width: '110px' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border/20 text-left">
                <th className="pl-4 pr-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Key</th>
                <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</th>
                <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">Status</th>
                <th className="px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center" title="Cherry-Pick PRs">Cherry Pick</th>
                <th className="px-0.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center" title="Original PRs">PRs</th>
                <th className="px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center">Build</th>
                <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">Dev</th>
                <th className="px-2 pr-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">QA</th>
              </tr>
            </thead>
            <tbody>
              {r.tickets.slice(0, view === 'pm' ? 50 : 25).map((ticket: any) => {
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
                      onClick={() => onClickPr(ticket.key, ticket.summary, ticket.prs || [], r.repo || 'webplatform', r.version)}
                    />
                    <BuildStatusCell build={ticket.build} />
                    <td className="px-2 py-1.5 align-middle text-right whitespace-nowrap">
                      <span className={cn('text-xs truncate max-w-[110px] inline-block', dev.className)}>{dev.text}</span>
                    </td>
                    <td className="px-2 pr-4 py-1.5 align-middle text-right whitespace-nowrap">
                      <span className={cn('text-xs truncate max-w-[110px] inline-block', qa.className)}>{qa.text}</span>
                    </td>
                  </tr>
                )
              })}
              {r.tickets.length > (view === 'pm' ? 50 : 25) && (
                <tr>
                  <td colSpan={8} className="pl-4 py-2 text-xs text-muted-foreground">
                    +{r.tickets.length - (view === 'pm' ? 50 : 25)} more tickets
                  </td>
                </tr>
              )}
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

function PrCountCells({ prs, onClick }: { prs: PrInfo[]; onClick: () => void }) {
  const cherryPicks = prs.filter(p => {
    const b = p.baseBranch || ''
    return b.startsWith('releases/') || b.startsWith('VIV/') || b.startsWith('release/')
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
