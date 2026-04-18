import { create } from 'zustand'

export type HomeView = 'dev' | 'qa' | 'pm' | 'support' | 'cs'
export type HomeGroupBy = 'releases' | 'tickets' | 'people'
export type HomeDays = 7 | 14 | 30

interface HomeState {
  /** Active role view */
  view: HomeView
  /** Selected person name (null = show all / no filter) */
  person: string | null
  /** Whether to group results by release (default) or by ticket */
  groupBy: HomeGroupBy
  /** How many days ahead to show upcoming releases */
  days: HomeDays
  /** Whether this is the first visit (show role picker) */
  isFirstVisit: boolean
  /** Set the active view */
  setView: (view: HomeView) => void
  /** Set the selected person */
  setPerson: (person: string | null) => void
  /** Set the grouping mode */
  setGroupBy: (groupBy: HomeGroupBy) => void
  /** Set the horizon days */
  setDays: (days: HomeDays) => void
  /** Mark first visit as complete */
  dismissFirstVisit: () => void
}

const STORAGE_KEY_VIEW = 'nectar-home-view'
const STORAGE_KEY_PERSON = 'nectar-home-person'
const STORAGE_KEY_GROUP_BY = 'nectar-home-group-by'
const STORAGE_KEY_DAYS = 'nectar-home-days'
const STORAGE_KEY_FIRST_VISIT = 'nectar-home-first-visit'

const VALID_DAYS: HomeDays[] = [7, 14, 30]

function loadFromStorage(): { view: HomeView; person: string | null; groupBy: HomeGroupBy; days: HomeDays; isFirstVisit: boolean } {
  try {
    const view = (localStorage.getItem(STORAGE_KEY_VIEW) as HomeView) || 'dev'
    const person = localStorage.getItem(STORAGE_KEY_PERSON) || null
    const groupBy = (localStorage.getItem(STORAGE_KEY_GROUP_BY) as HomeGroupBy) || 'releases'
    const rawDays = parseInt(localStorage.getItem(STORAGE_KEY_DAYS) || '7')
    const days = VALID_DAYS.includes(rawDays as HomeDays) ? rawDays as HomeDays : 7
    const isFirstVisit = localStorage.getItem(STORAGE_KEY_FIRST_VISIT) !== 'false'
    return { view, person, groupBy, days, isFirstVisit }
  } catch {
    return { view: 'dev', person: null, groupBy: 'releases', days: 7, isFirstVisit: true }
  }
}

export const useHomeStore = create<HomeState>((set) => {
  const initial = loadFromStorage()

  return {
    ...initial,

    setView: (view) => {
      try { localStorage.setItem(STORAGE_KEY_VIEW, view) } catch { /* ok */ }
      set({ view })
    },

    setPerson: (person) => {
      try {
        if (person) localStorage.setItem(STORAGE_KEY_PERSON, person)
        else localStorage.removeItem(STORAGE_KEY_PERSON)
      } catch { /* ok */ }
      set({ person })
    },

    setGroupBy: (groupBy) => {
      try { localStorage.setItem(STORAGE_KEY_GROUP_BY, groupBy) } catch { /* ok */ }
      set({ groupBy })
    },

    setDays: (days) => {
      try { localStorage.setItem(STORAGE_KEY_DAYS, String(days)) } catch { /* ok */ }
      set({ days })
    },

    dismissFirstVisit: () => {
      try { localStorage.setItem(STORAGE_KEY_FIRST_VISIT, 'false') } catch { /* ok */ }
      set({ isFirstVisit: false })
    },
  }
})
