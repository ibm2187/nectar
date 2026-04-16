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

// ── Filter types ───────────────────────────────────────

type GapFilter = 'any' | 'missing' | 'unplanned' | 'matched'
type SortKey = 'key' | 'summary' | 'status' | 'assignee' | 'qaAssignee' | 'releases'

// ── Page ───────────────────────────────────────────────

export function TicketsPage() {
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


