import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DenseCard } from '../DenseCard'
import type { DeployRow } from '../shared'
import type { BuildCard } from '../types'

const renderInRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>)

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
    newCommits: [
      { sha: 'deadbeef1234567', message: 'fix: a fix' },
      { sha: 'cafebabe1234567', message: 'feat: a feature' },
    ],
    jiraKeys: ['DEV-1'],
    prUrl: null,
    githubBranchUrl: 'https://github.com/viv/webplatform/tree/releases/4.2.0',
    ...overrides,
  }
}

const deployRows: DeployRow[] = [
  {
    key: 'ind:p1',
    kind: 'individual',
    label: 'ck uat',
    status: 'Succeeded',
    pipelineName: 'p1',
  },
  {
    key: 'ind:p2',
    kind: 'individual',
    label: 'ck prod',
    status: 'Failed',
    pipelineName: 'p2',
  },
]

describe('DenseCard', () => {
  it('renders without crashing', () => {
    renderInRouter(<DenseCard build={makeBuild()} deployRows={deployRows} onNavigate={vi.fn()} />)
    expect(screen.getByText('ck')).toBeInTheDocument()
  })

  it('renders the GitHub link on the right (branch fallback when no PR)', () => {
    renderInRouter(<DenseCard build={makeBuild()} deployRows={deployRows} onNavigate={vi.fn()} />)
    const link = screen.getByRole('link', { name: /branch/i })
    expect(link.getAttribute('href')).toBe(
      'https://github.com/viv/webplatform/tree/releases/4.2.0',
    )
  })

  it('renders the PR link when prUrl is set', () => {
    renderInRouter(
      <DenseCard
        build={makeBuild({ prUrl: 'https://github.com/viv/webplatform/pull/100' })}
        deployRows={deployRows}
        onNavigate={vi.fn()}
      />,
    )
    const link = screen.getByRole('link', { name: /open pr/i })
    expect(link.getAttribute('href')).toBe('https://github.com/viv/webplatform/pull/100')
  })

  it('expand toggles visibility of commit list', () => {
    renderInRouter(
      <DenseCard
        build={makeBuild()}
        deployRows={deployRows}
        onNavigate={vi.fn()}
        defaultExpanded={false}
      />,
    )
    expect(screen.queryByText(/commits since last success/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /toggle build details/i }))
    expect(screen.getByText(/commits since last success/)).toBeInTheDocument()
  })

  it('collapsing hides BuildCardDetails and deploy-targets list but keeps deploy summary', () => {
    renderInRouter(
      <DenseCard
        build={makeBuild()}
        deployRows={deployRows}
        onNavigate={vi.fn()}
        defaultExpanded={true}
      />,
    )
    // Expanded: full list present, "Deploys to" heading present
    expect(screen.getByText('Deploys to')).toBeInTheDocument()
    expect(screen.getByText(/ck uat/)).toBeInTheDocument()
    expect(screen.getByText(/ck prod/)).toBeInTheDocument()
    expect(screen.getByText('1/2 deployed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /toggle build details/i }))

    // Collapsed: BuildCardDetails gone, deploy list gone, summary still visible
    expect(screen.queryByText(/commits since last success/)).not.toBeInTheDocument()
    expect(screen.queryByText('Deploys to')).not.toBeInTheDocument()
    expect(screen.queryByText(/ck uat/)).not.toBeInTheDocument()
    expect(screen.queryByText(/ck prod/)).not.toBeInTheDocument()
    expect(screen.getByText('1/2 deployed')).toBeInTheDocument()
  })
})
