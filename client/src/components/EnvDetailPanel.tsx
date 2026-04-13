import { useEffect } from 'react'
import { cn } from '../lib/utils'

export interface EnvDetailItem {
  envId: string
  envName: string
  tier: string
  franchise: string | null
  franchiseDisplayName: string | null
  enabled: boolean | null
  configured?: boolean | null
}

interface EnvDetailPanelProps {
  open: boolean
  onClose: () => void
  customerName: string
  /** Flag or integration name */
  itemName: string
  /** "feature" or "integration" */
  itemType: 'feature' | 'integration'
  envs: EnvDetailItem[]
}

export function EnvDetailPanel({ open, onClose, customerName, itemName, itemType, envs }: EnvDetailPanelProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Prevent body scroll when open
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  const enabledCount = envs.filter(e => e.enabled === true).length
  const disabledCount = envs.filter(e => e.enabled === false).length

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-96 max-w-[90vw] bg-card border-l shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground truncate">{customerName}</h3>
            <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{itemName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Summary */}
        <div className="px-5 py-3 border-b flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-green-400 font-medium">{enabledCount}</span>
            <span className="text-muted-foreground">on</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
            <span className="text-red-400 font-medium">{disabledCount}</span>
            <span className="text-muted-foreground">off</span>
          </div>
          <span className="text-muted-foreground text-xs ml-auto">{envs.length} environments</span>
        </div>

        {/* Environment list */}
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y divide-border/30">
            {envs.map(env => (
              <div key={env.envId} className="px-5 py-2.5 flex items-center gap-3 hover:bg-accent/20 transition-colors">
                <span className={cn(
                  "w-2.5 h-2.5 rounded-full shrink-0",
                  env.enabled === true ? 'bg-green-500' :
                  env.enabled === false ? 'bg-red-500' :
                  'bg-gray-500'
                )} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">
                    {env.franchiseDisplayName || env.envName}
                  </div>
                  {env.franchise && env.franchiseDisplayName !== env.envName && (
                    <div className="text-xs text-muted-foreground truncate">{env.envName}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {itemType === 'integration' && env.configured !== undefined && env.configured !== null && (
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border",
                      env.configured
                        ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                        : 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                    )}>
                      {env.configured ? 'configured' : 'not configured'}
                    </span>
                  )}
                  <span className={cn(
                    "text-xs font-semibold w-8 text-right",
                    env.enabled === true ? 'text-green-400' :
                    env.enabled === false ? 'text-red-400' :
                    'text-muted-foreground'
                  )}>
                    {env.enabled === true ? 'ON' : env.enabled === false ? 'OFF' : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
