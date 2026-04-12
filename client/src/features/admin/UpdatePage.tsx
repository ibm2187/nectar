import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface VersionInfo {
  branch: string
  commit: string
  commitMessage: string
  commitDate: string
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

  const handlePull = async () => {
    setPulling(true)
    setError(null)
    addLog('Running git pull...')
    try {
      const result = await apiFetch<{ ok: boolean; output: string }>('/admin/pull', {
        method: 'POST',
      })
      addLog(result.output || 'Pull completed')
      if (result.ok) {
        addLog('Pull successful. Reloading version info...')
        await load()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Pull failed'
      addLog(`ERROR: ${msg}`)
      setError(msg)
    }
    setPulling(false)
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
    await handlePull()
    if (!error) {
      await handleRestart()
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
        View current version and update the Nectar server.
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
            <Button
              size="sm"
              onClick={handlePullAndRestart}
              disabled={pulling || restarting}
            >
              {pulling ? 'Pulling...' : restarting ? 'Restarting...' : 'Pull & Restart'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRestart}
              disabled={pulling || restarting}
            >
              {restarting ? 'Restarting...' : 'Restart Only'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePull}
              disabled={pulling || restarting}
            >
              {pulling ? 'Pulling...' : 'Pull Only'}
            </Button>
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
            Pull fetches latest code from git. Restart exits the server process (expects a process manager like pm2/systemd to restart it).
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
