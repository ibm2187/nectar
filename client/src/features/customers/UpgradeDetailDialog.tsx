import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { JiraLink } from '../../components/JiraLink'
import { apiFetch } from '../../api/client'
import type { EnvUpgradeItem } from '../../api/client'
import { timeAgo } from '../../lib/utils'

interface UpgradeSource {
  upgradeName: string
  path: string
  content: string
  jiraKey: string | null
  introCommit: string | null
  introAuthor: string | null
  introDate: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  upgrade: EnvUpgradeItem | null
}

export function UpgradeDetailDialog({ open, onOpenChange, upgrade }: Props) {
  const [source, setSource] = useState<UpgradeSource | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !upgrade) return
    setSource(null)
    setError(null)
    setLoading(true)
    apiFetch<UpgradeSource>(`/upgrades/${encodeURIComponent(upgrade.upgradeName)}/source`)
      .then(data => setSource(data))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, upgrade])

  if (!upgrade) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-base truncate" title={upgrade.upgradeName}>
            {upgrade.upgradeName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto mt-4 space-y-4">
          {/* Status info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <StatusField label="JIRA" value={source?.jiraKey ? <JiraLink jiraKey={source.jiraKey} /> : '—'} />
            <StatusField label="Intro author" value={source?.introAuthor || '—'} />
            <StatusField
              label="Intro commit"
              value={source?.introCommit ? <span className="font-mono text-xs">{source.introCommit.slice(0, 10)}</span> : '—'}
            />
            <StatusField label="Intro date" value={source?.introDate ? timeAgo(source.introDate) : '—'} />
            <StatusField label="Target envs" value={upgrade.desiredEnvs.length > 0 ? upgrade.desiredEnvs.join(', ') : 'all'} />
            <StatusField label="Non-blocking" value={upgrade.nonBlocking ? 'yes' : 'no'} />
            <StatusField label="Enforce envs" value={upgrade.enforceDesiredEnvs ? 'yes' : 'no'} />
            <StatusField label="Has verify()" value={upgrade.hasVerify ? 'yes' : 'no'} />
            <StatusField label="Completed" value={upgrade.history?.completedAt ? timeAgo(upgrade.history.completedAt) : '—'} />
            <StatusField
              label="Verification"
              value={upgrade.history?.verificationStatus ? (
                <Badge variant={upgrade.history.verificationStatus === 'SUCCESS' ? 'success' : 'destructive'}>
                  {upgrade.history.verificationStatus}
                </Badge>
              ) : '—'}
            />
          </div>

          {/* Verification error + metadata */}
          {upgrade.history?.verificationError && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
              <div className="text-xs font-semibold text-red-400 mb-1">Verification Error</div>
              <div className="text-xs text-muted-foreground">{upgrade.history.verificationError}</div>
            </div>
          )}

          {upgrade.history?.verificationMetadata && Object.keys(upgrade.history.verificationMetadata).length > 0 && (
            <div className="rounded-md border p-3">
              <div className="text-xs font-semibold mb-1">Verification Metadata</div>
              <pre className="text-xs font-mono text-muted-foreground overflow-auto max-h-40">
                {JSON.stringify(upgrade.history.verificationMetadata, null, 2)}
              </pre>
            </div>
          )}

          {upgrade.history?.skippedReason && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
              <div className="text-xs font-semibold text-yellow-400 mb-1">Skipped</div>
              <div className="text-xs text-muted-foreground">
                {upgrade.history.skippedReason}
                {upgrade.history.skippedBy && ` — ${upgrade.history.skippedBy}`}
              </div>
            </div>
          )}

          {/* Source code */}
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Source Code</div>
            {loading && (
              <div className="rounded-md border p-4 text-sm text-muted-foreground italic">
                Loading source from webplatform clone...
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
                {error}
              </div>
            )}
            {source && (
              <pre className="rounded-md border bg-card p-3 text-xs font-mono overflow-auto max-h-96">
                {source.content}
              </pre>
            )}
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatusField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  )
}
