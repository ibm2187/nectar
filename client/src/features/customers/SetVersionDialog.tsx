import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Badge } from '../../components/ui/badge'
import { apiFetch } from '../../api/client'
import type { Environment } from '../../api/client'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Either a single environment or a batch
  environment?: Environment | null
  environments?: Environment[]   // for bulk set (e.g., all CK franchises)
  title?: string
}

/**
 * Dialog for manually setting a version on one or many environments.
 * - If `environment` is provided: single-env update via PATCH /api/environments/:id/version
 * - If `environments` (array) is provided: bulk update via PATCH /api/environments/bulk/version
 */
export function SetVersionDialog({ open, onOpenChange, environment, environments, title }: Props) {
  const isBulk = !!environments && environments.length > 0
  const targets = isBulk ? environments! : (environment ? [environment] : [])
  const [version, setVersion] = useState('')
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Reset form when opening
  useEffect(() => {
    if (open) {
      const seed = environment?.currentVersion || ''
      setVersion(seed)
      setBranch(environment?.currentBranch || '')
      setError('')
    }
  }, [open, environment])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!version.trim()) {
      setError('Version is required')
      return
    }
    setLoading(true)
    setError('')

    try {
      const body: Record<string, unknown> = {
        version: version.trim(),
        setBy: 'ui',
      }
      if (branch.trim()) body.branch = branch.trim()

      if (isBulk) {
        await apiFetch('/environments/bulk/version', {
          method: 'PATCH',
          body: JSON.stringify({
            ...body,
            environmentIds: targets.map(e => e.id),
          }),
        })
      } else if (environment) {
        await apiFetch(`/environments/${encodeURIComponent(environment.id)}/version`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }

      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  function handleClear() {
    setVersion('')
    setBranch('')
  }

  if (targets.length === 0) return null

  const resolvedTitle = title || (isBulk
    ? `Set version for ${targets.length} environments`
    : `Set version for ${environment?.id}`)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{resolvedTitle}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          {isBulk ? (
            <div className="max-h-36 overflow-auto border rounded-md p-2 space-y-0.5 text-xs">
              {targets.map(e => (
                <div key={e.id} className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">{e.tier}</Badge>
                  <span className="font-mono">{e.id}</span>
                  {e.currentVersion && (
                    <span className="text-muted-foreground ml-auto">current: {e.currentVersion}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              <div><span className="opacity-70">URL:</span> <span className="font-mono">{environment?.url}</span></div>
              {environment?.currentVersion && (
                <div><span className="opacity-70">Current:</span> <span className="font-mono text-foreground">{environment.currentVersion}</span></div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="version">Version</Label>
            <Input
              id="version"
              placeholder="4.2.1"
              value={version}
              onChange={e => setVersion(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="branch">Branch (optional)</Label>
            <Input
              id="branch"
              placeholder="releases/4.2.1 (auto-filled if blank)"
              value={branch}
              onChange={e => setBranch(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to auto-derive from version (releases/&lt;version&gt;)
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClear} disabled={loading}>
              Clear
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !version.trim()}>
              {loading ? 'Saving...' : isBulk ? `Set on ${targets.length} envs` : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
