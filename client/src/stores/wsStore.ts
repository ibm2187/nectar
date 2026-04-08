import { create } from 'zustand'
import type { Release, CustomerVersion } from '../api/client'

interface AppConfig {
  jiraBaseUrl: string
}

interface WsState {
  connected: boolean
  releases: Release[]
  customers: CustomerVersion[]
  config: AppConfig
  setConnected: (v: boolean) => void
  setReleases: (r: Release[]) => void
  setCustomers: (c: CustomerVersion[]) => void
  setConfig: (c: AppConfig) => void
  upsertRelease: (r: Release) => void
  removeRelease: (version: string) => void
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  releases: [],
  customers: [],
  config: { jiraBaseUrl: '' },
  setConnected: (connected) => set({ connected }),
  setReleases: (releases) => set({ releases }),
  setCustomers: (customers) => set({ customers }),
  setConfig: (config) => set({ config }),
  upsertRelease: (release) => set((state) => {
    const idx = state.releases.findIndex(r => r.id === release.id)
    const next = [...state.releases]
    if (idx >= 0) next[idx] = release
    else next.unshift(release)
    return { releases: next }
  }),
  removeRelease: (version) => set((state) => ({
    releases: state.releases.filter(r => r.version !== version),
  })),
}))

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connectWebSocket() {
  const store = useWsStore.getState()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/ws`)

  ws.onopen = () => {
    store.setConnected(true)
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const s = useWsStore.getState()

    switch (msg.type) {
      case 'init':
        s.setReleases(msg.releases)
        if (msg.customers) s.setCustomers(msg.customers)
        if (msg.config) s.setConfig(msg.config)
        break
      case 'release:created':
        s.upsertRelease(msg.release)
        break
      case 'release:updated':
      case 'release:transition':
        s.upsertRelease(msg.release)
        break
      case 'release:deleted':
        s.removeRelease(msg.version)
        break
      case 'customer:updated':
        if (msg.customers) s.setCustomers(msg.customers)
        break
      case 'discovery:completed':
      case 'jira:sync-completed':
        if (msg.releases) s.setReleases(msg.releases)
        break
    }
  }

  ws.onclose = () => {
    store.setConnected(false)
    ws = null
    reconnectTimer = setTimeout(connectWebSocket, 3000)
  }

  ws.onerror = () => {
    ws?.close()
  }
}

export function disconnectWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close()
}
