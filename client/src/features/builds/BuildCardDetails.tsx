import { useMemo, useState } from 'react'
import { JiraLink } from '../../components/JiraLink'
import { cn, timeAgo, formatDuration } from '../../lib/utils'
import { CommitList } from './CommitList'
import type { BuildCard, BuildInfo } from './types'

interface BuildCardDetailsProps {
  build: BuildCard
  searchTerm?: string
}

export function BuildCardDetails({ build, searchTerm }: BuildCardDetailsProps) {
  const hasJira = build.jiraKeys.length > 0
  const hasCommits = build.newCommits.length > 0
  const hasHistory = build.builds.length > 1

  if (!hasJira && !hasCommits && !hasHistory) return null

  return (
    <div className="px-4 pb-3 space-y-3 border-t border-border/20">
      {hasJira && (
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

      {hasCommits && <CommitList commits={build.newCommits} />}

      {hasHistory && (
        <BuildHistory builds={build.builds} projectName={build.projectName} searchTerm={searchTerm || ''} />
      )}
    </div>
  )
}

// ── Build history with expandable JIRA keys ──────────────

interface BuildHistoryProps {
  builds: BuildInfo[]
  projectName: string
  searchTerm: string
}

function BuildHistory({ builds, projectName, searchTerm }: BuildHistoryProps) {
  // Auto-expand the build that matches the search term (by JIRA key)
  const autoExpand = useMemo(() => {
    if (!searchTerm) return null
    const s = searchTerm.toLowerCase()
    for (const b of builds) {
      if (b.jiraKeys?.some(k => k.toLowerCase().includes(s))) {
        return b.buildNumber
      }
    }
    return null
  }, [builds, searchTerm])

  const [selectedBuild, setSelectedBuild] = useState<number | null>(null)
  const active = autoExpand ?? selectedBuild

  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        History
      </h4>
      <div className="flex items-center gap-1.5 flex-wrap">
        {builds.map(b => (
          <button
            key={b.buildNumber}
            type="button"
            onClick={e => {
              e.stopPropagation()
              setSelectedBuild(selectedBuild === b.buildNumber ? null : b.buildNumber)
            }}
            className={cn(
              'flex flex-col items-center gap-0.5 px-1.5 py-1 rounded border cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all min-w-[40px]',
              b.status === 'SUCCEEDED'
                ? 'bg-green-500/10 border-green-500/30'
                : b.status === 'FAILED'
                  ? 'bg-red-500/10 border-red-500/30'
                  : b.status === 'IN_PROGRESS'
                    ? 'bg-blue-500/10 border-blue-500/30'
                    : 'bg-gray-500/10 border-gray-500/30',
              active === b.buildNumber && 'ring-1 ring-primary/50',
            )}
          >
            <span
              className={cn(
                'text-[10px] font-semibold',
                b.status === 'SUCCEEDED'
                  ? 'text-green-400'
                  : b.status === 'FAILED'
                    ? 'text-red-400'
                    : b.status === 'IN_PROGRESS'
                      ? 'text-blue-400'
                      : 'text-gray-400',
              )}
            >
              #{b.buildNumber}
            </span>
            <span className="text-[9px] text-muted-foreground">
              {b.startTime ? timeAgo(b.startTime) : '—'}
            </span>
          </button>
        ))}
      </div>

      {active != null &&
        (() => {
          const b = builds.find(x => x.buildNumber === active)
          if (!b) return null
          const keys = b.jiraKeys || []
          return (
            <div className="mt-2 p-2 rounded border border-border/30 bg-accent/5">
              <div className="flex items-center gap-2 text-xs mb-1 flex-wrap">
                <span className="font-semibold">Build #{b.buildNumber}</span>
                <span
                  className={cn(
                    b.status === 'SUCCEEDED'
                      ? 'text-green-400'
                      : b.status === 'FAILED'
                        ? 'text-red-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {b.status}
                </span>
                {b.durationSec != null && (
                  <span className="text-muted-foreground">{formatDuration(b.durationSec)}</span>
                )}
                {b.startTime && (
                  <span className="text-muted-foreground">{timeAgo(b.startTime)}</span>
                )}
                <a
                  href={`https://us-east-1.console.aws.amazon.com/codesuite/codebuild/projects/${projectName}/build/${projectName}%3A${b.buildNumber}/log`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="text-primary hover:underline ml-auto"
                >
                  AWS Logs
                </a>
              </div>
              {keys.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {keys.map(k => (
                    <JiraLink key={k} jiraKey={k} className="text-xs" />
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground italic">
                  No JIRA tickets in this build
                </span>
              )}
            </div>
          )
        })()}
    </div>
  )
}
