import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const apiFetchMock = vi.fn()
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...(args as [string])) }
})

// Auth gate for CapGuard components within the page
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { hasCap: (cap: string) => boolean }) => unknown) =>
    selector({ hasCap: () => true }),
}))

import { StandupPage } from '../StandupPage'

function makePerson(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Alice Dev',
    slackId: null,
    roles: ['dev'],
    teamId: null,
    team: null,
    isOoo: false,
    buckets: {
      releaseCritical: [], awaitingCherryPick: [], reviewChangesRequested: [],
      reviewApproved: [], blocked: [], pendingTesting: [], inDev: [],
    },
    urgencyScore: 0,
    totalItems: 0,
    releases: [],
    defaultFilter: 'all',
    imminentVersions: [],
    ...overrides,
  }
}

function seedStandup(people: ReturnType<typeof makePerson>[], teams: { id: string; name: string; color: string }[]) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/standup') {
      return Promise.resolve({ people, releasesDueThisWeek: [], teams, generatedAt: '' })
    }
    return Promise.resolve(null)
  })
}

beforeEach(() => { apiFetchMock.mockReset() })

function renderAt(path = '/standup') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StandupPage />
    </MemoryRouter>
  )
}

describe('StandupPage team pills', () => {
  it('renders one pill per team from the API', async () => {
    seedStandup(
      [makePerson({ teamId: 'web', team: { id: 'web', name: 'Web', color: '#60a5fa' } })],
      [
        { id: 'web', name: 'Web', color: '#60a5fa' },
        { id: 'qa',  name: 'QA',  color: '#34d399' },
      ],
    )
    renderAt()
    await waitFor(() => expect(screen.getByRole('button', { name: /^All/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Web/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^QA/ })).toBeInTheDocument()
    // "Other" pill always appears
    expect(screen.getByRole('button', { name: /^Other/ })).toBeInTheDocument()
  })

  it('filters to a specific team on click', async () => {
    const aliceWeb = makePerson({ name: 'Alice Dev', teamId: 'web', team: { id: 'web', name: 'Web', color: '#60a5fa' } })
    const bobQa   = makePerson({ name: 'Bob QA',    teamId: 'qa',  team: { id: 'qa',  name: 'QA',  color: '#34d399' } })
    seedStandup(
      [aliceWeb, bobQa],
      [
        { id: 'web', name: 'Web', color: '#60a5fa' },
        { id: 'qa',  name: 'QA',  color: '#34d399' },
      ],
    )
    renderAt()
    // Both people initially visible
    await waitFor(() => expect(screen.queryAllByText('Alice Dev').length).toBeGreaterThan(0))
    expect(screen.queryAllByText('Bob QA').length).toBeGreaterThan(0)
    const webPill = await screen.findByRole('button', { name: /^Web/ })
    fireEvent.click(webPill)
    // After filtering to Web, Bob QA is gone everywhere and Alice Dev remains
    await waitFor(() => expect(screen.queryByText('Bob QA')).not.toBeInTheDocument())
    expect(screen.queryAllByText('Alice Dev').length).toBeGreaterThan(0)
  })

  it('Other pill filters to people with teamId === null', async () => {
    const alice = makePerson({ name: 'Alice Dev', teamId: null, team: null })
    const bob   = makePerson({ name: 'Bob QA',    teamId: 'web', team: { id: 'web', name: 'Web', color: '#60a5fa' } })
    seedStandup([alice, bob], [{ id: 'web', name: 'Web', color: '#60a5fa' }])
    renderAt()
    const otherPill = await screen.findByRole('button', { name: /^Other/ })
    fireEvent.click(otherPill)
    await waitFor(() => expect(screen.queryByText('Bob QA')).not.toBeInTheDocument())
    expect(screen.queryAllByText('Alice Dev').length).toBeGreaterThan(0)
  })

  it('unknown ?team= falls back to "All"', async () => {
    const alice = makePerson({ name: 'Alice Dev' })
    const bob   = makePerson({ name: 'Bob QA' })
    seedStandup([alice, bob], [{ id: 'web', name: 'Web', color: '#60a5fa' }])
    renderAt('/standup?team=bogus')
    // Both people visible in sidebar (All is active by fallback)
    await waitFor(() => expect(screen.queryAllByText('Alice Dev').length).toBeGreaterThan(0))
    expect(screen.queryAllByText('Bob QA').length).toBeGreaterThan(0)
  })
})
