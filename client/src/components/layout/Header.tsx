import { useWsStore } from '../../stores/wsStore'
import { cn } from '../../lib/utils'

export function Header() {
  const connected = useWsStore(s => s.connected)
  const releases = useWsStore(s => s.releases)
  const active = releases.filter(r => r.state !== 'done').length

  return (
    <header className="h-12 border-b bg-card flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        {active > 0 && (
          <span className="text-sm text-muted-foreground">
            {active} active release{active !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className={cn(
          "w-2 h-2 rounded-full",
          connected ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]" : "bg-red-400"
        )} />
        <span className="text-xs text-muted-foreground">
          {connected ? 'connected' : 'disconnected'}
        </span>
      </div>
    </header>
  )
}
