import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppShell } from './components/layout/AppShell'
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
import { LoginPage } from './features/auth/LoginPage'
import { connectWebSocket, disconnectWebSocket, useWsStore } from './stores/wsStore'
import { useAuthStore, type UserPermissions } from './stores/authStore'

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
            <Route path="/" element={<PermissionGuard permKey="releases"><ReleasesPage /></PermissionGuard>} />
            <Route path="/features" element={<PermissionGuard permKey="features"><FeaturesPage /></PermissionGuard>} />
            <Route path="/integrations" element={<PermissionGuard permKey="integrations"><IntegrationsPage /></PermissionGuard>} />
            <Route path="/releases/:key" element={<PermissionGuard permKey="releases"><ReleaseDetail /></PermissionGuard>} />
            <Route path="/customers" element={<PermissionGuard permKey="environments"><CustomersPage /></PermissionGuard>} />
            <Route path="/environments/:id" element={<PermissionGuard permKey="environments"><EnvironmentDetailPage /></PermissionGuard>} />
            <Route path="/issues" element={<PermissionGuard permKey="issues"><IssuesPage /></PermissionGuard>} />
            <Route path="/tickets" element={<PermissionGuard permKey="tickets"><TicketsPage /></PermissionGuard>} />
            <Route path="/roadmap" element={<PermissionGuard permKey="roadmap"><RoadmapPage /></PermissionGuard>} />
            <Route path="/tasks-queue" element={<PermissionGuard permKey="tasks"><TasksPage /></PermissionGuard>} />
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

/**
 * Permission guard — checks the user's per-page permissions.
 * Admins always have access. When SSO is disabled, all pages are accessible.
 * Denied users see a 403 message.
 */
function PermissionGuard({ permKey, children }: {
  permKey: keyof UserPermissions
  children: React.ReactNode
}) {
  const { user, ssoEnabled } = useAuthStore()

  // SSO disabled or no user = open access
  if (!ssoEnabled || !user) return <>{children}</>

  // Admins always have access
  if (user.role === 'admin') return <>{children}</>

  // Check permission
  if (user.permissions && !user.permissions[permKey]) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center gap-3">
        <p className="text-4xl font-bold text-muted-foreground">403</p>
        <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        <p className="text-xs text-muted-foreground">Contact an admin to request access.</p>
      </div>
    )
  }

  return <>{children}</>
}
