import { create } from 'zustand'
import { apiFetch } from '../api/client'

export interface Capability {
  id: string
  name: string
  description: string
  namespace: string
}

export interface Role {
  id: string
  name: string
  description: string | null
  capabilities: string[]
  system: boolean
  createdAt: string
  updatedAt: string
}

export interface AccessUser {
  email: string
  name: string
  picture: string | null
  roleIds: string[]
  capabilities: string[]
  teamId: string | null
  jiraName: string | null
  lastLoginAt: string | null
  createdAt: string
}

export interface Team {
  id: string
  name: string
  description: string | null
  color: string
  createdAt: string
  updatedAt: string
}

export interface AccessKey {
  id: string
  label: string
  roleId: string | null
  roleName: string | null
  createdAt: string
  createdBy: string | null
  lastUsedAt: string | null
}

interface AccessState {
  capabilities: Capability[]
  roles: Role[]
  users: AccessUser[]
  keys: AccessKey[]
  teams: Team[]
  loading: boolean
  error: string | null

  loadAll: () => Promise<void>
  createRole: (data: { id: string; name: string; description?: string; capabilities: string[] }) => Promise<Role>
  updateRole: (id: string, data: { name?: string; description?: string; capabilities?: string[] }) => Promise<Role>
  deleteRole: (id: string) => Promise<void>
  updateUserRoles: (email: string, roleIds: string[]) => Promise<void>
  createKey: (data: { label: string; roleId: string }) => Promise<{ id: string; rawKey: string; label: string; roleId: string }>
  updateKeyRole: (keyId: string, roleId: string) => Promise<void>
  revokeKey: (keyId: string) => Promise<void>

  createTeam: (input: { name: string; description?: string; color: string }) => Promise<Team>
  updateTeam: (id: string, patch: Partial<Pick<Team, 'name' | 'description' | 'color'>>) => Promise<Team>
  deleteTeam: (id: string) => Promise<void>
  updateUserTeam: (email: string, teamId: string | null) => Promise<void>
  updateUserJiraName: (email: string, jiraName: string | null) => Promise<void>
}

export const useAccessStore = create<AccessState>((set, get) => ({
  capabilities: [],
  roles: [],
  users: [],
  keys: [],
  teams: [],
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null })
    try {
      const [capabilities, roles, users, keys, teams] = await Promise.all([
        apiFetch<Capability[]>('/access/capabilities'),
        apiFetch<Role[]>('/access/roles'),
        apiFetch<AccessUser[]>('/access/users'),
        apiFetch<AccessKey[]>('/access/keys'),
        apiFetch<Team[]>('/access/teams'),
      ])
      set({ capabilities, roles, users, keys, teams, loading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load access data'
      set({ error: message, loading: false })
    }
  },

  createRole: async (data) => {
    const role = await apiFetch<Role>('/access/roles', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    set({ roles: [...get().roles, role] })
    return role
  },

  updateRole: async (id, data) => {
    const updated = await apiFetch<Role>(`/access/roles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
    set({ roles: get().roles.map((r) => (r.id === id ? updated : r)) })
    return updated
  },

  deleteRole: async (id) => {
    await apiFetch<void>(`/access/roles/${id}`, { method: 'DELETE' })
    set({ roles: get().roles.filter((r) => r.id !== id) })
  },

  updateUserRoles: async (email, roleIds) => {
    await apiFetch<void>(`/access/users/${encodeURIComponent(email)}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ roleIds }),
    })
    set({
      users: get().users.map((u) =>
        u.email === email ? { ...u, roleIds } : u
      ),
    })
  },

  createKey: async (data) => {
    const result = await apiFetch<{ id: string; rawKey: string; label: string; roleId: string }>(
      '/access/keys',
      { method: 'POST', body: JSON.stringify(data) }
    )
    // Re-fetch keys to get the server-rendered entry (rawKey is only returned once)
    const keys = await apiFetch<AccessKey[]>('/access/keys')
    set({ keys })
    return result
  },

  updateKeyRole: async (keyId, roleId) => {
    await apiFetch<void>(`/access/keys/${keyId}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId }),
    })
    set({
      keys: get().keys.map((k) =>
        k.id === keyId ? { ...k, roleId } : k
      ),
    })
  },

  revokeKey: async (keyId) => {
    await apiFetch<void>(`/access/keys/${keyId}`, { method: 'DELETE' })
    set({ keys: get().keys.filter((k) => k.id !== keyId) })
  },

  createTeam: async (data) => {
    const team = await apiFetch<Team>('/access/teams', {
      method: 'POST',
      body: JSON.stringify(data),
    })
    set({ teams: [...get().teams, team].sort((a, b) => a.name.localeCompare(b.name)) })
    return team
  },

  updateTeam: async (id, patch) => {
    const updated = await apiFetch<Team>(`/access/teams/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    set({ teams: get().teams.map((t) => (t.id === id ? updated : t)) })
    return updated
  },

  deleteTeam: async (id) => {
    await apiFetch<void>(`/access/teams/${id}`, { method: 'DELETE' })
    set({ teams: get().teams.filter((t) => t.id !== id) })
  },

  updateUserTeam: async (email, teamId) => {
    await apiFetch<void>(`/access/users/${encodeURIComponent(email)}/team`, {
      method: 'PUT',
      body: JSON.stringify({ teamId }),
    })
    set({ users: get().users.map((u) => (u.email === email ? { ...u, teamId } : u)) })
  },

  updateUserJiraName: async (email, jiraName) => {
    await apiFetch<void>(`/access/users/${encodeURIComponent(email)}/jira-name`, {
      method: 'PUT',
      body: JSON.stringify({ jiraName }),
    })
    set({ users: get().users.map((u) => (u.email === email ? { ...u, jiraName } : u)) })
  },
}))
