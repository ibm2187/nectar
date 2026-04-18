import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, type ZohoRef } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { cn, exportToCsv } from '../../lib/utils'
import { SavedViews } from '../../components/SavedViews'
import { TicketRow, type ReleaseMembership } from '../../components/TicketRow'
import { SortableHeader, useSortableData, nextSortState, type SortState, type SortDir as SortableSortDir } from '../../components/SortableHeader'
import { JiraLink } from '../../components/JiraLink'
import { getStatusBadgeColor } from '../../lib/status-colors'

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

// ── Flat ticket from jira_tickets table ────────────────

interface FlatTicket {
  key: string
  summary: string
  status: string | null
  statusCategory: string | null
  type: string | null
  assignee: string | null
  qaAssignee: string | null
  priority: string | null
  component: string | null
  created: string | null
  fixVersions: string[]
  targetFixVersions: string[]
}

interface FlatTicketsResponse {
  tickets: FlatTicket[]
  total: number
  hasMore: boolean
  since?: string
}

interface SyncStatus {
  sync: { lastTicketSyncTime: string | null; totalTicketsSynced: number; lastSyncDurationMs: number | null; lastSyncError: string | null }
  stats: { total: number; byStatusCategory: Record<string, number>; byType: Record<string, number> }
}

// ── Filter types ───────────────────────────────────────

type GapFilter = 'any' | 'missing' | 'unplanned' | 'matched'
type SortKey = 'key' | 'summary' | 'status' | 'assignee' | 'qaAssignee' | 'releases'
type TicketsTab = 'releases' | 'qa-scope' | 'triage'

const TAB_CONFIG: Record<TicketsTab, { label: string }> = {
  releases:   { label: 'Releases' },
  'qa-scope': { label: 'QA Scope' },
  triage:     { label: 'Triage' },
}
const TAB_ORDER: TicketsTab[] = ['releases', 'qa-scope', 'triage']

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
      {tab === 'qa-scope' && <QAScopeTab />}
      {tab === 'triage' && <TriageTab />}
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
      {/* Header + stats */}
      <div>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <h2 className="text-2xl font-bold">Tickets</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Roadmap view across {data.releases.length} active releases.
              Planning signal from JIRA's Target FixVersion (<span className="font-mono text-xs">customfield_10594</span>)
              combined with canonical fixVersions.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>

        {/* Stats pills — also serve as gap-filter toggles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatPill
            label="Total"
            sublabel="unique tickets"
            count={data.stats.total}
            color="border-l-muted-foreground/30 text-foreground"
            active={gapFilter === 'any'}
            onClick={() => updateParams({ gap: null })}
          />
          <StatPill
            label="Delivered as Planned"
            sublabel="target === actual"
            count={data.stats.deliveredAsPlanned}
            color="border-l-green-500 text-green-400"
            active={gapFilter === 'matched'}
            onClick={() => updateParams({ gap: gapFilter === 'matched' ? null : 'matched' })}
          />
          <StatPill
            label="Missing Plans"
            sublabel="in target, not cherry-picked"
            count={data.stats.anyMissing}
            color="border-l-yellow-500 text-yellow-400"
            active={gapFilter === 'missing'}
            onClick={() => updateParams({ gap: gapFilter === 'missing' ? null : 'missing' })}
          />
          <StatPill
            label="Unplanned Adds"
            sublabel="shipped without target"
            count={data.stats.anyUnplanned}
            color="border-l-orange-500 text-orange-400"
            active={gapFilter === 'unplanned'}
            onClick={() => updateParams({ gap: gapFilter === 'unplanned' ? null : 'unplanned' })}
          />
        </div>
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

// ── QA Scope tab ──────────────────────────────────────

function QAScopeTab() {
  const [data, setData] = useState<FlatTicketsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  async function load() {
    setLoading(true)
    try {
      const result = await apiFetch<FlatTicketsResponse>('/tickets/scope?limit=500')
      setData(result)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    if (!data) return []
    if (!search.trim()) return data.tickets
    const q = search.toLowerCase()
    return data.tickets.filter(t =>
      t.key.toLowerCase().includes(q) ||
      t.summary.toLowerCase().includes(q) ||
      (t.assignee || '').toLowerCase().includes(q)
    )
  }, [data, search])

  if (loading) return <NectarLoader size="lg" message="Loading QA scope..." className="mt-32" />
  if (!data) return null

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">QA Scope</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Tickets completed but not assigned to any release. If you cut from master today, these would be included.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="Search key, summary, assignee..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground ml-auto">
          {filtered.length} of {data.total} tickets
        </span>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            No tickets in QA scope.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-left">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-28">Key</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Summary</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-40">Status</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-24">Type</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-32">Assignee</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-28 hidden md:table-cell">QA</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-24 hidden md:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => <FlatTicketRow key={t.key} ticket={t} />)}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Triage tab ────────────────────────────────────────

function TriageTab() {
  const [data, setData] = useState<FlatTicketsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [days, setDays] = useState(7)

  async function load(d: number) {
    setLoading(true)
    try {
      const since = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10)
      const result = await apiFetch<FlatTicketsResponse>(`/tickets/triage?since=${since}&limit=500`)
      setData(result)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load(days) }, [days])

  const filtered = useMemo(() => {
    if (!data) return []
    if (!search.trim()) return data.tickets
    const q = search.toLowerCase()
    return data.tickets.filter(t =>
      t.key.toLowerCase().includes(q) ||
      t.summary.toLowerCase().includes(q) ||
      (t.assignee || '').toLowerCase().includes(q)
    )
  }, [data, search])

  if (loading) return <NectarLoader size="lg" message="Loading triage..." className="mt-32" />
  if (!data) return null

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Triage</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Recently created tickets that need prioritization. Status: To Do.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search key, summary, assignee..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex rounded-md border text-xs">
          {[1, 3, 7, 14, 30].map((d, i, arr) => (
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
              {d}d
            </button>
          ))}
        </div>
        <span className="text-sm text-muted-foreground ml-auto">
          {filtered.length} of {data.total} tickets
        </span>
        <Button variant="outline" size="sm" onClick={() => load(days)}>Refresh</Button>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            No new tickets in the last {days} day{days > 1 ? 's' : ''}.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-left">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-28">Key</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Summary</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-40">Status</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-24">Type</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-24">Priority</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-32">Assignee</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-24 hidden md:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => <FlatTicketRow key={t.key} ticket={t} showPriority />)}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Shared flat ticket row ────────────────────────────

function FlatTicketRow({ ticket: t, showPriority }: { ticket: FlatTicket; showPriority?: boolean }) {
  const badgeColor = t.status ? getStatusBadgeColor(t.status) : ''
  const created = t.created ? new Date(t.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

  return (
    <tr className="border-b hover:bg-accent/30 transition-colors">
      <td className="px-3 py-2">
        <JiraLink jiraKey={t.key} className="text-xs" />
      </td>
      <td className="px-3 py-2">
        <span className="line-clamp-1">{t.summary}</span>
      </td>
      <td className="px-3 py-2">
        {badgeColor ? (
          <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", badgeColor)}>
            {t.status}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t.status || '—'}</span>
        )}
      </td>
      {showPriority ? (
        <td className="px-3 py-2 text-xs text-muted-foreground">{t.priority || '—'}</td>
      ) : (
        <td className="px-3 py-2 text-xs text-muted-foreground">{t.type || '—'}</td>
      )}
      <td className="px-3 py-2 text-xs">{t.assignee || '—'}</td>
      <td className="px-3 py-2 text-xs hidden md:table-cell">{t.qaAssignee || '—'}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground hidden md:table-cell">{created}</td>
    </tr>
  )
}

// ── Subcomponents ──────────────────────────────────────

function StatPill({ label, sublabel, count, color, active, onClick }: {
  label: string
  sublabel: string
  count: number
  color: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border border-l-4 p-3 text-left transition-all",
        color,
        active ? "bg-accent/50 ring-2 ring-primary" : "hover:bg-accent/30"
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold">{count}</span>
      </div>
      <div className="text-xs uppercase tracking-wider font-semibold">{label}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sublabel}</div>
    </button>
  )
}

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


