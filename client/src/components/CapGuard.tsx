import { useAuthStore } from '../stores/authStore'

interface CapGuardProps {
  cap: string
  children: React.ReactNode
}

export function CapGuard({ cap, children }: CapGuardProps) {
  const hasCap = useAuthStore((s) => s.hasCap)
  if (!hasCap(cap)) return null
  return <>{children}</>
}
