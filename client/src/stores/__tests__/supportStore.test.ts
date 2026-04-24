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
    stats: null,
    syncStatus: null,
    accounts: [],
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
  })

  describe('loadTickets', () => {
    it('populates tickets on success', async () => {
      mockFetch({ tickets: [{ id: '1', ticketNumber: 'VHC-1' }] })
      await useSupportStore.getState().loadTickets()
      expect(useSupportStore.getState().tickets).toHaveLength(1)
      expect(useSupportStore.getState().tickets[0].ticketNumber).toBe('VHC-1')
      expect(useSupportStore.getState().loading).toBe(false)
      expect(useSupportStore.getState().error).toBeNull()
    })

    it('records error on failure', async () => {
      mockFetch({ error: 'boom' }, { ok: false, status: 500 })
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
      expect(url).toContain('assigneeEmail=a%40v.com')
      expect(url).toContain('statuses=Investigating')
      expect(url).toContain('openOnly=true')
    })
  })

  describe('loadAll', () => {
    it('fires all four lookup endpoints in parallel', async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn(async (url: string) => {
        calls.push(url)
        return {
          ok: true, status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ tickets: [], assignees: [], accounts: [], ticketCount: 0 }),
        } as any
      }) as any

      await useSupportStore.getState().loadAll()
      const paths = calls.map(c => c.replace(/\?.*$/, ''))
      expect(paths).toContain('/api/support/tickets')
      expect(paths).toContain('/api/support/sync-status')
      expect(paths).toContain('/api/support/stats')
      expect(paths).toContain('/api/support/accounts')
    })
  })

  describe('persistence', () => {
    it('writes preset + filters to localStorage on setPreset', async () => {
      mockFetch({ tickets: [] })
      useSupportStore.getState().setPreset('stale')
      expect(localStorage.getItem('nectar-support-preset')).toBe('stale')
      const saved = JSON.parse(localStorage.getItem('nectar-support-filters') || '{}')
      expect(saved.minAgeDays).toBe(30)
    })
  })
})
