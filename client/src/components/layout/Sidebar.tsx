import { NavLink } from 'react-router-dom'
import { cn } from '../../lib/utils'

const links = [
  { to: '/', label: 'Releases', icon: '📦' },
  { to: '/customers', label: 'Customers', icon: '🏢' },
]

export function Sidebar() {
  return (
    <aside className="w-56 border-r bg-card flex flex-col">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold text-primary">Nectar</h1>
        <p className="text-xs text-muted-foreground">Release Management</p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {links.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
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
  )
}
