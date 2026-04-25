import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSupportStore, SUPPORT_PRESETS } from '../supportStore'

// Reset store + mock fetch between tests
const ORIGINAL_FETCH = globalThis.fetch

function mockFetch(response: any, { ok = true, status = 200 } = {}) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    status,
    headers: { get: () => 'application/json' } as any,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }) as any) as any
}

function resetStore() {
  useSupportStore.setState({
    tickets: [],
    totalTickets: 0,
    stats: null,
    syncStatus: null,
    accounts: [],
    departments: [],
    preset: 'standup',
    filters: { ...SUPPORT_PRESETS.standup },
    loading: false,
    error: null,
  })
}

describe('supportStore', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStore()
  })
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  describe('presets', () => {
    it('standup preset filters to Investigating + WVR', () => {
      expect(SUPPORT_PRESETS.standup.statuses).toEqual([
        'Investigating',
        'Waiting for Viv Response',
      ])
    })

    it('stale preset sets minAgeDays to 30', () => {
      expect(SUPPORT_PRESETS.stale.minAgeDays).toBe(30)
      expect(SUPPORT_PRESETS.stale.openOnly).toBe(true)
    })

    it('setPreset swaps in preset filters and fetches', async () => {
      mockFetch({ tickets: [] })
      useSupportStore.getState().setPreset('allOpen')
      expect(useSupportStore.getState().preset).toBe('allOpen')
      expect(useSupportStore.getState().filters.openOnly).toBe(true)
      expect(useSupportStore.getState().filters.statuses).toBeUndefined()
    })
  })

  describe('setFilters', () => {
    it('updates filters and transitions preset to custom', async () => {
      mockFetch({ tickets: [] })
      useSupportStore.getState().setFilters({ search: 'payroll' })
      expect(useSupportStore.getState().filters.search).toBe('payroll')
      expect(useSupportStore.getState().preset).toBe('custom')
    })

    it('clearFilter removes a single filter key', async () => {
      mockFetch({ tickets: [] })
      useSupportStore.getState().setFilters({ search: 'x', assigneeEmail: 'a@v.com' })
      useSupportStore.getState().clearFilter('search')
      expect(useSupportStore.getState().filters.search).toBeUndefined()
      expect(useSupportStore.getState().filters.assigneeEmail).toBe('a@v.com')
    })

    it('paging/sort-only updates preserve the active preset', async () => {
      mockFetch({ tickets: [] })
      // Land on a preset
      useSupportStore.getState().setPreset('stale')
      expect(useSupportStore.getState().preset).toBe('stale')

      // Page change: still 'stale'
      useSupportStore.getState().setFilters({ page: 2 })
      expect(useSupportStore.getState().preset).toBe('stale')

      // Page-size change: still 'stale'
      useSupportStore.getState().setFilters({ pageSize: 100 })
      expect(useSupportStore.getState().preset).toBe('stale')

      // Sort change: still 'stale'
      useSupportStore.getState().setFilters({ sort: 'priority', sortDir: 'asc' })
      expect(useSupportStore.getState().preset).toBe('stale')

      // Real criteria change → custom
      useSupportStore.getState().setFilters({ search: 'payroll' })
      expect(useSupportStore.getState().preset).toBe('custom')
    })
  })

  describe('loadTickets', () => {
    it('skips the network call when no assignee is active', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock as any
      // No assigneeEmail in the default standup preset — should be a no-op.
      await useSupportStore.getState().loadTickets()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(useSupportStore.getState().tickets).toHaveLength(0)
    })

    it('populates tickets on success when an assignee is active', async () => {
      mockFetch({ tickets: [{ id: '1', ticketNumber: 'VHC-1' }] })
      useSupportStore.setState({ filters: { assigneeEmail: 'a@v.com' } })
      await useSupportStore.getState().loadTickets()
      expect(useSupportStore.getState().tickets).toHaveLength(1)
      expect(useSupportStore.getState().tickets[0].ticketNumber).toBe('VHC-1')
      expect(useSupportStore.getState().loading).toBe(false)
      expect(useSupportStore.getState().error).toBeNull()
    })

    it('records error on failure', async () => {
      mockFetch({ error: 'boom' }, { ok: false, status: 500 })
      useSupportStore.setState({ filters: { assigneeEmail: 'a@v.com' } })
      await useSupportStore.getState().loadTickets()
      expect(useSupportStore.getState().tickets).toHaveLength(0)
      expect(useSupportStore.getState().error).toBeTruthy()
    })

    it('builds correct query string from filters', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ tickets: [] }),
      })) as any
      globalThis.fetch = fetchMock

      useSupportStore.setState({
        filters: { assigneeEmail: 'a@v.com', statuses: ['Investigating'], openOnly: true },
      })
      await useSupportStore.getState().loadTickets()

      const url = fetchMock.mock.calls[0][0] as string
      // assigneeEmail is server-side again — only the active person's
      // tickets are paged from the backend.
      expect(url).toContain('assigneeEmail=a%40v.com')
      expect(url).toContain('statuses=Investigating')
      expect(url).toContain('openOnly=true')
    })

    it('emits page/pageSize/sort/sortDir under the standard list-API contract', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ tickets: [], total: 0, page: 2, pageSize: 25 }),
      })) as any
      globalThis.fetch = fetchMock

      useSupportStore.setState({
        filters: { assigneeEmail: 'a@v.com', page: 2, pageSize: 25, sort: 'priority', sortDir: 'asc' },
      })
      await useSupportStore.getState().loadTickets()

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('page=2')
      expect(url).toContain('pageSize=25')
      expect(url).toContain('sort=priority')
      expect(url).toContain('sortDir=asc')
    })

    it('totalTickets is populated from the envelope total field', async () => {
      mockFetch({ tickets: [{ id: '1', ticketNumber: 'VHC-1' }], total: 137 })
      useSupportStore.setState({ filters: { assigneeEmail: 'a@v.com' } })
      await useSupportStore.getState().loadTickets()
      expect(useSupportStore.getState().totalTickets).toBe(137)
    })

    it('totalTickets falls back to tickets.length when the API omits total', async () => {
      mockFetch({ tickets: [{ id: '1', ticketNumber: 'VHC-1' }, { id: '2', ticketNumber: 'VHC-2' }] })
      useSupportStore.setState({ filters: { assigneeEmail: 'a@v.com' } })
      await useSupportStore.getState().loadTickets()
      expect(useSupportStore.getState().totalTickets).toBe(2)
    })

    it('emits new filters: accountIds, deptPrefixes, minAgeDays (incl. 0), maxAgeDays', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ tickets: [] }),
      })) as any
      globalThis.fetch = fetchMock

      useSupportStore.setState({
        filters: {
          assigneeEmail: 'a@v.com',
          accountIds: ['acct-1', 'acct-2'],
          deptPrefixes: ['VHC'],
          minAgeDays: 0,    // age-bucket "0–15d" — must not be dropped by truthy check
          maxAgeDays: 15,
        },
      })
      await useSupportStore.getState().loadTickets()

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('accountIds=acct-1%2Cacct-2')
      expect(url).toContain('deptPrefixes=VHC')
      expect(url).toContain('minAgeDays=0')
      expect(url).toContain('maxAgeDays=15')
    })
  })

  describe('loadAll', () => {
    it('fires all five lookup endpoints in parallel (tickets only when assignee active)', async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn(async (url: string) => {
        calls.push(url)
        return {
          ok: true, status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ tickets: [], assignees: [], accounts: [], departments: [], ticketCount: 0 }),
        } as any
      }) as any

      // Activate an assignee so /tickets fires too.
      useSupportStore.setState({ filters: { assigneeEmail: 'a@v.com' } })
      await useSupportStore.getState().loadAll()
      const paths = calls.map(c => c.replace(/\?.*$/, ''))
      expect(paths).toContain('/api/support/tickets')
      expect(paths).toContain('/api/support/sync-status')
      expect(paths).toContain('/api/support/stats')
      expect(paths).toContain('/api/support/accounts')
      expect(paths).toContain('/api/support/departments')
    })

    it('loadDepartments populates departments state', async () => {
      mockFetch({ departments: [{ deptPrefix: 'VHC', count: 12 }, { deptPrefix: 'BYD', count: 7 }] })
      await useSupportStore.getState().loadDepartments()
      expect(useSupportStore.getState().departments).toEqual([
        { deptPrefix: 'VHC', count: 12 },
        { deptPrefix: 'BYD', count: 7 },
      ])
    })
  })

  describe('persistence', () => {
    it('writes preset + filters to localStorage on setPreset', async () => {
      mockFetch({ tickets: [] })
      useSupportStore.getState().setPreset('stale')
      expect(localStorage.getItem('nectar-support-preset.v2')).toBe('stale')
      const saved = JSON.parse(localStorage.getItem('nectar-support-filters.v2') || '{}')
      expect(saved.minAgeDays).toBe(30)
    })
  })
})
