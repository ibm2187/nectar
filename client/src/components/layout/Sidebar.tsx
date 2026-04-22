import { NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { cn } from '../../lib/utils'
import { NectarIcon } from '../NectarLoader'
import { useAuthStore } from '../../stores/authStore'
import { useWsStore } from '../../stores/wsStore'
import { apiFetch } from '../../api/client'

const links: ReadonlyArray<{
  to: string
  label: string
  icon: string
  /** Capability required to see this link */
  cap?: string
}> = [
  { to: '/', label: 'Home', icon: '🏠' },
  { to: '/standup', label: 'Standup', icon: '🎯' },
  { to: '/builds', label: 'Builds', icon: '🔨' },
  { to: '/releases', label: 'Releases', icon: '📦' },
  { to: '/roadmap', label: 'Roadmap', icon: '🗺' },
  { to: '/tickets', label: 'Tickets', icon: '🎯' },
  { to: '/customers', label: 'Environments', icon: '🏢' },
  { to: '/health-dashboard', label: 'Health', icon: '💚' },
  { to: '/incidents', label: 'Incidents', icon: '🚨' },
  { to: '/features', label: 'Features', icon: '🚩' },
  { to: '/integrations', label: 'Integrations', icon: '🔌' },
  { to: '/issues', label: 'Issues', icon: '🐛' },
  { to: '/tasks-queue', label: 'Tasks', icon: '📋' },
  { to: '/reports/process-health', label: 'Reports', icon: '📊' },
  { to: '/config', label: 'Config', icon: '⚙', cap: 'config.write' },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

// ── Badge helpers for sidebar nav items ────────────────────

function useSidebarBadges() {
  const releases = useWsStore(s => s.releases)
  const environments = useWsStore(s => s.environments)
  const [pendingTaskCount, setPendingTaskCount] = useState(0)
  const [activeIncidents, setActiveIncidents] = useState(0)

  // Count overdue releases — past release date, not done, not archived
  const today = new Date().toISOString().slice(0, 10)
  const overdueCount = releases.filter(
    r => r.jiraReleaseDate && r.jiraReleaseDate < today && r.state !== 'done' && !r.jiraArchived
  ).length

  // Derive health — check if any production environment is unhealthy/unreachable
  const hasUnhealthyEnv = environments.some(e => {
    const health = (e as unknown as Record<string, unknown>).health as { status?: string } | null | undefined
    return health?.status === 'unhealthy' || health?.status === 'degraded'
  })

  // Poll tasks count periodically
  useEffect(() => {
    let cancelled = false
    const fetchTasks = async () => {
      try {
        const data = await apiFetch<Array<{ status: string }>>('/tasks?limit=50')
        if (!cancelled) {
          const tasks = Array.isArray(data) ? data : (data as any).tasks || []
          const active = tasks.filter(
            (t: { status: string }) => t.status === 'pending' || t.status === 'in-progress'
          ).length
          setPendingTaskCount(active)
        }
      } catch { /* silent */ }
    }
    fetchTasks()
    const interval = setInterval(fetchTasks, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Poll incident counts every 30s
  useEffect(() => {
    let cancelled = false
    const fetchCounts = async () => {
      try {
        const data = await apiFetch<{ active: number }>('/alerts/incidents/counts')
        if (!cancelled) setActiveIncidents(data.active || 0)
      } catch { /* silent */ }
    }
    fetchCounts()
    const interval = setInterval(fetchCounts, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return { overdueCount, hasUnhealthyEnv, pendingTaskCount, activeIncidents }
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const { ssoEnabled, hasCap } = useAuthStore()
  const { overdueCount, hasUnhealthyEnv, pendingTaskCount, activeIncidents } = useSidebarBadges()

  return (
    <>
      {/* Backdrop — mobile only, visible when sidebar is open */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-56 border-r bg-card flex flex-col transform transition-transform duration-200 ease-in-out",
          "md:relative md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="p-4 border-b flex items-center gap-2.5">
          <NectarIcon className="w-7 h-7 shrink-0" />
          <div>
            <h1 className="text-lg font-bold text-primary leading-tight">Nectar</h1>
            <p className="text-xs text-muted-foreground">Release Intelligence</p>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {links.filter(l => {
            // Capability-gated links: hide if user lacks the required capability
            if (l.cap && ssoEnabled && !hasCap(l.cap)) return false
            return true
          }).map(({ to, label, icon }) => {
            // Determine badge for this nav item
            let badge: React.ReactNode = null
            if ((to === '/' || to === '/releases') && overdueCount > 0) {
              badge = (
                <span className="ml-auto bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
                  {overdueCount}
                </span>
              )
            } else if (to === '/health-dashboard' && hasUnhealthyEnv) {
              badge = (
                <span className="ml-auto w-2 h-2 rounded-full bg-red-500 shrink-0" title="Unhealthy environment detected" />
              )
            } else if (to === '/tasks-queue' && pendingTaskCount > 0) {
              badge = (
                <span className="ml-auto bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
                  {pendingTaskCount}
                </span>
              )
            } else if (to === '/incidents' && activeIncidents > 0) {
              badge = (
                <span className="ml-auto bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
                  {activeIncidents}
                </span>
              )
            }

            return (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                onClick={onClose}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )
                }
              >
                <span>{icon}</span>
                {label}
                {badge}
              </NavLink>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
