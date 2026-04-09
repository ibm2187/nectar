import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { JiraLink } from '../../components/JiraLink'
import { apiFetch } from '../../api/client'
import type { ReleaseTruthReport, DeploymentImpactReport, VerifiedTicket, Health, HealthCategory } from '../../api/client'
import { cn, timeAgo } from '../../lib/utils'
import { useWsStore } from '../../stores/wsStore'
import { NectarLoader, NectarSpinner } from '../../components/NectarLoader'
import { CompareSelector } from './CompareSelector'
import type { CompareTarget } from './CompareSelector'

interface Props {
  repo: string
  version: string
}

// Health styling — color, emoji, label, sort priority (worst first)
const HEALTH_INFO: Record<Health, { label: string; color: string; emoji: string; priority: number }> = {
  'failed-qa':     { label: 'Failed QA',     color: 'bg-red-500/20 text-red-400 border-red-500/40',         emoji: '🔴', priority: 1 },
  'not-on-branch': { label: 'Not on Branch', color: 'bg-red-500/20 text-red-400 border-red-500/40',         emoji: '🔴', priority: 2 },
  'blocked':       { label: 'Blocked',       color: 'bg-red-500/20 text-red-400 border-red-500/40',         emoji: '🚫', priority: 3 },
  'unknown':       { label: 'Unknown',       color: 'bg-gray-500/20 text-gray-400 border-gray-500/40',      emoji: '?',  priority: 4 },
  'needs-review':  { label: 'Needs Review',  color: 'bg-orange-500/20 text-orange-400 border-orange-500/40', emoji: '🔎', priority: 5 },
  'pre-dev':       { label: 'Pre-Dev',       color: 'bg-orange-500/20 text-orange-400 border-orange-500/40', emoji: '○',  priority: 6 },
  'in-dev':        { label: 'In Dev',        color: 'bg-orange-500/20 text-orange-400 border-orange-500/40', emoji: '🛠', priority: 7 },
  'awaiting-cp':   { label: 'Awaiting CP',   color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40', emoji: '⏳', priority: 8 },
  'pr-pending':    { label: 'PR Pending',    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40', emoji: '⏳', priority: 9 },
  'status-stale':  { label: 'JIRA Stale',    color: 'bg-blue-500/20 text-blue-400 border-blue-500/40',       emoji: 'ℹ', priority: 10 },
  'in-qa':         { label: 'In QA',         color: 'bg-blue-500/20 text-blue-400 border-blue-500/40',       emoji: '🔬', priority: 11 },
  'healthy':       { label: 'Healthy',       color: 'bg-green-500/20 text-green-400 border-green-500/40',    emoji: '✓',  priority: 12 },
  'no-code':       { label: 'No Code',       color: 'bg-gray-500/20 text-gray-300 border-gray-500/40',       emoji: '⊘',  priority: 13 },
  // Deprecated — kept for backward compat
  'lying':         { label: 'Not on Branch', color: 'bg-red-500/20 text-red-400 border-red-500/40',         emoji: '🔴', priority: 2 },
  'stale-cert':    { label: 'Not on Branch', color: 'bg-red-500/20 text-red-400 border-red-500/40',         emoji: '🔴', priority: 2 },
}

const PILL_FILTERS: { key: 'all' | HealthCategory; label: string; color: string }[] = [
  { key: 'all',          label: 'Planned',     color: 'bg-muted' },
  { key: 'done',         label: 'Done',        color: 'bg-green-500/15 text-green-400' },
  { key: 'in-qa',        label: 'In QA',       color: 'bg-blue-500/15 text-blue-400' },
  { key: 'awaiting-cp',  label: 'Awaiting CP', color: 'bg-yellow-500/15 text-yellow-400' },
  { key: 'in-dev',       label: 'In Dev',      color: 'bg-orange-500/15 text-orange-400' },
  { key: 'attention',    label: 'Attention',   color: 'bg-red-500/15 text-red-400' },
]

type SortKey = 'health' | 'key' | 'jiraStatus' | 'assignee'
type SortDir = 'asc' | 'desc'

type ViewMode = 'impact' | 'full'
type FilterKey = 'all' | HealthCategory
type CompareType = CompareTarget['type']

export function TruthView({ repo, version }: Props) {
  // ── URL-driven state (everything here is shareable) ─────────
  const [searchParams, setSearchParams] = useSearchParams()

  const cmpVersion = searchParams.get('cmp') || ''
  const cmpType = (searchParams.get('cmpType') as CompareType | null) || null
  const mode: ViewMode = (searchParams.get('view') as ViewMode | null)
    || (cmpVersion ? 'impact' : 'full')
  const filter: FilterKey = (searchParams.get('filter') as FilterKey | null) || 'all'
  const search = searchParams.get('q') || ''
  const sortKey: SortKey = (searchParams.get('sort') as SortKey | null) || 'health'
  const sortDir: SortDir = (searchParams.get('dir') as SortDir | null) || 'asc'

  // Helper — patches the URL, dropping keys that go back to defaults
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

  const setMode = (m: ViewMode) => {
    // Dropping cmp* when switching to full avoids confusing leftover params
    if (m === 'full') updateParams({ view: 'full' })
    else updateParams({ view: 'impact' })
  }
  const setFilter = (f: FilterKey) => updateParams({ filter: f === 'all' ? null : f })
  const setSearch = (q: string) => updateParams({ q: q || null })
  const setSort = (key: SortKey) => {
    if (sortKey === key) {
      updateParams({ sort: key, dir: sortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      updateParams({ sort: key, dir: 'asc' })
    }
  }

  // ── Derive display label for the compare target from store data ───
  const releases = useWsStore(s => s.releases)
  const environments = useWsStore(s => s.environments)
  const customers = useWsStore(s => s.customers)

  const compareTarget: CompareTarget | null = useMemo(() => {
    if (!cmpVersion) return null
    const type = cmpType || 'branch'
    // Derive a nice label from the store if we can find a match
    let label = cmpVersion
    if (type === 'customer') {
      const env = environments.find(e => e.tier === 'production' && e.currentVersion === cmpVersion)
      if (env) {
        const cust = customers.find(c => c.id === env.customerId)
        label = `${cust?.name || env.customerId} (${cmpVersion})`
      }
    } else if (type === 'branch') {
      const rel = releases.find(r => r.version === cmpVersion)
      label = rel?.branch ? `${cmpVersion} (${rel.branch})` : cmpVersion
    } else if (type === 'environment') {
      const env = environments.find(e => e.currentVersion === cmpVersion)
      if (env) label = `${env.id} (${cmpVersion})`
    }
    return { type, version: cmpVersion, label }
  }, [cmpVersion, cmpType, releases, environments, customers])

  const prodVersion = cmpVersion
  const [selectorOpen, setSelectorOpen] = useState(false)

  const [truth, setTruth] = useState<ReleaseTruthReport | null>(null)
  const [impact, setImpact] = useState<DeploymentImpactReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadTruth() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<ReleaseTruthReport>(
        `/releases/${encodeURIComponent(repo)}/${encodeURIComponent(version)}/truth`
      )
      setTruth(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load truth')
    }
    setLoading(false)
  }

  async function loadImpact() {
    if (!prodVersion) return
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<DeploymentImpactReport>(
        `/releases/${encodeURIComponent(repo)}/${encodeURIComponent(version)}/impact?prodVersion=${encodeURIComponent(prodVersion)}`
      )
      setImpact(data)
      // Also store the full truth from the impact response so Full View doesn't need a separate fetch
      setTruth(data.targetTruth)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load impact')
    }
    setLoading(false)
  }

  function load() {
    if (mode === 'impact' && prodVersion) loadImpact()
    else loadTruth()
  }

  useEffect(() => { load() }, [repo, version, mode, prodVersion])

  // Active data depends on mode
  const activeTickets: VerifiedTicket[] = mode === 'impact' && impact
    ? impact.delta.tickets.new
    : truth?.verified || []
  const activeRollup = mode === 'impact' && impact
    ? impact.delta.rollup
    : truth?.rollup || { planned: 0, done: 0, inQa: 0, awaitingCp: 0, inDev: 0, attention: 0 }
  const activeRogues = mode === 'impact' && impact
    ? impact.delta.rogues
    : truth?.rogues || []

  const filtered = useMemo(() => {
    if (activeTickets.length === 0 && !truth && !impact) return []
    let rows = activeTickets

    if (filter !== 'all') {
      rows = rows.filter(t => t.healthCategory === filter)
    }

    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter(t =>
        t.key.toLowerCase().includes(q) ||
        (t.summary || '').toLowerCase().includes(q) ||
        (t.assignee || '').toLowerCase().includes(q)
      )
    }

    rows = [...rows].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'health':
          cmp = HEALTH_INFO[a.health].priority - HEALTH_INFO[b.health].priority
          break
        case 'key':
          cmp = a.key.localeCompare(b.key)
          break
        case 'jiraStatus':
          cmp = a.jiraStatus.localeCompare(b.jiraStatus)
          break
        case 'assignee':
          cmp = (a.assignee || 'zzz').localeCompare(b.assignee || 'zzz')
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return rows
  }, [activeTickets, filter, search, sortKey, sortDir])

  if (loading && !truth && !impact) {
    return (
      <Card>
        <CardContent className="p-6">
          <NectarLoader message="Computing truth from JIRA + Git + GitHub..." />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={loadTruth} className="mt-2">Retry</Button>
        </CardContent>
      </Card>
    )
  }

  if (!truth && !impact) return null

  function pillCount(key: typeof PILL_FILTERS[number]['key']): number {
    if (key === 'all') return activeRollup.planned
    const r = activeRollup
    switch (key) {
      case 'done': return r.done
      case 'in-qa': return r.inQa
      case 'awaiting-cp': return r.awaitingCp
      case 'in-dev': return r.inDev
      case 'attention': return r.attention
    }
    return 0
  }

  return (
    <div className="space-y-4">
      {/* Header / rollup */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">Release Truth</CardTitle>
              {/* Mode toggle */}
              <div className="flex rounded-md border text-xs">
                  <button
                    type="button"
                    onClick={() => setMode('impact')}
                    className={cn("px-3 py-1 rounded-l-md transition-colors", mode === 'impact' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                  >
                    Impact
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('full')}
                    className={cn("px-3 py-1 rounded-r-md border-l transition-colors", mode === 'full' ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                  >
                    Full View
                  </button>
                </div>
            </div>
            <div className="flex items-center gap-2">
              {mode === 'impact' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectorOpen(true)}
                  className="text-xs"
                >
                  {compareTarget
                    ? <>vs <span className="font-mono font-medium ml-1">{compareTarget.label}</span></>
                    : 'Select comparison...'
                  }
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                {loading ? <><NectarSpinner className="mr-1" /> Computing...</> : 'Refresh'}
              </Button>
            </div>
          </div>
          {/* Impact mode banner */}
          {mode === 'impact' && impact && (
            <div className="text-xs text-muted-foreground mt-2">
              Showing <span className="text-foreground font-medium">{impact.delta.tickets.total} new tickets</span> and{' '}
              <span className="text-foreground font-medium">{impact.delta.commits.total} commits</span> between{' '}
              <span className="font-mono">{impact.prod.version}</span> and <span className="font-mono">{impact.target.version}</span>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {/* Pill filters */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
            {PILL_FILTERS.map(p => {
              const count = pillCount(p.key)
              const active = filter === p.key
              const disabled = count === 0 && p.key !== 'all'
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => !disabled && setFilter(p.key)}
                  disabled={disabled}
                  className={cn(
                    "rounded-lg border p-3 text-center transition-all",
                    p.color,
                    active && "ring-2 ring-primary",
                    disabled ? "opacity-40 cursor-default" : "cursor-pointer hover:scale-[1.02] hover:brightness-125"
                  )}
                >
                  <div className="text-2xl font-bold">{count}</div>
                  <div className="text-xs uppercase tracking-wider opacity-80">{p.label}</div>
                </button>
              )
            })}
          </div>

          {/* Meta info */}
          {truth && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs pt-2 border-t">
              <div>
                <div className="text-muted-foreground">JIRA</div>
                <div className="font-medium">
                  {truth.jira.released ? 'Released' : 'Unreleased'}
                  {truth.jira.releaseDate && <span className="text-muted-foreground ml-1">({truth.jira.releaseDate})</span>}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Branch</div>
                <div className="font-mono text-xs truncate" title={truth.branch || ''}>
                  {truth.git.branchExists ? truth.branch : '—'}
                </div>
                {truth.git.branchExists && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {truth.git.cherryPickCount} cherry-picks
                  </div>
                )}
              </div>
              <div>
                <div className="text-muted-foreground">Open PRs</div>
                <div>{truth.pullRequests.open} targeting branch</div>
              </div>
              <div>
                <div className="text-muted-foreground">Derived State</div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className={`state-${truth.derivedState}`}>{truth.derivedState}</Badge>
                  {!truth.stateMatchesReality && (
                    <span className="text-yellow-400" title={`Currently: ${truth.currentState}`}>⚠</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Filter / search row */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by key, title, assignee..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground">
          {filtered.length} of {activeTickets.length}
        </span>
        {(filter !== 'all' || search) && (
          <Button variant="ghost" size="sm" onClick={() => updateParams({ filter: null, q: null })}>
            Clear filters
          </Button>
        )}
        {(cmpVersion || mode !== 'full' || sortKey !== 'health' || sortDir !== 'asc') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigator.clipboard.writeText(window.location.href).catch(() => {})}
            title="Copy a shareable URL with the current view"
          >
            Copy link
          </Button>
        )}
      </div>

      {/* Tickets table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-28" />
                <col />{/* title takes remaining */}
                <col className="w-40" />
                <col className="w-32" />
                <col className="w-20" />
                <col className="w-64" />
              </colgroup>
              <thead>
                <tr className="border-b text-left">
                  <SortHeader label="Key"        active={sortKey === 'key'}        dir={sortDir} onClick={() => setSort('key')} />
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</th>
                  <SortHeader label="JIRA Status" active={sortKey === 'jiraStatus'} dir={sortDir} onClick={() => setSort('jiraStatus')} />
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cherry-Pick</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center">Branch</th>
                  <SortHeader label="Health"     active={sortKey === 'health'}     dir={sortDir} onClick={() => setSort('health')} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground italic">
                      No tickets match the current filter
                    </td>
                  </tr>
                ) : (
                  filtered.map(t => <TicketRow key={t.key} ticket={t} />)
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Rogue commits */}
      {activeRogues.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border bg-purple-500/15 text-purple-400 border-purple-500/30">
                ⚡ Rogue Commits
              </span>
              <span className="text-muted-foreground font-normal text-sm">{activeRogues.length}</span>
              <span className="text-xs text-muted-foreground font-normal ml-2">(JIRA keys in commits but not in fixVersion)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-64 overflow-auto">
              {activeRogues.map(r => (
                <div key={r.key} className="flex items-center gap-2 text-sm py-1">
                  <JiraLink jiraKey={r.key} className="text-purple-400 hover:text-purple-300" />
                  {r.commitSha && <span className="font-mono text-xs text-muted-foreground">{r.commitSha.substring(0, 7)}</span>}
                  <span className="text-muted-foreground truncate flex-1">{r.commitMessage}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground text-right">
        {impact && mode === 'impact'
          ? `Computed in ${impact.durationMs}ms · ${timeAgo(impact.computedAt)}`
          : truth ? `Computed in ${truth.durationMs}ms · ${timeAgo(truth.computedAt)}` : ''
        }
      </div>

      <CompareSelector
        open={selectorOpen}
        onOpenChange={setSelectorOpen}
        releaseVersion={version}
        onSelect={(target) => {
          updateParams({
            view: 'impact',
            cmp: target.version,
            cmpType: target.type,
          })
        }}
      />
    </div>
  )
}

function SortHeader({
  label, active, dir, onClick,
}: {
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

function TicketRow({ ticket: t }: { ticket: VerifiedTicket }) {
  const info = HEALTH_INFO[t.health]
  return (
    <tr className="border-b border-border/30 hover:bg-accent/30 transition-colors">
      {/* Key */}
      <td className="px-3 py-2 align-top">
        <JiraLink jiraKey={t.key} />
      </td>

      {/* Title */}
      <td className="px-3 py-2 align-top">
        <div className="text-foreground line-clamp-2" title={t.summary}>{t.summary}</div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">
          {t.type && <span>{t.type}</span>}
          {t.assignee && <span>{t.type ? ' · ' : ''}{t.assignee}</span>}
        </div>
      </td>

      {/* JIRA Status */}
      <td className="px-3 py-2 align-top">
        <span className="text-xs">{t.jiraStatus}</span>
      </td>

      {/* Cherry-pick PR */}
      <td className="px-3 py-2 align-top">
        {t.pr ? (
          <a
            href={t.pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline text-xs"
          >
            #{t.pr.prNumber} (open)
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>

      {/* On Branch */}
      <td className="px-3 py-2 align-top text-center">
        {!t.branchHasCommits ? (
          <span className="text-muted-foreground text-xs italic" title="Branch not cut yet">n/a</span>
        ) : t.onBranch ? (
          <span className="text-green-400 text-base">✓</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      {/* Health */}
      <td className="px-3 py-2 align-top">
        <div
          className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border", info.color)}
          title={t.healthMessage}
        >
          {info.emoji} {info.label}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate" title={t.healthMessage}>
          {t.healthMessage}
        </div>
      </td>
    </tr>
  )
}
