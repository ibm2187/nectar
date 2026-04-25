import { create } from 'zustand'
import { apiFetch } from '../api/client'

// ── Types ──────────────────────────────────────────────────

export interface SupportTicket {
  id: string
  ticketNumber: string
  deptPrefix: string | null
  assigneeEmail: string | null
  assigneeName: string | null
  accountId: string | null
  accountName: string | null
  subject: string | null
  status: string | null
  statusType: string | null
  priority: string | null
  category: string | null
  subCategory: string | null
  channel: string | null
  sentiment: string | null
  commentCount: number
  threadCount: number
  createdAt: string | null
  modifiedAt: string | null
  closedAt: string | null
  onHoldAt: string | null
  customerResponseAt: string | null
  webUrl: string | null
  ageDays: number | null
  linkedJiraCount?: number
  linkedJiras?: SupportLinkedJira[]
  lastSyncedAt: string
}

export interface SupportLinkedJira {
  jiraKey: string
  summary?: string | null
  status: string | null
  statusCategory: string | null
  assignee: string | null
  priority?: string | null
  fixVersions: string[]
  truth?: SupportLinkedJiraTruth[]
}

export interface SupportLinkedJiraTruth {
  version: string
  repo: string
  healthCategory: string | null
  healthMessage: string | null
  stage: string | null
  prNumber: number | null
  prUrl: string | null
  onBranch: boolean
  inFixVersion: boolean
}

export interface SupportAssigneeStat {
  assigneeEmail: string | null
  displayName: string | null
  total: number
  openCount: number
}

export interface SupportStats {
  total: number
  open: number
  assignees: SupportAssigneeStat[]
}

export interface SupportSyncStatus {
  lastRunAt: string | null
  lastBackfillAt: string | null
  backfillStatus: 'pending' | 'in_progress' | 'done' | 'failed' | null
  backfillProgress: number
  backfillTotal: number
  lastModifiedCursor: string | null
  lastSyncError: string | null
  lastSyncDurationMs: number | null
  ticketCount: number
  openTicketCount: number
}

export interface SupportTicketLink {
  jiraKey: string
  source: string
}

export interface SupportHistoryEntry {
  id: string
  ticketId: string
  changedAt: string
  changedByEmail: string | null
  fieldName: string
  fromValue: string | null
  toValue: string | null
}

export interface SupportTicketDetail {
  ticket: SupportTicket & { rawPayload?: string | null }
  linkedJiraKeys: SupportTicketLink[]
  linkedJiras?: SupportLinkedJira[]
  history: SupportHistoryEntry[]
  daysInCurrentStatus: number | null
}

export interface SupportAccount {
  id: string
  name: string | null
  departmentId: string | null
}

export interface SupportDepartment {
  deptPrefix: string
  count: number
}

// ── Filter shape ────────────────────────────────────────────

export type SupportFilters = {
  assigneeEmail?: string
  statuses?: string[]
  statusTypes?: string[]
  priorities?: string[]
  deptPrefixes?: string[]
  accountIds?: string[]
  openOnly?: boolean
  closedOnly?: boolean
  hasJiraLinks?: boolean
  minAgeDays?: number
  maxAgeDays?: number
  fixVersions?: string[]
  search?: string
  orderBy?: 'modified' | 'created' | 'status'
  orderDir?: 'asc' | 'desc'
  limit?: number
}

export type SupportPreset = 'standup' | 'allOpen' | 'stale' | 'myTickets' | 'custom'

const PRESETS: Record<SupportPreset, SupportFilters> = {
  standup: {
    statuses: ['Investigating', 'Waiting for Viv Response'],
    orderBy: 'created',
    orderDir: 'asc',
  },
  allOpen: {
    openOnly: true,
    orderBy: 'modified',
    orderDir: 'desc',
  },
  stale: {
    openOnly: true,
    minAgeDays: 30,
    orderBy: 'created',
    orderDir: 'asc',
  },
  myTickets: {
    // assigneeEmail is injected at selection time from auth store
    orderBy: 'modified',
    orderDir: 'desc',
  },
  custom: {},
}

// ── Store ───────────────────────────────────────────────────

interface SupportState {
  // Data
  tickets: SupportTicket[]
  stats: SupportStats | null
  syncStatus: SupportSyncStatus | null
  accounts: SupportAccount[]
  departments: SupportDepartment[]

  // Filter state
  preset: SupportPreset
  filters: SupportFilters

  // Loading / errors
  loading: boolean
  error: string | null

  // Actions
  loadAll: () => Promise<void>
  loadTickets: () => Promise<void>
  loadSyncStatus: () => Promise<void>
  loadStats: () => Promise<void>
  loadAccounts: () => Promise<void>
  loadDepartments: () => Promise<void>

  setPreset: (preset: SupportPreset, overrides?: Partial<SupportFilters>) => void
  setFilters: (updates: Partial<SupportFilters>) => void
  clearFilter: (key: keyof SupportFilters) => void

}

const STORAGE_KEY_PRESET = 'nectar-support-preset'
const STORAGE_KEY_FILTERS = 'nectar-support-filters'

function loadPersisted(): { preset: SupportPreset; filters: SupportFilters } {
  try {
    const preset = (localStorage.getItem(STORAGE_KEY_PRESET) as SupportPreset) || 'standup'
    const filtersRaw = localStorage.getItem(STORAGE_KEY_FILTERS)
    const filters = filtersRaw ? JSON.parse(filtersRaw) : PRESETS[preset]
    return { preset, filters: { ...PRESETS[preset], ...filters } }
  } catch {
    return { preset: 'standup', filters: { ...PRESETS.standup } }
  }
}

function persistState(preset: SupportPreset, filters: SupportFilters) {
  try {
    localStorage.setItem(STORAGE_KEY_PRESET, preset)
    localStorage.setItem(STORAGE_KEY_FILTERS, JSON.stringify(filters))
  } catch { /* ok */ }
}

function filtersToQuery(f: SupportFilters): string {
  const p = new URLSearchParams()
  if (f.assigneeEmail) p.set('assigneeEmail', f.assigneeEmail)
  if (f.statuses?.length) p.set('statuses', f.statuses.join(','))
  if (f.statusTypes?.length) p.set('statusTypes', f.statusTypes.join(','))
  if (f.priorities?.length) p.set('priorities', f.priorities.join(','))
  if (f.deptPrefixes?.length) p.set('deptPrefixes', f.deptPrefixes.join(','))
  if (f.accountIds?.length) p.set('accountIds', f.accountIds.join(','))
  if (f.openOnly) p.set('openOnly', 'true')
  if (f.closedOnly) p.set('closedOnly', 'true')
  if (f.hasJiraLinks) p.set('hasJiraLinks', 'true')
  if (f.minAgeDays != null) p.set('minAgeDays', String(f.minAgeDays))
  if (f.maxAgeDays != null) p.set('maxAgeDays', String(f.maxAgeDays))
  if (f.fixVersions?.length) p.set('fixVersions', f.fixVersions.join(','))
  if (f.search) p.set('search', f.search)
  if (f.orderBy) p.set('orderBy', f.orderBy)
  if (f.orderDir) p.set('orderDir', f.orderDir)
  if (f.limit) p.set('limit', String(f.limit))
  return p.toString()
}

export const useSupportStore = create<SupportState>((set, get) => {
  const persisted = loadPersisted()

  return {
    tickets: [],
    stats: null,
    syncStatus: null,
    accounts: [],
    departments: [],
    preset: persisted.preset,
    filters: persisted.filters,
    loading: false,
    error: null,

    loadAll: async () => {
      await Promise.all([
        get().loadTickets(),
        get().loadSyncStatus(),
        get().loadStats(),
        get().loadAccounts(),
        get().loadDepartments(),
      ])
    },

    loadTickets: async () => {
      set({ loading: true, error: null })
      try {
        const qs = filtersToQuery(get().filters)
        const data = await apiFetch<{ tickets: SupportTicket[] }>(`/support/tickets${qs ? `?${qs}` : ''}`)
        set({ tickets: data.tickets, loading: false })
      } catch (err: any) {
        set({ error: err?.message || 'Failed to load tickets', loading: false })
      }
    },

    loadSyncStatus: async () => {
      try {
        const data = await apiFetch<SupportSyncStatus>('/support/sync-status')
        set({ syncStatus: data })
      } catch { /* non-fatal */ }
    },

    loadStats: async () => {
      try {
        const data = await apiFetch<SupportStats>('/support/stats')
        set({ stats: data })
      } catch { /* non-fatal */ }
    },

    loadAccounts: async () => {
      try {
        const data = await apiFetch<{ accounts: SupportAccount[] }>('/support/accounts')
        set({ accounts: data.accounts })
      } catch { /* non-fatal */ }
    },

    loadDepartments: async () => {
      try {
        const data = await apiFetch<{ departments: SupportDepartment[] }>('/support/departments')
        set({ departments: data.departments })
      } catch { /* non-fatal */ }
    },

    setPreset: (preset, overrides = {}) => {
      const filters = { ...PRESETS[preset], ...overrides }
      persistState(preset, filters)
      set({ preset, filters })
      // Fetch fresh tickets for the new preset
      get().loadTickets()
    },

    setFilters: (updates) => {
      const filters = { ...get().filters, ...updates }
      persistState(get().preset, filters)
      set({ filters, preset: 'custom' })
      persistState('custom', filters)
      get().loadTickets()
    },

    clearFilter: (key) => {
      const filters = { ...get().filters }
      delete filters[key]
      persistState(get().preset, filters)
      set({ filters })
      get().loadTickets()
    },

  }
})

// Exported for tests / downstream helpers
export const SUPPORT_PRESETS = PRESETS
