import { create } from 'zustand'

export interface AuthUser {
  email: string
  name: string
  picture: string | null
  domain: string | null
  role: 'admin' | 'user'
  capabilities: string[]
  roles: string[]
}

interface AuthState {
  /** Whether auth state has been loaded from the server */
  loaded: boolean
  /** Whether the user is authenticated */
  authenticated: boolean
  /** Whether Google SSO is enabled on the server */
  ssoEnabled: boolean
  /** The authenticated user (null when not authenticated) */
  user: AuthUser | null
  /** Check if the current user has a specific capability */
  hasCap: (cap: string) => boolean
  /** Load auth state from /api/auth/me */
  loadAuth: () => Promise<void>
  /** Log out the current user */
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  loaded: false,
  authenticated: false,
  ssoEnabled: false,
  user: null,

  hasCap: (cap: string) => {
    const { user, ssoEnabled } = get()
    // Dev mode (SSO disabled) = full access, matching backend behavior
    if (!ssoEnabled) return true
    return user?.capabilities.includes(cap) ?? false
  },

  loadAuth: async () => {
    try {
      const res = await fetch('/api/auth/me')
      const data = await res.json()
      set({
        loaded: true,
        authenticated: data.authenticated || false,
        ssoEnabled: data.ssoEnabled || false,
        user: data.user || null,
      })
    } catch {
      set({ loaded: true, authenticated: false, ssoEnabled: false, user: null })
    }
  },

  logout: async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore
    }
    set({ authenticated: false, user: null })
    window.location.href = '/login'
  },
}))
