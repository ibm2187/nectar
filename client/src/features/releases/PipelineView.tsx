import { cn, timeAgo } from '../../lib/utils'
import { Card, CardContent } from '../../components/ui/card'
import { JiraLink } from '../../components/JiraLink'

// ── Types ────────────────────────────────────────────────

interface BuildInfo {
  buildNumber: number
  status: string // SUCCEEDED, FAILED, IN_PROGRESS, STOPPED
  startTime: string | null
  endTime: string | null
  durationSec: number | null
  commitSha: string | null
  initiator?: string | null
}

interface PipelineData {
  projectName?: string
  builds?: BuildInfo[]
  latest?: BuildInfo
  newCommits?: Array<{ sha: string; message: string }>
  jiraKeys?: string[]
  deploys?: unknown[]
  syncedAt?: string
  deploySyncedAt?: string
}

// ── Build status styling ─────────────────────────────────

const BUILD_STATUS: Record<string, { label: string; color: string; dot: string }> = {
  SUCCEEDED:   { label: 'Succeeded',   color: 'text-green-400',  dot: 'bg-green-500' },
  FAILED:      { label: 'Failed',      color: 'text-red-400',    dot: 'bg-red-500' },
  IN_PROGRESS: { label: 'Building...',  color: 'text-blue-400',  dot: 'bg-blue-500 animate-pulse' },
  STOPPED:     { label: 'Stopped',     color: 'text-gray-400',   dot: 'bg-gray-500' },
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${min}m ${s}s` : `${min}m`
}

// ── Full Pipeline View (for release detail page) ─────────

export function PipelineView({ pipeline }: { pipeline: PipelineData | null }) {
  if (!pipeline) {
    return <p className="text-sm text-muted-foreground italic py-2">No pipeline data — build project not found for this release</p>
  }

  const latest = pipeline.latest
  const builds = pipeline.builds || []
  const newCommits = pipeline.newCommits || []
  const jiraKeys = pipeline.jiraKeys || []

  return (
    <div className="space-y-4">
      {latest ? (
        <BuildCard build={latest} previousBuilds={builds.slice(1)} newCommits={newCommits} jiraKeys={jiraKeys} />
      ) : (
        <p className="text-sm text-muted-foreground italic">No builds found for this release</p>
      )}

      {pipeline.syncedAt && (
        <p className="text-xs text-muted-foreground">Synced {timeAgo(pipeline.syncedAt)}</p>
      )}
    </div>
  )
}

// ── Build card ───────────────────────────────────────────

function BuildCard({ build, previousBuilds, newCommits, jiraKeys }: {
  build: BuildInfo
  previousBuilds: BuildInfo[]
  newCommits: Array<{ sha: string; message: string }>
  jiraKeys: string[]
}) {
  const info = BUILD_STATUS[build.status] || BUILD_STATUS.STOPPED

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <span className={cn("w-3 h-3 rounded-full shrink-0", info.dot)} />
          <span className={cn("font-semibold", info.color)}>{info.label}</span>
          <span className="text-sm text-muted-foreground">Build #{build.buildNumber}</span>
          {build.durationSec && (
            <span className="text-xs text-muted-foreground">{formatDuration(build.durationSec)}</span>
          )}
          {build.startTime && (
            <span className="text-xs text-muted-foreground ml-auto">{timeAgo(build.startTime)}</span>
          )}
        </div>

        {/* New commits in this build */}
        {newCommits.length > 0 && (
          <div className="mb-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              {newCommits.length} commit{newCommits.length !== 1 ? 's' : ''} since last build
              {jiraKeys.length > 0 && ` · ${jiraKeys.length} JIRA ticket${jiraKeys.length !== 1 ? 's' : ''}`}
            </h4>

            {/* JIRA keys */}
            {jiraKeys.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {jiraKeys.map(key => (
                  <JiraLink key={key} jiraKey={key} className="text-xs" />
                ))}
              </div>
            )}

            {/* Commit list */}
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {newCommits.slice(0, 20).map(c => (
                <div key={c.sha} className="flex items-start gap-2 text-xs py-0.5">
                  <span className="font-mono text-muted-foreground shrink-0">{c.sha.slice(0, 7)}</span>
                  <span className="text-foreground truncate">{c.message}</span>
                </div>
              ))}
              {newCommits.length > 20 && (
                <div className="text-xs text-muted-foreground">+{newCommits.length - 20} more</div>
              )}
            </div>
          </div>
        )}

        {/* Build history */}
        {previousBuilds.length > 0 && (
          <div className="border-t border-border/30 pt-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Previous Builds</h4>
            <div className="flex items-center gap-1.5">
              {previousBuilds.slice(0, 8).map(b => {
                const bi = BUILD_STATUS[b.status] || BUILD_STATUS.STOPPED
                return (
                  <div
                    key={b.buildNumber}
                    className={cn("w-6 h-6 rounded flex items-center justify-center text-[9px] font-medium border", {
                      'bg-green-500/15 border-green-500/30 text-green-400': b.status === 'SUCCEEDED',
                      'bg-red-500/15 border-red-500/30 text-red-400': b.status === 'FAILED',
                      'bg-blue-500/15 border-blue-500/30 text-blue-400': b.status === 'IN_PROGRESS',
                      'bg-gray-500/15 border-gray-500/30 text-gray-400': b.status === 'STOPPED',
                    })}
                    title={`Build #${b.buildNumber}: ${bi.label}${b.startTime ? ` — ${timeAgo(b.startTime)}` : ''}`}
                  >
                    {b.buildNumber}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}


// ── Compact badge for Home page release headers ──────────

export function PipelineBadge({ pipeline }: { pipeline: PipelineData | null }) {
  if (!pipeline?.latest) return null

  const build = pipeline.latest
  const buildInfo = BUILD_STATUS[build.status] || BUILD_STATUS.STOPPED

  return (
    <span className="inline-flex items-center gap-1.5 text-xs shrink-0 px-1.5 py-0.5 rounded border border-border/30 bg-card/50">
      <span className={cn("w-1.5 h-1.5 rounded-full", buildInfo.dot)} />
      <span className={cn(buildInfo.color)}>
        Build #{build.buildNumber} {build.status === 'IN_PROGRESS' ? '...' : build.status === 'SUCCEEDED' ? '✓' : build.status === 'FAILED' ? '✗' : '—'}
      </span>
      {build.startTime && <span className="text-muted-foreground">{timeAgo(build.startTime)}</span>}
    </span>
  )
}
