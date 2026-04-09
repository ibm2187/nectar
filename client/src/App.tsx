import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { AppShell } from './components/layout/AppShell'
import { ReleasesPage } from './features/releases/ReleasesPage'
import { ReleaseDetail } from './features/releases/ReleaseDetail'
import { CustomersPage } from './features/customers/CustomersPage'
import { EnvironmentDetailPage } from './features/customers/EnvironmentDetailPage'
import { connectWebSocket, disconnectWebSocket, useWsStore } from './stores/wsStore'

declare global {
  interface Window {
    __nectarDismissLoader?: () => void
  }
}

export default function App() {
  const connected = useWsStore(s => s.connected)
  const hasReleases = useWsStore(s => s.releases.length > 0)
  const hasCustomers = useWsStore(s => s.customers.length > 0)
  const dismissed = useRef(false)

  useEffect(() => {
    connectWebSocket()
    return () => disconnectWebSocket()
  }, [])

  // Dismiss the HTML loading screen once all initial data is loaded
  useEffect(() => {
    if (connected && hasReleases && hasCustomers && !dismissed.current) {
      dismissed.current = true
      window.__nectarDismissLoader?.()
    }
  }, [connected, hasReleases, hasCustomers])

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<ReleasesPage />} />
          <Route path="/releases/:key" element={<ReleaseDetail />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/environments/:id" element={<EnvironmentDetailPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
