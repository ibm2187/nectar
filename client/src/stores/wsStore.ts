import { create } from 'zustand'
import type { Release, Customer, Environment } from '../api/client'

interface AppConfig {
  jiraBaseUrl: string
  jiraProject?: string
}

interface WsState {
  connected: boolean
  releases: Release[]
  customers: Customer[]
  environments: Environment[]
  config: AppConfig
  setConnected: (v: boolean) => void
  setReleases: (r: Release[]) => void
  setCustomers: (c: Customer[]) => void
  setEnvironments: (e: Environment[]) => void
  setConfig: (c: AppConfig) => void
  upsertRelease: (r: Release) => void
  removeRelease: (version: string) => void
  upsertCustomer: (c: Customer) => void
  upsertEnvironment: (e: Environment) => void
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  releases: [],
  customers: [],
  environments: [],
  config: { jiraBaseUrl: '' },
  setConnected: (connected) => set({ connected }),
  setReleases: (releases) => set({ releases }),
  setCustomers: (customers) => set({ customers }),
  setEnvironments: (environments) => set({ environments }),
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
  upsertCustomer: (customer) => set((state) => {
    const idx = state.customers.findIndex(c => c.id === customer.id)
    const next = [...state.customers]
    if (idx >= 0) next[idx] = customer
    else next.push(customer)
    return { customers: next }
  }),
  upsertEnvironment: (env) => set((state) => {
    const idx = state.environments.findIndex(e => e.id === env.id)
    const next = [...state.environments]
    if (idx >= 0) next[idx] = env
    else next.push(env)
    return { environments: next }
  }),
}))

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let pingTimer: ReturnType<typeof setInterval> | null = null
let lastPong = 0

const MIN_RECONNECT = 1000
const MAX_RECONNECT = 60000

function resetReconnectDelay() {
  reconnectDelay = MIN_RECONNECT
}

function nextReconnectDelay() {
  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT)
  return delay
}

function startHeartbeat() {
  stopHeartbeat()
  lastPong = Date.now()
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // If no pong in 45s, connection is dead — force reconnect
    if (Date.now() - lastPong > 45000) {
      ws.close()
      return
    }
    ws.send(JSON.stringify({ type: 'ping' }))
  }, 30000)
}

function stopHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
}

export function connectWebSocket() {
  const store = useWsStore.getState()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/ws`)

  ws.onopen = () => {
    store.setConnected(true)
    resetReconnectDelay()
    startHeartbeat()
  }

  ws.onmessage = (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    const s = useWsStore.getState()

    if (msg.type === 'pong') {
      lastPong = Date.now()
      return
    }

    switch (msg.type) {
      case 'init':
        s.setReleases(msg.releases)
        if (msg.customers) s.setCustomers(msg.customers)
        if (msg.environments) s.setEnvironments(msg.environments)
        if (msg.config) s.setConfig(msg.config)
        break
      case 'release:created':
        s.upsertRelease(msg.release)
        break
      case 'release:updated':
      case 'release:transition':
        s.upsertRelease(msg.release)
        break
      case 'comment:added':
      case 'comment:deleted':
        if (msg.release) s.upsertRelease(msg.release)
        break
      case 'release:deleted':
        s.removeRelease(msg.version)
        break
      case 'customer:updated':
        if (msg.customer) s.upsertCustomer(msg.customer)
        break
      case 'environment:updated':
      case 'environment:version':
        if (msg.environment) s.upsertEnvironment(msg.environment)
        break
      case 'webplatform:scan-completed':
        if (msg.customers) s.setCustomers(msg.customers)
        if (msg.environments) s.setEnvironments(msg.environments)
        break
      case 'discovery:completed':
      case 'jira:sync-completed':
        if (msg.releases) s.setReleases(msg.releases)
        break
    }
  }

  ws.onclose = () => {
    store.setConnected(false)
    stopHeartbeat()
    ws = null
    const delay = nextReconnectDelay()
    reconnectTimer = setTimeout(connectWebSocket, delay)
  }

  ws.onerror = () => {
    ws?.close()
  }
}

export function disconnectWebSocket() {
  stopHeartbeat()
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  ws?.close()
  ws = null
}
