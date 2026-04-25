import { useEffect, useMemo } from 'react'
import { useSupportStore, type SupportPreset, type SupportTicket, type SupportFilters } from '../../stores/supportStore'
import { useAuthStore } from '../../stores/authStore'
import { useWsStore } from '../../stores/wsStore'
import { MultiSelectPopover } from '../../components/MultiSelectPopover'
import { Paginator } from '../../components/Paginator'
import { JiraLinkHoverCard } from './JiraLinkHoverCard'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn } from '../../lib/utils'

// ── Small helpers ──────────────────────────────────────────

function fmtAge(days: number | null): { label: string; cls: string } {
  if (days == null) return { label: '—', cls: 'bg-muted text-muted-foreground' }
  if (days >= 60) return { label: `${days}d`, cls: 'bg-red-500/20 text-red-600 dark:text-red-400' }
  if (days >= 45) return { label: `${days}d`, cls: 'bg-orange-500/20 text-orange-600 dark:text-orange-400' }
  if (days >= 30) return { label: `${days}d`, cls: 'bg-amber-500/20 text-amber-600 dark:text-amber-400' }
  if (days >= 15) return { label: `${days}d`, cls: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400' }
  return { label: `${days}d`, cls: 'bg-blue-500/20 text-blue-600 dark:text-blue-400' }
}

function priorityCls(p: string | null): string {
  switch ((p || '').toLowerCase()) {
    case 'urgent': return 'bg-red-500/20 text-red-700 dark:text-red-400 border-red-500/40'
    case 'high':   return 'bg-orange-500/20 text-orange-700 dark:text-orange-400 border-orange-500/40'
    case 'medium': return 'bg-slate-500/20 text-slate-700 dark:text-slate-300 border-slate-500/40'
    case 'low':    return 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30'
    default:       return 'bg-muted text-muted-foreground border-muted-foreground/30'
  }
}

function statusCls(statusType: string | null): string {
  switch (statusType) {
    case 'Open':    return 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border-emerald-500/40'
    case 'Closed':  return 'bg-muted text-muted-foreground border-muted-foreground/30'
    case 'On Hold': return 'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/40'
    default:        return 'bg-sky-500/20 text-sky-700 dark:text-sky-400 border-sky-500/40'
  }
}

// Health badges (matches HoverCard palette so the inline column reads consistent)
const JIRA_HEALTH_COLOR: Record<string, string> = {
  attention:    'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
  'awaiting-cp':'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  'in-qa':      'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30',
  'in-dev':     'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30',
  done:         'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
}
const JIRA_HEALTH_LABEL: Record<string, string> = {
  attention: 'Attention',
  'awaiting-cp': 'Awaiting CP',
  'in-qa': 'In QA',
  'in-dev': 'In Dev',
  done: 'Done',
}

// Pick the most-relevant health for a linked JIRA: worst non-done over its truth rows;
// fall back to the first truth row, or null when no truth exists yet.
function pickHealth(linked: { truth?: { healthCategory: string | null }[] }): string | null {
  const truth = linked.truth || []
  if (truth.length === 0) return null
  const PRIORITY = ['attention', 'awaiting-cp', 'in-qa', 'in-dev', 'done']
  for (const cat of PRIORITY) {
    if (truth.some(t => t.healthCategory === cat)) return cat
  }
  return truth[0].healthCategory ?? null
}

function fmtSyncAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

// ── Preset definitions ────────────────────────────────────

const PRESET_LABELS: Record<SupportPreset, string> = {
  standup: 'Standup',
  allOpen: 'All Open',
  stale: 'Stale (>30d)',
  myTickets: 'My Tickets',
  custom: 'Custom',
}
const PRESET_ORDER: SupportPreset[] = ['standup', 'allOpen', 'stale', 'myTickets']

const STATUS_CHIPS = ['Investigating', 'Waiting for Viv Response', 'On Hold']
const PRIORITY_CHIPS = ['Urgent', 'High', 'Medium', 'Low']

// Age buckets — chip selector that maps to (minAgeDays, maxAgeDays).
// Mutually exclusive: clicking one replaces any prior bucket; click again to clear.
const AGE_BUCKETS: { label: string; min?: number; max?: number }[] = [
  { label: '0–15d',  min: 0,  max: 15 },
  { label: '16–30d', min: 16, max: 30 },
  { label: '31–45d', min: 31, max: 45 },
  { label: '46–60d', min: 46, max: 60 },
  { label: '60+d',   min: 60 },
]


// ── Page ────────────────────────────────────────────────────

export function SupportPage() {
  const tickets = useSupportStore(s => s.tickets)
  const totalTickets = useSupportStore(s => s.totalTickets)
  const stats = useSupportStore(s => s.stats)
  const syncStatus = useSupportStore(s => s.syncStatus)
  const preset = useSupportStore(s => s.preset)
  const filters = useSupportStore(s => s.filters)
  const accounts = useSupportStore(s => s.accounts)
  const departments = useSupportStore(s => s.departments)
  const releases = useWsStore(s => s.releases)
  const loading = useSupportStore(s => s.loading)
  const error = useSupportStore(s => s.error)
  const loadAll = useSupportStore(s => s.loadAll)
  const loadTickets = useSupportStore(s => s.loadTickets)
  const setPreset = useSupportStore(s => s.setPreset)
  const setFilters = useSupportStore(s => s.setFilters)
  const currentUserEmail = useAuthStore(s => s.user?.email || null)

  // "My Tickets" preset requires injecting the current user's email.
  // Other presets pass no override.
  function selectPreset(p: SupportPreset) {
    if (p === 'myTickets' && currentUserEmail) {
      setPreset(p, { assigneeEmail: currentUserEmail.toLowerCase() })
    } else {
      setPreset(p)
    }
  }

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const activeAssigneeFilter = filters.assigneeEmail || null

  // Tab/card list comes from the filter-aware /support/stats endpoint.
  // Each row already has the per-assignee count for the current filter set,
  // and the page only fetches *tickets* for the active assignee — so this
  // scales to any number of matching tickets.
  const filterAwareAssignees = useMemo(() => {
    return (stats?.assignees ?? [])
      .filter(a => a.assigneeEmail && a.total > 0)
      .map(a => ({
        assigneeEmail: a.assigneeEmail!,
        displayName: a.displayName || a.assigneeEmail!,
        count: a.total,
      }))
      .sort((a, b) => b.count - a.count)
  }, [stats])

  // "All" count = sum of filter-aware per-assignee totals (matchTotal from
  // the API). Falls back to the assignees array sum when an older deploy
  // omits the field.
  const allTabCount = stats?.matchTotal ?? filterAwareAssignees.reduce((s, a) => s + a.count, 0)

  // Release options for the filter — pull non-shipped versions from the WS
  // releases store, dedup by version, sort by most-recent first.
  const releaseOptions = useMemo(() => {
    const seen = new Set<string>()
    const items: { version: string; state: string }[] = []
    for (const r of releases) {
      if (r.state === 'done') continue
      if (!r.version || seen.has(r.version)) continue
      seen.add(r.version)
      items.push({ version: r.version, state: r.state })
    }
    return items.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
  }, [releases])

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Support Tickets</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Zoho Desk mirror · {syncStatus?.ticketCount ?? 0} total · {syncStatus?.openTicketCount ?? 0} open
            {' · '}
            synced {fmtSyncAgo(syncStatus?.lastRunAt || syncStatus?.lastBackfillAt || null)}
            {syncStatus?.backfillStatus && syncStatus.backfillStatus !== 'done' && (
              <span className="ml-2 text-amber-500">
                · backfill {syncStatus.backfillStatus}{syncStatus.backfillProgress > 0 ? ` (${syncStatus.backfillProgress})` : ''}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => loadTickets()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Preset selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">View:</span>
        {PRESET_ORDER.map(p => (
          <button
            key={p}
            onClick={() => selectPreset(p)}
            className={cn(
              'px-3 py-1 text-sm rounded-md border transition-colors',
              preset === p
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background hover:bg-muted border-muted-foreground/20'
            )}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
        {preset === 'custom' && (
          <Badge variant="outline">custom filters</Badge>
        )}
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Status:</span>
            {STATUS_CHIPS.map(s => (
              <ChipToggle
                key={s}
                label={s}
                active={filters.statuses?.includes(s) || false}
                onToggle={() => {
                  const cur = filters.statuses || []
                  const next = cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s]
                  setFilters({ statuses: next.length > 0 ? next : undefined })
                }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Priority:</span>
            {PRIORITY_CHIPS.map(p => (
              <ChipToggle
                key={p}
                label={p}
                active={filters.priorities?.includes(p) || false}
                onToggle={() => {
                  const cur = filters.priorities || []
                  const next = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p]
                  setFilters({ priorities: next.length > 0 ? next : undefined })
                }}
              />
            ))}
          </div>
          {departments.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Department:</span>
              {departments.map(d => (
                <ChipToggle
                  key={d.deptPrefix}
                  label={`${d.deptPrefix} (${d.count})`}
                  active={filters.deptPrefixes?.includes(d.deptPrefix) || false}
                  onToggle={() => {
                    const cur = filters.deptPrefixes || []
                    const next = cur.includes(d.deptPrefix)
                      ? cur.filter(x => x !== d.deptPrefix)
                      : [...cur, d.deptPrefix]
                    setFilters({ deptPrefixes: next.length > 0 ? next : undefined })
                  }}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Age:</span>
            {AGE_BUCKETS.map(b => {
              const active = filters.minAgeDays === b.min && filters.maxAgeDays === b.max
              return (
                <ChipToggle
                  key={b.label}
                  label={b.label}
                  active={active}
                  onToggle={() => {
                    if (active) {
                      setFilters({ minAgeDays: undefined, maxAgeDays: undefined })
                    } else {
                      setFilters({ minAgeDays: b.min, maxAgeDays: b.max })
                    }
                  }}
                />
              )
            })}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Account:</span>
            <MultiSelectPopover
              items={accounts.map(a => ({ id: a.id, label: a.name || a.id }))}
              selected={filters.accountIds || []}
              onChange={(ids) => setFilters({ accountIds: ids.length > 0 ? ids : undefined })}
              placeholder="All accounts"
              searchPlaceholder="Search accounts…"
              noun="accounts"
            />
          </div>
          {releaseOptions.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Release:</span>
              <MultiSelectPopover
                items={releaseOptions.map(r => ({ id: r.version, label: r.version }))}
                selected={filters.fixVersions || []}
                onChange={(ids) => setFilters({ fixVersions: ids.length > 0 ? ids : undefined })}
                placeholder="All releases"
                searchPlaceholder="Search releases…"
                noun="releases"
              />
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              type="text"
              placeholder="Search ticket # or subject…"
              value={filters.search || ''}
              onChange={(e) => setFilters({ search: e.target.value || undefined })}
              className="max-w-sm"
            />
            <ChipToggle
              label="Has linked JIRA"
              active={filters.hasJiraLinks || false}
              onToggle={() => setFilters({ hasJiraLinks: filters.hasJiraLinks ? undefined : true })}
            />
            {(filters.openOnly || filters.closedOnly) && (
              <Badge variant="outline">
                {filters.openOnly ? 'Open only' : 'Closed only'}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary strip */}
      {stats && (
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          <span><strong className="text-foreground">{stats.total.toLocaleString()}</strong> tickets</span>
          <span><strong className="text-foreground">{stats.open.toLocaleString()}</strong> open</span>
          <span>
            <strong className="text-foreground">{totalTickets.toLocaleString()}</strong> match filters
            {totalTickets > tickets.length && (
              <span className="ml-1 text-xs">· showing {tickets.length}</span>
            )}
          </span>
        </div>
      )}

      {/* Assignee tabs — counts derive from current tickets array so they
          stay in sync with active filters. Tab labels show "(count in view)". */}
      {filterAwareAssignees.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap border-b pb-2">
          <TabButton
            label={`All (${allTabCount})`}
            active={!activeAssigneeFilter}
            onClick={() => setFilters({ assigneeEmail: undefined })}
          />
          {filterAwareAssignees
            .slice(0, 12)
            .map(a => (
              <TabButton
                key={a.assigneeEmail}
                label={`${a.displayName} (${a.count})`}
                active={activeAssigneeFilter === a.assigneeEmail}
                onClick={() => setFilters({ assigneeEmail: a.assigneeEmail })}
              />
            ))}
        </div>
      )}

      {/* Errors */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="p-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Per-assignee grouped table */}
      <div className="space-y-4">
        {filterAwareAssignees.length === 0 && !loading && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No tickets match the current filters.
            </CardContent>
          </Card>
        )}

        {/* Only the active assignee's card is shown — the tabs above act as
            the navigation. No peer-card noise. */}
        {activeAssigneeFilter && (() => {
          const active = filterAwareAssignees.find(a => a.assigneeEmail === activeAssigneeFilter)
          if (!active) return null
          return (
            <AssigneeCard
              key={active.assigneeEmail}
              assigneeKey={active.assigneeEmail}
              displayName={active.displayName}
              tickets={tickets}
              ticketsTotal={totalTickets}
              page={filters.page || 1}
              pageSize={filters.pageSize || 25}
              filters={filters}
              setFilters={setFilters}
              onPageChange={(p) => setFilters({ page: p })}
            />
          )
        })()}
        {!activeAssigneeFilter && filterAwareAssignees.length > 0 && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground text-sm">
              Pick a person from the tabs above to see their tickets.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Pagination is rendered per-assignee Card; see AssigneeCard. */}
    </div>
  )
}

// Per-assignee table card. Drives backend pagination via `onPageChange`.
// /support only ever renders the *active* assignee's card — peer cards are
// gone in favor of the tab pills at the top of the page.
function AssigneeCard({
  assigneeKey,
  displayName,
  tickets,
  ticketsTotal,
  page,
  pageSize,
  filters,
  setFilters,
  onPageChange,
}: {
  assigneeKey: string
  displayName: string
  /** The actual ticket rows to render (paged from the backend). */
  tickets: SupportTicket[]
  /** Total matching for the active assignee (from /tickets envelope). */
  ticketsTotal: number
  page: number
  pageSize: number
  filters: SupportFilters
  setFilters: (updates: Partial<SupportFilters>) => void
  onPageChange: (p: number) => void
}) {
  const assigneeLabel = assigneeKey === '__unassigned__' ? 'Unassigned' : displayName
  const staleCount = tickets.filter(t => (t.ageDays ?? 0) >= 30).length

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 py-3 flex items-center justify-between border-b">
          <div>
            <span className="font-medium">{assigneeLabel}</span>
            <span className="ml-2 text-sm text-muted-foreground">{ticketsTotal.toLocaleString()} tickets</span>
          </div>
          {staleCount > 0 && (
            <Badge variant="outline" className="text-xs">{staleCount} stale (&gt;30d) on this page</Badge>
          )}
        </div>
        {ticketsTotal > pageSize && (
          <div className="px-4 py-2 border-b bg-muted/20">
            <Paginator
              page={page}
              pageSize={pageSize}
              total={ticketsTotal}
              onPageChange={onPageChange}
            />
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase text-muted-foreground">
              <SortableSupportTh sortKey="age" label="Age" className="w-20 px-4" filters={filters} setFilters={setFilters} />
              <SortableSupportTh sortKey="ticketNumber" label="Ticket" className="w-28" filters={filters} setFilters={setFilters} />
              <th className="text-left px-2 py-2 w-32">JIRA</th>
              <th className="text-left px-2 py-2 w-36">JIRA Status</th>
              <th className="text-left px-2 py-2 w-28">JIRA Health</th>
              <th className="text-left px-2 py-2 w-36">JIRA Releases</th>
              <th className="text-left px-2 py-2">Subject</th>
              <th className="text-left px-2 py-2 w-48">Account</th>
              <th className="text-left px-2 py-2 w-40">Category</th>
              <SortableSupportTh sortKey="status" label="Status" className="w-44" filters={filters} setFilters={setFilters} />
              <SortableSupportTh sortKey="priority" label="Priority" className="w-24" filters={filters} setFilters={setFilters} />
            </tr>
          </thead>
          <tbody>
            {tickets.map(t => {
                      const age = fmtAge(t.ageDays)
                      return (
                        <tr key={t.id} className="border-b last:border-b-0 hover:bg-muted/50">
                          <td className="px-4 py-2">
                            <span className={cn('inline-block px-2 py-0.5 rounded text-xs font-medium', age.cls)}>{age.label}</span>
                          </td>
                          <td className="px-2 py-2">
                            {t.webUrl ? (
                              <a
                                href={t.webUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-xs text-primary hover:underline"
                              >
                                {t.ticketNumber}
                              </a>
                            ) : (
                              <span className="font-mono text-xs">{t.ticketNumber}</span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            {(t.linkedJiras ?? []).length > 0 ? (
                              <div className="flex flex-col gap-0.5 text-xs">
                                {(t.linkedJiras ?? []).slice(0, 3).map(l => (
                                  <div key={l.jiraKey} className="leading-snug">
                                    <JiraLinkHoverCard link={l} />
                                  </div>
                                ))}
                                {(t.linkedJiraCount ?? 0) > 3 && (
                                  <span className="text-[10px] text-muted-foreground">+{(t.linkedJiraCount ?? 0) - 3} more</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            {(t.linkedJiras ?? []).length > 0 ? (
                              <div className="flex flex-col gap-0.5 text-xs">
                                {(t.linkedJiras ?? []).slice(0, 3).map(l => (
                                  <div key={l.jiraKey} className="leading-snug text-muted-foreground" title={l.statusCategory || undefined}>
                                    {l.status || '—'}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            {(t.linkedJiras ?? []).length > 0 ? (
                              <div className="flex flex-col gap-0.5 text-xs">
                                {(t.linkedJiras ?? []).slice(0, 3).map(l => {
                                  const hc = pickHealth(l)
                                  if (!hc) return <div key={l.jiraKey} className="text-muted-foreground">—</div>
                                  return (
                                    <span
                                      key={l.jiraKey}
                                      className={cn('inline-block px-1.5 rounded border text-[10px] w-fit', JIRA_HEALTH_COLOR[hc] || JIRA_HEALTH_COLOR['in-dev'])}
                                    >
                                      {JIRA_HEALTH_LABEL[hc] || hc}
                                    </span>
                                  )
                                })}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            {(t.linkedJiras ?? []).length > 0 ? (
                              <div className="flex flex-col gap-0.5 text-xs">
                                {(t.linkedJiras ?? []).slice(0, 3).map(l => (
                                  <div key={l.jiraKey} className="leading-snug text-muted-foreground truncate" title={l.fixVersions.join(', ')}>
                                    {l.fixVersions.length > 0 ? l.fixVersions.join(', ') : '—'}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {t.webUrl ? (
                              <a href={t.webUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                {t.subject || <span className="text-muted-foreground italic">(no subject)</span>}
                              </a>
                            ) : (
                              <span>{t.subject || <span className="text-muted-foreground italic">(no subject)</span>}</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground truncate max-w-[12rem]">
                            {t.accountName || '—'}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground truncate max-w-[10rem]">
                            {t.category || '—'}
                          </td>
                          <td className="px-2 py-2">
                            <span className={cn('inline-block px-2 py-0.5 rounded text-xs border', statusCls(t.statusType))}>
                              {t.status || '—'}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            {t.priority && (
                              <span className={cn('inline-block px-2 py-0.5 rounded text-xs border', priorityCls(t.priority))}>
                                {t.priority}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

// ── Small components ───────────────────────────────────────

// Click-to-sort table header that drives `filters.sort` / `filters.sortDir`.
// Three-state cycle: unset → desc → asc → unset.
function SortableSupportTh({
  sortKey,
  label,
  className,
  filters,
  setFilters,
}: {
  sortKey: string
  label: string
  className?: string
  filters: { sort?: string; sortDir?: 'asc' | 'desc' }
  setFilters: (f: { sort?: string; sortDir?: 'asc' | 'desc'; page?: number }) => void
}) {
  const active = filters.sort === sortKey
  const dir = active ? filters.sortDir : null
  const arrow = dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''

  function onClick() {
    if (!active) {
      setFilters({ sort: sortKey, sortDir: 'desc', page: 1 })
    } else if (dir === 'desc') {
      setFilters({ sort: sortKey, sortDir: 'asc', page: 1 })
    } else {
      setFilters({ sort: undefined, sortDir: undefined, page: 1 })
    }
  }

  return (
    <th className={cn('text-left px-2 py-2', className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 text-xs uppercase tracking-wide transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <span>{label}</span>
        <span className={cn('text-[8px] opacity-60', !arrow && 'invisible')}>{arrow || '▼'}</span>
      </button>
    </th>
  )
}

function ChipToggle({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'px-2.5 py-0.5 text-xs rounded-full border transition-colors',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-background hover:bg-muted border-muted-foreground/30'
      )}
    >
      {label}
    </button>
  )
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm rounded-md transition-colors',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}

