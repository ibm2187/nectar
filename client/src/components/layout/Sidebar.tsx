import { NavLink } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { NectarIcon } from '../NectarLoader'
import { useAuthStore } from '../../stores/authStore'

const links = [
  { to: '/', label: 'Releases', icon: '📦' },
  { to: '/roadmap', label: 'Roadmap', icon: '🗺' },
  { to: '/tickets', label: 'Tickets', icon: '🎯' },
  { to: '/customers', label: 'Environments', icon: '🏢' },
  { to: '/features', label: 'Features', icon: '🚩' },
  { to: '/integrations', label: 'Integrations', icon: '🔌' },
  { to: '/issues', label: 'Issues', icon: '🐛' },
  { to: '/tasks-queue', label: 'Tasks', icon: '📋' },
  { to: '/config', label: 'Config', icon: '⚙', adminOnly: true },
] as const

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export function Sidebar({ open, onClose }: SidebarProps) {
  const { user, ssoEnabled } = useAuthStore()
  const isAdmin = !ssoEnabled || user?.role === 'admin'

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
          {links.filter(l => !('adminOnly' in l && l.adminOnly) || isAdmin).map(({ to, label, icon }) => (
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
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  )
}
