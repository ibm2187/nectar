import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { apiFetch } from '../../api/client'
import { cn } from '../../lib/utils'

interface AffectedRelease {
  version: string
  repo: string | null
  state: string
  shipDate: string | null
  templateVersion: number
  gatesActed: number
  gatesTotal: number
  impact: 'untouched' | 'active' | 'shipped'
  stale: boolean
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  templateKey: string
  templateLabel: string
  templateVersion: number
  onApplied?: (appliedCount: number) => void
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const impactLabels: Record<string, { label: string; color: string }> = {
  untouched: { label: 'Not started', color: 'border-green-500/40 text-green-600 dark:text-green-400' },
  active: { label: 'In progress', color: 'border-yellow-500/40 text-yellow-600 dark:text-yellow-400' },
  shipped: { label: 'Shipped', color: 'border-muted-foreground/30 text-muted-foreground' },
}

export function TemplateApplyDialog({
  open, onOpenChange, templateKey, templateLabel, templateVersion, onApplied,
}: Props) {
  const [affected, setAffected] = useState<AffectedRelease[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    apiFetch<{ releases: AffectedRelease[] }>(`/settings/release-templates/${templateKey}/affected-releases`)
      .then(r => {
        // Only show stale releases (older template version)
        const stale = (r.releases || []).filter(x => x.stale)
        setAffected(stale)
        // Pre-check untouched releases (safe to refresh)
        setSelected(new Set(stale.filter(x => x.impact === 'untouched').map(x => x.version)))
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, templateKey])

  function toggle(version: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === affected.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(affected.map(a => a.version)))
    }
  }

  async function apply() {
    if (selected.size === 0) {
      onOpenChange(false)
      return
    }
    setApplying(true)
    setError(null)
    const versions = Array.from(selected)
    let ok = 0
    let failed: string[] = []
    for (const v of versions) {
      try {
        await apiFetch(`/releases/${encodeURIComponent(v)}/refresh-template`, { method: 'POST' })
        ok++
      } catch {
        failed.push(v)
      }
    }
    setApplying(false)
    if (failed.length > 0) {
      setError(`Applied to ${ok} of ${versions.length}. Failed: ${failed.join(', ')}`)
    } else {
      onApplied?.(ok)
      onOpenChange(false)
    }
  }

  const untouchedCount = affected.filter(a => a.impact === 'untouched').length
  const activeCount = affected.filter(a => a.impact === 'active').length
  const shippedCount = affected.filter(a => a.impact === 'shipped').length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Apply {templateLabel} v{templateVersion} to existing releases?</DialogTitle>
        </DialogHeader>

        <div className="py-3 space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-6">Loading{'\u2026'}</p>
          ) : affected.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No existing releases are on an older version. Nothing to refresh.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{affected.length} release{affected.length !== 1 ? 's' : ''} on older version</span>
                {untouchedCount > 0 && <span className="text-green-600 dark:text-green-400">{untouchedCount} not started</span>}
                {activeCount > 0 && <span className="text-yellow-600 dark:text-yellow-400">{activeCount} in progress</span>}
                {shippedCount > 0 && <span>{shippedCount} shipped</span>}
                <button
                  onClick={toggleAll}
                  className="ml-auto text-xs text-primary hover:underline"
                >
                  {selected.size === affected.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              <div className="border rounded-md divide-y max-h-80 overflow-y-auto">
                {affected.map(r => {
                  const isSelected = selected.has(r.version)
                  const impact = impactLabels[r.impact]
                  return (
                    <label
                      key={r.version}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/30',
                        isSelected && 'bg-primary/5'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(r.version)}
                        className="shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium text-foreground">{r.version}</span>
                          <Badge variant="outline" className={cn('text-[10px]', impact.color)}>
                            {impact.label}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            v{r.templateVersion} {'\u2192'} v{templateVersion}
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {r.shipDate && `Ship ${formatDate(r.shipDate)} \u2022 `}
                          {r.gatesActed} of {r.gatesTotal} gates acted on {'\u2022'} {r.state}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>

              <div className="rounded-md bg-muted/30 border px-3 py-2 text-[11px] text-muted-foreground">
                <strong className="text-foreground">What refresh does:</strong> Acted-on gates (met/missed/skipped) keep
                their status. Pending gates pick up new T-minus values, owners, and labels. Manual date
                overrides are preserved. Removed milestones stay as history if acted on; otherwise dropped.
              </div>
            </>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>
            Skip For Now
          </Button>
          <Button onClick={apply} disabled={applying || loading || selected.size === 0}>
            {applying
              ? `Applying\u2026`
              : selected.size === 0
                ? 'Nothing Selected'
                : `Apply to ${selected.size} Release${selected.size !== 1 ? 's' : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
