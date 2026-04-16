import { create } from 'zustand'
import { apiFetch } from '../api/client'

export interface OutEvent {
  name: string
  startDate: string
  endDate: string
  summary: string
}

export interface Holiday {
  date: string
  name: string
  countries: string[]
  summary: string
}

export interface AvailabilitySnapshot {
  loaded: boolean
  lastRefreshedAt: string | null
  currentlyOut: OutEvent[]
  upcomingHolidays: Holiday[]
  todayIsHoliday: { name: string; countries: string[] } | null
}

interface AvailabilityState {
  data: AvailabilitySnapshot
  loading: boolean
  /** Normalized name → current out event (fast lookup for PersonBadge) */
  _outByNormalized: Map<string, OutEvent>
  load: () => Promise<void>
  getOut: (name: string | null | undefined) => OutEvent | null
}

function normalize(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildIndex(events: OutEvent[]): Map<string, OutEvent> {
  const m = new Map<string, OutEvent>()
  for (const e of events) {
    const key = normalize(e.name)
    if (key) m.set(key, e)
  }
  return m
}

const EMPTY: AvailabilitySnapshot = {
  loaded: false,
  lastRefreshedAt: null,
  currentlyOut: [],
  upcomingHolidays: [],
  todayIsHoliday: null,
}

export const useAvailabilityStore = create<AvailabilityState>((set, get) => ({
  data: EMPTY,
  loading: false,
  _outByNormalized: new Map(),

  load: async () => {
    set({ loading: true })
    try {
      const data = await apiFetch<AvailabilitySnapshot>('/availability')
      set({
        data,
        loading: false,
        _outByNormalized: buildIndex(data.currentlyOut || []),
      })
    } catch {
      set({ loading: false })
    }
  },

  getOut: (name) => {
    if (!name) return null
    const idx = get()._outByNormalized
    const key = normalize(name)
    const exact = idx.get(key)
    if (exact) return exact

    // Fuzzy fallback: first name + last-name full match
    const tokens = key.split(/\s+/).filter(Boolean)
    if (tokens.length >= 2) {
      const wantLast = tokens[tokens.length - 1]
      const wantFirstInitial = tokens[0][0]
      for (const [storedKey, event] of idx.entries()) {
        const storedTokens = storedKey.split(/\s+/).filter(Boolean)
        if (storedTokens.length < 2) continue
        const storedLast = storedTokens[storedTokens.length - 1]
        const storedFirstInitial = storedTokens[0][0]
        if (storedLast === wantLast && storedFirstInitial === wantFirstInitial) {
          return event
        }
      }
    }
    return null
  },
}))
