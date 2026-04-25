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
  /** Absolute DB total (no filter applied). */
  total: number
  /** Absolute DB open count (no filter applied). */
  open: number
  /** Sum across the filter-aware assignee distribution — "N match filters". */
  matchTotal?: number
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
  /** Whitelisted on the server: modified | created | status | priority | assignee | ticketNumber | age */
  sort?: string
  sortDir?: 'asc' | 'desc'
  /** 1-based page number for the standard list-API contract. */
  page?: number
  pageSize?: number
  /** @deprecated use `pageSize`; retained for legacy callers. */
  limit?: number
  /** @deprecated use `sort`. */
  orderBy?: 'modified' | 'created' | 'status'
  /** @deprecated use `sortDir`. */
  orderDir?: 'asc' | 'desc'
}

export type SupportPreset = 'standup' | 'allOpen' | 'stale' | 'myTickets' | 'custom'

// Default page size for /support's per-assignee pagination. Server enforces
// this via opts.limit; SupportPage's Paginator uses it to compute page count.
const DEFAULT_PAGE_SIZE = 25

const PRESETS: Record<SupportPreset, SupportFilters> = {
  standup: {
    statuses: ['Investigating', 'Waiting for Viv Response'],
    orderBy: 'created',
    orderDir: 'asc',
    pageSize: DEFAULT_PAGE_SIZE,
  },
  allOpen: {
    openOnly: true,
    orderBy: 'modified',
    orderDir: 'desc',
    pageSize: DEFAULT_PAGE_SIZE,
  },
  stale: {
    openOnly: true,
    minAgeDays: 30,
    orderBy: 'created',
    orderDir: 'asc',
    pageSize: DEFAULT_PAGE_SIZE,
  },
  myTickets: {
    // assigneeEmail is injected at selection time from auth store
    orderBy: 'modified',
    orderDir: 'desc',
    pageSize: DEFAULT_PAGE_SIZE,
  },
  custom: { pageSize: DEFAULT_PAGE_SIZE },
}

// ── Store ───────────────────────────────────────────────────

interface SupportState {
  // Data
  tickets: SupportTicket[]
  /** Total tickets matching current filters across all pages (from API envelope). */
  totalTickets: number
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

// v2 — Bundle 3 added pageSize/sort to the persisted filter; bumping the key
// resets any localStorage entry with a small global pageSize that would now
// cap the per-card pagination's source data.
const STORAGE_KEY_PRESET = 'nectar-support-preset.v2'
const STORAGE_KEY_FILTERS = 'nectar-support-filters.v2'

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
  if (f.sort) p.set('sort', f.sort)
  else if (f.orderBy) p.set('sort', f.orderBy)
  if (f.sortDir) p.set('sortDir', f.sortDir)
  else if (f.orderDir) p.set('sortDir', f.orderDir)
  if (f.page) p.set('page', String(f.page))
  if (f.pageSize) p.set('pageSize', String(f.pageSize))
  else if (f.limit) p.set('limit', String(f.limit))
  return p.toString()
}

export const useSupportStore = create<SupportState>((set, get) => {
  const persisted = loadPersisted()

  return {
    tickets: [],
    totalTickets: 0,
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
      // /support only renders tickets for the *active* assignee — other
      // assignees show count only via /stats. Skip the network call entirely
      // when no assignee is selected; the page state stays empty and the
      // user gets cards-only.
      if (!get().filters.assigneeEmail) {
        set({ tickets: [], totalTickets: 0, loading: false })
        return
      }
      set({ loading: true, error: null })
      try {
        const qs = filtersToQuery(get().filters)
        const data = await apiFetch<{ tickets: SupportTicket[]; total?: number }>(
          `/support/tickets${qs ? `?${qs}` : ''}`
        )
        set({
          tickets: data.tickets,
          totalTickets: data.total ?? data.tickets.length,
          loading: false,
        })
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
        // Stats use the same filter set as /tickets EXCEPT assigneeEmail
        // (the cross-assignee distribution is the whole point) and paging
        // params (don't apply to aggregate counts).
        const f = get().filters
        const statsFilters: SupportFilters = { ...f }
        delete statsFilters.assigneeEmail
        delete statsFilters.page
        delete statsFilters.pageSize
        delete statsFilters.limit
        const qs = filtersToQuery(statsFilters)
        const data = await apiFetch<SupportStats>(`/support/stats${qs ? `?${qs}` : ''}`)
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
      // Reload both: tickets for the active assignee + filter-aware tab counts
      get().loadTickets()
      get().loadStats()
    },

    setFilters: (updates) => {
      // Any filter *criteria* change resets to page 1 — narrowing a list could
      // otherwise leave the user on a now-empty later page.
      // Pagination/sort-only updates (next/prev page, page-size selector,
      // sort header click) preserve the active preset; they only change how
      // we view the criteria, not the criteria themselves.
      const isPagingOrSortOnly = Object.keys(updates).every(
        k => k === 'page' || k === 'pageSize' || k === 'sort' || k === 'sortDir'
      )
      const next = isPagingOrSortOnly
        ? { ...get().filters, ...updates }
        : { ...get().filters, ...updates, page: 1 }
      const nextPreset = isPagingOrSortOnly ? get().preset : 'custom'
      persistState(nextPreset, next)
      set({ filters: next, preset: nextPreset })
      get().loadTickets()
      // Stats only need to refetch when criteria actually change (not on
      // page/sort flips inside an already-narrowed view) AND only when the
      // change isn't purely an assignee switch (which is just selecting a
      // tab — the per-assignee counts don't change just because we're
      // looking at a different person).
      const onlyAssignee = Object.keys(updates).every(k => k === 'assigneeEmail')
      if (!isPagingOrSortOnly && !onlyAssignee) get().loadStats()
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
