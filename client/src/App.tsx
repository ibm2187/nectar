import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppShell } from './components/layout/AppShell'
import { HomePage } from './features/home/HomePage'
import { BuildsPage } from './features/builds/BuildsPage'
import { ReleasesPage } from './features/releases/ReleasesPage'
import { ReleaseDetail } from './features/releases/ReleaseDetail'
import { FeaturesPage } from './features/features/FeaturesPage'
import { IntegrationsPage } from './features/integrations/IntegrationsPage'
import { CustomersPage } from './features/customers/CustomersPage'
import { EnvironmentDetailPage } from './features/customers/EnvironmentDetailPage'
import { IssuesPage } from './features/issues/IssuesPage'
import { TicketsPage } from './features/tickets/TicketsPage'
import { RoadmapPage } from './features/roadmap/RoadmapPage'
import { ConfigPage } from './features/config/ConfigPage'
import { TasksPage } from './features/tasks/TasksPage'
import { HealthDashboard } from './features/health/HealthDashboard'
import { CustomerStatusPage } from './features/health/CustomerStatusPage'
import { StandupPage } from './features/standup/StandupPage'
import { IncidentsPage } from './features/incidents/IncidentsPage'
import { ProcessHealthPage } from './features/reports/ProcessHealthPage'
import { LoginPage } from './features/auth/LoginPage'
import { connectWebSocket, disconnectWebSocket, useWsStore } from './stores/wsStore'
import { useAuthStore } from './stores/authStore'

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

  const { loaded: authLoaded, authenticated, ssoEnabled, loadAuth } = useAuthStore()

  useEffect(() => {
    loadAuth()
  }, [loadAuth])

  useEffect(() => {
    // Only connect WebSocket after auth check passes
    if (!authLoaded) return
    if (ssoEnabled && !authenticated) return
    connectWebSocket()
    return () => disconnectWebSocket()
  }, [authLoaded, ssoEnabled, authenticated])

  // Dismiss the HTML loading screen once all initial data is loaded
  useEffect(() => {
    if (connected && hasReleases && hasCustomers && !dismissed.current) {
      dismissed.current = true
      window.__nectarDismissLoader?.()
    }
  }, [connected, hasReleases, hasCustomers])

  // Also dismiss loader when SSO login page should show
  useEffect(() => {
    if (authLoaded && ssoEnabled && !authenticated && !dismissed.current) {
      dismissed.current = true
      window.__nectarDismissLoader?.()
    }
  }, [authLoaded, ssoEnabled, authenticated])

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          {/* Login page is always accessible */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected routes — guarded by auth when SSO is enabled */}
          <Route element={
            <AuthGuard authLoaded={authLoaded} authenticated={authenticated} ssoEnabled={ssoEnabled}>
              <AppShell />
            </AuthGuard>
          }>
            <Route path="/" element={<HomePage />} />
            <Route path="/standup" element={<StandupPage />} />
            <Route path="/builds" element={<BuildsPage />} />
            <Route path="/releases" element={<ReleasesPage />} />
            <Route path="/features" element={<FeaturesPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/releases/:key" element={<ReleaseDetail />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/environments/:id" element={<EnvironmentDetailPage />} />
            <Route path="/health-dashboard" element={<HealthDashboard />} />
            <Route path="/incidents" element={<IncidentsPage />} />
            <Route path="/health/:customerId" element={<CustomerStatusPage />} />
            <Route path="/issues" element={<IssuesPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/roadmap" element={<RoadmapPage />} />
            <Route path="/tasks-queue" element={<TasksPage />} />
            <Route path="/reports/process-health" element={<ProcessHealthPage />} />
            <Route path="/config" element={<ConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

/**
 * Auth guard — when SSO is enabled, redirects to login if not authenticated.
 * When SSO is disabled, renders children directly (open access).
 */
function AuthGuard({ authLoaded, authenticated, ssoEnabled, children }: {
  authLoaded: boolean
  authenticated: boolean
  ssoEnabled: boolean
  children: React.ReactNode
}) {
  if (!authLoaded) {
    return null // Still loading auth state
  }

  if (ssoEnabled && !authenticated) {
    // Redirect to login page
    window.location.href = '/login'
    return null
  }

  return <>{children}</>
}

