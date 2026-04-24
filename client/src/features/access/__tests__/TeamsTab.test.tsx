import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// ── Mock apiFetch so loadAll's 5 fetches return whatever the test wants ──
const apiFetchMock = vi.fn()
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...(args as [string])) }
})

// ── Mock auth store so gating passes ──
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { hasCap: (cap: string) => boolean }) => unknown) =>
    selector({ hasCap: () => true }),
}))

import { AccessPage } from '../AccessPage'
import type { Team, AccessUser } from '../../../stores/accessStore'

type Fixtures = { teams?: Team[]; users?: AccessUser[] }
function seed(fixtures: Fixtures = {}) {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/access/capabilities') return Promise.resolve([])
    if (path === '/access/roles') return Promise.resolve([])
    if (path === '/access/users') return Promise.resolve(fixtures.users ?? [])
    if (path === '/access/keys') return Promise.resolve([])
    if (path === '/access/teams') return Promise.resolve(fixtures.teams ?? [])
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  seed()
})

describe('TeamsTab', () => {
  it('renders empty state and opens create dialog on "New team"', async () => {
    render(<AccessPage embedded />)
    const teamsTabBtn = await screen.findByRole('button', { name: /^teams$/i })
    fireEvent.click(teamsTabBtn)
    expect(await screen.findByText(/No teams yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /new team/i }))
    // Dialog title confirms create dialog is open
    expect(await screen.findByText(/New team/i, { selector: 'h2, [id^="radix-"]' })).toBeInTheDocument()
  })

  it('renders existing teams with member counts', async () => {
    seed({
      teams: [
        { id: 'web', name: 'Web Platform', description: null, color: '#60a5fa', createdAt: '', updatedAt: '' },
      ],
      users: [
        { email: 'a@x.com', name: 'A', picture: null, roleIds: [], capabilities: [], teamId: 'web', jiraName: null, lastLoginAt: null, createdAt: '' },
      ],
    })
    render(<AccessPage embedded />)
    const teamsTabBtn = await screen.findByRole('button', { name: /^teams$/i })
    fireEvent.click(teamsTabBtn)
    expect(await screen.findByText(/Web Platform/)).toBeInTheDocument()
    // member count cell shows 1
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('blocks delete dialog when team has members', async () => {
    seed({
      teams: [
        { id: 'web', name: 'Web Platform', description: null, color: '#60a5fa', createdAt: '', updatedAt: '' },
      ],
      users: [
        { email: 'alice@x.com', name: 'Alice', picture: null, roleIds: [], capabilities: [], teamId: 'web', jiraName: null, lastLoginAt: null, createdAt: '' },
      ],
    })
    render(<AccessPage embedded />)
    const teamsTabBtn = await screen.findByRole('button', { name: /^teams$/i })
    fireEvent.click(teamsTabBtn)
    const deleteBtn = await screen.findByRole('button', { name: /delete/i })
    fireEvent.click(deleteBtn)
    // Delete-blocked dialog appears
    expect(await screen.findByText(/Team has members/i)).toBeInTheDocument()
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
  })
})
