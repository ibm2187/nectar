import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { BuildCard, BuildsPageData, CustomerGroup } from '../types'

vi.mock('../useBuildsData', () => ({
  useBuildsData: () => ({ data: mockData, loading: false, error: null }),
}))

import { BuildsPage } from '../BuildsPage'

function makeBuild(name: string, overrides: Partial<BuildCard> = {}): BuildCard {
  return {
    projectName: `ECR-Build_${name}`,
    branch: `feature/${name}`,
    version: null,
    repo: 'webplatform',
    isCustom: false,
    imageTag: name,
    account: 'viv',
    customerKey: 'viv',
    latestStatus: 'SUCCEEDED',
    latestStartTime: '2025-01-01T00:00:00Z',
    builds: [
      {
        buildNumber: 1,
        status: 'SUCCEEDED',
        startTime: '2025-01-01T00:00:00Z',
        endTime: '2025-01-01T00:01:00Z',
        durationSec: 60,
        commitSha: 'abc',
      },
    ],
    newCommits: [],
    jiraKeys: [],
    prUrl: null,
    githubBranchUrl: `https://github.com/viv/webplatform/tree/feature/${name}`,
    ...overrides,
  }
}

function makeCustomer(key: string, label: string, prefix: string): CustomerGroup {
  const pinnedBuild = makeBuild(`${prefix}-pinned`, { customerKey: key, account: key })
  const recentBuilds = [
    makeBuild(`${prefix}-recent-1`, { customerKey: key, account: key }),
    makeBuild(`${prefix}-recent-2`, { customerKey: key, account: key }),
  ]
  const extraBuilds = Array.from({ length: 5 }, (_, i) =>
    makeBuild(`${prefix}-extra-${i}`, { customerKey: key, account: key }),
  )
  return {
    key,
    label,
    account: key,
    pinnedBuild,
    recentBuilds,
    allBuilds: [pinnedBuild, ...recentBuilds, ...extraBuilds],
  }
}

let mockData: BuildsPageData = {
  customers: [
    makeCustomer('viv', 'Viv', 'viv'),
    makeCustomer('ck', 'Comfort Keepers', 'ck'),
    makeCustomer('bayada', 'Bayada', 'bayada'),
  ],
  deployTargets: {},
  lastRun: '2025-01-01T00:00:00Z',
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <BuildsPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  localStorage.clear()
})

describe('BuildsPage', () => {
  it('renders customer tabs with All, Viv, Comfort Keepers, Bayada labels', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Viv' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Comfort Keepers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bayada' })).toBeInTheDocument()
  })

  it('clicking the Comfort Keepers tab hides Viv builds and shows CK builds', () => {
    renderPage()
    expect(screen.getAllByText(/viv-pinned/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Comfort Keepers' }))
    expect(screen.queryByText(/viv-pinned/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/ck-pinned/).length).toBeGreaterThan(0)
  })

  it('search filters cards within the active customer tab', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Viv' }))
    expect(screen.getAllByText(/viv-pinned/).length).toBeGreaterThan(0)
    const input = screen.getByLabelText(/search builds/i)
    fireEvent.change(input, { target: { value: 'recent-1' } })
    expect(screen.queryByText(/viv-pinned/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/viv-recent-1/).length).toBeGreaterThan(0)
  })

  it('pinned build is marked with data-pinned="true" and renders above recent list', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Viv' }))
    const pinned = document.querySelectorAll('[data-pinned="true"]')
    expect(pinned.length).toBe(1)
    expect(pinned[0].textContent).toMatch(/viv-pinned/)
  })

  it('Show all expander reveals cards from allBuilds beyond pinned+recent', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Viv' }))
    expect(screen.queryByText(/viv-extra-4/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /show all/i }))
    expect(screen.getAllByText(/viv-extra-4/).length).toBeGreaterThan(0)
  })

  it('All tab renders a section per customer with its label header', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: 'Viv' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Comfort Keepers' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bayada' })).toBeInTheDocument()
  })
})
