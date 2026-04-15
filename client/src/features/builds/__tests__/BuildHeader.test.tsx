import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BuildHeader } from '../BuildHeader'
import type { BuildCard } from '../types'

function makeBuild(overrides: Partial<BuildCard> = {}): BuildCard {
  return {
    projectName: 'ECR-Build_viv-release-ck',
    branch: 'releases/4.2.0',
    version: '4.2.0',
    repo: 'webplatform',
    isCustom: false,
    imageTag: '4.2.0',
    account: 'ck',
    customerKey: 'ck',
    latestStatus: 'SUCCEEDED',
    latestStartTime: '2025-01-01T00:00:00Z',
    builds: [
      {
        buildNumber: 1,
        status: 'SUCCEEDED',
        startTime: '2025-01-01T00:00:00Z',
        endTime: '2025-01-01T00:04:12Z',
        durationSec: 252,
        commitSha: 'abc1234',
      },
    ],
    newCommits: [],
    jiraKeys: [],
    prUrl: 'https://github.com/viv/webplatform/pull/28784',
    githubBranchUrl: 'https://github.com/viv/webplatform/tree/releases/4.2.0',
    ...overrides,
  }
}

describe('BuildHeader', () => {
  it('renders the project name stripped of ECR-Build_ and viv-release- prefixes', () => {
    render(<BuildHeader build={makeBuild()} />)
    expect(screen.getByText('ck')).toBeInTheDocument()
  })

  it('strips viv-release- prefix for release builds with version suffix', () => {
    render(
      <BuildHeader build={makeBuild({ projectName: 'ECR-Build_viv-release-4_2_0-cktribute' })} />,
    )
    expect(screen.getByText('4_2_0-cktribute')).toBeInTheDocument()
  })

  it('strips viv-custom- prefix', () => {
    render(<BuildHeader build={makeBuild({ projectName: 'ECR-Build_viv-custom-fang' })} />)
    expect(screen.getByText('fang')).toBeInTheDocument()
  })

  it('strips bare viv- prefix for master', () => {
    render(<BuildHeader build={makeBuild({ projectName: 'ECR-Build_viv-master' })} />)
    expect(screen.getByText('master')).toBeInTheDocument()
  })

  it('renders the branch name stripped of releases/ prefix', () => {
    render(<BuildHeader build={makeBuild()} />)
    expect(screen.getByText('4.2.0')).toBeInTheDocument()
  })

  it('renders the status label for SUCCEEDED', () => {
    render(<BuildHeader build={makeBuild({ latestStatus: 'SUCCEEDED' })} />)
    expect(screen.getByText('Succeeded')).toBeInTheDocument()
  })

  it('renders the status label for IN_PROGRESS', () => {
    render(<BuildHeader build={makeBuild({ latestStatus: 'IN_PROGRESS' })} />)
    expect(screen.getByText('Building')).toBeInTheDocument()
  })

  it('renders the status label for FAILED', () => {
    render(<BuildHeader build={makeBuild({ latestStatus: 'FAILED' })} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('does not render the GitHub link (it lives on the right side of DenseCard)', () => {
    render(<BuildHeader build={makeBuild()} />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
