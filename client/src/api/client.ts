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

export type EffectiveReleaseStatus = 'shipped' | 'in-flight' | 'upcoming' | 'overdue' | 'unknown'

export interface ReleaseStatusSignal {
  type: 'jira-released' | 'running-in-prod' | 'superseded' | 'state-done'
  detail: string
  env?: string
  envVersion?: string
}

export interface EffectiveStatus {
  status: EffectiveReleaseStatus
  shippedSignals: ReleaseStatusSignal[]
  matchingEnvs: Array<{ id: string; customerId: string; currentVersion: string | null }>
  daysUntil?: number
  daysOverdue?: number
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
  // Set by backend when releases are returned via /api/releases or /api/releases/calendar
  effectiveStatus?: EffectiveStatus
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

  // Live data from /api/status/* endpoints
  features?: EnvFeatures | null
  integrations?: EnvIntegrations | null
  upgrades?: EnvUpgrades | null
  lastFeaturesCheckedAt?: string | null
  lastIntegrationsCheckedAt?: string | null
  lastUpgradesCheckedAt?: string | null
}

export interface EnvFeatureFlag {
  key: string
  enabled: boolean
  isMobileFeature: boolean
}

export interface EnvFeatures {
  dbFeatureFlags: EnvFeatureFlag[]
  configFeatures: {
    portalFeatureFlag: Record<string, unknown>
    mobileFeatureFlag: Record<string, unknown>
    workflow: Record<string, unknown>
  }
  toggles: Record<string, boolean>
}

export interface EnvIntegrations {
  disableOutgoingCommunication: boolean
  dbIntegrations: Record<string, { enabled: boolean; configured: boolean }>
  configIntegrations: Record<string, { enabled: boolean; syncAllData?: boolean }>
  dataPublishing: Record<string, boolean>
  sqsQueues: Record<string, Record<string, string[]>>
}

/** History entry joined with an upgrade, or null if never run */
export interface EnvUpgradeHistory {
  startedAt: string | null
  completedAt: string | null
  inProgress: boolean
  skipped: boolean
  skippedReason: string | null
  skippedBy: string | null
  verificationStatus: 'SUCCESS' | 'FAILED' | null
  verificationError: string | null
  verificationMetadata: Record<string, unknown> | null
  forceRun: boolean
  version: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** A single upgrade from the pool, with history joined in */
export interface EnvUpgradeItem {
  upgradeName: string
  desiredEnvs: string[]
  nonBlocking: boolean
  enforceDesiredEnvs: boolean
  hasVerify: boolean
  history: EnvUpgradeHistory | null
}

/**
 * Merged result of walking every page of webplatform's /api/status/upgrades.
 * Stored in the customer store after Nectar's poller aggregates all pages.
 */
export interface EnvUpgrades {
  environment: string | null
  totalInPool: number
  items: EnvUpgradeItem[]
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
  | 'healthy'       // Certified + on branch
  | 'no-code'       // Resolved without code change
  | 'in-qa'         // In QA, on branch — expected
  | 'pr-pending'    // Cherry-pick PR open, not yet merged
  | 'status-stale'  // On branch but JIRA hasn't caught up
  | 'awaiting-cp'   // Waiting for cherry-pick
  | 'pre-dev'       // Not started
  | 'in-dev'        // In development
  | 'needs-review'  // Needs re-verification (e.g. "Re-verify Bug")
  | 'not-on-branch' // In JIRA fixVersion but not found on the branch — needs cherry-pick or wrong fixVersion
  | 'failed-qa'     // Failed QA
  | 'blocked'       // Blocked / On hold
  | 'unknown'       // Unrecognized JIRA status
  // Deprecated — kept for backward compatibility with old truth data
  | 'lying'
  | 'stale-cert'

export interface ZohoRef {
  raw: string
  id: string | null
  ticketNumber: string | null
  zohoUrl: string | null
  kind: 'url' | 'ticketNumber' | 'unknown'
  parseable: boolean
}

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
  fixVersions?: string[]
  targetFixVersions?: string[]
  /** True if this release is in the ticket's Target FixVersion (customfield_10594) */
  inTarget?: boolean
  /** True if this release is in the ticket's canonical fixVersions */
  inFixVersion?: boolean
  zohoRef?: ZohoRef | null
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

export interface DeploymentImpactReport {
  target: { version: string; branch: string | null }
  prod: { version: string; branch: string | null }
  targetTruth: ReleaseTruthReport
  delta: {
    commits: { total: number; jiraKeys: string[] }
    tickets: {
      new: VerifiedTicket[]
      shared: VerifiedTicket[]
      deltaOnly: string[]
      total: number
    }
    rollup: {
      planned: number
      done: number
      inQa: number
      awaitingCp: number
      inDev: number
      attention: number
    }
    rogues: RogueCommit[]
  }
  computedAt: string
  durationMs: number
}
