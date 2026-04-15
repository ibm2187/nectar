import { Badge } from '../../components/ui/badge'
import { cn, timeAgo, formatDuration } from '../../lib/utils'
import { STATUS_CONFIG } from './shared'
import type { BuildCard } from './types'

interface BuildHeaderProps {
  build: BuildCard
  className?: string
}

function stripProjectPrefix(name: string): string {
  // Longest prefixes first so viv-release- matches before viv-.
  return name
    .replace(/^ECR-Build_/, '')
    .replace(/^viv-release-/, '')
    .replace(/^viv-custom-/, '')
    .replace(/^viv-/, '')
}

function stripBranchPrefix(branch: string): string {
  return branch.replace(/^releases\//, '')
}

/**
 * Display-only header content: status dot, project name, branch, badges,
 * status label, duration, time ago. All clickable elements (PR link, release
 * link, expand toggle) live in the parent card on the right side.
 */
export function BuildHeader({ build, className }: BuildHeaderProps) {
  const info = STATUS_CONFIG[build.latestStatus] || STATUS_CONFIG.STOPPED
  const latest = build.builds[0]
  const displayProject = stripProjectPrefix(build.projectName)
  const displayBranch = stripBranchPrefix(build.branch)
  const startTime = latest?.startTime || build.latestStartTime

  return (
    <div className={cn('flex items-center gap-2 min-w-0', className)}>
      <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', info.dot)} aria-hidden="true" />

      <span className="font-mono font-bold truncate">{displayProject}</span>

      <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted/40 shrink-0">
        {displayBranch}
      </span>

      {build.isCustom && (
        <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30 shrink-0">
          custom
        </Badge>
      )}

      <span className={cn('text-xs shrink-0', info.color)}>{info.label}</span>

      {latest?.durationSec != null && (
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDuration(latest.durationSec)}
        </span>
      )}

      {startTime && (
        <span className="text-xs text-muted-foreground shrink-0">{timeAgo(startTime)}</span>
      )}
    </div>
  )
}
