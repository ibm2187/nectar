import type { BuildCard, DeployTarget } from './types'

// ── Status styling ───────────────────────────────────────

export const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string; border: string }> = {
  IN_PROGRESS: { label: 'Building',  color: 'text-blue-400',   dot: 'bg-blue-500 animate-pulse', border: 'border-blue-500/30' },
  FAILED:      { label: 'Failed',    color: 'text-red-400',    dot: 'bg-red-500',                border: 'border-red-500/30' },
  SUCCEEDED:   { label: 'Succeeded', color: 'text-green-400',  dot: 'bg-green-500',              border: 'border-green-500/30' },
  STOPPED:     { label: 'Stopped',   color: 'text-gray-400',   dot: 'bg-gray-500',               border: 'border-gray-500/30' },
}

export const DEPLOY_STATUS: Record<string, { color: string; dot: string }> = {
  Succeeded:  { color: 'text-green-400', dot: 'bg-green-500' },
  InProgress: { color: 'text-blue-400',  dot: 'bg-blue-500 animate-pulse' },
  Failed:     { color: 'text-red-400',   dot: 'bg-red-500' },
}

// ── Deploy target matching ────────────────────────────────
// Some builds produce images with multiple tags (e.g., master → "master" + "latest")
export const TAG_ALIASES: Record<string, string[]> = {
  master: ['master', 'latest'],
}

// ── Deploy row grouping ──────────────────────────────────

export type DeployRowKind = 'individual' | 'group'
export type DeployRowStatus = 'Succeeded' | 'Failed' | 'InProgress' | 'Mixed' | 'Other'

export interface DeployRow {
  key: string
  kind: DeployRowKind
  label: string
  status: DeployRowStatus
  succeededCount?: number
  totalCount?: number
  detail?: string
  pipelineName?: string
}

const FRANCHISE_ENV_RE = /^\d+$/

function toRowStatus(s: string | null | undefined): DeployRowStatus {
  if (s === 'Succeeded') return 'Succeeded'
  if (s === 'Failed') return 'Failed'
  if (s === 'InProgress') return 'InProgress'
  return 'Other'
}

/**
 * Default label is "Customer Env" (e.g. "Tribute Staging"). When the
 * pipeline's ecrRepo doesn't match the standard viv-release-<customerKey>
 * pattern, the pipeline is hosted under a different brand inside the same AWS
 * account (e.g. Tribute account hosts Deploy-HAVEN and Deploy-QUALITYCARE,
 * which read from viv-release-haven and viv-release-qualitycare). Use the
 * pipeline name suffix (after "Deploy-") so the brand is obvious.
 */
function labelForTarget(t: DeployTarget, customerKey?: string): string {
  if (customerKey && t.ecrRepo) {
    const expected = `viv-release-${customerKey}`
    if (t.ecrRepo !== expected) {
      return t.pipelineName.replace(/^Deploy-/, '')
    }
  }
  return `${t.customer} ${t.env}`
}

function toIndividualRow(
  t: DeployTarget,
  customerKey?: string,
  detail?: string,
  overrideStatus?: DeployRowStatus,
): DeployRow {
  return {
    key: `ind:${t.pipelineName}`,
    kind: 'individual',
    label: labelForTarget(t, customerKey),
    status: overrideStatus ?? toRowStatus(t.status),
    detail,
    pipelineName: t.pipelineName,
  }
}

/**
 * Detect the production-version tag for a customer: the imageTag with the
 * most franchise pipelines (env is purely digits) deployed on it. Returns
 * null if the customer has no franchise pipelines at all.
 */
function detectProductionTag(
  allDeployTargets: Record<string, DeployTarget[]>,
  customerKey: string,
): string | null {
  const tagFranchiseCount = new Map<string, number>()
  for (const [tag, targets] of Object.entries(allDeployTargets)) {
    for (const t of targets) {
      if ((t.account || '').toLowerCase() !== customerKey) continue
      if (!FRANCHISE_ENV_RE.test(t.env)) continue
      tagFranchiseCount.set(tag, (tagFranchiseCount.get(tag) || 0) + 1)
    }
  }
  if (tagFranchiseCount.size === 0) return null
  let best: { tag: string; count: number } | null = null
  for (const [tag, count] of tagFranchiseCount) {
    if (!best || count > best.count) best = { tag, count }
  }
  return best?.tag || null
}

export function groupDeployTargetsForBuild(
  build: BuildCard,
  allDeployTargets: Record<string, DeployTarget[]>,
  customerKey?: string,
): DeployRow[] {
  const onThisTag = getDeployTargetsForBuild(build, allDeployTargets, customerKey)

  if (!customerKey) {
    return onThisTag.map(t => toIndividualRow(t, customerKey))
  }

  // Franchise rollup is only meaningful for the build that represents the
  // current production version (the imageTag with the most franchise
  // deployments). Every other build just shows its targets individually.
  const productionTag = detectProductionTag(allDeployTargets, customerKey)
  const buildTagAliases = TAG_ALIASES[build.imageTag || ''] || [build.imageTag || '']
  const isProductionBuild = !!productionTag && buildTagAliases.includes(productionTag)

  if (!isProductionBuild) {
    return onThisTag.map(t => toIndividualRow(t, customerKey))
  }

  const franchiseOnThisVersion = onThisTag.filter(t => FRANCHISE_ENV_RE.test(t.env))
  const nonFranchise = onThisTag.filter(t => !FRANCHISE_ENV_RE.test(t.env))

  // Build franchise inventory across all tags for this customer
  const franchiseInventory = new Map<string, { tag: string; target: DeployTarget }>()
  for (const t of franchiseOnThisVersion) {
    franchiseInventory.set(t.pipelineName, { tag: build.imageTag || '', target: t })
  }
  for (const [tag, targets] of Object.entries(allDeployTargets)) {
    for (const t of targets) {
      if ((t.account || '').toLowerCase() !== customerKey) continue
      if (!FRANCHISE_ENV_RE.test(t.env)) continue
      if (!franchiseInventory.has(t.pipelineName)) {
        franchiseInventory.set(t.pipelineName, { tag, target: t })
      }
    }
  }

  if (franchiseInventory.size === 0) {
    return onThisTag.map(t => toIndividualRow(t, customerKey))
  }

  const onThisVersionNames = new Set(franchiseOnThisVersion.map(t => t.pipelineName))
  const franchiseGroupTotal = franchiseInventory.size
  const franchiseGroupOnThisVersion = franchiseOnThisVersion.length
  const franchiseGroupSucceeded = franchiseOnThisVersion.filter(t => t.status === 'Succeeded').length

  const rows: DeployRow[] = []

  for (const t of nonFranchise) {
    rows.push(toIndividualRow(t, customerKey))
  }

  const groupCustomerLabel =
    nonFranchise[0]?.customer || franchiseOnThisVersion[0]?.customer || 'Customer'
  let groupStatus: DeployRowStatus
  if (
    franchiseGroupSucceeded === franchiseGroupTotal &&
    franchiseGroupOnThisVersion === franchiseGroupTotal
  ) {
    groupStatus = 'Succeeded'
  } else if (franchiseGroupOnThisVersion > 0) {
    groupStatus = 'Mixed'
  } else {
    groupStatus = 'Other'
  }
  rows.push({
    key: `grp:${customerKey}:franchises`,
    kind: 'group',
    label: `${groupCustomerLabel} Franchises`,
    status: groupStatus,
    succeededCount: franchiseGroupSucceeded,
    totalCount: franchiseGroupTotal,
  })

  // Outlier rows: franchises NOT on this production version
  for (const [pipelineName, { tag, target }] of franchiseInventory) {
    if (onThisVersionNames.has(pipelineName)) continue
    rows.push(toIndividualRow(target, customerKey, `on ${tag}`, 'Mixed'))
  }

  return rows
}

export function getDeployTargetsForBuild(
  build: BuildCard,
  allTargets: Record<string, DeployTarget[]>,
  customerKey?: string,
): DeployTarget[] {
  const tag = build.imageTag || ''
  const tags = TAG_ALIASES[tag] || [tag]
  const seen = new Set<string>()
  const targets: DeployTarget[] = []
  for (const t of tags) {
    for (const d of (allTargets[t] || [])) {
      if (customerKey && (d.account || '').toLowerCase() !== customerKey) continue
      // Different brands can share an imageTag (e.g. 4.2.0-cktribute exists in
      // viv-release-tribute, viv-release-haven, viv-release-qualitycare).
      // Match the build's ecrRepo to the pipeline's ecrRepo when both are known.
      if (build.ecrRepo && d.ecrRepo && d.ecrRepo !== build.ecrRepo) continue
      if (!seen.has(d.pipelineName)) {
        seen.add(d.pipelineName)
        targets.push(d)
      }
    }
  }
  return targets
}
