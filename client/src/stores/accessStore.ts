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
  lastLoginAt: string | null
  createdAt: string
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
}

export const useAccessStore = create<AccessState>((set, get) => ({
  capabilities: [],
  roles: [],
  users: [],
  keys: [],
  loading: false,
  error: null,

  loadAll: async () => {
    set({ loading: true, error: null })
    try {
      const [capabilities, roles, users, keys] = await Promise.all([
        apiFetch<Capability[]>('/access/capabilities'),
        apiFetch<Role[]>('/access/roles'),
        apiFetch<AccessUser[]>('/access/users'),
        apiFetch<AccessKey[]>('/access/keys'),
      ])
      set({ capabilities, roles, users, keys, loading: false })
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
}))
