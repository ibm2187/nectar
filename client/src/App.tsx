import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'
import { AppShell } from './components/layout/AppShell'
import { ReleasesPage } from './features/releases/ReleasesPage'
import { ReleaseDetail } from './features/releases/ReleaseDetail'
import { CustomersPage } from './features/customers/CustomersPage'
import { EnvironmentDetailPage } from './features/customers/EnvironmentDetailPage'
import { connectWebSocket, disconnectWebSocket, useWsStore } from './stores/wsStore'
import { NectarLoader } from './components/NectarLoader'

export default function App() {
  const connected = useWsStore(s => s.connected)
  const hasData = useWsStore(s => s.releases.length > 0)

  useEffect(() => {
    connectWebSocket()
    return () => disconnectWebSocket()
  }, [])

  if (!connected || !hasData) {
    return <NectarLoader size="lg" message={!connected ? 'Connecting to Nectar...' : 'Loading releases...'} className="min-h-screen" />
  }

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
