import { useWsStore } from '../../stores/wsStore'

export function ConnectionBanner() {
  const connected = useWsStore(s => s.connected)
  if (connected) return null

  return (
    <div className="bg-destructive/90 text-destructive-foreground px-4 py-1.5 text-center text-xs font-medium flex items-center justify-center gap-2">
      <span className="inline-block w-2 h-2 rounded-full bg-destructive-foreground/70 animate-pulse" />
      Connection lost — data may be stale. Reconnecting...
    </div>
  )
}
