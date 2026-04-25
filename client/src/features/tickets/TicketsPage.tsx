import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, type ZohoRef } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { cn, exportToCsv } from '../../lib/utils'
import { SavedViews } from '../../components/SavedViews'
import { TicketRow, TicketDeployedCell, ReleaseBadge, PriorityBadge, RiskBadge, HealthBadge, getNextRelease, priorityOrdinal, riskOrdinal, NextReleaseVersionCell, NextReleaseDateCell, type ReleaseMembership, type TicketRowData, type TruthEntry } from '../../components/TicketRow'
import { SortableHeader, useSortableData, useSortState, nextSortState, type SortState, type SortDir as SortableSortDir } from '../../components/SortableHeader'
import { JiraLink } from '../../components/JiraLink'
import { OutIcon } from '../../components/PersonBadge'
import { STATUS_GROUPS, type StatusGroup } from '../../lib/status-colors'
import { toLocalDateKey } from '../../lib/date'

interface ReleaseColumn {
  repo: string
  version: string
  state: string
  jiraReleaseDate: string | null
  branch: string | null
}

interface Ticket {
  key: string
  summary: string
  jiraStatus: string
  state: string
  type: string | null
  assignee: string | null
  qaAssignee: string | null
  zohoRef: ZohoRef | null
  deployedEnvironments: string[]
  fixVersions: string[]
  targetFixVersions: string[]
  releases: ReleaseMembership[]
}

interface TicketsResponse {
  releases: ReleaseColumn[]
  stats: {
    total: number
    plannedOnly: number
    deliveredAsPlanned: number
    anyUnplanned: number
    anyMissing: number
  }
  tickets: Ticket[]
}

// ── Flat ticket from jira_tickets table (enriched by API with releases + jiraStatus) ──

/** Extends TicketRowData with extra fields returned by the flat ticket endpoints. */
interface FlatTicket extends TicketRowData {
  status?: string | null
  statusCategory?: string | null
  component?: string | null
  module?: string | null
  product?: string[]
  projects?: string[]
  labels?: string[]
  customerTags?: string[]
  created?: string | null
  prs?: TicketPr[]
  truth?: TruthEntry[]
}

interface TicketPr {
  prNumber: number
  repo: string
  status: string
  baseBranch: string
  prUrl: string
}

interface ScopeStats {
  byGroup: Record<string, number>
  byType: Record<string, number>
  byStatus: Record<string, number>
}

interface FlatTicketsResponse {
  tickets: FlatTicket[]
  total: number
  hasMore: boolean
  since?: string
  scopeStats?: ScopeStats
}

interface SyncStatus {
  sync: { lastTicketSyncTime: string | null; totalTicketsSynced: number; lastSyncDurationMs: number | null; lastSyncError: string | null }
  stats: { total: number; byStatusCategory: Record<string, number>; byType: Record<string, number> }
}

// ── Filter types ───────────────────────────────────────

type GapFilter = 'any' | 'missing' | 'unplanned' | 'matched'
type SortKey = 'key' | 'summary' | 'status' | 'assignee' | 'qaAssignee' | 'releases'
type TicketsTab = 'releases' | 'scope' | 'triage' | 'all'

const TAB_CONFIG: Record<TicketsTab, { label: string }> = {
  releases:   { label: 'Releases' },
  scope:      { label: 'Cut Scope' },
  triage:     { label: 'Triage' },
  all:        { label: 'All Tickets' },
}
const TAB_ORDER: TicketsTab[] = ['releases', 'scope', 'triage', 'all']

interface FilterOptions {
  modules: string[]
  components: string[]
  customers: string[]
  projects: string[]
  products: string[]
  people: string[]
}

// ── Page ───────────────────────────────────────────────

export function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = (searchParams.get('tab') as TicketsTab) || 'releases'

  function setTab(t: TicketsTab) {
    setSearchParams(() => {
      const next = new URLSearchParams()
      if (t !== 'releases') next.set('tab', t)
      return next
    }, { replace: true })
  }

  return (
    <div className="w-full space-y-6">
      {/* Tab bar + sync status */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          {TAB_ORDER.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                tab === t
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {TAB_CONFIG[t].label}
            </button>
          ))}
        </div>
        <SyncStatusBadge />
      </div>

      {tab === 'releases' && <ReleasesTicketsTab />}
      {tab === 'scope' && <CutScopeTab />}
      {tab === 'triage' && <TriageTab />}
      {tab === 'all' && <AllTicketsTab />}
    </div>
  )
}

// ── Sync status badge ─────────────────────────────────

function SyncStatusBadge() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    apiFetch<SyncStatus>('/tickets/sync-status').then(setStatus).catch(() => {})
  }, [])
  if (!status) return null
  const { sync, stats } = status
  return (
    <span className="text-xs text-muted-foreground">
      {stats.total > 0
        ? `${stats.total.toLocaleString()} tickets synced`
        : 'Ticket sync pending...'}
      {sync.lastTicketSyncTime && (
        <span className="ml-1 opacity-60">
          (last: {new Date(sync.lastTicketSyncTime).toLocaleTimeString()})
        </span>
      )}
    </span>
  )
}

// ── Releases tab (existing view) ──────────────────────

function ReleasesTicketsTab() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('q') || ''
  const repoFilter = searchParams.get('repo') || ''
  const gapFilter = (searchParams.get('gap') as GapFilter) || 'any'
  const releaseFilter = searchParams.get('release') || '' // comma-separated
  const sortKeyRaw = searchParams.get('sort') as SortKey | null
  const sortDirRaw = searchParams.get('dir') as SortableSortDir | null
  const sortState: SortState<SortKey> = {
    key: sortKeyRaw,
    dir: sortDirRaw === 'asc' || sortDirRaw === 'desc' ? sortDirRaw : null,
  }

  const [data, setData] = useState<TicketsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      const result = await apiFetch<TicketsResponse>('/tickets')
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // ── Derived: release filter parsed into a set ─────────
  const selectedReleases = useMemo(() => {
    if (!releaseFilter) return null
    return new Set(releaseFilter.split(',').filter(Boolean))
  }, [releaseFilter])

  function toggleRelease(version: string) {
    const current = selectedReleases ? Array.from(selectedReleases) : []
    const next = current.includes(version)
      ? current.filter(v => v !== version)
      : [...current, version]
    updateParams({ release: next.length ? next.join(',') : null })
  }

  // ── Filter + sort pipeline ────────────────────────────
  const filtered = useMemo(() => {
    if (!data) return []
    let rows = data.tickets

    if (repoFilter) {
      rows = rows.filter(t => t.releases.some(r => r.repo === repoFilter))
    }

    if (selectedReleases) {
      rows = rows.filter(t => t.releases.some(r => selectedReleases.has(r.version)))
    }

    if (gapFilter === 'missing') {
      rows = rows.filter(t => t.releases.some(r => r.source === 'target'))
    } else if (gapFilter === 'unplanned') {
      rows = rows.filter(t => t.releases.some(r => r.source === 'fixVersion'))
    } else if (gapFilter === 'matched') {
      rows = rows.filter(t => t.releases.every(r => r.source === 'both'))
    }

    const q = search.toLowerCase().trim()
    if (q) {
      rows = rows.filter(t => {
        if (t.key.toLowerCase().includes(q)) return true
        if (t.summary.toLowerCase().includes(q)) return true
        if (t.assignee?.toLowerCase().includes(q)) return true
        if (t.qaAssignee?.toLowerCase().includes(q)) return true
        if (t.jiraStatus.toLowerCase().includes(q)) return true
        if (t.releases.some(r => r.version.toLowerCase().includes(q))) return true
        return false
      })
    }

    return rows
  }, [data, repoFilter, selectedReleases, gapFilter, search])

  // Sort applied separately so we can reuse a shared hook
  const sortAccessors = useMemo(() => ({
    key:        (t: Ticket) => t.key,
    summary:    (t: Ticket) => t.summary,
    status:     (t: Ticket) => t.jiraStatus,
    assignee:   (t: Ticket) => t.assignee,
    qaAssignee: (t: Ticket) => t.qaAssignee,
    releases:   (t: Ticket) => t.releases.length,
  }), [])
  const sorted = useSortableData<Ticket, SortKey>(filtered, sortState, sortAccessors)

  function setSort(key: SortKey) {
    const next = nextSortState(sortState, key)
    updateParams({ sort: next.key, dir: next.dir })
  }

  // ── Render ────────────────────────────────────────────

  if (loading) {
    return <NectarLoader size="lg" message="Aggregating tickets across releases..." className="mt-32" />
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

  if (!data) return null

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Tickets</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {data.stats.total} tickets across {data.releases.length} active releases.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Filters */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search DEV-12345, summary, assignee, release..."
            value={search}
            onChange={e => updateParams({ q: e.target.value || null })}
            className="max-w-sm"
          />
          <RepoFilter value={repoFilter} onChange={v => updateParams({ repo: v || null })} />
          <span className="text-sm text-muted-foreground ml-auto">
            {filtered.length} of {data.stats.total}
          </span>
          {(search || repoFilter || selectedReleases || gapFilter !== 'any') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateParams({ q: null, repo: null, release: null, gap: null })}
            >
              Clear filters
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={() => {
              exportToCsv(
                'tickets.csv',
                ['Key', 'Summary', 'Status', 'Type', 'Assignee', 'QA', 'Deployed', 'Releases'],
                sorted.map(t => [
                  t.key,
                  t.summary,
                  t.jiraStatus,
                  t.type || '',
                  t.assignee || '',
                  t.qaAssignee || '',
                  t.deployedEnvironments.join('; '),
                  t.releases.map(r => r.version).join('; '),
                ])
              )
            }}
          >
            Export CSV
          </Button>
          <SavedViews storageKey="nectar-saved-views-tickets" />
        </div>

        {/* Release filter chips — horizontal scroll, compact */}
        <ReleaseChips
          columns={data.releases.filter(c => !repoFilter || c.repo === repoFilter)}
          selected={selectedReleases}
          onToggle={toggleRelease}
        />
      </div>

      {/* Tickets table */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            No tickets match the current filters.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <colgroup>
                  <col className="w-28" />
                  <col />{/* summary */}
                  <col className="w-40" />
                  <col className="w-32" />
                  <col className="w-28" />
                  <col />{/* releases */}
                </colgroup>
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-left">
                    <SortableHeader label="Key"       sortKey="key"        state={sortState} onSort={k => setSort(k as SortKey)} />
                    <SortableHeader label="Summary"   sortKey="summary"    state={sortState} onSort={k => setSort(k as SortKey)} />
                    <SortableHeader label="Status"    sortKey="status"     state={sortState} onSort={k => setSort(k as SortKey)} />
                    <SortableHeader label="Assignee"  sortKey="assignee"   state={sortState} onSort={k => setSort(k as SortKey)} />
                    <SortableHeader label="QA"        sortKey="qaAssignee" state={sortState} onSort={k => setSort(k as SortKey)} className="hidden md:table-cell" />
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hidden md:table-cell">Deployed</th>
                    <SortableHeader label="Releases"  sortKey="releases"  state={sortState} onSort={k => setSort(k as SortKey)} />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(t => <TicketRow key={t.key} ticket={t} onReleaseClick={toggleRelease} />)}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Shared server-side paginated ticket table ─────────

type FlatSortKey = 'key' | 'summary' | 'status' | 'module' | 'assignee' | 'qaAssignee' | 'component' | 'created' | 'priority' | 'riskLevel' | 'customerPriority' | 'type'

// Client-side sort keys matching the Home page TicketsTable columns
type HomeSortKey = 'key' | 'summary' | 'status' | 'health' | 'priority' | 'risk' | 'customerPriority' | 'assignee' | 'qa' | 'deployed' | 'nextRelease' | 'nextDate' | 'releases' | 'prs'

interface BuildUrlParams {
  offset: number; limit: number; sort: FlatSortKey; sortDir: 'asc' | 'desc'
  search: string; module: string; person: string; statusGroup: StatusGroup
}

function ServerTicketTable({
  title,
  description,
  buildUrl,
  extraControls,
  emptyMessage = 'No tickets found.',
}: {
  title: string
  description: string
  buildUrl: (params: BuildUrlParams) => string
  extraControls?: React.ReactNode
  emptyMessage?: string
}) {
  const PAGE_SIZE = 50
  const [data, setData] = useState<FlatTicketsResponse & { offset?: number; limit?: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<FlatSortKey>('created')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [moduleFilter, setModuleFilter] = useState('')
  const [personFilter, setPersonFilter] = useState('')
  const [statusGroup, setStatusGroup] = useState<StatusGroup>('all')
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null)

  // Map Home-style sort keys to server sort keys.
  // Columns NOT in this map (nextRelease, nextDate, releases, prs, deployed)
  // can only sort the current page client-side.
  const SERVER_SORT_MAP: Partial<Record<HomeSortKey, FlatSortKey>> = {
    key: 'key',
    summary: 'summary',
    status: 'status',
    priority: 'priority',
    risk: 'riskLevel' as FlatSortKey,
    customerPriority: 'customerPriority' as FlatSortKey,
    assignee: 'assignee',
    qa: 'qaAssignee' as FlatSortKey,
  }

  function onSort(col: HomeSortKey) {
    const serverCol = SERVER_SORT_MAP[col]
    if (serverCol) {
      // Server-sortable column — re-fetch with new sort
      if (sort === serverCol) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc')
      } else {
        setSort(serverCol)
        setSortDir('desc')
      }
      setOffset(0)
    }
    // For non-server-sortable columns, we still track the sort state
    // but it only sorts the current page (acknowledged limitation with paginated data)
    onClientSort(col)
  }

  // Client-side sort for columns that can't sort server-side (applied after fetch)
  const [clientSort, onClientSort] = useSortState<HomeSortKey>(null, null)

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setOffset(0) }, 300)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    apiFetch<FilterOptions>('/tickets/filter-options').then(setFilterOptions).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const url = buildUrl({ offset, limit: PAGE_SIZE, sort, sortDir, search: debouncedSearch, module: moduleFilter, person: personFilter, statusGroup })
    apiFetch<FlatTicketsResponse>(url)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [offset, sort, sortDir, debouncedSearch, moduleFilter, personFilter, statusGroup, buildUrl])

  // Release filter chips — multi-select with OR semantics (same as Home)
  const [selectedReleases, setSelectedReleases] = useState<Set<string>>(new Set())
  const toggleRelease = (version: string) => {
    setSelectedReleases(prev => {
      const next = new Set(prev)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  // All non-shipped releases that appear across current page tickets
  const releaseChips = useMemo(() => {
    if (!data) return []
    const seen = new Map<string, { version: string; jiraReleaseDate: string | null; isOverdue: boolean }>()
    for (const t of data.tickets) {
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
  }, [data])

  // Filter by selected release chips
  const filteredTickets = useMemo(() => {
    if (!data) return []
    if (selectedReleases.size === 0) return data.tickets
    return data.tickets.filter(t => (t.releases || []).some(r => selectedReleases.has(r.version)))
  }, [data, selectedReleases])

  // Client-side sort using Home-style accessors
  const HEALTH_SORT_PRIORITY: Record<string, number> = { attention: 0, 'in-dev': 1, 'awaiting-cp': 2, 'in-qa': 3, done: 4 }
  const worstHealthOrdinal = (t: FlatTicket): number => {
    if (!t.truth || t.truth.length === 0) return 99
    return t.truth.reduce((w, e) => Math.min(w, HEALTH_SORT_PRIORITY[e.healthCategory] ?? 5), 99)
  }
  const clientAccessors = useMemo(() => ({
    key:              (t: FlatTicket) => t.key,
    summary:          (t: FlatTicket) => t.summary,
    status:           (t: FlatTicket) => t.jiraStatus,
    health:           (t: FlatTicket) => worstHealthOrdinal(t),
    priority:         (t: FlatTicket) => priorityOrdinal(t.priority),
    risk:             (t: FlatTicket) => riskOrdinal(t.riskLevel),
    customerPriority: (t: FlatTicket) => priorityOrdinal(t.customerPriority),
    assignee:         (t: FlatTicket) => t.assignee,
    qa:               (t: FlatTicket) => t.qaAssignee,
    deployed:         (t: FlatTicket) => (t.deployedEnvironments || []).length,
    nextRelease:      (t: FlatTicket) => getNextRelease(t)?.version || null,
    nextDate:         (t: FlatTicket) => getNextRelease(t)?.jiraReleaseDate || null,
    releases:         (t: FlatTicket) => (t.releases || []).length,
    prs:              (t: FlatTicket) => (t.prs || []).length,
  }), [])
  const sorted = useSortableData<FlatTicket, HomeSortKey>(filteredTickets, clientSort, clientAccessors)

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  const stats = data?.scopeStats

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">{title}</h2>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
        {stats && data && (
          <div className="flex gap-3 text-xs shrink-0">
            <div className="text-center px-3 py-2 rounded-md bg-muted/50">
              <div className="text-lg font-bold">{data.total}</div>
              <div className="text-muted-foreground">Total</div>
            </div>
            <div className="text-center px-3 py-2 rounded-md bg-green-500/10">
              <div className="text-lg font-bold text-green-400">{stats.byGroup.done || 0}</div>
              <div className="text-green-400/70">Done</div>
            </div>
            <div className="text-center px-3 py-2 rounded-md bg-yellow-500/10">
              <div className="text-lg font-bold text-yellow-400">{stats.byGroup['in-dev'] || 0}</div>
              <div className="text-yellow-400/70">In Dev</div>
            </div>
            <div className="text-center px-3 py-2 rounded-md bg-blue-500/10">
              <div className="text-lg font-bold text-blue-400">{stats.byGroup['ready-for-qa'] || 0}</div>
              <div className="text-blue-400/70">Ready QA</div>
            </div>
            <div className="text-center px-3 py-2 rounded-md bg-purple-500/10">
              <div className="text-lg font-bold text-purple-400">{stats.byGroup['in-qa'] || 0}</div>
              <div className="text-purple-400/70">In QA</div>
            </div>
            {(stats.byGroup.blocked || 0) > 0 && (
              <div className="text-center px-3 py-2 rounded-md bg-red-500/10">
                <div className="text-lg font-bold text-red-400">{stats.byGroup.blocked}</div>
                <div className="text-red-400/70">Blocked</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status group filter pills — matches Home page */}
      <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5 flex-wrap">
        {STATUS_GROUPS.map(g => (
          <button
            key={g.key}
            onClick={() => { setStatusGroup(g.key); setOffset(0) }}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              statusGroup === g.key ? g.pillActive : g.pillInactive,
            )}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Release filter chips (same as Home TicketsTable) */}
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

      {/* Filters row */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Search tickets..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-md border bg-background text-foreground w-48"
        />
        {filterOptions && (
          <>
            <select
              value={moduleFilter}
              onChange={e => { setModuleFilter(e.target.value); setOffset(0) }}
              className="h-8 px-2 text-sm rounded-md border bg-background text-foreground"
            >
              <option value="">All Modules</option>
              {filterOptions.modules.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select
              value={personFilter}
              onChange={e => { setPersonFilter(e.target.value); setOffset(0) }}
              className="h-8 px-2 text-sm rounded-md border bg-background text-foreground"
            >
              <option value="">All People</option>
              {filterOptions.people.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </>
        )}
        {extraControls}
        {(search || moduleFilter || personFilter || statusGroup !== 'all') && (
          <button
            onClick={() => { setSearch(''); setModuleFilter(''); setPersonFilter(''); setStatusGroup('all'); setOffset(0) }}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent/50"
          >
            Clear filters
          </button>
        )}
        <span className="text-sm text-muted-foreground ml-auto">
          {data ? `${data.total.toLocaleString()} tickets` : '...'}
        </span>
      </div>

      {loading && !data ? (
        <NectarLoader size="lg" message="Loading tickets..." className="mt-16" />
      ) : !data ? null : data.tickets.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            {emptyMessage}
          </CardContent>
        </Card>
      ) : (
        <>
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
                      <SortableHeader label="Key"          sortKey="key"              state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Summary"      sortKey="summary"          state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Status"       sortKey="status"           state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Health"       sortKey="health"           state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Priority"     sortKey="priority"         state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Risk"         sortKey="risk"             state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Cust Prio"    sortKey="customerPriority" state={clientSort} onSort={k => onSort(k as HomeSortKey)} className="hidden md:table-cell" title="Primary Customer Priority" />
                      <SortableHeader label="Assignee"     sortKey="assignee"         state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="QA"           sortKey="qa"               state={clientSort} onSort={k => onSort(k as HomeSortKey)} className="hidden md:table-cell" />
                      <SortableHeader label="Deployed"     sortKey="deployed"         state={clientSort} onSort={k => onSort(k as HomeSortKey)} className="hidden md:table-cell" />
                      <SortableHeader label="Next Release" sortKey="nextRelease"      state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Date"         sortKey="nextDate"         state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="Releases"     sortKey="releases"         state={clientSort} onSort={k => onSort(k as HomeSortKey)} />
                      <SortableHeader label="PRs"          sortKey="prs"              state={clientSort} onSort={k => onSort(k as HomeSortKey)} className="hidden lg:table-cell" />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(t => <FlatTicketRow key={t.key} ticket={t} onReleaseClick={toggleRelease} />)}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(0)}>First</Button>
                <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</Button>
                <Button variant="outline" size="sm" disabled={!data.hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Cut Scope tab ─────────────────────────────────────

function CutScopeTab() {
  const buildUrl = useCallback(({ offset, limit, sort, sortDir, search, module, person, statusGroup }: BuildUrlParams) => {
    const params = new URLSearchParams()
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    params.set('sort', sort)
    params.set('sortDir', sortDir)
    if (search) params.set('q', search)
    if (module) params.set('module', module)
    if (person) params.set('person', person)
    if (statusGroup && statusGroup !== 'all') params.set('statusGroup', statusGroup)
    return `/tickets/cut-scope?${params}`
  }, [])

  return (
    <ServerTicketTable
      title="Cut Scope"
      description="Tickets with a PR merged to main but no Fix Version. If you cut a release branch today, these would be included."
      buildUrl={buildUrl}
      emptyMessage="No tickets in cut scope."
    />
  )
}

// ── Triage tab ────────────────────────────────────────

function TriageTab() {
  const [days, setDays] = useState(7)

  const buildUrl = useCallback(({ offset, limit, sort, sortDir, search, module, person, statusGroup }: BuildUrlParams) => {
    const params = new URLSearchParams()
    if (statusGroup && statusGroup !== 'all') {
      params.set('statusGroup', statusGroup)
    } else {
      params.set('statusCategory', 'To Do')
    }
    if (days > 0) {
      const since = toLocalDateKey(new Date(Date.now() - days * 86400000))
      params.set('createdSince', since)
    }
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    params.set('sort', sort)
    params.set('sortDir', sortDir)
    if (search) params.set('q', search)
    if (module) params.set('module', module)
    if (person) params.set('person', person)
    return `/tickets/search?${params}`
  }, [days])

  const dayButtons = (
    <div className="flex rounded-md border text-xs">
      {[7, 14, 30, 60, 90, 0].map((d, i, arr) => (
        <button
          key={d}
          type="button"
          onClick={() => setDays(d)}
          className={cn(
            "px-3 py-2 transition-colors",
            i === 0 && "rounded-l-md",
            i === arr.length - 1 && "rounded-r-md",
            i > 0 && "border-l",
            days === d ? "bg-primary text-primary-foreground" : "hover:bg-accent"
          )}
        >
          {d === 0 ? 'All' : `${d}d`}
        </button>
      ))}
    </div>
  )

  return (
    <ServerTicketTable
      title="Triage"
      description="Tickets needing prioritization. Status: To Do."
      buildUrl={buildUrl}
      extraControls={dayButtons}
      emptyMessage={days > 0 ? `No new tickets in the last ${days} days.` : 'No tickets to triage.'}
    />
  )
}

// ── All Tickets tab ───────────────────────────────────

function AllTicketsTab() {
  const buildUrl = useCallback(({ offset, limit, sort, sortDir, search, module, person, statusGroup }: BuildUrlParams) => {
    const params = new URLSearchParams()
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    params.set('sort', sort)
    params.set('sortDir', sortDir)
    if (search) params.set('q', search)
    if (module) params.set('module', module)
    if (person) params.set('person', person)
    if (statusGroup && statusGroup !== 'all') params.set('statusGroup', statusGroup)
    return `/tickets/search?${params}`
  }, [])

  return (
    <ServerTicketTable
      title="All Tickets"
      description="Every ticket synced from JIRA."
      buildUrl={buildUrl}
    />
  )
}

// ── Shared flat ticket row (matches HomeTicketRow layout exactly) ──

function FlatTicketRow({ ticket: t, onReleaseClick }: { ticket: FlatTicket; onReleaseClick: (version: string) => void }) {
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
          <OutIcon name={t.assignee} className="ml-0" />
        </span>
      </td>
      <td className="px-3 py-2 align-top whitespace-nowrap hidden md:table-cell">
        <span className="text-xs text-muted-foreground inline-flex items-center gap-0.5">
          <span>{t.qaAssignee || '—'}</span>
          <OutIcon name={t.qaAssignee} className="ml-0" />
        </span>
      </td>
      <td className="px-3 py-2 align-top hidden md:table-cell">
        <TicketDeployedCell envs={t.deployedEnvironments || []} jiraStatus={t.jiraStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <NextReleaseVersionCell next={next} onClick={onReleaseClick} />
      </td>
      <td className="px-3 py-2 align-top">
        <NextReleaseDateCell next={next} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {(t.releases || []).map(r => (
            <ReleaseBadge
              key={`${r.repo}:${r.version}`}
              release={r}
              onClick={() => onReleaseClick(r.version)}
            />
          ))}
        </div>
      </td>
      <td className="px-3 py-2 align-top hidden lg:table-cell">
        {t.prs && t.prs.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {t.prs.map(pr => (
              <a
                key={`${pr.repo}-${pr.prNumber}`}
                href={pr.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors',
                  pr.status === 'merged' ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
                    : pr.status === 'open' ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/25'
                    : 'bg-muted/30 text-muted-foreground border-muted hover:bg-muted/50',
                )}
                title={`#${pr.prNumber} → ${pr.baseBranch} (${pr.status})`}
              >
                #{pr.prNumber}
              </a>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground italic">—</span>
        )}
      </td>
    </tr>
  )
}

// ── Subcomponents ──────────────────────────────────────

function RepoFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = [
    { key: '',            label: 'All repos' },
    { key: 'webplatform', label: 'Web' },
    { key: 'android',     label: 'Android' },
    { key: 'ios',         label: 'iOS' },
  ]
  return (
    <div className="flex rounded-md border text-xs">
      {options.map((opt, i, arr) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={cn(
            "px-3 py-2 transition-colors",
            i === 0 && "rounded-l-md",
            i === arr.length - 1 && "rounded-r-md",
            i > 0 && "border-l",
            value === opt.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function ReleaseChips({ columns, selected, onToggle }: {
  columns: ReleaseColumn[]
  selected: Set<string> | null
  onToggle: (version: string) => void
}) {
  if (columns.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
      {columns.map(c => {
        const isSelected = selected?.has(c.version) ?? false
        return (
          <button
            key={`${c.repo}:${c.version}`}
            type="button"
            onClick={() => onToggle(c.version)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-colors",
              isSelected
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/30 border-muted hover:bg-accent/50"
            )}
            title={`${c.repo} · ${c.version}${c.jiraReleaseDate ? ' · ' + c.jiraReleaseDate : ''}`}
          >
            <span className="font-mono">{c.version}</span>
            {c.jiraReleaseDate && (
              <span className="text-[10px] opacity-70">{c.jiraReleaseDate.slice(5)}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}


