import { describe, it, expect } from 'vitest'
import { groupDeployTargetsForBuild } from '../shared'
import type { BuildCard, DeployTarget } from '../types'

function makeBuild(imageTag: string, customerKey = 'ck'): BuildCard {
  return {
    projectName: 'ECR-Build_x',
    branch: 'b',
    version: null,
    repo: 'webplatform',
    isCustom: false,
    imageTag,
    account: customerKey,
    customerKey,
    latestStatus: 'SUCCEEDED',
    latestStartTime: null,
    builds: [],
    newCommits: [],
    jiraKeys: [],
    prUrl: null,
    githubBranchUrl: '',
  }
}

function t(
  pipelineName: string,
  env: string,
  status: string | null,
  account = 'ck',
  customer = 'CK',
): DeployTarget {
  return { pipelineName, customer, env, status, lastUpdated: null, account }
}

describe('groupDeployTargetsForBuild', () => {
  it('returns empty array for empty input', () => {
    const rows = groupDeployTargetsForBuild(makeBuild('v1'), {}, 'ck')
    expect(rows).toEqual([])
  })

  it('returns individual rows when customerKey undefined (no grouping)', () => {
    const build = makeBuild('v1')
    const rows = groupDeployTargetsForBuild(
      build,
      {
        v1: [t('Deploy-CK_101', '101', 'Succeeded'), t('Deploy-CK_Prod', 'Production', 'Succeeded')],
      },
      undefined,
    )
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.kind === 'individual')).toBe(true)
  })

  it('no franchises: returns individual rows, no group', () => {
    const build = makeBuild('v1')
    const rows = groupDeployTargetsForBuild(
      build,
      {
        v1: [
          t('Deploy-CK_Prod', 'Production', 'Succeeded'),
          t('Deploy-CK_Stg', 'Staging', 'Succeeded'),
        ],
      },
      'ck',
    )
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.kind === 'individual')).toBe(true)
  })

  it('all franchises on this version: returns single group row 3/3 Succeeded', () => {
    const build = makeBuild('v1')
    const rows = groupDeployTargetsForBuild(
      build,
      {
        v1: [
          t('Deploy-CK_101', '101', 'Succeeded'),
          t('Deploy-CK_102', '102', 'Succeeded'),
          t('Deploy-CK_103', '103', 'Succeeded'),
        ],
      },
      'ck',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('group')
    expect(rows[0].status).toBe('Succeeded')
    expect(rows[0].succeededCount).toBe(3)
    expect(rows[0].totalCount).toBe(3)
  })

  it('some franchises missing: returns group row + outlier rows', () => {
    const build = makeBuild('v1')
    const rows = groupDeployTargetsForBuild(
      build,
      {
        v1: [
          t('Deploy-CK_101', '101', 'Succeeded'),
          t('Deploy-CK_102', '102', 'Succeeded'),
          t('Deploy-CK_103', '103', 'Succeeded'),
        ],
        v2: [
          t('Deploy-CK_104', '104', 'Succeeded'),
          t('Deploy-CK_105', '105', 'Succeeded'),
        ],
      },
      'ck',
    )
    const group = rows.find(r => r.kind === 'group')!
    expect(group).toBeDefined()
    expect(group.succeededCount).toBe(3)
    expect(group.totalCount).toBe(5)
    expect(group.status).toBe('Mixed')
    const outliers = rows.filter(r => r.kind === 'individual')
    expect(outliers).toHaveLength(2)
    expect(outliers.every(o => o.detail === 'on v2')).toBe(true)
    expect(outliers.every(o => o.status === 'Mixed')).toBe(true)
  })

  it('does not group franchises when build is not the production version', () => {
    // v1 has 38 franchises (production), v2 has only 2 → v1 wins.
    // For a build whose imageTag is v2, we expect raw individual rows, no group.
    const build = makeBuild('v2')
    const v1Franchises = Array.from({ length: 38 }, (_, i) =>
      t(`Deploy-CK_${100 + i}`, `${100 + i}`, 'Succeeded'),
    )
    const v2Targets = [
      t('Deploy-CK_900', '900', 'Succeeded'),
      t('Deploy-CK_901', '901', 'Succeeded'),
      t('Deploy-CK_QA06', 'QA06', 'Succeeded'),
    ]
    const rows = groupDeployTargetsForBuild(
      build,
      { v1: v1Franchises, v2: v2Targets },
      'ck',
    )
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.kind === 'individual')).toBe(true)
    expect(rows.find(r => r.label.includes('Franchises'))).toBeUndefined()
  })

  it('mixed franchise + non-franchise: Production first, then group, then outliers', () => {
    const build = makeBuild('v1')
    const v1Franchises = Array.from({ length: 38 }, (_, i) =>
      t(`Deploy-CK_${100 + i}`, `${100 + i}`, 'Succeeded'),
    )
    const v2Outliers = [
      t('Deploy-CK_900', '900', 'Succeeded'),
      t('Deploy-CK_901', '901', 'Succeeded'),
    ]
    const rows = groupDeployTargetsForBuild(
      build,
      {
        v1: [t('Deploy-CK_Prod', 'Production', 'Succeeded'), ...v1Franchises],
        v2: v2Outliers,
      },
      'ck',
    )
    expect(rows[0].kind).toBe('individual')
    expect(rows[0].label).toBe('CK Production')
    expect(rows[1].kind).toBe('group')
    expect(rows[1].succeededCount).toBe(38)
    expect(rows[1].totalCount).toBe(40)
    expect(rows.slice(2).every(r => r.kind === 'individual' && r.detail === 'on v2')).toBe(true)
    expect(rows.slice(2)).toHaveLength(2)
  })
})
