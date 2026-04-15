import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn, timeAgo } from '../../lib/utils'
import { useBuildsData } from './useBuildsData'
import { DenseCard } from './DenseCard'
import { getDeployTargetsForBuild, groupDeployTargetsForBuild } from './shared'
import type { DeployRow } from './shared'
import type { BuildCard, DeployTarget } from './types'

const ALL_KEY = 'all'

function buildMatchesSearch(
  build: BuildCard,
  query: string,
  deployTargetMap: Record<string, DeployTarget[]>,
): boolean {
  if (!query) return true
  const s = query.toLowerCase()
  if (build.branch.toLowerCase().includes(s)) return true
  if (build.projectName.toLowerCase().includes(s)) return true
  if (build.jiraKeys.some(k => k.toLowerCase().includes(s))) return true
  // Search JIRA keys across ALL builds in the project, not just latest
  if (build.builds.some(b => b.jiraKeys?.some(k => k.toLowerCase().includes(s)))) return true
  if ((build.account || '').toLowerCase().includes(s)) return true
  const targets = getDeployTargetsForBuild(build, deployTargetMap, build.customerKey)
  return targets.some(
    d =>
      d.customer.toLowerCase().includes(s) ||
      d.env.toLowerCase().includes(s) ||
      `${d.customer} ${d.env}`.toLowerCase().includes(s) ||
      d.pipelineName.toLowerCase().includes(s),
  )
}

interface BuildCardSlotProps {
  build: BuildCard
  deployRows: DeployRow[]
  isPinned?: boolean
  onNavigate: (path: string) => void
  searchTerm: string
}

function BuildCardSlot({ build, deployRows, isPinned, onNavigate, searchTerm }: BuildCardSlotProps) {
  return (
    <div
      data-testid="dense-card"
      data-pinned={isPinned ? 'true' : undefined}
    >
      <DenseCard
        build={build}
        deployRows={deployRows}
        onNavigate={onNavigate}
        searchTerm={searchTerm}
      />
    </div>
  )
}

export function BuildsPage() {
  const { data, loading, error } = useBuildsData()
  const [activeKey, setActiveKey] = useState<string>(ALL_KEY)
  const [search, setSearch] = useState('')
  const [expandedAllFor, setExpandedAllFor] = useState<Set<string>>(new Set())
  const navigate = useNavigate()

  const toggleExpandAll = (customerKey: string) => {
    setExpandedAllFor(prev => {
      const next = new Set(prev)
      if (next.has(customerKey)) next.delete(customerKey)
      else next.add(customerKey)
      return next
    })
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">Loading builds...</div>
  }
  if (error) {
    return (
      <div className="text-sm text-red-400 py-8 text-center">
        Failed to load builds: {error.message}
      </div>
    )
  }
  if (!data || data.customers.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center italic">
        No build data available. Pipeline sync may not have run yet.
      </div>
    )
  }

  const visibleCustomers =
    activeKey === ALL_KEY ? data.customers : data.customers.filter(c => c.key === activeKey)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Builds</h1>
        {data.lastRun && (
          <span className="text-xs text-muted-foreground">synced {timeAgo(data.lastRun)}</span>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setActiveKey(ALL_KEY)}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              activeKey === ALL_KEY
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            All
          </button>
          {data.customers.map(c => (
            <button
              key={c.key}
              type="button"
              onClick={() => setActiveKey(c.key)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                activeKey === c.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search branch, project, JIRA key, environment..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-8 px-3 text-sm rounded-md border bg-background text-foreground w-64"
          aria-label="Search builds"
        />
      </div>

      <div className="space-y-6">
        {visibleCustomers.map(c => {
          const topSlots: Array<{ build: BuildCard; pinned: boolean }> = [
            ...(c.pinnedBuild ? [{ build: c.pinnedBuild, pinned: true }] : []),
            ...c.recentBuilds.map(b => ({ build: b, pinned: false })),
          ].filter(({ build }) => buildMatchesSearch(build, search, data.deployTargets))

          const topNames = new Set<string>([
            ...(c.pinnedBuild ? [c.pinnedBuild.projectName] : []),
            ...c.recentBuilds.map(b => b.projectName),
          ])
          const remaining = c.allBuilds.filter(
            b =>
              !topNames.has(b.projectName) &&
              buildMatchesSearch(b, search, data.deployTargets),
          )
          const showingAll = expandedAllFor.has(c.key)

          return (
            <section key={c.key} data-customer-key={c.key}>
              <header className="flex items-baseline gap-3 mb-2">
                <h2 className="text-base font-semibold">{c.label}</h2>
              </header>

              <div className="space-y-3">
                {topSlots.length === 0 && remaining.length === 0 && (
                  <div className="text-xs text-muted-foreground italic">
                    No builds match the current filter
                  </div>
                )}

                {topSlots.map(({ build, pinned }) => (
                  <BuildCardSlot
                    key={build.projectName}
                    build={build}
                    deployRows={groupDeployTargetsForBuild(build, data.deployTargets, build.customerKey)}
                    isPinned={pinned}
                    onNavigate={navigate}
                    searchTerm={search}
                  />
                ))}

                {remaining.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpandAll(c.key)}
                    className="text-xs text-primary hover:underline"
                    aria-expanded={showingAll}
                  >
                    {showingAll ? 'Hide extras' : `Show all ${c.allBuilds.length} projects`}
                  </button>
                )}

                {showingAll &&
                  remaining.map(b => (
                    <BuildCardSlot
                      key={b.projectName}
                      build={b}
                      deployRows={groupDeployTargetsForBuild(b, data.deployTargets, b.customerKey)}
                      onNavigate={navigate}
                      searchTerm={search}
                    />
                  ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
