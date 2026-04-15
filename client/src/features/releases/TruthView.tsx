import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { JiraLink } from '../../components/JiraLink'
import { apiFetch } from '../../api/client'
import type { ReleaseTruthReport, DeploymentImpactReport, VerifiedTicket, Health, HealthCategory, ZohoRef } from '../../api/client'
import { cn, timeAgo, exportToCsv } from '../../lib/utils'
import { useWsStore } from '../../stores/wsStore'
import { NectarLoader, NectarSpinner } from '../../components/NectarLoader'
import { CompareSelector } from './CompareSelector'
import type { CompareTarget } from './CompareSelector'
import { SavedViews } from '../../components/SavedViews'
import { PrDetailPanel, isCodeStatus, type PrInfo } from '../../components/PrDetailPanel'
import { getStatusBadgeColor, displayAssignee } from '../../lib/status-colors'

interface Props {
  repo: string
  version: string
  prsByJiraKey?: Record<string, PrInfo[]>
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

type SortKey = 'health' | 'key' | 'jiraStatus' | 'assignee' | 'qaAssignee'
type SortDir = 'asc' | 'desc'

type ViewMode = 'impact' | 'full'
type FilterKey = 'all' | HealthCategory
type CompareType = CompareTarget['type']

export function TruthView({ repo, version, prsByJiraKey = {} }: Props) {
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
  const [prPanel, setPrPanel] = useState<{ jiraKey: string; summary: string; prs: PrInfo[] } | null>(null)

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
        (t.assignee || '').toLowerCase().includes(q) ||
        (t.qaAssignee || '').toLowerCase().includes(q)
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
        case 'qaAssignee':
          cmp = (a.qaAssignee || 'zzz').localeCompare(b.qaAssignee || 'zzz')
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
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={() => {
              exportToCsv(
                `truth-${version}.csv`,
                ['Key', 'Summary', 'JIRA Status', 'Assignee', 'QA', 'Health', 'Health Message', 'On Branch'],
                filtered.map(t => [
                  t.key,
                  t.summary || '',
                  t.jiraStatus,
                  t.assignee || '',
                  t.qaAssignee || '',
                  HEALTH_INFO[t.health]?.label || t.health,
                  t.healthMessage || '',
                  t.onBranch ? 'Yes' : 'No',
                ])
              )
            }}
          >
            Export CSV
          </Button>
          <SavedViews storageKey="nectar-saved-views-truth" />
        </div>
      </div>

      {/* Tickets table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-28" />
                <col />{/* title takes remaining */}
                <col className="w-36" />
                <col className="w-16" />
                <col className="w-10" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-16" />
                <col className="w-24" />
                <col className="w-48" />
              </colgroup>
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b text-left">
                  <SortHeader label="Key"        active={sortKey === 'key'}        dir={sortDir} onClick={() => setSort('key')} />
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</th>
                  <SortHeader label="JIRA Status" active={sortKey === 'jiraStatus'} dir={sortDir} onClick={() => setSort('jiraStatus')} />
                  <th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center hidden md:table-cell whitespace-nowrap">Cherry Pick</th>
                  <th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center hidden md:table-cell">PRs</th>
                  <SortHeader label="Dev"         active={sortKey === 'assignee'}   dir={sortDir} onClick={() => setSort('assignee')} className="hidden md:table-cell" />
                  <SortHeader label="QA"          active={sortKey === 'qaAssignee'} dir={sortDir} onClick={() => setSort('qaAssignee')} className="hidden md:table-cell" />
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-center hidden md:table-cell">Branch</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hidden md:table-cell">Deployed</th>
                  <SortHeader label="Health"     active={sortKey === 'health'}     dir={sortDir} onClick={() => setSort('health')} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-sm text-muted-foreground italic">
                      No tickets match the current filter
                    </td>
                  </tr>
                ) : (
                  filtered.map(t => <TicketRow key={t.key} ticket={t} prs={prsByJiraKey[t.key] || []} version={version} onClickPr={(prs) => setPrPanel({ jiraKey: t.key, summary: t.summary, prs })} />)
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
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-28" />
                  <col />{/* title / commit */}
                  <col className="w-36" />
                  <col className="w-28" />
                  <col className="w-24" />
                </colgroup>
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Key</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title / Commit</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">JIRA Status</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Assignee</th>
                    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Commit</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRogues.map(r => (
                    <tr key={r.key} className="border-b border-border/30 hover:bg-accent/30 transition-colors bg-purple-500/[0.02]">
                      <td className="px-3 py-2 align-top">
                        <JiraLink jiraKey={r.key} className="text-purple-400 hover:text-purple-300" />
                      </td>
                      <td className="px-3 py-2 align-top">
                        {r.summary ? (
                          <>
                            <div className="text-foreground line-clamp-2" title={r.summary}>{r.summary}</div>
                            <div className="text-xs text-muted-foreground mt-0.5 truncate">
                              {r.type && <span>{r.type}</span>}
                              {r.component && (
                                <span className="inline-flex items-center ml-1.5 px-1.5 py-px rounded text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                  {r.component}
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <span className="text-muted-foreground truncate text-xs">{r.commitMessage}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="text-xs">{r.jiraStatus || '—'}</span>
                        {r.fixVersions && r.fixVersions.length > 0 && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 truncate" title={r.fixVersions.join(', ')}>
                            fix: {r.fixVersions.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className="text-xs text-muted-foreground">{r.assignee || '—'}</span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {r.commitSha && (
                          <span className="font-mono text-xs text-muted-foreground">{r.commitSha.substring(0, 7)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

      <PrDetailPanel
        open={!!prPanel}
        onClose={() => setPrPanel(null)}
        jiraKey={prPanel?.jiraKey || ''}
        summary={prPanel?.summary || ''}
        prs={prPanel?.prs || []}
        githubSearchUrl={prPanel ? `https://github.com/mavencare/${repo}/pulls?q=${prPanel.jiraKey}` : undefined}
        releaseVersion={version}
      />
    </div>
  )
}

function SortHeader({
  label, active, dir, onClick, className,
}: {
  label: string; active: boolean; dir: SortDir; onClick: () => void; className?: string
}) {
  return (
    <th
      onClick={onClick}
      className={cn("px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground select-none", className)}
    >
      {label}
      {active && <span className="ml-1">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}

function TicketRow({ ticket: t, prs, version, onClickPr }: { ticket: VerifiedTicket; prs: PrInfo[]; version: string; onClickPr: (prs: PrInfo[]) => void }) {
  const info = HEALTH_INFO[t.health]
  // A ticket is a "missing plan" for this release if it appears in Target FixVersion
  // but NOT in the canonical fixVersions — meaning the plan says it should ship here,
  // but no cherry-pick has landed to prove it will.
  const isPlannedOnly = t.inTarget === true && t.inFixVersion === false
  const isUnplannedAdd = t.inTarget === false && t.inFixVersion === true
  return (
    <tr className={cn(
      "border-b border-border/30 hover:bg-accent/30 transition-colors",
      isPlannedOnly && "bg-yellow-500/[0.03]"
    )}>
      {/* Key */}
      <td className="px-3 py-2 align-top">
        <div className="flex flex-col gap-1">
          <JiraLink jiraKey={t.key} />
          {isPlannedOnly && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono w-fit bg-yellow-500/15 text-yellow-400 border border-yellow-500/40"
              title="In Target FixVersion but not in canonical fixVersions — the plan says this should ship here, but it's not on the branch yet"
            >
              📋 Planned
            </span>
          )}
          {isUnplannedAdd && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono w-fit bg-orange-500/15 text-orange-400 border border-orange-500/40"
              title="In canonical fixVersions but not in Target FixVersion — unplanned addition / late cherry-pick"
            >
              ⚡ Unplanned
            </span>
          )}
          {t.zohoRef && <ZohoBadge refData={t.zohoRef} />}
        </div>
      </td>

      {/* Title */}
      <td className="px-3 py-2 align-top">
        <div className="text-foreground line-clamp-2" title={t.summary}>{t.summary}</div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate">
          {t.type && <span>{t.type}</span>}
          {t.component && (
            <span className="inline-flex items-center ml-1.5 px-1.5 py-px rounded text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              {t.component}
            </span>
          )}
        </div>
      </td>

      {/* JIRA Status */}
      <td className="px-3 py-2 align-top">
        {isCodeStatus(t.jiraStatus) ? (
          <button
            type="button"
            onClick={() => onClickPr(t.pr ? [{
              prNumber: t.pr!.prNumber,
              prTitle: t.pr!.prTitle,
              prAuthor: t.pr!.prAuthor,
              prUrl: t.pr!.prUrl,
              prCreatedAt: t.pr!.prCreatedAt,
              status: 'open',
            }] : [])}
            className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border cursor-pointer hover:ring-1 hover:ring-primary/30', getStatusBadgeColor(t.jiraStatus))}
          >
            {t.jiraStatus}
          </button>
        ) : (
          <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border', getStatusBadgeColor(t.jiraStatus))}>{t.jiraStatus}</span>
        )}
      </td>

      {/* CPs + PRs */}
      {(() => {
        const allPrs = prs.length > 0 ? prs : (t.pr ? [{
          prNumber: t.pr.prNumber, prTitle: t.pr.prTitle, prAuthor: t.pr.prAuthor,
          prUrl: t.pr.prUrl, prCreatedAt: t.pr.prCreatedAt, status: 'open' as const,
          baseBranch: `releases/${version}`,
        }] : [])
        const cps = allPrs.filter((p: any) => { const b = p.baseBranch || ''; return b.startsWith('releases/') || b.startsWith('VIV/') || b.startsWith('release/') })
        const originals = allPrs.filter((p: any) => { const b = p.baseBranch || ''; return b === 'master' || b === 'main' || b === 'develop' })
        const cpMerged = cps.some((p: any) => p.status === 'merged')
        const cpOpen = cps.some((p: any) => p.status === 'open')
        return (
          <>
            <td className="px-2 py-2 align-top text-center hidden md:table-cell">
              {cpMerged ? (
                <button type="button" onClick={() => onClickPr(allPrs)} className="cursor-pointer hover:opacity-80"><span className="text-green-400 text-sm">✓</span></button>
              ) : cpOpen ? (
                <button type="button" onClick={() => onClickPr(allPrs)} className="cursor-pointer hover:opacity-80"><span className="text-yellow-400 text-sm">○</span></button>
              ) : (
                <span className="text-muted-foreground/20 text-sm">—</span>
              )}
            </td>
            <td className="px-2 py-2 align-top text-center hidden md:table-cell">
              {originals.length > 0 ? (
                <button type="button" onClick={() => onClickPr(allPrs)}
                  className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-400 cursor-pointer hover:bg-blue-500/30"
                >{originals.length}</button>
              ) : (
                <span className="text-muted-foreground/20 text-sm">—</span>
              )}
            </td>
          </>
        )
      })()}

      {/* Dev Assignee */}
      <td className="px-3 py-2 align-top hidden md:table-cell">
        {(() => { const dev = displayAssignee(t.assignee); return <span className={cn('text-xs truncate max-w-[90px] inline-block', dev.className)}>{dev.text}</span> })()}
      </td>

      {/* QA Assignee */}
      <td className="px-3 py-2 align-top hidden md:table-cell">
        {(() => { const qa = displayAssignee(t.qaAssignee); return <span className={cn('text-xs truncate max-w-[90px] inline-block', qa.className)}>{qa.text}</span> })()}
      </td>

      {/* On Branch */}
      <td className="px-3 py-2 align-top text-center hidden md:table-cell">
        {!t.branchHasCommits ? (
          <span className="text-muted-foreground text-xs italic" title="Branch not cut yet">n/a</span>
        ) : t.onBranch ? (
          <span className="text-green-400 text-base">✓</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      {/* Deployed */}
      <td className="px-3 py-2 align-top hidden md:table-cell">
        <DeployedCell ticket={t} />
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

function DeployedCell({ ticket: t }: { ticket: VerifiedTicket }) {
  const envs = t.deployedEnvironments || []
  const needsTesting = ['in-qa', 'awaiting-cp'].includes(t.healthCategory) ||
    ['ready for testing', 'testing in branch', 'in qa'].includes(t.jiraStatus.toLowerCase())

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

  const { label, style } = getDeployTier(envs)
  return (
    <span
      className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", style)}
      title={`${envs.length} env${envs.length !== 1 ? 's' : ''}: ${envs.join(', ')}`}
    >
      {label}
    </span>
  )
}

function getDeployTier(envs: string[]): { label: string; style: string } {
  const hasProd = envs.some(e => /prod/i.test(e) && !/staging/i.test(e))
  if (hasProd) return { label: 'Prod', style: 'bg-green-500/15 text-green-400 border-green-500/30' }
  const hasStaging = envs.some(e => /staging|uat/i.test(e))
  if (hasStaging) return { label: 'Staging', style: 'bg-blue-500/15 text-blue-400 border-blue-500/30' }
  const hasQa = envs.some(e => /qa|dev|integration|sandbox/i.test(e))
  if (hasQa) return { label: 'QA', style: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' }
  return { label: 'Deployed', style: 'bg-muted/30 text-muted-foreground border-muted' }
}

function ZohoBadge({ refData }: { refData: ZohoRef }) {
  const baseClasses = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border w-fit"

  if (refData.kind === 'url' && refData.zohoUrl) {
    return (
      <a
        href={refData.zohoUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className={cn(baseClasses, "bg-orange-500/10 text-orange-400 border-orange-500/30 hover:bg-orange-500/20")}
        title={`Open Zoho ticket ${refData.id}`}
      >
        <span>Zoho</span>
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </a>
    )
  }

  if (refData.kind === 'ticketNumber') {
    return (
      <span
        className={cn(baseClasses, "bg-blue-500/10 text-blue-400 border-blue-500/30")}
        title={`Zoho short-form ref — copy ${refData.ticketNumber} and search in Zoho Desk`}
      >
        {refData.ticketNumber}
      </span>
    )
  }

  // Unparseable — someone pasted garbage into customfield_10691
  return (
    <span
      className={cn(baseClasses, "bg-muted/30 text-muted-foreground/70 border-muted/50 italic")}
      title={`Unparseable Zoho ref in JIRA: ${refData.raw}`}
    >
      Zoho ?
    </span>
  )
}
