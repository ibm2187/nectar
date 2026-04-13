import { useWsStore } from '../../stores/wsStore'
import { useAuthStore } from '../../stores/authStore'
import { useThemeStore } from '../../stores/themeStore'
import { cn } from '../../lib/utils'

interface HeaderProps {
  onToggleSidebar: () => void
  onOpenSearch: () => void
}

export function Header({ onToggleSidebar, onOpenSearch }: HeaderProps) {
  const connected = useWsStore(s => s.connected)
  const releases = useWsStore(s => s.releases)
  const active = releases.filter(r => r.state !== 'done').length

  const { ssoEnabled, authenticated, user, logout } = useAuthStore()
  const { theme, toggle: toggleTheme } = useThemeStore()

  return (
    <header className="h-12 border-b bg-card flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        {/* Hamburger menu — mobile only */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="md:hidden p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Toggle sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {active > 0 && (
          <span className="text-sm text-muted-foreground hidden md:inline">
            {active} active release{active !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* Search bar — opens command palette */}
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border/50 bg-muted/30 text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors text-xs w-48 md:w-64"
        >
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span className="flex-1 text-left truncate">Search...</span>
          <kbd className="hidden md:inline-flex items-center px-1.5 py-0.5 rounded bg-muted/50 border border-border/30 font-mono text-[10px]">⌘K</kbd>
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
        </button>

        {/* User info (only when SSO is enabled and authenticated) */}
        {ssoEnabled && authenticated && user && (
          <div className="flex items-center gap-2">
            {user.picture ? (
              <img
                src={user.picture}
                alt={user.name}
                className="w-6 h-6 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary">
                {(user.name || user.email || '?')[0].toUpperCase()}
              </div>
            )}
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {user.name || user.email}
            </span>
            <button
              onClick={logout}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-accent"
            >
              Logout
            </button>
          </div>
        )}

        {/* Connection indicator */}
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-2 h-2 rounded-full",
            connected ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]" : "bg-red-400"
          )} />
          <span className="text-xs text-muted-foreground">
            {connected ? 'connected' : 'disconnected'}
          </span>
        </div>
      </div>
    </header>
  )
}
