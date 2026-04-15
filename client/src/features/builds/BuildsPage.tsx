import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { JiraLink } from '../../components/JiraLink'
import { cn, timeAgo } from '../../lib/utils'

// ── Types ────────────────────────────────────────────────

interface BuildInfo {
  buildNumber: number
  status: string
  startTime: string | null
  endTime: string | null
  durationSec: number | null
  commitSha: string | null
}

interface BuildCard {
  projectName: string
  branch: string
  version: string | null
  repo: string
  isCustom: boolean
  imageTag: string | null
  account: string | null
  latestStatus: string
  latestStartTime: string | null
  builds: BuildInfo[]
  newCommits: Array<{ sha: string; message: string }>
  jiraKeys: string[]
}

interface DeployTarget {
  pipelineName: string
  customer: string
  env: string
  status: string | null
  lastUpdated: string | null
}

interface BuildsPageData {
  builds: BuildCard[]
  deployTargets: Record<string, DeployTarget[]>
  lastRun: string | null
}

// ── Status styling ───────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string; border: string }> = {
  IN_PROGRESS: { label: 'Building',  color: 'text-blue-400',   dot: 'bg-blue-500 animate-pulse', border: 'border-blue-500/30' },
  FAILED:      { label: 'Failed',    color: 'text-red-400',    dot: 'bg-red-500',                border: 'border-red-500/30' },
  SUCCEEDED:   { label: 'Succeeded', color: 'text-green-400',  dot: 'bg-green-500',              border: 'border-green-500/30' },
  STOPPED:     { label: 'Stopped',   color: 'text-gray-400',   dot: 'bg-gray-500',               border: 'border-gray-500/30' },
}

const DEPLOY_STATUS: Record<string, { color: string; dot: string }> = {
  Succeeded:  { color: 'text-green-400', dot: 'bg-green-500' },
  InProgress: { color: 'text-blue-400',  dot: 'bg-blue-500 animate-pulse' },
  Failed:     { color: 'text-red-400',   dot: 'bg-red-500' },
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${min}m ${s}s` : `${min}m`
}

// ── Filter type ──────────────────────────────────────────

type Filter = 'all' | 'building' | 'failed' | 'succeeded' | 'custom'

// ── Deploy target matching ────────────────────────────────
// Some builds produce images with multiple tags (e.g., master → "master" + "latest")
const TAG_ALIASES: Record<string, string[]> = {
  master: ['master', 'latest'],
}

function getDeployTargetsForBuild(build: BuildCard, allTargets: Record<string, DeployTarget[]>): DeployTarget[] {
  const tag = build.imageTag || ''
  const tags = TAG_ALIASES[tag] || [tag]
  const seen = new Set<string>()
  const targets: DeployTarget[] = []
  for (const t of tags) {
    for (const d of (allTargets[t] || [])) {
      if (!seen.has(d.pipelineName)) {
        seen.add(d.pipelineName)
        targets.push(d)
      }
    }
  }
  return targets
}

// ── Commit list with show more ───────────────────────────

function CommitList({ commits }: { commits: Array<{ sha: string; message: string }> }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? commits : commits.slice(0, 5)

  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {commits.length} commit{commits.length !== 1 ? 's' : ''} since last success
      </h4>
      <div className="space-y-0.5">
        {visible.map(c => (
          <div key={c.sha} className="flex items-start gap-2 text-xs">
            <span className="font-mono text-muted-foreground shrink-0">{c.sha.slice(0, 7)}</span>
            <span className="truncate">{c.message}</span>
          </div>
        ))}
      </div>
      {commits.length > 5 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline mt-1"
        >
          Show {commits.length - 5} more
        </button>
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────

export function BuildsPage() {
  const [data, setData] = useState<BuildsPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    setLoading(true)
    apiFetch<BuildsPageData>('/pipeline/builds')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    if (!data) return []
    let builds = data.builds
    if (filter === 'building') builds = builds.filter(b => b.latestStatus === 'IN_PROGRESS')
    else if (filter === 'failed') builds = builds.filter(b => b.latestStatus === 'FAILED')
    else if (filter === 'succeeded') builds = builds.filter(b => b.latestStatus === 'SUCCEEDED')
    else if (filter === 'custom') builds = builds.filter(b => b.isCustom)
    if (search) {
      const s = search.toLowerCase()
      builds = builds.filter(b => {
        if (b.branch.toLowerCase().includes(s)) return true
        if (b.projectName.toLowerCase().includes(s)) return true
        if (b.jiraKeys.some(k => k.toLowerCase().includes(s))) return true
        if ((b.account || '').toLowerCase().includes(s)) return true
        // Search deploy targets — match customer, env, or combined (with or without space)
        const targets = getDeployTargetsForBuild(b, data.deployTargets)
        if (targets.some(d =>
          d.customer.toLowerCase().includes(s) ||
          d.env.toLowerCase().includes(s) ||
          `${d.customer} ${d.env}`.toLowerCase().includes(s) ||
          `${d.customer}${d.env}`.toLowerCase().includes(s) ||
          d.pipelineName.toLowerCase().includes(s)
        )) return true
        return false
      })
    }
    return builds
  }, [data, filter, search])

  const counts = useMemo(() => {
    if (!data) return { building: 0, failed: 0, succeeded: 0 }
    return {
      building: data.builds.filter(b => b.latestStatus === 'IN_PROGRESS').length,
      failed: data.builds.filter(b => b.latestStatus === 'FAILED').length,
      succeeded: data.builds.filter(b => b.latestStatus === 'SUCCEEDED').length,
    }
  }, [data])

  if (loading) return <div className="text-sm text-muted-foreground py-8 text-center">Loading builds...</div>
  if (!data || data.builds.length === 0) return <div className="text-sm text-muted-foreground py-8 text-center italic">No build data available. Pipeline sync may not have run yet.</div>

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Builds</h1>
        <div className="flex items-center gap-3 text-sm">
          {counts.building > 0 && <span className="text-blue-400 font-medium">{counts.building} building</span>}
          {counts.failed > 0 && <span className="text-red-400 font-medium">{counts.failed} failed</span>}
          <span className="text-green-400">{counts.succeeded} succeeded</span>
          {data.lastRun && <span className="text-xs text-muted-foreground">synced {timeAgo(data.lastRun)}</span>}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          {([
            ['all', 'All'],
            ['building', `Building${counts.building ? ` (${counts.building})` : ''}`],
            ['failed', `Failed${counts.failed ? ` (${counts.failed})` : ''}`],
            ['succeeded', 'Succeeded'],
            ['custom', 'Custom'],
          ] as [Filter, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                filter === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search branch, project, JIRA key, environment..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-md border bg-background text-foreground w-64"
        />
      </div>

      {/* Build cards */}
      <div className="space-y-3">
        {filtered.map(build => (
          <BuildCardComponent
            key={build.projectName}
            build={build}
            deployTargets={getDeployTargetsForBuild(build, data.deployTargets)}
            navigate={navigate}
          />
        ))}
        {filtered.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center italic">No builds match the current filter</div>
        )}
      </div>
    </div>
  )
}

// ── Build card with deploy targets ───────────────────────

function BuildCardComponent({ build, deployTargets, navigate }: {
  build: BuildCard
  deployTargets: DeployTarget[]
  navigate: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const latest = build.builds[0]
  const info = STATUS_CONFIG[build.latestStatus] || STATUS_CONFIG.STOPPED

  const displayBranch = build.branch
    .replace('releases/', '')
    .replace('ECR-Build_viv-', '')

  return (
    <div className="flex flex-col md:flex-row md:items-stretch gap-2 md:gap-0">
      {/* Build card */}
      <Card className={cn('flex-1 min-w-0 overflow-hidden', build.latestStatus === 'FAILED' && 'border-red-500/20')}>
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/20 transition-colors text-left"
        >
          <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", info.dot)} />
          <span className="font-mono font-bold truncate">{displayBranch}</span>
          {build.account && build.account !== 'Viv' && (
            <Badge variant="outline" className="text-xs text-cyan-400 border-cyan-500/30 shrink-0">{build.account}</Badge>
          )}
          {build.isCustom && <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30 shrink-0">custom</Badge>}
          {build.version && (
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/releases/webplatform:${build.version}`) }}
              className="text-xs text-primary hover:underline shrink-0"
            >
              release
            </button>
          )}
          <span className={cn("text-xs shrink-0", info.color)}>{info.label}</span>
          {latest?.durationSec && <span className="text-xs text-muted-foreground shrink-0">{formatDuration(latest.durationSec)}</span>}
          {latest?.startTime && <span className="text-xs text-muted-foreground shrink-0">{timeAgo(latest.startTime)}</span>}
          <span className="text-xs text-muted-foreground ml-auto shrink-0">{expanded ? '▾' : '▸'}</span>
        </button>

        {/* Expanded: commits + build history */}
        {expanded && (
          <div className="px-4 pb-3 space-y-3 border-t border-border/20">
            {/* JIRA keys */}
            {build.jiraKeys.length > 0 && (
              <div className="pt-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {build.jiraKeys.length} JIRA ticket{build.jiraKeys.length !== 1 ? 's' : ''}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {build.jiraKeys.map(key => (
                    <JiraLink key={key} jiraKey={key} className="text-xs" />
                  ))}
                </div>
              </div>
            )}

            {/* Commits — show 5, then "show more" */}
            {build.newCommits.length > 0 && (
              <CommitList commits={build.newCommits} />
            )}

            {/* Build history */}
            {build.builds.length > 1 && (
              <div>
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">History</h4>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {build.builds.map(b => (
                    <a
                      key={b.buildNumber}
                      href={`https://us-east-1.console.aws.amazon.com/codesuite/codebuild/projects/${build.projectName}/build/${build.projectName}%3A${b.buildNumber}/log`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "flex flex-col items-center gap-0.5 px-1.5 py-1 rounded border cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all min-w-[40px]",
                        b.status === 'SUCCEEDED' ? 'bg-green-500/10 border-green-500/30' :
                        b.status === 'FAILED' ? 'bg-red-500/10 border-red-500/30' :
                        b.status === 'IN_PROGRESS' ? 'bg-blue-500/10 border-blue-500/30' :
                        'bg-gray-500/10 border-gray-500/30'
                      )}
                      title={`#${b.buildNumber}: ${b.status}${b.startTime ? ` — ${timeAgo(b.startTime)}` : ''}${b.durationSec ? ` — ${formatDuration(b.durationSec)}` : ''}${(b as any).jiraKeys?.length ? `\nJIRA: ${(b as any).jiraKeys.join(', ')}` : ''}`}
                    >
                      <span className={cn(
                        "text-[10px] font-semibold",
                        b.status === 'SUCCEEDED' ? 'text-green-400' :
                        b.status === 'FAILED' ? 'text-red-400' :
                        b.status === 'IN_PROGRESS' ? 'text-blue-400' :
                        'text-gray-400'
                      )}>
                        #{b.buildNumber}
                      </span>
                      <span className="text-[9px] text-muted-foreground">
                        {b.startTime ? timeAgo(b.startTime) : '—'}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Arrow connector with build time — hidden on mobile */}
      <div className="hidden md:flex items-center justify-center shrink-0 w-44 px-3">
        <div className="flex flex-col items-center w-full">
          {latest?.durationSec && (
            <span className="text-[10px] text-muted-foreground/50 mb-1.5">{formatDuration(latest.durationSec)}</span>
          )}
          <div className="w-full flex items-center">
            <div className="flex-1 h-0.5 bg-muted-foreground/25 rounded-full" />
            <div className="w-0 h-0 border-t-[6px] border-t-transparent border-b-[6px] border-b-transparent border-l-[10px] border-l-muted-foreground/25 shrink-0" />
          </div>
          {build.latestStatus === 'IN_PROGRESS' && (
            <span className="text-[10px] text-blue-400/60 mt-1.5">ETA ~20 min</span>
          )}
        </div>
      </div>

      {/* Deploy card — always shows */}
      <Card className="w-full md:w-52 shrink-0 overflow-hidden">
        <div className="px-3 py-3 h-full flex flex-col">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Deploys to</h4>
          {deployTargets.length > 0 ? (
            <>
              <div className="space-y-1.5 flex-1">
                {deployTargets.map(d => {
                  const di = DEPLOY_STATUS[d.status || ''] || { color: 'text-muted-foreground', dot: 'bg-gray-500' }
                  return (
                    <div key={d.pipelineName} className="flex items-center gap-2">
                      <span className={cn("w-2 h-2 rounded-full shrink-0", di.dot)} />
                      <span className="text-xs flex-1 truncate">{d.customer} {d.env}</span>
                      <span className={cn("text-[10px] shrink-0", di.color)}>
                        {d.status === 'Succeeded' ? '✓' : d.status === 'Failed' ? '✗' : d.status === 'InProgress' ? '...' : '—'}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="text-[10px] text-muted-foreground mt-2 pt-1.5 border-t border-border/20">
                {deployTargets.filter(d => d.status === 'Succeeded').length}/{deployTargets.length} deployed
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-xs text-muted-foreground/40 italic">No deploy targets configured</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
