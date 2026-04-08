const BASE = '/api'

export async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data as T
}

export interface Release {
  id: string
  repo: string | null
  version: string
  state: 'planning' | 'cutting' | 'stabilizing' | 'approved' | 'deploying' | 'done'
  branch: string
  cutFrom: string | null
  cutAt: string | null
  cutBy: string | null
  tickets: Ticket[]
  cherryPicks: CherryPick[]
  ci: { status: string | null; buildUrl: string | null; lastRun: string | null }
  risk: { score: string | null; numericScore: number | null; factors: RiskFactor[] }
  deployments: Deployment[]
  approvals: Approval[]
  notes: string | null
  createdAt: string
  updatedAt: string
  // JIRA metadata (optional, set by JIRA sync)
  jiraVersionId?: string
  jiraVersionName?: string
  jiraReleased?: boolean
  jiraReleaseDate?: string | null
  jiraArchived?: boolean
}

export interface Ticket {
  key: string
  summary: string
  state: string
  pr: number | null
}

export interface CherryPick {
  sha: string
  pr: number | null
  ticket: string | null
  status: string
}

export interface RiskFactor {
  reason: string
  points: number
  files?: string[]
}

export interface Deployment {
  customer: string
  env: string
  status: string
  at: string
  triggeredBy?: string
}

export interface Approval {
  user: string
  role: string
  at: string
}

// Legacy type — kept for backwards compat with old poller
export interface CustomerVersion {
  name: string
  staging: string | null
  stagingReachable: boolean | null
  stagingLastChecked: string | null
  production: string | null
  productionReachable: boolean | null
  productionLastChecked: string | null
}

// New entity types
export interface Customer {
  id: string
  name: string
  configName: string | null
  domain: string | null
  domainPrefix: string
  integrations: string[]
  hasFranchises: boolean
  active: boolean
  syncedFrom: string
  lastSyncedAt: string
  createdAt: string
  updatedAt: string
  notes?: string | null
}

export type EnvTier =
  | 'production'
  | 'staging'
  | 'uat'
  | 'training'
  | 'sandbox'
  | 'loadtest'
  | 'demo'
  | 'integration'
  | 'test'
  | 'qa'
  | 'dev'
  | 'other'

export interface Environment {
  id: string
  nodeEnv: string
  customerId: string
  franchise: string | null
  franchiseDisplayName: string | null
  tier: EnvTier
  name: string
  url: string | null
  versionEndpoint: string | null
  currentVersion: string | null
  currentBranch: string | null
  lastChecked: string | null
  reachable: boolean | null
  versionSetManually?: boolean
  versionSetBy?: string | null
  versionSetAt?: string | null
  disabled: boolean
  ascendEnabled?: boolean
  disableOutgoingCommunication?: boolean
  syncedFrom: string
  lastSyncedAt: string
  createdAt: string
  updatedAt: string
  notes?: string | null
}

export interface EnvDeployment {
  id: string
  environmentId: string
  customerId: string
  version: string
  branch: string | null
  previousVersion: string | null
  detectedAt: string
  endedAt: string | null
  source: string
}

export interface AuditEntry {
  id: string
  version: string
  action: string
  detail: Record<string, unknown>
  user: string | null
  at: string
}

export interface ValidationReport {
  version: string
  state: string
  timestamp: string
  jira: { ok: boolean; issues: { key?: string; problem: string }[] }
  git: { ok: boolean; issues: { ticket?: string; pr?: number; problem: string }[] }
  ci: { ok: boolean; issues: { problem: string }[] }
  approvals: { ok: boolean; issues: { problem: string; missing?: string[] }[] }
  ready: boolean
}

// Release Truth — Per-ticket verification with health rules
export type HealthCategory = 'done' | 'in-qa' | 'awaiting-cp' | 'in-dev' | 'attention'

export type Health =
  | 'healthy'      // Certified + on branch
  | 'no-code'      // Resolved without code change
  | 'in-qa'        // In QA, on branch — expected
  | 'pr-pending'   // Cherry-pick PR open, not yet merged
  | 'status-stale' // On branch but JIRA hasn't caught up
  | 'awaiting-cp'  // Waiting for cherry-pick
  | 'pre-dev'      // Not started
  | 'in-dev'       // In development
  | 'needs-review' // Needs re-verification (e.g. "Re-verify Bug") — pre-work investigation
  | 'lying'        // JIRA says past code review but not on branch — RED FLAG
  | 'stale-cert'   // Certified but not on branch — possibly reverted
  | 'failed-qa'    // Failed QA
  | 'blocked'      // Blocked / Needs Requirements
  | 'unknown'      // Unrecognized JIRA status

export interface VerifiedTicket {
  key: string
  summary: string
  jiraStatus: string
  type: string | null
  assignee: string | null
  stage: string
  onBranch: boolean
  branchHasCommits: boolean
  pr: {
    prNumber: number
    prTitle: string
    prAuthor: string | null
    prUrl: string
    prCreatedAt: string
  } | null
  health: Health
  healthCategory: HealthCategory
  healthMessage: string
}

export interface RogueCommit {
  key: string
  commitSha: string | null
  commitMessage: string | null
}

export interface ReleaseTruthReport {
  repo: string
  version: string
  branch: string | null
  jira: {
    versionId: string | null
    versionName: string | null
    released: boolean
    releaseDate: string | null
    archived: boolean
  }
  git: {
    branchExists: boolean
    commitCount: number
    cherryPickCount: number
    cutFrom: string | null
  }
  pullRequests: {
    open: number
  }
  rollup: {
    planned: number
    done: number
    inQa: number
    awaitingCp: number
    inDev: number
    attention: number
    rogue: number
  }
  verified: VerifiedTicket[]
  rogues: RogueCommit[]
  derivedState: string
  currentState: string
  stateMatchesReality: boolean
  computedAt: string
  durationMs: number
}
