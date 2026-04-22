import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { JiraLink } from '../../components/JiraLink'
import { SortableHeader, useSortableData, useSortState, nextSortState, type SortState, type SortDir as SortableSortDir } from '../../components/SortableHeader'
import { apiFetch } from '../../api/client'
import type { ReleaseTruthReport, DeploymentImpactReport, VerifiedTicket, Health, HealthCategory, ZohoRef } from '../../api/client'
import { cn, timeAgo, exportToCsv, releaseKey } from '../../lib/utils'
import { useWsStore } from '../../stores/wsStore'
import { NectarLoader, NectarSpinner } from '../../components/NectarLoader'
import { CompareSelector } from './CompareSelector'
import type { CompareTarget } from './CompareSelector'
import { SavedViews } from '../../components/SavedViews'
import { PrDetailPanel, isCodeStatus, type PrInfo } from '../../components/PrDetailPanel'
import { NotifyDialog } from '../../components/NotifyDialog'
import { STATUS_GROUPS, getStatusBadgeColor, displayAssignee, type StatusGroup } from '../../lib/status-colors'

interface Props {
  repo: string
  version: string
  prsByJiraKey?: Record<string, PrInfo[]>
  buildByJiraKey?: Record<string, { buildNumber: number; status: string; startTime: string; branch: string }>
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

type SortKey = 'health' | 'key' | 'title' | 'jiraStatus' | 'cherryPick' | 'prs' | 'build' | 'assignee' | 'qaAssignee' | 'branch' | 'deployed'

type ViewMode = 'impact' | 'full'
type FilterKey = 'all' | HealthCategory
type CompareType = CompareTarget['type']

export function TruthView({ repo, version, prsByJiraKey: prsByJiraKeyProp = {}, buildByJiraKey = {} }: Props) {
  // Fetch PR data from PrStore (covers all PRs — open + merged, cherry-picks + originals)
  // Falls back to the prop if the fetch hasn't completed yet.
  const [fetchedPrs, setFetchedPrs] = useState<Record<string, PrInfo[]>>({})
  useEffect(() => {
    apiFetch<Record<string, PrInfo[]>>(`/releases/${encodeURIComponent(releaseKey({ repo, version }))}/prs`)
      .then(setFetchedPrs)
      .catch(() => {}) // silent — fall back to prop
  }, [repo, version])
  const prsByJiraKey = Object.keys(fetchedPrs).length > 0 ? fetchedPrs : prsByJiraKeyProp
  // ── URL-driven state (everything here is shareable) ─────────
  const [searchParams, setSearchParams] = useSearchParams()

  const cmpVersion = searchParams.get('cmp') || ''
  const cmpType = (searchParams.get('cmpType') as CompareType | null) || null
  const mode: ViewMode = (searchParams.get('view') as ViewMode | null)
    || (cmpVersion ? 'impact' : 'full')
  const filter: FilterKey = (searchParams.get('filter') as FilterKey | null) || 'all'
  const jiraStatusGroup: StatusGroup = (searchParams.get('statusGroup') as StatusGroup | null) || 'all'
  const search = searchParams.get('q') || ''
  const sortKeyRaw = searchParams.get('sort') as SortKey | null
  const sortDirRaw = searchParams.get('dir') as SortableSortDir | null
  // Default sort is by health asc; null/null means user explicitly cleared
  const hasSortInUrl = searchParams.has('sort')
  const sortState: SortState<SortKey> = hasSortInUrl
    ? { key: sortKeyRaw, dir: sortDirRaw === 'asc' || sortDirRaw === 'desc' ? sortDirRaw : null }
    : { key: 'health', dir: 'asc' }

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
    const next = nextSortState(sortState, key)
    updateParams({ sort: next.key, dir: next.dir })
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
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prPanel, setPrPanel] = useState<{ jiraKey: string; summary: string; prs: PrInfo[] } | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [notifySingleTicket, setNotifySingleTicket] = useState<VerifiedTicket | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Poll for truth result — triggers background computation, then polls until ready
  const pollTruth = useCallback(async (refresh = false) => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
    try {
      const qs = refresh ? '?refresh=true' : ''
      const data = await apiFetch<{ status: string; result?: ReleaseTruthReport; error?: string; computedAt?: string }>(
        `/releases/${encodeURIComponent(repo)}/${encodeURIComponent(version)}/truth${qs}`
      )
      if (data.status === 'ready') {
        setTruth(data.result!)
        setComputing(false)
        setLoading(false)
        setError(null)
      } else if (data.status === 'computing') {
        setComputing(true)
        if (!truth && !data.result) setLoading(true) // only show loader if no data yet
        if (data.result) setTruth(data.result) // show stale data while recomputing
        pollRef.current = setTimeout(() => pollTruth(), 2000)
      } else if (data.status === 'error') {
        setError(data.error || 'Computation failed')
        if (data.result) setTruth(data.result) // show stale data
        setComputing(false)
        setLoading(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load truth')
      setComputing(false)
      setLoading(false)
    }
  }, [repo, version, truth])

  async function loadImpact() {
    if (!prodVersion) return
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<DeploymentImpactReport>(
        `/releases/${encodeURIComponent(repo)}/${encodeURIComponent(version)}/impact?prodVersion=${encodeURIComponent(prodVersion)}`
      )
      setImpact(data)
      setTruth(data.targetTruth)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load impact')
    }
    setLoading(false)
  }

  function load(refresh = false) {
    if (mode === 'impact' && prodVersion) loadImpact()
    else {
      setLoading(true)
      setError(null)
      pollTruth(refresh)
    }
  }

  useEffect(() => { load() }, [repo, version, mode, prodVersion])

  // Cleanup poll on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current) }
  }, [])

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

    // JIRA status group filter
    if (jiraStatusGroup !== 'all') {
      const groupDef = STATUS_GROUPS.find(g => g.key === jiraStatusGroup)
      if (jiraStatusGroup === 'not-done') {
        const doneStatuses = new Set(STATUS_GROUPS.find(g => g.key === 'done')?.statuses || [])
        rows = rows.filter(t => !doneStatuses.has(t.jiraStatus))
      } else if (groupDef && groupDef.statuses.length > 0) {
        const statuses = new Set(groupDef.statuses)
        rows = rows.filter(t => statuses.has(t.jiraStatus))
      }
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

    return rows
  }, [activeTickets, filter, jiraStatusGroup, search])

  // Sort applied separately via shared hook
  const sortAccessors = useMemo(() => ({
    health:     (t: VerifiedTicket) => HEALTH_INFO[t.health].priority,
    key:        (t: VerifiedTicket) => t.key,
    title:      (t: VerifiedTicket) => t.summary || '',
    jiraStatus: (t: VerifiedTicket) => t.jiraStatus,
    cherryPick: (t: VerifiedTicket) => t.pr ? 1 : 0,
    prs:        (t: VerifiedTicket) => (prsByJiraKey[t.key] || []).length,
    build:      (t: VerifiedTicket) => buildByJiraKey[t.key]?.status || '',
    assignee:   (t: VerifiedTicket) => t.assignee,
    qaAssignee: (t: VerifiedTicket) => t.qaAssignee,
    branch:     (t: VerifiedTicket) => t.onBranch ? 1 : 0,
    deployed:   (t: VerifiedTicket) => (t.deployedEnvironments || []).length,
  }), [prsByJiraKey, buildByJiraKey])
  const sorted = useSortableData<VerifiedTicket, SortKey>(filtered, sortState, sortAccessors)

  // ── Rogue commits table sort state (local, doesn't go in URL) ──
  type RogueSortKey = 'key' | 'title' | 'jiraStatus' | 'assignee' | 'commit'
  const [rogueSortState, onRogueSort] = useSortState<RogueSortKey>(null)
  const rogueAccessors = useMemo(() => ({
    key:        (r: typeof activeRogues[number]) => r.key,
    title:      (r: typeof activeRogues[number]) => r.summary || r.commitMessage || '',
    jiraStatus: (r: typeof activeRogues[number]) => r.jiraStatus,
    assignee:   (r: typeof activeRogues[number]) => r.assignee,
    commit:     (r: typeof activeRogues[number]) => r.commitSha,
  }), [activeRogues])
  const sortedRogues = useSortableData<typeof activeRogues[number], RogueSortKey>(activeRogues, rogueSortState, rogueAccessors)

  if (loading && !truth && !impact) {
    return (
      <Card>
        <CardContent className="p-6">
          <NectarLoader message="Computing truth from JIRA + Git + GitHub..." />
        </CardContent>
      </Card>
    )
  }

  if (error && !truth) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={() => load(true)} className="mt-2">Retry</Button>
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
              <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading || computing}>
                {computing ? <><NectarSpinner className="mr-1" /> Computing...</> : 'Refresh'}
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

          {/* JIRA status group filters */}
          <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5 mb-4 flex-wrap">
            {STATUS_GROUPS.map(g => {
              const count = g.key === 'all' ? activeTickets.length
                : g.key === 'not-done'
                  ? activeTickets.filter(t => !STATUS_GROUPS.find(sg => sg.key === 'done')?.statuses.includes(t.jiraStatus)).length
                  : g.statuses.length > 0
                    ? activeTickets.filter(t => g.statuses.includes(t.jiraStatus)).length
                    : 0
              return (
                <button
                  key={g.key}
                  onClick={() => updateParams({ statusGroup: jiraStatusGroup === g.key ? null : g.key })}
                  className={cn(
                    'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                    jiraStatusGroup === g.key ? g.pillActive : g.pillInactive,
                    count === 0 && g.key !== 'all' && 'opacity-40'
                  )}
                >
                  {g.label}
                  {count > 0 && <span className="ml-1 opacity-70">{count}</span>}
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
        {(cmpVersion || mode !== 'full' || sortState.key !== 'health' || sortState.dir !== 'asc') && (
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
                sorted.map(t => [
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
                <col className="w-8" />{/* checkbox */}
                <col className="w-28" />
                <col />{/* title takes remaining */}
                <col className="w-44" />
                <col className="w-24" />
                <col className="w-12" />
                <col className="w-12" />
                <col className="w-24" />
                <col className="w-24" />
                <col className="w-16" />
                <col className="w-24" />
                <col className="w-48" />
              </colgroup>
              <thead className="sticky top-0 bg-background z-10">
                <tr className="border-b text-left">
                  <th className="px-1 py-2">
                    <input
                      type="checkbox"
                      checked={sorted.length > 0 && selectedKeys.size === sorted.length}
                      onChange={e => {
                        if (e.target.checked) setSelectedKeys(new Set(sorted.map(t => t.key)))
                        else setSelectedKeys(new Set())
                      }}
                      className="rounded border-border"
                    />
                  </th>
                  <SortableHeader label="Key"         sortKey="key"        state={sortState} onSort={k => setSort(k as SortKey)} />
                  <SortableHeader label="Title"       sortKey="title"      state={sortState} onSort={k => setSort(k as SortKey)} />
                  <SortableHeader label="JIRA Status" sortKey="jiraStatus" state={sortState} onSort={k => setSort(k as SortKey)} />
                  <SortableHeader label="Cherry Pick" sortKey="cherryPick" state={sortState} onSort={k => setSort(k as SortKey)} align="center" className="hidden md:table-cell" />
                  <SortableHeader label="PRs"         sortKey="prs"        state={sortState} onSort={k => setSort(k as SortKey)} align="center" className="hidden md:table-cell" />
                  <SortableHeader label="Build"       sortKey="build"      state={sortState} onSort={k => setSort(k as SortKey)} align="center" className="hidden md:table-cell" />
                  <SortableHeader label="Dev"         sortKey="assignee"   state={sortState} onSort={k => setSort(k as SortKey)} className="hidden md:table-cell" />
                  <SortableHeader label="QA"          sortKey="qaAssignee" state={sortState} onSort={k => setSort(k as SortKey)} className="hidden md:table-cell" />
                  <SortableHeader label="Branch"      sortKey="branch"     state={sortState} onSort={k => setSort(k as SortKey)} align="center" className="hidden md:table-cell" />
                  <SortableHeader label="Deployed"    sortKey="deployed"   state={sortState} onSort={k => setSort(k as SortKey)} className="hidden md:table-cell" />
                  <SortableHeader label="Health"      sortKey="health"     state={sortState} onSort={k => setSort(k as SortKey)} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-sm text-muted-foreground italic">
                      No tickets match the current filter
                    </td>
                  </tr>
                ) : (
                  sorted.map(t => <TicketRow key={t.key} ticket={t} prs={prsByJiraKey[t.key] || []} build={buildByJiraKey[t.key] || null} version={version} onClickPr={(prs) => setPrPanel({ jiraKey: t.key, summary: t.summary, prs })} selected={selectedKeys.has(t.key)} onSelect={(checked) => { const next = new Set(selectedKeys); if (checked) next.add(t.key); else next.delete(t.key); setSelectedKeys(next) }} onNotify={() => { setNotifySingleTicket(t); setNotifyOpen(true) }} />)
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Floating action bar for selected tickets */}
      {selectedKeys.size > 0 && (
        <div className="sticky bottom-4 z-20 flex justify-center">
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border bg-card shadow-lg">
            <span className="text-sm font-medium">{selectedKeys.size} selected</span>
            <button
              onClick={() => { setNotifySingleTicket(null); setNotifyOpen(true) }}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Notify
            </button>
            <button
              onClick={() => setSelectedKeys(new Set())}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Notify dialog */}
      <NotifyDialog
        open={notifyOpen}
        onClose={() => { setNotifyOpen(false); setNotifySingleTicket(null) }}
        tickets={
          notifySingleTicket
            ? [{ key: notifySingleTicket.key, summary: notifySingleTicket.summary, assignee: notifySingleTicket.assignee, qaAssignee: notifySingleTicket.qaAssignee, jiraStatus: notifySingleTicket.jiraStatus }]
            : sorted.filter(t => selectedKeys.has(t.key)).map(t => ({ key: t.key, summary: t.summary, assignee: t.assignee, qaAssignee: t.qaAssignee, jiraStatus: t.jiraStatus }))
        }
        version={version}
      />

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
                    <SortableHeader label="Key"            sortKey="key"        state={rogueSortState} onSort={k => onRogueSort(k as RogueSortKey)} />
                    <SortableHeader label="Title / Commit" sortKey="title"      state={rogueSortState} onSort={k => onRogueSort(k as RogueSortKey)} />
                    <SortableHeader label="JIRA Status"    sortKey="jiraStatus" state={rogueSortState} onSort={k => onRogueSort(k as RogueSortKey)} />
                    <SortableHeader label="Assignee"       sortKey="assignee"   state={rogueSortState} onSort={k => onRogueSort(k as RogueSortKey)} />
                    <SortableHeader label="Commit"         sortKey="commit"     state={rogueSortState} onSort={k => onRogueSort(k as RogueSortKey)} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRogues.map(r => (
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

function TicketRow({ ticket: t, prs, build, version, onClickPr, selected, onSelect, onNotify }: { ticket: VerifiedTicket; prs: PrInfo[]; build: { buildNumber: number; status: string; startTime: string; branch: string } | null; version: string; onClickPr: (prs: PrInfo[]) => void; selected: boolean; onSelect: (checked: boolean) => void; onNotify: () => void }) {
  const info = HEALTH_INFO[t.health]
  const isPlannedOnly = t.inTarget === true && t.inFixVersion === false
  const isUnplannedAdd = t.inTarget === false && t.inFixVersion === true
  return (
    <tr className={cn(
      "border-b border-border/30 hover:bg-accent/30 transition-colors group",
      isPlannedOnly && "bg-yellow-500/[0.03]"
    )}>
      {/* Checkbox */}
      <td className="px-1 py-2 align-top text-center">
        <input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)} className="rounded border-border" />
      </td>
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
            className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border cursor-pointer hover:ring-1 hover:ring-primary/30 whitespace-nowrap', getStatusBadgeColor(t.jiraStatus))}
          >
            {t.jiraStatus}
          </button>
        ) : (
          <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border whitespace-nowrap', getStatusBadgeColor(t.jiraStatus))}>{t.jiraStatus}</span>
        )}
      </td>

      {/* CPs + PRs */}
      {(() => {
        const allPrs = prs.length > 0 ? prs : (t.pr ? [{
          prNumber: t.pr.prNumber, prTitle: t.pr.prTitle, prAuthor: t.pr.prAuthor,
          prUrl: t.pr.prUrl, prCreatedAt: t.pr.prCreatedAt, status: 'open' as const,
          baseBranch: `releases/${version}`,
        }] : [])
        const releaseBranch = `releases/${version}`
        const cps = allPrs.filter((p: any) => {
          const b = p.baseBranch || ''
          if (!(b.startsWith('releases/') || b.startsWith('VIV/') || b.startsWith('release/'))) return false
          // Only count CPs targeting THIS release's branch
          return b === releaseBranch || b === `VIV/${version}`
        })
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

      {/* Build status */}
      <td className="px-1 py-2 align-top text-center hidden md:table-cell">
        {build ? (
          <span
            className={cn('text-sm cursor-default',
              build.status === 'SUCCEEDED' ? 'text-green-400' :
              build.status === 'FAILED' ? 'text-red-400' :
              build.status === 'IN_PROGRESS' ? 'text-blue-400 animate-pulse' :
              'text-muted-foreground'
            )}
            title={`Build #${build.buildNumber} ${build.status}${build.startTime ? ` · ${new Date(build.startTime).toLocaleString()}` : ''}${build.branch ? ` · ${build.branch}` : ''}`}
          >
            {build.status === 'SUCCEEDED' ? '✓' : build.status === 'FAILED' ? '✗' : build.status === 'IN_PROGRESS' ? '...' : '?'}
          </span>
        ) : (
          <span className="text-muted-foreground/20 text-sm">—</span>
        )}
      </td>

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
      <td className="px-3 py-2 align-top relative">
        <div
          className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border", info.color)}
          title={t.healthMessage}
        >
          {info.emoji} {info.label}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 truncate" title={t.healthMessage}>
          {t.healthMessage}
        </div>
        <button
          onClick={onNotify}
          className="absolute top-2 right-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          title="Notify about this ticket"
        >
          <span className="text-xs">✉</span>
        </button>
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
