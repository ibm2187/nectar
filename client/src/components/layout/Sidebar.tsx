import { NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { cn } from '../../lib/utils'
import { NectarIcon } from '../NectarLoader'
import { useAuthStore } from '../../stores/authStore'
import { useWsStore } from '../../stores/wsStore'
import { apiFetch } from '../../api/client'
import { todayLocal } from '../../lib/date'

type NavLinkItem = {
  to: string
  label: string
  icon: string
  /** Capability required to see this link */
  cap?: string
}

type NavSection = {
  /** Optional heading; when omitted, items render at the top with no group label */
  heading?: string
  /** Tailwind class for the heading text tint */
  toneText?: string
  /** Tailwind class for the small colored bar beside the heading + the items' left guide line */
  toneBg?: string
  items: ReadonlyArray<NavLinkItem>
}

const sections: ReadonlyArray<NavSection> = [
  {
    items: [
      { to: '/', label: 'Home', icon: '🏠' },
      { to: '/standup', label: 'Standup', icon: '🎯' },
    ],
  },
  {
    heading: 'Deliver',
    toneText: 'text-sky-600 dark:text-sky-400',
    toneBg: 'bg-sky-500',
    items: [
      { to: '/roadmap', label: 'Roadmap', icon: '🗺' },
      { to: '/releases', label: 'Releases', icon: '📦' },
      { to: '/builds', label: 'Builds', icon: '🔨' },
      { to: '/tickets', label: 'Tickets', icon: '🎯' },
    ],
  },
  {
    heading: 'Operate',
    toneText: 'text-emerald-600 dark:text-emerald-400',
    toneBg: 'bg-emerald-500',
    items: [
      { to: '/customers', label: 'Environments', icon: '🏢' },
      { to: '/health-dashboard', label: 'Health', icon: '💚' },
      { to: '/incidents', label: 'Incidents', icon: '🚨' },
      { to: '/features', label: 'Features', icon: '🚩' },
      { to: '/integrations', label: 'Integrations', icon: '🔌' },
      { to: '/support', label: 'Support', icon: '🛟' },
    ],
  },
  {
    heading: 'System',
    toneText: 'text-zinc-500 dark:text-zinc-400',
    toneBg: 'bg-zinc-400 dark:bg-zinc-500',
    items: [
      { to: '/tasks-queue', label: 'Tasks', icon: '📋' },
      { to: '/reports/process-health', label: 'Reports', icon: '📊' },
      { to: '/issues', label: 'Nectar Issues', icon: '🐛' },
      { to: '/config', label: 'Config', icon: '⚙', cap: 'config.write' },
    ],
  },
]

interface SidebarProps {
  open: boolean
  onClose: () => void
}

// ── Sidebar preferences (collapse state + favorites) ───────

type SidebarPrefs = {
  collapsed: string[]   // section headings the user has collapsed
  favorites: string[]   // `to` paths, in the order the user added them
}

const PREFS_STORAGE_KEY = 'nectar.sidebar.prefs.v3'
// Items pinned to the top section that cannot be favorited/unfavorited
const PINNED_TOP_PATHS = new Set(['/', '/standup'])

function loadPrefs(): SidebarPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SidebarPrefs>
      return {
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : ['System'],
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      }
    }
  } catch { /* ignore */ }
  return { collapsed: ['System'], favorites: [] }
}

function useSidebarPrefs() {
  const [prefs, setPrefs] = useState<SidebarPrefs>(loadPrefs)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs))
    } catch { /* ignore */ }
  }, [prefs])

  const toggleCollapsed = (heading: string) => {
    setPrefs(p => ({
      ...p,
      collapsed: p.collapsed.includes(heading)
        ? p.collapsed.filter(h => h !== heading)
        : [...p.collapsed, heading],
    }))
  }

  const toggleFavorite = (to: string) => {
    if (PINNED_TOP_PATHS.has(to)) return
    setPrefs(p => ({
      ...p,
      favorites: p.favorites.includes(to)
        ? p.favorites.filter(f => f !== to)
        : [...p.favorites, to],
    }))
  }

  return { prefs, toggleCollapsed, toggleFavorite }
}

// ── Badge helpers for sidebar nav items ────────────────────

function useSidebarBadges() {
  const releases = useWsStore(s => s.releases)
  const environments = useWsStore(s => s.environments)
  const [pendingTaskCount, setPendingTaskCount] = useState(0)
  const [activeIncidents, setActiveIncidents] = useState(0)

  // Count overdue releases — past release date, not done, not archived
  const today = todayLocal()
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
  const { prefs, toggleCollapsed, toggleFavorite } = useSidebarPrefs()

  // Build a lookup so favorites (stored as `to` paths) can be resolved to full items
  const itemByPath = new Map<string, NavLinkItem>()
  for (const section of sections) {
    for (const item of section.items) itemByPath.set(item.to, item)
  }

  // Resolve favorites in user-pinned order, dropping any that no longer exist or are
  // capability-gated away from this user.
  const favoriteItems: NavLinkItem[] = prefs.favorites
    .map(p => itemByPath.get(p))
    .filter((item): item is NavLinkItem => {
      if (!item) return false
      if (item.cap && ssoEnabled && !hasCap(item.cap)) return false
      return true
    })
  const favoriteSet = new Set(favoriteItems.map(i => i.to))

  // Determine the badge node for a given nav path
  const renderBadge = (to: string): React.ReactNode => {
    if ((to === '/' || to === '/releases') && overdueCount > 0) {
      return (
        <span className="ml-auto bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
          {overdueCount}
        </span>
      )
    }
    if (to === '/health-dashboard' && hasUnhealthyEnv) {
      return (
        <span className="ml-auto w-2 h-2 rounded-full bg-red-500 shrink-0" title="Unhealthy environment detected" />
      )
    }
    if (to === '/tasks-queue' && pendingTaskCount > 0) {
      return (
        <span className="ml-auto bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
          {pendingTaskCount}
        </span>
      )
    }
    if (to === '/incidents' && activeIncidents > 0) {
      return (
        <span className="ml-auto bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">
          {activeIncidents}
        </span>
      )
    }
    return null
  }

  // Render a single nav item (with optional favorite star)
  const renderItem = (item: NavLinkItem) => {
    const { to, label } = item
    const isFavorited = favoriteSet.has(to)
    const canFavorite = !PINNED_TOP_PATHS.has(to)
    const badge = renderBadge(to)

    return (
      <div key={to} className="group relative">
        <NavLink
          to={to}
          end={to === '/'}
          onClick={onClose}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              // Reserve room on the right when the star is always visible (favorited)
              // OR when canFavorite + has a badge (so the star can fade in on hover without overlap)
              (isFavorited || (canFavorite && badge)) && "pr-8",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )
          }
        >
          <span className="flex-1 truncate">{label}</span>
          {badge}
        </NavLink>
        {canFavorite && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(to) }}
            className={cn(
              "absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-xs transition-opacity",
              isFavorited
                ? "opacity-80 text-yellow-500 hover:opacity-100"
                : "opacity-0 group-hover:opacity-100 text-muted-foreground"
            )}
            title={isFavorited ? 'Unpin from top' : 'Pin to top'}
            aria-label={isFavorited ? 'Unpin from top' : 'Pin to top'}
          >
            {isFavorited ? '★' : '☆'}
          </button>
        )}
      </div>
    )
  }

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
        <nav className="flex-1 p-2 overflow-y-auto">
          {sections.map((section, sectionIdx) => {
            // Filter items: capability gates + remove favorited items from their original group
            const visibleItems = section.items.filter(l => {
              if (l.cap && ssoEnabled && !hasCap(l.cap)) return false
              if (favoriteSet.has(l.to)) return false
              return true
            })

            // For the top (no-heading) section, prepend pinned items, then append favorites
            const itemsToRender = section.heading
              ? visibleItems
              : [...visibleItems, ...favoriteItems]

            if (itemsToRender.length === 0) return null

            const isCollapsed = section.heading ? prefs.collapsed.includes(section.heading) : false

            return (
              <div
                key={section.heading ?? `top-${sectionIdx}`}
                className={cn(sectionIdx > 0 && 'mt-2 pt-2 border-t border-border/60')}
              >
                {section.heading && (
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(section.heading!)}
                    className={cn(
                      'group/heading w-full flex items-center justify-between gap-2 px-3 py-2 mb-0.5 rounded-md',
                      'text-[13px] font-semibold tracking-wide transition-colors',
                      'hover:bg-accent/40',
                      section.toneText ?? 'text-muted-foreground'
                    )}
                    aria-expanded={!isCollapsed}
                  >
                    <span className="flex items-center gap-2">
                      {section.toneBg && (
                        <span className={cn('w-1 h-3.5 rounded-full', section.toneBg)} aria-hidden="true" />
                      )}
                      <span>{section.heading}</span>
                    </span>
                    <span
                      className={cn(
                        'flex items-center justify-center w-6 h-6 rounded text-base leading-none',
                        'opacity-70 group-hover/heading:opacity-100 group-hover/heading:bg-accent/60 transition-all duration-150',
                        'transform',
                        isCollapsed ? '-rotate-90' : 'rotate-0'
                      )}
                      aria-hidden="true"
                    >
                      ▾
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <div
                    className={cn(
                      'space-y-1',
                      section.heading && 'ml-[14px] pl-2 border-l border-border/60'
                    )}
                  >
                    {itemsToRender.map(renderItem)}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
