import { JiraLink } from './JiraLink'
import { cn } from '../lib/utils'
import type { ZohoRef } from '../api/client'

// ── Shared types ──────────────────────────────────────

export type ReleaseSource = 'both' | 'target' | 'fixVersion'

export interface ReleaseMembership {
  repo: string
  version: string
  inTarget: boolean
  inFixVersion: boolean
  source: ReleaseSource
  // Optional enrichments — present when fed by /api/tickets/home
  state?: string
  jiraReleaseDate?: string | null
  isImmediate?: boolean
  isShipped?: boolean
  isOverdue?: boolean
}

export interface TicketRowData {
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

// ── TicketRow ─────────────────────────────────────────

export function TicketRow({ ticket: t, onReleaseClick }: {
  ticket: TicketRowData
  onReleaseClick?: (version: string) => void
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
      <td className="px-3 py-2 align-top hidden md:table-cell">
        <span className="text-xs text-muted-foreground">{t.qaAssignee || '—'}</span>
      </td>
      <td className="px-3 py-2 align-top hidden md:table-cell">
        <TicketDeployedCell envs={t.deployedEnvironments} jiraStatus={t.jiraStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {t.releases.map(r => (
            <ReleaseBadge
              key={`${r.repo}:${r.version}`}
              release={r}
              onClick={() => onReleaseClick?.(r.version)}
            />
          ))}
        </div>
      </td>
    </tr>
  )
}

// ── ReleaseBadge ──────────────────────────────────────

export function ReleaseBadge({ release, onClick }: {
  release: ReleaseMembership
  onClick?: () => void
}) {
  // Shipped releases get a distinct muted+green look with checkmark
  if (release.isShipped) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClick?.() }}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono border bg-green-900/20 text-green-500/80 border-green-500/20 hover:bg-green-900/30 transition-colors cursor-pointer"
        title={`${release.repo} · ${release.version} — Shipped${release.jiraReleaseDate ? ' on ' + release.jiraReleaseDate : ''}`}
      >
        <span>✓</span>{release.version}
      </button>
    )
  }

  // Overdue releases get a red ring
  const isOverdue = release.isOverdue

  const baseStyles: Record<ReleaseSource, string> = {
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
  const dateSuffix = release.jiraReleaseDate ? ` · ${release.jiraReleaseDate}${isOverdue ? ' (OVERDUE)' : ''}` : ''
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer',
        baseStyles[release.source],
        isOverdue && 'ring-1 ring-red-500/60'
      )}
      title={`${release.repo} · ${release.version}${dateSuffix} — ${titles[release.source]}`}
    >
      {prefix[release.source]}{release.version}
    </button>
  )
}

// ── TicketDeployedCell ────────────────────────────────

export function TicketDeployedCell({ envs, jiraStatus }: { envs: string[]; jiraStatus: string }) {
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
      className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border', style)}
      title={`${envs.length} env${envs.length !== 1 ? 's' : ''}: ${envs.join(', ')}`}
    >
      {label}
    </span>
  )
}
