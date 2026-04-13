import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useHomeStore, type HomeView } from '../../stores/homeStore'
import { apiFetch } from '../../api/client'
import type { Release } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { cn } from '../../lib/utils'
import { JiraLink } from '../../components/JiraLink'
import { ZohoImpactBadge } from '../releases/CustomerImpact'

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

const JIRA_STATUS_COLORS: Record<string, string> = {
  'QA Certified':           'bg-green-500/15 text-green-400 border-green-500/30',
  'Cherry Picked':          'bg-green-500/15 text-green-400 border-green-500/30',
  'Done':                   'bg-green-500/15 text-green-400 border-green-500/30',
  'Closed':                 'bg-green-500/15 text-green-400 border-green-500/30',
  'Resolved Without Code':  'bg-gray-500/15 text-gray-400 border-gray-500/30',
  'Ready For Testing':      'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'In Testing':             'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'Testing in Branch':      'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'In Review':              'bg-purple-500/15 text-purple-400 border-purple-500/30',
  'Development In Progress': 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  'In Progress':            'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  'Waiting for Cherry Pick': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  'Re-verify Bug':          'bg-orange-500/15 text-orange-400 border-orange-500/30',
  'Blocked':                'bg-red-500/15 text-red-400 border-red-500/30',
  'Testing Failed':         'bg-red-500/15 text-red-400 border-red-500/30',
}

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

function getJiraStatusColor(status: string): string {
  return JIRA_STATUS_COLORS[status] || 'bg-gray-500/15 text-gray-400 border-gray-500/30'
}

// ── Component ────────────────────────────────────────────

export function HomePage() {
  const { view, person, isFirstVisit, setView, setPerson, dismissFirstVisit } = useHomeStore()
  const navigate = useNavigate()

  const [releases, setReleases] = useState<HomeRelease[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  // Split releases
  const { overdue, upcoming, unscheduled } = useMemo(() => {
    const overdue: HomeRelease[] = []
    const upcoming: HomeRelease[] = []
    const unscheduled: HomeRelease[] = []
    for (const r of releases) {
      if (!r.jiraReleaseDate) unscheduled.push(r)
      else if (r.isOverdue) overdue.push(r)
      else upcoming.push(r)
    }
    return { overdue, upcoming, unscheduled }
  }, [releases])

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

        {releases.length > 1 && (
          <div className="flex gap-1 ml-auto">
            <button onClick={expandAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50">Expand all</button>
            <button onClick={collapseAll} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50">Collapse all</button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
      ) : releases.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center italic">
          No releases in scope{person && ` for ${person}`}
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
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Release group ────────────────────────────────────────

function ReleaseGroup({
  title, titleColor, releases, view, person, navigate, collapsed, onToggle,
}: {
  title: string
  titleColor?: string
  releases: HomeRelease[]
  view: HomeView
  person: string | null
  navigate: (path: string, opts?: any) => void
  collapsed: Set<string>
  onToggle: (id: string) => void
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
          />
        ))}
      </div>
    </div>
  )
}

// ── Release panel with collapsible tickets ───────────────

function ReleasePanel({
  release: r, view, person, navigate, isCollapsed, onToggle,
}: {
  release: HomeRelease
  view: HomeView
  person: string | null
  navigate: (path: string, opts?: any) => void
  isCollapsed: boolean
  onToggle: () => void
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
              <col style={{ width: '160px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border/20 text-left">
                <th className="pl-4 pr-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Key</th>
                <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</th>
                <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">Status</th>
                <th className="px-2 pr-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-right">
                  {view === 'dev' ? 'QA' : view === 'qa' ? 'Dev' : 'Assignee'}
                </th>
              </tr>
            </thead>
            <tbody>
              {r.tickets.slice(0, view === 'pm' ? 50 : 25).map((ticket: any) => (
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
                        getJiraStatusColor(ticket.jiraStatus)
                      )}>
                        {ticket.jiraStatus}
                      </span>
                    )}
                  </td>
                  <td className="px-2 pr-4 py-1.5 align-middle text-right whitespace-nowrap">
                    <span className="text-xs text-muted-foreground truncate">
                      {view === 'dev' ? (ticket.qaAssignee || '') :
                       view === 'qa' ? (ticket.assignee || '') :
                       (ticket.assignee || '')}
                    </span>
                  </td>
                </tr>
              ))}
              {r.tickets.length > (view === 'pm' ? 50 : 25) && (
                <tr>
                  <td colSpan={4} className="pl-4 py-2 text-xs text-muted-foreground">
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
