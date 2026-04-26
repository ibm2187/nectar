import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AlertRule, AlertTrigger, Customer, Environment } from '../../../api/client'

// ── Mock apiFetch so we can control responses per-test ────

const apiFetchMock = vi.fn()
vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) }
})

// ── Mock wsStore so we can seed customers + environments ──

const mockCustomers: Customer[] = []
const mockEnvironments: Environment[] = []
vi.mock('../../../stores/wsStore', () => ({
  useWsStore: (selector: (s: { customers: Customer[]; environments: Environment[] }) => unknown) =>
    selector({ customers: mockCustomers, environments: mockEnvironments }),
}))

import { AlertRulesPanel } from '../AlertRulesPanel'

const SAMPLE_TRIGGERS: AlertTrigger[] = [
  {
    key: 'env-unhealthy',
    label: 'Environment became unhealthy',
    description: 'Fires the first time an environment transitions to an unhealthy state',
    defaultSeverity: 'critical',
    tier: 1,
    filterFields: [
      { key: 'customerIds', label: 'Customers', type: 'customer-multi' },
      { key: 'envIds', label: 'Environments', type: 'env-multi' },
      { key: 'envTier', label: 'Environment tier', type: 'tier-multi', options: ['production', 'staging', 'lower'] },
      { key: 'components', label: 'Components', type: 'component-multi', options: ['Database', 'Cache', 'File Storage'] },
    ],
  },
  {
    key: 'env-recovered',
    label: 'Environment recovered',
    description: 'Fires when a previously-unhealthy environment becomes healthy again',
    defaultSeverity: 'info',
    tier: 1,
    filterFields: [],
  },
]

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'alrt-1',
    name: 'Prod health',
    triggerType: 'env-unhealthy',
    filter: {},
    channels: ['#alerts-prod'],
    mention: null,
    severity: 'critical',
    enabled: true,
    lastFiredAt: null,
    createdAt: '2026-04-22T08:00:00Z',
    updatedAt: '2026-04-22T08:00:00Z',
    ...overrides,
  }
}

/**
 * Define per-URL responses for apiFetch. Default handler returns {} if
 * path doesn't match.
 */
function wireApi(handlers: Record<string, (opts?: RequestInit) => unknown>) {
  apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) {
        return Promise.resolve(handler(opts))
      }
    }
    return Promise.resolve({})
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  mockCustomers.length = 0
  mockEnvironments.length = 0
})

function seedCustomer(id: string, overrides: Partial<Customer> = {}): Customer {
  return {
    id,
    name: id,
    shortName: id.toUpperCase(),
    configName: null,
    domain: 'viv.com',
    domainPrefix: id,
    integrations: [],
    hasFranchises: false,
    active: true,
    syncedFrom: 'test',
    lastSyncedAt: '2026-04-22T00:00:00Z',
    createdAt: '2026-04-22T00:00:00Z',
    updatedAt: '2026-04-22T00:00:00Z',
    hidden: false,
    sortOrder: 0,
    ...overrides,
  }
}

function seedEnv(id: string, customerId: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    nodeEnv: id,
    customerId,
    franchise: null,
    franchiseDisplayName: null,
    tier: 'production',
    name: id,
    url: `https://${id}.viv.com`,
    versionEndpoint: `https://${id}.viv.com/api/status/version`,
    currentVersion: '4.1.0',
    currentBranch: 'releases/4.1.0',
    lastChecked: '2026-04-22T00:00:00Z',
    reachable: true,
    disabled: false,
    syncedFrom: 'test',
    lastSyncedAt: '2026-04-22T00:00:00Z',
    createdAt: '2026-04-22T00:00:00Z',
    updatedAt: '2026-04-22T00:00:00Z',
    ...overrides,
  }
}

describe('AlertRulesPanel — listing', () => {
  it('renders rules from API', async () => {
    wireApi({
      '/alerts/rules': () => ({ rules: [makeRule()] }),
      '/alerts/triggers': () => ({ triggers: SAMPLE_TRIGGERS }),
    })

    render(<AlertRulesPanel />)
    await waitFor(() => expect(screen.getByText('Prod health')).toBeInTheDocument())
    expect(screen.getByText('#alerts-prod')).toBeInTheDocument()
    expect(screen.getByText('Environment became unhealthy')).toBeInTheDocument()
  })

  it('renders empty state when no rules', async () => {
    wireApi({
      '/alerts/rules': () => ({ rules: [] }),
      '/alerts/triggers': () => ({ triggers: SAMPLE_TRIGGERS }),
    })
    render(<AlertRulesPanel />)
    await waitFor(() => expect(screen.getByText(/No alert rules configured/i)).toBeInTheDocument())
  })
})

/** Open the channel picker and click the channel whose unprefixed name matches. */
async function pickChannel(name: string) {
  fireEvent.click(screen.getByText(/Add a Slack channel/i))
  // Picker option button accessible name is "{icon} {label}" (e.g. "# alerts-prod").
  // Find by role + a substring matcher rather than an exact match.
  const buttons = await screen.findAllByRole('button')
  const option = buttons.find(b => {
    const text = b.textContent?.trim() || ''
    // Strip leading "# " or "🔒 " icon prefix before comparing.
    return text.replace(/^[#🔒]\s*/, '') === name
  })
  if (!option) throw new Error(`No picker option found for channel "${name}"`)
  fireEvent.click(option)
}

describe('AlertRulesPanel — editor', () => {
  it('disables Save until all channels validate OK', async () => {
    wireApi({
      '/alerts/rules': () => ({ rules: [] }),
      '/alerts/triggers': () => ({ triggers: SAMPLE_TRIGGERS }),
      '/alerts/slack/channels': () => ({
        ok: true,
        channels: [
          { id: 'C1', name: 'not-invited', isPrivate: false },
          { id: 'C2', name: 'ok', isPrivate: false },
        ],
      }),
      '/alerts/validate-channel': (opts) => {
        const body = JSON.parse((opts?.body as string) || '{}')
        if (body.channel === '#ok') return { ok: true, inChannel: true, channelId: 'C2', name: 'ok' }
        return { ok: false, code: 'not_in_channel', error: 'Bot is not in channel' }
      },
    })

    render(<AlertRulesPanel />)
    await waitFor(() => expect(screen.getByText('+ New Rule')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ New Rule'))

    await waitFor(() => expect(screen.getByText('New Alert Rule')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/e.g. Prod health alerts/i), { target: { value: 'Test Rule' } })

    const saveButton = screen.getByRole('button', { name: /Create/i })
    expect(saveButton).toBeDisabled()

    // Wait for the channel picker to enable (Slack list loaded).
    await waitFor(() => expect(screen.getByText(/Add a Slack channel/i)).not.toBeDisabled())

    // Pick the bad channel — validation fails, save stays disabled.
    await pickChannel('not-invited')
    await waitFor(() => expect(screen.getByText(/not_in_channel/i)).toBeInTheDocument())
    expect(saveButton).toBeDisabled()

    // Remove the failing chip, then pick the good one.
    fireEvent.click(screen.getByLabelText(/Remove #not-invited/i))
    await pickChannel('ok')
    await waitFor(() => expect(screen.getByText('#ok')).toBeInTheDocument())
    expect(saveButton).not.toBeDisabled()
  })

  it('submits with the correct payload on save', async () => {
    const createCalls: unknown[] = []
    wireApi({
      '/alerts/rules': (opts) => {
        if (opts?.method === 'POST') {
          createCalls.push(JSON.parse((opts.body as string) || '{}'))
          return makeRule({ id: 'alrt-new' })
        }
        return { rules: [] }
      },
      '/alerts/triggers': () => ({ triggers: SAMPLE_TRIGGERS }),
      '/alerts/slack/channels': () => ({
        ok: true,
        channels: [{ id: 'C1', name: 'alerts-prod', isPrivate: false }],
      }),
      '/alerts/validate-channel': () => ({ ok: true, inChannel: true }),
    })

    render(<AlertRulesPanel />)
    await waitFor(() => screen.getByText('+ New Rule'))
    fireEvent.click(screen.getByText('+ New Rule'))

    fireEvent.change(screen.getByPlaceholderText(/e.g. Prod health alerts/i), {
      target: { value: 'Prod health' },
    })
    await waitFor(() => expect(screen.getByText(/Add a Slack channel/i)).not.toBeDisabled())
    await pickChannel('alerts-prod')
    await waitFor(() => expect(screen.getByText('#alerts-prod')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Create/i }))

    await waitFor(() => expect(createCalls.length).toBe(1))
    const payload = createCalls[0] as Record<string, unknown>
    expect(payload.name).toBe('Prod health')
    expect(payload.channels).toEqual(['#alerts-prod'])
    expect(payload.triggerType).toBe('env-unhealthy')
  })

  it('trigger dropdown description updates when user changes trigger', async () => {
    wireApi({
      '/alerts/rules': () => ({ rules: [] }),
      '/alerts/triggers': () => ({ triggers: SAMPLE_TRIGGERS }),
    })
    render(<AlertRulesPanel />)
    await waitFor(() => screen.getByText('+ New Rule'))
    fireEvent.click(screen.getByText('+ New Rule'))

    // Default trigger shown
    expect(screen.getByText(/Fires the first time/i)).toBeInTheDocument()

    const triggerSelect = screen.getByDisplayValue(/Environment became unhealthy/i)
    fireEvent.change(triggerSelect, { target: { value: 'env-recovered' } })
    await waitFor(() => expect(screen.getByText(/Fires when a previously-unhealthy/i)).toBeInTheDocument())
  })
})

describe('AlertRulesPanel — actions', () => {
  it('Test button fires a synthetic alert', async () => {
    const testCalls: string[] = []
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/test')) {
        testCalls.push(path)
        return Promise.resolve({ ok: true, results: [] })
      }
      if (path === '/alerts/rules') return Promise.resolve({ rules: [makeRule()] })
      if (path === '/alerts/triggers') return Promise.resolve({ triggers: SAMPLE_TRIGGERS })
      return Promise.resolve({})
    })
    // Mock window.alert to avoid jsdom errors
    window.alert = vi.fn()

    render(<AlertRulesPanel />)
    await waitFor(() => screen.getByText('Prod health'))
    fireEvent.click(screen.getByRole('button', { name: /Actions for Prod health/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(testCalls).toEqual(['/alerts/rules/alrt-1/test']))
  })

  it('Delete prompts for confirmation and deletes', async () => {
    const deleteCalls: string[] = []
    apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
      if (opts?.method === 'DELETE') {
        deleteCalls.push(path)
        return Promise.resolve({})
      }
      if (path === '/alerts/rules') return Promise.resolve({ rules: [makeRule()] })
      if (path === '/alerts/triggers') return Promise.resolve({ triggers: SAMPLE_TRIGGERS })
      return Promise.resolve({})
    })
    window.confirm = vi.fn(() => true)

    render(<AlertRulesPanel />)
    await waitFor(() => screen.getByText('Prod health'))
    fireEvent.click(screen.getByRole('button', { name: /Actions for Prod health/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteCalls).toEqual(['/alerts/rules/alrt-1']))
  })
})

// ══════════════════════════════════════════════════════════════
// Multi-select filter UI
// ══════════════════════════════════════════════════════════════

describe('AlertRulesPanel — filter multi-selects', () => {
  async function openEditor() {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/alerts/rules') return Promise.resolve({ rules: [] })
      if (path === '/alerts/triggers') return Promise.resolve({ triggers: SAMPLE_TRIGGERS })
      if (path === '/alerts/validate-channel') return Promise.resolve({ ok: true, inChannel: true })
      return Promise.resolve({})
    })
    render(<AlertRulesPanel />)
    await waitFor(() => screen.getByText('+ New Rule'))
    fireEvent.click(screen.getByText('+ New Rule'))
    await waitFor(() => screen.getByText('New Alert Rule'))
  }

  it('renders customer dropdown with real customers from wsStore', async () => {
    mockCustomers.push(
      seedCustomer('bayada', { shortName: 'Bayada' }),
      seedCustomer('ck', { shortName: 'CK' }),
    )
    await openEditor()

    fireEvent.click(screen.getByText(/Any customer/i))
    await waitFor(() => screen.getByText('Bayada'))
    expect(screen.getByText('CK')).toBeInTheDocument()
  })

  it('hidden customers are excluded from the dropdown', async () => {
    mockCustomers.push(
      seedCustomer('bayada'),
      seedCustomer('haven', { hidden: true }),
    )
    await openEditor()

    fireEvent.click(screen.getByText(/Any customer/i))
    await waitFor(() => screen.getByText('BAYADA'))
    expect(screen.queryByText('HAVEN')).not.toBeInTheDocument()
  })

  it('selecting a customer adds it as a chip', async () => {
    mockCustomers.push(seedCustomer('bayada', { shortName: 'Bayada' }))
    await openEditor()

    fireEvent.click(screen.getByText(/Any customer/i))
    const option = await screen.findByText('Bayada')
    fireEvent.click(option)

    // Chip should now be visible in the closed trigger
    expect(screen.getAllByText('Bayada').length).toBeGreaterThan(0)
  })

  it('environments list narrows when customers are selected', async () => {
    mockCustomers.push(
      seedCustomer('bayada', { shortName: 'Bayada' }),
      seedCustomer('ck', { shortName: 'CK' }),
    )
    mockEnvironments.push(
      seedEnv('bayada-prod', 'bayada'),
      seedEnv('bayada-staging', 'bayada'),
      seedEnv('ck-prod', 'ck'),
    )
    await openEditor()

    // Select only Bayada
    fireEvent.click(screen.getByText(/Any customer/i))
    fireEvent.click(await screen.findByText('Bayada'))
    // Close customer dropdown
    fireEvent.mouseDown(document.body)

    // Open env dropdown — should only show bayada envs
    const envTrigger = screen.getByText(/Any env in selected customers/i)
    fireEvent.click(envTrigger)

    await waitFor(() => screen.getByText('bayada-prod'))
    expect(screen.getByText('bayada-staging')).toBeInTheDocument()
    expect(screen.queryByText('ck-prod')).not.toBeInTheDocument()
  })

  it('component chips come from the trigger catalog options', async () => {
    await openEditor()
    // Components are rendered as chips, not a dropdown — they appear inline
    expect(screen.getByText('Database')).toBeInTheDocument()
    expect(screen.getByText('Cache')).toBeInTheDocument()
    expect(screen.getByText('File Storage')).toBeInTheDocument()
  })

  it('envTier chips come from the trigger options', async () => {
    await openEditor()
    expect(screen.getByText('production')).toBeInTheDocument()
    expect(screen.getByText('staging')).toBeInTheDocument()
    expect(screen.getByText('lower')).toBeInTheDocument()
  })

  it('search filters options in the dropdown', async () => {
    mockCustomers.push(
      seedCustomer('bayada', { shortName: 'Bayada' }),
      seedCustomer('ck', { shortName: 'CK' }),
      seedCustomer('tribute', { shortName: 'Tribute' }),
    )
    await openEditor()

    fireEvent.click(screen.getByText(/Any customer/i))
    const searchInput = await screen.findByPlaceholderText(/Search.../i)
    fireEvent.change(searchInput, { target: { value: 'bay' } })

    await waitFor(() => {
      expect(screen.getByText('Bayada')).toBeInTheDocument()
      expect(screen.queryByText('CK')).not.toBeInTheDocument()
      expect(screen.queryByText('Tribute')).not.toBeInTheDocument()
    })
  })

  it('Clear button removes all selected values', async () => {
    mockCustomers.push(
      seedCustomer('bayada', { shortName: 'Bayada' }),
      seedCustomer('ck', { shortName: 'CK' }),
    )
    await openEditor()

    fireEvent.click(screen.getByText(/Any customer/i))
    fireEvent.click(await screen.findByText('Bayada'))
    fireEvent.click(await screen.findByText('CK'))

    // Clear button
    fireEvent.click(screen.getByText('Clear'))
    await waitFor(() => expect(screen.getByText(/Any customer/i)).toBeInTheDocument())
  })

  it('submits selected customer IDs to the API on save', async () => {
    const createCalls: unknown[] = []
    mockCustomers.push(seedCustomer('bayada', { shortName: 'Bayada' }))
    apiFetchMock.mockImplementation((path: string, opts?: RequestInit) => {
      if (path === '/alerts/rules' && opts?.method === 'POST') {
        createCalls.push(JSON.parse((opts.body as string) || '{}'))
        return Promise.resolve({})
      }
      if (path === '/alerts/rules') return Promise.resolve({ rules: [] })
      if (path === '/alerts/triggers') return Promise.resolve({ triggers: SAMPLE_TRIGGERS })
      if (path === '/alerts/slack/channels') return Promise.resolve({
        ok: true,
        channels: [{ id: 'C1', name: 'alerts-prod', isPrivate: false }],
      })
      if (path === '/alerts/validate-channel') return Promise.resolve({ ok: true, inChannel: true })
      return Promise.resolve({})
    })

    render(<AlertRulesPanel />)
    await waitFor(() => screen.getByText('+ New Rule'))
    fireEvent.click(screen.getByText('+ New Rule'))
    await waitFor(() => screen.getByText('New Alert Rule'))

    fireEvent.change(screen.getByPlaceholderText(/e.g. Prod health alerts/i), { target: { value: 'Rule 1' } })
    await waitFor(() => expect(screen.getByText(/Add a Slack channel/i)).not.toBeDisabled())
    await pickChannel('alerts-prod')
    await waitFor(() => screen.getByText('#alerts-prod'))

    // Pick Bayada
    fireEvent.click(screen.getByText(/Any customer/i))
    fireEvent.click(await screen.findByText('Bayada'))
    fireEvent.mouseDown(document.body) // close dropdown

    fireEvent.click(screen.getByRole('button', { name: /Create/i }))

    await waitFor(() => expect(createCalls).toHaveLength(1))
    const payload = createCalls[0] as { filter: { customerIds?: string[] } }
    expect(payload.filter.customerIds).toEqual(['bayada'])
  })
})
