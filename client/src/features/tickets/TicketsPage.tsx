import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, type ZohoRef } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { JiraLink } from '../../components/JiraLink'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

// ── Types ──────────────────────────────────────────────

type ReleaseSource = 'both' | 'target' | 'fixVersion'

interface ReleaseMembership {
  repo: string
  version: string
  inTarget: boolean
  inFixVersion: boolean
  source: ReleaseSource
}

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
type SortDir = 'asc' | 'desc'

// ── Page ───────────────────────────────────────────────

export function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('q') || ''
  const repoFilter = searchParams.get('repo') || ''
  const gapFilter = (searchParams.get('gap') as GapFilter) || 'any'
  const releaseFilter = searchParams.get('release') || '' // comma-separated
  const sortKey = (searchParams.get('sort') as SortKey) || 'key'
  const sortDir = (searchParams.get('dir') as SortDir) || 'desc'

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

    rows = [...rows].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'key':      cmp = a.key.localeCompare(b.key, undefined, { numeric: true }); break
        case 'summary':  cmp = a.summary.localeCompare(b.summary); break
        case 'status':   cmp = a.jiraStatus.localeCompare(b.jiraStatus); break
        case 'assignee': cmp = (a.assignee || 'zzz').localeCompare(b.assignee || 'zzz'); break
        case 'qaAssignee': cmp = (a.qaAssignee || 'zzz').localeCompare(b.qaAssignee || 'zzz'); break
        case 'releases': cmp = a.releases.length - b.releases.length; break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return rows
  }, [data, repoFilter, selectedReleases, gapFilter, search, sortKey, sortDir])

  function setSort(key: SortKey) {
    if (sortKey === key) {
      updateParams({ sort: key, dir: sortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      updateParams({ sort: key, dir: 'asc' })
    }
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
                <thead>
                  <tr className="border-b text-left">
                    <SortHeader label="Key"       active={sortKey === 'key'}       dir={sortDir} onClick={() => setSort('key')} />
                    <SortHeader label="Summary"   active={sortKey === 'summary'}   dir={sortDir} onClick={() => setSort('summary')} />
                    <SortHeader label="Status"    active={sortKey === 'status'}    dir={sortDir} onClick={() => setSort('status')} />
                    <SortHeader label="Assignee"  active={sortKey === 'assignee'}  dir={sortDir} onClick={() => setSort('assignee')} />
                    <SortHeader label="QA"        active={sortKey === 'qaAssignee'} dir={sortDir} onClick={() => setSort('qaAssignee')} />
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deployed</th>
                    <SortHeader label="Releases"  active={sortKey === 'releases'}  dir={sortDir} onClick={() => setSort('releases')} />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => <TicketRow key={t.key} ticket={t} onReleaseClick={toggleRelease} />)}
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

function SortHeader({ label, active, dir, onClick }: {
  label: string; active: boolean; dir: SortDir; onClick: () => void
}) {
  return (
    <th
      onClick={onClick}
      className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground select-none"
    >
      {label}
      {active && <span className="ml-1">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}

function TicketRow({ ticket: t, onReleaseClick }: {
  ticket: Ticket
  onReleaseClick: (version: string) => void
}) {
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
      <td className="px-3 py-2 align-top">
        <span className="text-xs">
          {t.assignee || <span className="text-muted-foreground italic">—</span>}
        </span>
      </td>
      <td className="px-3 py-2 align-top">
        <span className="text-xs text-muted-foreground">{t.qaAssignee || '—'}</span>
      </td>
      <td className="px-3 py-2 align-top">
        <TicketDeployedCell envs={t.deployedEnvironments} jiraStatus={t.jiraStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {t.releases.map(r => (
            <ReleaseBadge key={`${r.repo}:${r.version}`} release={r} onClick={() => onReleaseClick(r.version)} />
          ))}
        </div>
      </td>
    </tr>
  )
}

function TicketDeployedCell({ envs, jiraStatus }: { envs: string[]; jiraStatus: string }) {
  const needsTesting = ['ready for testing', 'testing in branch', 'in qa'].includes(jiraStatus.toLowerCase())

  if (envs.length === 0) {
    if (needsTesting) {
      return (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-400 border border-red-500/30"
          title="Needs testing but not deployed anywhere"
        >
          Not deployed
        </span>
      )
    }
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const hasProd = envs.some(e => /prod/i.test(e) && !/staging/i.test(e))
  const hasStaging = envs.some(e => /staging|uat/i.test(e))
  const hasQa = envs.some(e => /qa|dev|integration|sandbox/i.test(e))

  const label = hasProd ? 'Prod' : hasStaging ? 'Staging' : hasQa ? 'QA' : 'Deployed'
  const style = hasProd
    ? 'bg-green-500/15 text-green-400 border-green-500/30'
    : hasStaging
    ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
    : hasQa
    ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
    : 'bg-muted/30 text-muted-foreground border-muted'

  return (
    <span
      className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", style)}
      title={`${envs.length} env${envs.length !== 1 ? 's' : ''}: ${envs.join(', ')}`}
    >
      {label}
    </span>
  )
}

function ReleaseBadge({ release, onClick }: {
  release: ReleaseMembership
  onClick: () => void
}) {
  const styles: Record<ReleaseSource, string> = {
    both:       'bg-green-500/15 text-green-400 border-green-500/40 hover:bg-green-500/25',
    target:     'bg-yellow-500/10 text-yellow-400 border-yellow-500/40 border-dashed hover:bg-yellow-500/20',
    fixVersion: 'bg-orange-500/15 text-orange-400 border-orange-500/40 hover:bg-orange-500/25',
  }
  const prefix: Record<ReleaseSource, string> = {
    both: '',
    target: '📋 ',
    fixVersion: '⚡ ',
  }
  const titles: Record<ReleaseSource, string> = {
    both: 'Planned AND on branch — delivered as planned',
    target: 'In Target FixVersion only — planned but no cherry-pick yet',
    fixVersion: 'In canonical fixVersions only — unplanned addition',
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer",
        styles[release.source]
      )}
      title={`${release.repo} · ${release.version} — ${titles[release.source]}`}
    >
      {prefix[release.source]}{release.version}
    </button>
  )
}
