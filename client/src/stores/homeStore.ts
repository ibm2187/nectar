import { create } from 'zustand'

export type HomeView = 'dev' | 'qa' | 'pm' | 'support' | 'cs'
export type HomeGroupBy = 'releases' | 'tickets' | 'people'

interface HomeState {
  /** Active role view */
  view: HomeView
  /** Selected person name (null = show all / no filter) */
  person: string | null
  /** Whether to group results by release (default) or by ticket */
  groupBy: HomeGroupBy
  /** Whether this is the first visit (show role picker) */
  isFirstVisit: boolean
  /** Set the active view */
  setView: (view: HomeView) => void
  /** Set the selected person */
  setPerson: (person: string | null) => void
  /** Set the grouping mode */
  setGroupBy: (groupBy: HomeGroupBy) => void
  /** Mark first visit as complete */
  dismissFirstVisit: () => void
}

const STORAGE_KEY_VIEW = 'nectar-home-view'
const STORAGE_KEY_PERSON = 'nectar-home-person'
const STORAGE_KEY_GROUP_BY = 'nectar-home-group-by'
const STORAGE_KEY_FIRST_VISIT = 'nectar-home-first-visit'

function loadFromStorage(): { view: HomeView; person: string | null; groupBy: HomeGroupBy; isFirstVisit: boolean } {
  try {
    const view = (localStorage.getItem(STORAGE_KEY_VIEW) as HomeView) || 'dev'
    const person = localStorage.getItem(STORAGE_KEY_PERSON) || null
    const groupBy = (localStorage.getItem(STORAGE_KEY_GROUP_BY) as HomeGroupBy) || 'releases'
    const isFirstVisit = localStorage.getItem(STORAGE_KEY_FIRST_VISIT) !== 'false'
    return { view, person, groupBy, isFirstVisit }
  } catch {
    return { view: 'dev', person: null, groupBy: 'releases', isFirstVisit: true }
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

    dismissFirstVisit: () => {
      try { localStorage.setItem(STORAGE_KEY_FIRST_VISIT, 'false') } catch { /* ok */ }
      set({ isFirstVisit: false })
    },
  }
})
