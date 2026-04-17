import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '../../components/ui/card'
import { cn, formatDuration } from '../../lib/utils'
import { BuildHeader } from './BuildHeader'
import { BuildCardDetails } from './BuildCardDetails'
import { GithubIcon } from './GithubIcon'
import { DEPLOY_STATUS } from './shared'
import type { DeployRow } from './shared'
import type { BuildCard } from './types'

export interface BuildAlertInfo {
  type: 'failure' | 'recovery'
  at: string
  version: string | null
  buildNumber: string | number
  notifiedPeople: string[]
  ticketKeys: string[]
}

interface DenseCardProps {
  build: BuildCard
  deployRows: DeployRow[]
  onNavigate?: (path: string) => void
  defaultExpanded?: boolean
  searchTerm?: string
  alert?: BuildAlertInfo | null
}

const GROUP_ALL_GREEN = { color: 'text-green-400', dot: 'bg-green-500' }
const GROUP_PARTIAL = { color: 'text-yellow-400', dot: 'bg-yellow-500' }

function getIndividualRowStyle(row: DeployRow) {
  if (row.status === 'Mixed' && row.detail) {
    // outlier: yellow
    return GROUP_PARTIAL
  }
  return (
    DEPLOY_STATUS[row.status] || {
      color: 'text-muted-foreground',
      dot: 'bg-gray-500',
    }
  )
}

function getGroupRowStyle(row: DeployRow) {
  const allGreen =
    row.status === 'Succeeded' &&
    row.succeededCount != null &&
    row.totalCount != null &&
    row.succeededCount === row.totalCount
  return allGreen ? GROUP_ALL_GREEN : GROUP_PARTIAL
}

function statusIcon(status: DeployRow['status']): string {
  if (status === 'Succeeded') return '✓'
  if (status === 'Failed') return '✗'
  if (status === 'InProgress') return '...'
  return '—'
}

export function DenseCard({
  build,
  deployRows,
  onNavigate,
  defaultExpanded = true,
  searchTerm,
  alert,
}: DenseCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const routerNavigate = useNavigate()
  const navigate = onNavigate ?? routerNavigate
  const latest = build.builds[0]

  const handleReleaseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (build.version) navigate(`/releases/webplatform:${build.version}`)
  }

  const toggle = () => setExpanded(prev => !prev)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }

  // Compute effective deploy counts (group rows expand to their totalCount)
  let effectiveSucceeded = 0
  let effectiveTotal = 0
  for (const row of deployRows) {
    if (row.kind === 'group') {
      effectiveSucceeded += row.succeededCount ?? 0
      effectiveTotal += row.totalCount ?? 0
    } else {
      effectiveSucceeded += row.status === 'Succeeded' ? 1 : 0
      effectiveTotal += 1
    }
  }
  const summaryText =
    effectiveTotal === 0 ? 'No deploy targets' : `${effectiveSucceeded}/${effectiveTotal} deployed`

  return (
    <div className="flex flex-col md:flex-row md:items-start gap-2 md:gap-0">
      <Card
        className={cn(
          'flex-1 min-w-0 overflow-hidden',
          build.latestStatus === 'FAILED' && 'border-red-500/20',
        )}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={handleKeyDown}
          aria-expanded={expanded}
          aria-label="Toggle build details"
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/20 transition-colors text-left cursor-pointer"
        >
          <BuildHeader build={build} className="flex-1" />
          {alert && (
            <span
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border shrink-0',
                alert.type === 'failure'
                  ? 'bg-red-500/10 text-red-400 border-red-500/30'
                  : 'bg-green-500/10 text-green-400 border-green-500/30'
              )}
              title={`${alert.type === 'failure' ? 'Failure' : 'Recovery'} alert sent at ${new Date(alert.at).toLocaleTimeString()}\nNotified: ${alert.notifiedPeople.join(', ') || 'none'}\nTickets: ${alert.ticketKeys.slice(0, 5).join(', ')}${alert.ticketKeys.length > 5 ? ` +${alert.ticketKeys.length - 5}` : ''}`}
            >
              {alert.type === 'failure' ? '🔔' : '✓'} {alert.notifiedPeople.length} notified
            </span>
          )}
          {build.version && (
            <button
              type="button"
              onClick={handleReleaseClick}
              className="text-xs text-primary hover:underline shrink-0"
            >
              release
            </button>
          )}
          {build.prUrl ? (
            <a
              href={build.prUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open PR"
              onClick={e => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
            >
              <GithubIcon />
              <span>PR</span>
            </a>
          ) : (
            <a
              href={build.githubBranchUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open branch on GitHub"
              onClick={e => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline shrink-0"
            >
              <GithubIcon />
              <span>branch</span>
            </a>
          )}
          <span className="text-xs text-muted-foreground shrink-0">{expanded ? '▾' : '▸'}</span>
        </div>

        {expanded && <BuildCardDetails build={build} searchTerm={searchTerm} />}
      </Card>

      {/* Arrow connector with build time — hidden on mobile */}
      <div className="hidden md:flex items-center justify-center shrink-0 w-44 px-3">
        <div className="flex flex-col items-center w-full">
          {latest?.durationSec != null && (
            <span className="text-[10px] text-muted-foreground/50 mb-1.5">
              {formatDuration(latest.durationSec)}
            </span>
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

      {/* Deploy-targets sidecar */}
      <Card className="w-full md:w-52 shrink-0 overflow-hidden">
        {expanded ? (
          <div className="px-3 py-3 flex flex-col">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Deploys to
            </h4>
            {deployRows.length > 0 ? (
              <>
                <div className="space-y-1.5 flex-1">
                  {deployRows.map(row => {
                    if (row.kind === 'group') {
                      const style = getGroupRowStyle(row)
                      return (
                        <div key={row.key} className="flex items-center gap-2">
                          <span className={cn('w-2 h-2 rounded-full shrink-0', style.dot)} />
                          <span className="text-xs flex-1 truncate">{row.label}</span>
                          <span className={cn('text-[10px] shrink-0', style.color)}>
                            {row.succeededCount}/{row.totalCount}
                          </span>
                        </div>
                      )
                    }
                    const style = getIndividualRowStyle(row)
                    return (
                      <div key={row.key} className="flex items-center gap-2">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', style.dot)} />
                        <span className="text-xs flex-1 truncate">
                          {row.label}
                          {row.detail && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {row.detail}
                            </span>
                          )}
                        </span>
                        <span className={cn('text-[10px] shrink-0', style.color)}>
                          {statusIcon(row.status)}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2 pt-1.5 border-t border-border/20">
                  {summaryText}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-xs text-muted-foreground/40 italic">
                  No deploy targets configured
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-3 flex items-center">
            <span className="text-xs text-muted-foreground truncate">{summaryText}</span>
          </div>
        )}
      </Card>
    </div>
  )
}
