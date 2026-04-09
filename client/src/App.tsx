import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'
import { AppShell } from './components/layout/AppShell'
import { ReleasesPage } from './features/releases/ReleasesPage'
import { ReleaseDetail } from './features/releases/ReleaseDetail'
import { CustomersPage } from './features/customers/CustomersPage'
import { EnvironmentDetailPage } from './features/customers/EnvironmentDetailPage'
import { connectWebSocket, disconnectWebSocket } from './stores/wsStore'

export default function App() {
  useEffect(() => {
    connectWebSocket()
    return () => disconnectWebSocket()
  }, [])

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
