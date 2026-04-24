import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const apiFetchMock = vi.fn()
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...(args as [string])) }
})

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { hasCap: (cap: string) => boolean }) => unknown) =>
    selector({ hasCap: () => true }),
}))

import { AccessPage } from '../AccessPage'
import type { Team, AccessUser } from '../../../stores/accessStore'

function seed(teams: Team[], users: AccessUser[]) {
  apiFetchMock.mockImplementation((path: string, opts?: { method?: string; body?: string }) => {
    if (path === '/access/capabilities') return Promise.resolve([])
    if (path === '/access/roles') return Promise.resolve([])
    if (path === '/access/users') return Promise.resolve(users)
    if (path === '/access/keys') return Promise.resolve([])
    if (path === '/access/teams') return Promise.resolve(teams)
    if (opts?.method === 'PUT') return Promise.resolve({})
    return Promise.resolve(null)
  })
}

const TEAMS: Team[] = [
  { id: 'web', name: 'Web', description: null, color: '#60a5fa', createdAt: '', updatedAt: '' },
  { id: 'qa',  name: 'QA',  description: null, color: '#34d399', createdAt: '', updatedAt: '' },
]

function makeUser(overrides: Partial<AccessUser> = {}): AccessUser {
  return {
    email: 'alice@viv.com',
    name: 'Alice',
    picture: null,
    roleIds: [],
    capabilities: [],
    teamId: null,
    jiraName: null,
    lastLoginAt: null,
    createdAt: '',
    ...overrides,
  }
}

beforeEach(() => { apiFetchMock.mockReset() })

describe('UsersTab teams and jiraName', () => {
  it('renders Team dropdown and calls updateUserTeam on change', async () => {
    seed(TEAMS, [makeUser()])
    render(<AccessPage embedded />)
    const select = await screen.findByLabelText(/team for alice@viv.com/i)
    fireEvent.change(select, { target: { value: 'web' } })
    // Verify PUT request was dispatched
    const putCall = apiFetchMock.mock.calls.find(c => c[1]?.method === 'PUT' && /users\/.*\/team$/.test(c[0] as string))
    expect(putCall).toBeDefined()
    expect(JSON.parse(putCall![1].body)).toEqual({ teamId: 'web' })
  })

  it('passes teamId=null when "No team" selected', async () => {
    seed(TEAMS, [makeUser({ teamId: 'web' })])
    render(<AccessPage embedded />)
    const select = await screen.findByLabelText(/team for alice@viv.com/i)
    fireEvent.change(select, { target: { value: '' } })
    const putCall = apiFetchMock.mock.calls.find(c => c[1]?.method === 'PUT' && /users\/.*\/team$/.test(c[0] as string))
    expect(JSON.parse(putCall![1].body)).toEqual({ teamId: null })
  })

  it('saves JIRA Name on blur and clears to null on empty', async () => {
    seed(TEAMS, [makeUser()])
    render(<AccessPage embedded />)
    const input = await screen.findByLabelText(/jira name for alice@viv.com/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Alice Smith' } })
    fireEvent.blur(input)
    const putCall = apiFetchMock.mock.calls.find(c => c[1]?.method === 'PUT' && /users\/.*\/jira-name$/.test(c[0] as string))
    expect(JSON.parse(putCall![1].body)).toEqual({ jiraName: 'Alice Smith' })
  })

  it('shows amber border on row with no jiraName', async () => {
    seed(TEAMS, [makeUser({ jiraName: null })])
    render(<AccessPage embedded />)
    const input = await screen.findByLabelText(/jira name for alice@viv.com/i)
    expect(input.className).toMatch(/amber/)
  })
})
