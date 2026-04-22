import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'
import { CapGuard } from '../../components/CapGuard'

interface VersionInfo {
  branch: string
  commit: string
  commitMessage: string
  commitDate: string
}

interface PullResult {
  ok: boolean
  output: string
  changed: boolean
}

export function UpdatePage() {
  const [version, setVersion] = useState<VersionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [logLines, setLogLines] = useState<string[]>([])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<VersionInfo>('/admin/version')
      setVersion(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load version info')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const addLog = (line: string) => {
    setLogLines(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`])
  }

  const addMultiLog = (output: string) => {
    for (const line of output.split('\n')) {
      if (line.trim()) addLog(line)
    }
  }

  const handlePull = async (): Promise<boolean> => {
    setPulling(true)
    setError(null)
    addLog('Starting update...')
    let success = false
    try {
      const result = await apiFetch<PullResult>('/admin/pull', {
        method: 'POST',
      })
      addMultiLog(result.output || 'Done')
      if (result.ok) {
        addLog(result.changed ? 'Update complete.' : 'Already up to date.')
        await load()
        success = true
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Pull failed'
      addLog(`ERROR: ${msg}`)
      setError(msg)
    }
    setPulling(false)
    return success
  }

  const handleRestart = async () => {
    setRestarting(true)
    addLog('Requesting server restart...')
    try {
      await apiFetch('/admin/restart', { method: 'POST' })
      addLog('Restart signal sent. Server will restart momentarily.')
      addLog('This page will stop responding until the server comes back up.')
    } catch {
      addLog('Restart request sent (connection closed as expected)')
    }
    // Don't reset restarting — the server is going down
  }

  const handlePullAndRestart = async () => {
    const success = await handlePull()
    if (success) {
      await handleRestart()
    } else {
      addLog('Skipping restart due to pull failure.')
    }
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  if (loading) {
    return <NectarLoader size="lg" message="Loading version info..." className="mt-32" />
  }

  return (
    <div className="w-full space-y-4">
      <p className="text-sm text-muted-foreground">
        View current version and update the Nectar server. Pull fetches latest code,
        installs dependencies if changed, and rebuilds the client if needed.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Version info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Current Version</CardTitle>
        </CardHeader>
        <CardContent>
          {version ? (
            <div className="space-y-3">
              <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
                <span className="text-muted-foreground">Branch</span>
                <span className="font-mono">{version.branch}</span>

                <span className="text-muted-foreground">Commit</span>
                <span className="font-mono">{version.commit}</span>

                <span className="text-muted-foreground">Message</span>
                <span>{version.commitMessage}</span>

                <span className="text-muted-foreground">Last Updated</span>
                <span>{formatDate(version.commitDate)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Version info unavailable</p>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <CapGuard cap="system.admin">
              <Button
                size="sm"
                onClick={handlePullAndRestart}
                disabled={pulling || restarting}
              >
                {pulling ? 'Updating...' : restarting ? 'Restarting...' : 'Update & Restart'}
              </Button>
            </CapGuard>
            <CapGuard cap="system.admin">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePull()}
                disabled={pulling || restarting}
              >
                {pulling ? 'Updating...' : 'Update Only'}
              </Button>
            </CapGuard>
            <CapGuard cap="system.admin">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestart}
                disabled={pulling || restarting}
              >
                {restarting ? 'Restarting...' : 'Restart Only'}
              </Button>
            </CapGuard>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              disabled={pulling || restarting}
            >
              Refresh
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Update pulls latest code, installs deps if changed, and rebuilds the client if needed.
            Restart uses systemctl in production or process exit locally.
          </p>
        </CardContent>
      </Card>

      {/* Log output */}
      {logLines.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Output</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLogLines([])}
              >
                Clear
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="bg-background border rounded-md p-3 max-h-64 overflow-auto font-mono text-xs space-y-0.5">
              {logLines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    line.includes('ERROR') ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {line}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
