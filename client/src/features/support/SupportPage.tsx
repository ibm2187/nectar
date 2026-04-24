import { useEffect, useMemo } from 'react'
import { useSupportStore, type SupportPreset, type SupportTicket } from '../../stores/supportStore'
import { useAuthStore } from '../../stores/authStore'
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

// ── Page ────────────────────────────────────────────────────

export function SupportPage() {
  const tickets = useSupportStore(s => s.tickets)
  const stats = useSupportStore(s => s.stats)
  const syncStatus = useSupportStore(s => s.syncStatus)
  const preset = useSupportStore(s => s.preset)
  const filters = useSupportStore(s => s.filters)
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

  // Group tickets by assignee for the card layout
  const byAssignee = useMemo(() => {
    const map = new Map<string, SupportTicket[]>()
    for (const t of tickets) {
      const key = t.assigneeEmail || '__unassigned__'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(t)
    }
    // Sort: unassigned last; then by ticket count desc
    return [...map.entries()].sort((a, b) => {
      if (a[0] === '__unassigned__') return 1
      if (b[0] === '__unassigned__') return -1
      return b[1].length - a[1].length
    })
  }, [tickets])

  const activeAssigneeFilter = filters.assigneeEmail || null

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
          <span><strong className="text-foreground">{stats.total}</strong> tickets</span>
          <span><strong className="text-foreground">{stats.open}</strong> open</span>
          <span><strong className="text-foreground">{tickets.length}</strong> in current view</span>
        </div>
      )}

      {/* Assignee tabs */}
      {stats && stats.assignees.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap border-b pb-2">
          <TabButton
            label={`All (${stats.assignees.reduce((a, s) => a + s.openCount, 0)})`}
            active={!activeAssigneeFilter}
            onClick={() => setFilters({ assigneeEmail: undefined })}
          />
          {stats.assignees
            .filter(s => s.assigneeEmail && s.openCount > 0)
            .slice(0, 10)
            .map(a => (
              <TabButton
                key={a.assigneeEmail!}
                label={`${a.displayName || a.assigneeEmail} (${a.openCount})`}
                active={activeAssigneeFilter === a.assigneeEmail}
                onClick={() => setFilters({ assigneeEmail: a.assigneeEmail! })}
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
        {byAssignee.length === 0 && !loading && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No tickets match the current filters.
            </CardContent>
          </Card>
        )}

        {byAssignee.map(([key, group]) => {
          const first = group[0]
          const assigneeLabel = key === '__unassigned__'
            ? 'Unassigned'
            : first.assigneeName || first.assigneeEmail || key
          const todayCount = group.filter(t => (t.ageDays ?? 0) >= 30).length
          return (
            <Card key={key}>
              <CardContent className="p-0">
                <div className="px-4 py-3 flex items-center justify-between border-b">
                  <div>
                    <span className="font-medium">{assigneeLabel}</span>
                    <span className="ml-2 text-sm text-muted-foreground">{group.length} tickets</span>
                  </div>
                  {todayCount > 0 && (
                    <Badge variant="outline" className="text-xs">{todayCount} stale (&gt;30d)</Badge>
                  )}
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs uppercase text-muted-foreground">
                      <th className="text-left px-4 py-2 w-20">Age</th>
                      <th className="text-left px-2 py-2 w-28">Ticket</th>
                      <th className="text-left px-2 py-2 w-56">JIRA</th>
                      <th className="text-left px-2 py-2">Subject</th>
                      <th className="text-left px-2 py-2 w-48">Account</th>
                      <th className="text-left px-2 py-2 w-40">Category</th>
                      <th className="text-left px-2 py-2 w-44">Status</th>
                      <th className="text-left px-2 py-2 w-24">Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.map(t => {
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
                          <td className="px-2 py-2">
                            {(t.linkedJiras ?? []).length > 0 ? (
                              <div className="flex flex-col gap-0.5 text-xs">
                                {(t.linkedJiras ?? []).slice(0, 3).map(l => (
                                  <div key={l.jiraKey} className="flex items-center gap-1 flex-wrap">
                                    <JiraLinkHoverCard link={l} />
                                    {l.status && (
                                      <span className="text-[10px] text-muted-foreground" title={l.statusCategory || undefined}>
                                        {l.status}
                                      </span>
                                    )}
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
        })}
      </div>
    </div>
  )
}

// ── Small components ───────────────────────────────────────

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
