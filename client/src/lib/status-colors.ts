/**
 * Unified JIRA status color system.
 *
 * Groups map JIRA statuses to workflow stages. Colors are consistent
 * across Home page, TruthView, Tickets page, and Roadmap.
 *
 * Color families:
 *   Yellow  = In Dev (needs developer work)
 *   Red     = Blocked (stuck, needs attention)
 *   Blue    = Ready for QA (code done, waiting for testing)
 *   Purple  = In QA (actively being tested)
 *   Green   = Done (completed)
 *   Gray    = Unknown / unrecognized
 */

export type StatusGroup = 'all' | 'in-dev' | 'blocked' | 'ready-for-qa' | 'in-qa' | 'done'

export interface StatusGroupDef {
  key: StatusGroup
  label: string
  color: string
  pillActive: string
  pillInactive: string
  statuses: string[]
}

export const STATUS_GROUPS: StatusGroupDef[] = [
  {
    key: 'all', label: 'All', color: '', statuses: [],
    pillActive: 'bg-background text-foreground shadow-sm',
    pillInactive: 'text-muted-foreground hover:text-foreground',
  },
  {
    key: 'in-dev', label: 'In Dev', color: 'text-yellow-400', statuses: [
      'Development In Progress', 'In Progress', 'In Review',
      'Waiting for Cherry Pick', 'Open', 'To Do', 'Backlog',
    ],
    pillActive: 'bg-yellow-500/15 text-yellow-400 shadow-sm',
    pillInactive: 'text-muted-foreground hover:text-yellow-400',
  },
  {
    key: 'blocked', label: 'Blocked', color: 'text-red-400', statuses: [
      'Blocked', 'Testing Failed',
    ],
    pillActive: 'bg-red-500/15 text-red-400 shadow-sm',
    pillInactive: 'text-muted-foreground hover:text-red-400',
  },
  {
    key: 'ready-for-qa', label: 'Ready for QA', color: 'text-blue-400', statuses: [
      'Ready For Testing', 'Cherry Picked',
    ],
    pillActive: 'bg-blue-500/15 text-blue-400 shadow-sm',
    pillInactive: 'text-muted-foreground hover:text-blue-400',
  },
  {
    key: 'in-qa', label: 'In QA', color: 'text-purple-400', statuses: [
      'In Testing', 'Testing in Branch', 'Re-verify Bug',
    ],
    pillActive: 'bg-purple-500/15 text-purple-400 shadow-sm',
    pillInactive: 'text-muted-foreground hover:text-purple-400',
  },
  {
    key: 'done', label: 'Done', color: 'text-green-400', statuses: [
      'QA Certified', 'Done', 'Closed', 'Resolved', 'Resolved Without Code',
    ],
    pillActive: 'bg-green-500/15 text-green-400 shadow-sm',
    pillInactive: 'text-muted-foreground hover:text-green-400',
  },
]

// Reverse lookup: JIRA status → group key
const _statusToGroup: Record<string, StatusGroup> = {}
for (const g of STATUS_GROUPS) {
  for (const s of g.statuses) _statusToGroup[s] = g.key
}

export function getStatusGroup(jiraStatus: string): StatusGroup {
  return _statusToGroup[jiraStatus] || 'in-dev'
}

// Badge colors — aligned with groups
const BADGE_COLORS: Record<StatusGroup, string> = {
  'all':          'bg-gray-500/15 text-gray-400 border-gray-500/30',
  'in-dev':       'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  'blocked':      'bg-red-500/15 text-red-400 border-red-500/30',
  'ready-for-qa': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'in-qa':        'bg-purple-500/15 text-purple-400 border-purple-500/30',
  'done':         'bg-green-500/15 text-green-400 border-green-500/30',
}

export function getStatusBadgeColor(jiraStatus: string): string {
  const group = getStatusGroup(jiraStatus)
  return BADGE_COLORS[group] || BADGE_COLORS.all
}

// "Not Assigned" display
export function displayAssignee(name: string | null | undefined): { text: string; className: string } {
  if (!name) return { text: 'Not Assigned', className: 'text-red-400/60 italic' }
  return { text: name, className: 'text-muted-foreground' }
}
