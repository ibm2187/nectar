import { JiraLink } from './JiraLink'
import { OutIcon } from './PersonBadge'
import { cn } from '../lib/utils'
import type { ZohoRef } from '../api/client'

// ── Shared types ──────────────────────────────────────

/** Per-release truth verdict for a ticket (from ticket_truth table). */
export interface TruthEntry {
  jiraKey?: string
  repo?: string
  version: string
  health: string
  healthCategory: string
  healthMessage: string
  onBranch: boolean
  prNumber?: number | null
  prUrl?: string | null
  stage?: string | null
  inTarget?: boolean
  inFixVersion?: boolean
  computedAt?: string | null
}

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
  /** Built-in JIRA priority (Urgent/Highest/High/Medium/Low/Lowest) */
  priority?: string | null
  /** "Risk Level" custom field — e.g. "1 - Low Risk", "2 - Medium Risk", "3 - High Risk" */
  riskLevel?: string | null
  /** "Primary Customer Priority" custom field — URGENT/High/Medium/Low/Internal Only */
  customerPriority?: string | null
  /** Per-release truth verdicts (from persisted ticket_truth table). */
  truth?: TruthEntry[]
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
        <OutIcon name={t.assignee} />
      </td>
      <td className="px-3 py-2 align-top hidden md:table-cell">
        <span className="text-xs text-muted-foreground">{t.qaAssignee || '—'}</span>
        <OutIcon name={t.qaAssignee} />
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

// ── PriorityBadge ────────────────────────────────────

export function PriorityBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-xs text-muted-foreground italic">—</span>
  const v = value.toLowerCase()
  const style =
    v === 'urgent' || v === 'highest'
      ? 'bg-red-500/15 text-red-400 border-red-500/40'
      : v === 'high'
        ? 'bg-orange-500/15 text-orange-400 border-orange-500/40'
        : v === 'medium'
          ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/40'
          : v === 'low' || v === 'lowest'
            ? 'bg-muted/30 text-muted-foreground border-muted'
            : 'bg-blue-500/10 text-blue-400 border-blue-500/30' // "Internal Only" etc.
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap', style)} title={value}>
      {value}
    </span>
  )
}

// ── RiskBadge ────────────────────────────────────────

export function RiskBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-xs text-muted-foreground italic">—</span>
  // "1 - Low Risk" / "2 - Medium Risk" / "3 - High Risk"
  const m = value.match(/^(\d+)/)
  const level = m ? parseInt(m[1], 10) : null
  const label = value.replace(/^\d+\s*-\s*/, '') // strip leading "1 - "
  const style =
    level === 3
      ? 'bg-red-500/15 text-red-400 border-red-500/40'
      : level === 2
        ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/40'
        : level === 1
          ? 'bg-green-500/10 text-green-400 border-green-500/30'
          : 'bg-muted/30 text-muted-foreground border-muted'
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap', style)} title={value}>
      {label}
    </span>
  )
}

// ── Next-release helpers ─────────────────────────────

/** Return the first non-shipped release for a ticket (the "next" one). */
export function getNextRelease(ticket: TicketRowData): TicketRowData['releases'][number] | null {
  for (const r of (ticket.releases || [])) {
    if (!r.isShipped) return r
  }
  return null
}

// Numeric ordering for JIRA priority/customer-priority enums.
// Lower number = more urgent, so ascending sort puts urgent first.
const PRIORITY_ORDER: Record<string, number> = {
  'urgent': 0, 'highest': 1, 'high': 2, 'medium': 3, 'low': 4, 'lowest': 5,
  'internal only': 6,
}
export function priorityOrdinal(value: string | null | undefined): number | null {
  if (!value) return null
  return PRIORITY_ORDER[value.toLowerCase()] ?? 99
}

// Risk Level field comes through as "1 - Low Risk", "2 - Medium Risk", "3 - High Risk".
// Higher number = riskier, so DESC puts high risk first.
export function riskOrdinal(value: string | null | undefined): number | null {
  if (!value) return null
  const m = value.match(/^(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

// ── NextReleaseVersionCell ───────────────────────────

export function NextReleaseVersionCell({ next, onClick }: {
  next: TicketRowData['releases'][number] | null
  onClick: (version: string) => void
}) {
  if (!next) return <span className="text-xs text-muted-foreground italic">—</span>
  const isOverdue = next.isOverdue
  return (
    <button
      type="button"
      onClick={() => onClick(next.version)}
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border cursor-pointer transition-colors',
        isOverdue
          ? 'bg-red-500/10 text-red-400 border-red-500/40 hover:bg-red-500/20'
          : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/40 hover:bg-yellow-500/20'
      )}
      title={`${next.version}${next.jiraReleaseDate ? ' — ' + next.jiraReleaseDate : ''}${isOverdue ? ' (OVERDUE)' : ''} · click to filter`}
    >
      {next.version}
    </button>
  )
}

// ── NextReleaseDateCell ──────────────────────────────

export function NextReleaseDateCell({ next }: { next: TicketRowData['releases'][number] | null }) {
  if (!next || !next.jiraReleaseDate) {
    return <span className="text-xs text-muted-foreground italic">—</span>
  }
  return (
    <span className={cn('text-xs whitespace-nowrap', next.isOverdue && 'text-red-400 font-medium')}>
      {next.jiraReleaseDate}
    </span>
  )
}

// ── HealthBadge ─────────────────────────────────────

const HEALTH_CATEGORY_PRIORITY: Record<string, number> = {
  attention: 0,
  'in-dev': 1,
  'awaiting-cp': 2,
  'in-qa': 3,
  done: 4,
}

const HEALTH_CATEGORY_COLORS: Record<string, string> = {
  'done':        'bg-green-500/15 text-green-400 border-green-500/30',
  'in-qa':       'bg-purple-500/15 text-purple-400 border-purple-500/30',
  'awaiting-cp': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'in-dev':      'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  'attention':   'bg-red-500/15 text-red-400 border-red-500/30',
}

const HEALTH_DISPLAY: Record<string, string> = {
  'healthy':        'Healthy',
  'no-code':        'No Code',
  'in-qa':          'In QA',
  'pr-pending':     'PR Open',
  'status-stale':   'Stale',
  'awaiting-cp':    'Awaiting CP',
  'in-dev':         'In Dev',
  'pre-dev':        'Pre-Dev',
  'not-on-branch':  'Missing',
  'failed-qa':      'Failed QA',
  'blocked':        'Blocked',
  'rogue':          'Rogue',
  'needs-review':   'Review',
  'unknown':        'Unknown',
}

/** Shows the worst health across all truth entries for a ticket. */
export function HealthBadge({ truth }: { truth?: TruthEntry[] }) {
  if (!truth || truth.length === 0) {
    return <span className="text-xs text-muted-foreground italic">—</span>
  }

  // Find the worst health across all releases
  const worst = truth.reduce((w, t) => {
    const wp = HEALTH_CATEGORY_PRIORITY[w.healthCategory] ?? 5
    const tp = HEALTH_CATEGORY_PRIORITY[t.healthCategory] ?? 5
    return tp < wp ? t : w
  })

  const colorClass = HEALTH_CATEGORY_COLORS[worst.healthCategory] || HEALTH_CATEGORY_COLORS.attention
  const label = HEALTH_DISPLAY[worst.health] || worst.health

  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap',
        colorClass,
      )}
      title={worst.healthMessage || `${worst.health} (${worst.healthCategory})`}
    >
      {label}
    </span>
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
