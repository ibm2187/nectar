import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Customer, Environment } from '../../../api/client'

// Mock wsStore before importing the component
const mockCustomers: Customer[] = []
const mockEnvironments: Environment[] = []

vi.mock('../../../stores/wsStore', () => ({
  useWsStore: (selector: (s: { customers: Customer[]; environments: Environment[] }) => unknown) =>
    selector({ customers: mockCustomers, environments: mockEnvironments }),
}))

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: vi.fn().mockResolvedValue({}) }
})

import { CustomersPage } from '../CustomersPage'

function makeCustomer(id: string, name: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id,
    name,
    configName: null,
    domain: 'mavencare.com',
    domainPrefix: id,
    integrations: [],
    hasFranchises: false,
    active: true,
    syncedFrom: 'webplatform',
    lastSyncedAt: '2025-01-01T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeEnv(id: string, customerId: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    nodeEnv: id,
    customerId,
    franchise: null,
    franchiseDisplayName: null,
    tier: 'production',
    name: id,
    url: `https://${id}.mavencare.com`,
    versionEndpoint: `https://${id}.mavencare.com/api/status/version`,
    currentVersion: '4.1.0',
    currentBranch: 'releases/4.1.0',
    lastChecked: '2025-01-01T00:00:00Z',
    reachable: true,
    disabled: false,
    versionSetManually: false,
    versionSetBy: null,
    versionSetAt: null,
    syncedFrom: 'webplatform',
    lastSyncedAt: '2025-01-01T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

function setMockData(customers: Customer[], environments: Environment[]) {
  mockCustomers.length = 0
  mockEnvironments.length = 0
  mockCustomers.push(...customers)
  mockEnvironments.push(...environments)
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <CustomersPage />
    </MemoryRouter>,
  )

beforeEach(() => {
  setMockData(
    [
      makeCustomer('bayada', 'Bayada Home Health'),
      makeCustomer('ck', 'Comfort Keepers', { hasFranchises: true }),
      makeCustomer('tribute', 'Tribute Home Care'),
      makeCustomer('haven', 'Haven Home Care'),
      makeCustomer('lumen', 'Help at Home'),
      makeCustomer('qualitycare', 'Quality Care'),
      makeCustomer('viv', 'Mavencare (Internal)'),
    ],
    [
      makeEnv('bayada', 'bayada'),
      makeEnv('bayada-staging', 'bayada', { tier: 'staging' }),
      makeEnv('ck', 'ck'),
      makeEnv('ck-staging', 'ck', { tier: 'staging' }),
      makeEnv('tribute', 'tribute'),
      makeEnv('haven', 'haven'),
      makeEnv('lumen', 'lumen'),
      makeEnv('qualitycare', 'qualitycare'),
      makeEnv('production', 'viv'),
      makeEnv('preprod', 'viv', { tier: 'staging' }),
    ],
  )
})

describe('CustomersPage filter pills', () => {
  it('renders short customer labels matching Builds page style', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bayada' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Comfort Keepers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tribute' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lumen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Quality Care' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Viv' })).toBeInTheDocument()
  })

  it('does not render Haven as a filter pill', () => {
    renderPage()
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map(b => b.textContent)
    expect(labels).not.toContain('Haven')
    expect(labels).not.toContain('Haven Home Care')
  })

  it('renders Viv as the last filter pill', () => {
    renderPage()
    const pillContainer = screen.getByRole('button', { name: 'All' }).parentElement!
    const pills = Array.from(pillContainer.querySelectorAll('button'))
    expect(pills[pills.length - 1].textContent).toBe('Viv')
  })

  it('"All" shows external customers but hides Viv and Haven', () => {
    renderPage()
    // All is active by default
    expect(screen.getByText('Bayada Home Health')).toBeInTheDocument()
    expect(screen.getByText('Comfort Keepers', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByText('Mavencare (Internal)')).not.toBeInTheDocument()
    // Haven is hidden from the list too
    expect(screen.queryByText('Haven Home Care')).not.toBeInTheDocument()
  })

  it('clicking a customer pill filters to only that customer', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Bayada' }))
    expect(screen.getByText('Bayada Home Health')).toBeInTheDocument()
    expect(screen.queryByText('Comfort Keepers', { selector: 'span' })).not.toBeInTheDocument()
    expect(screen.queryByText('Tribute Home Care')).not.toBeInTheDocument()
  })

  it('clicking Viv pill shows internal environments', () => {
    renderPage()
    expect(screen.queryByText('Mavencare (Internal)')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Viv' }))
    expect(screen.getByText('Mavencare (Internal)')).toBeInTheDocument()
  })

  it('clicking All after a customer filter shows all external customers again', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Bayada' }))
    expect(screen.queryByText('Comfort Keepers', { selector: 'span' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Bayada Home Health')).toBeInTheDocument()
    expect(screen.getByText('Comfort Keepers', { selector: 'span' })).toBeInTheDocument()
  })

  it('search filters within selected customer', () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Bayada' }))
    const input = screen.getByLabelText(/search environments/i)
    fireEvent.change(input, { target: { value: 'staging' } })
    // Bayada card still shows because it has bayada-staging env matching search
    expect(screen.getByText('Bayada Home Health')).toBeInTheDocument()
  })

  it('search with no match shows empty state', () => {
    renderPage()
    const input = screen.getByLabelText(/search environments/i)
    fireEvent.change(input, { target: { value: 'zzzznonexistent' } })
    expect(screen.getByText(/no customers match/i)).toBeInTheDocument()
  })
})
