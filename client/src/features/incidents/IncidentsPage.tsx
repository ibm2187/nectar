import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import type { Incident, IncidentStatus, AlertSeverity } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { NectarLoader } from '../../components/NectarLoader'
import { IncidentDetail } from './IncidentDetail'
import { ManualIncidentDialog } from './ManualIncidentDialog'

type Tab = 'active' | 'resolved' | 'all'

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  critical: 'bg-red-500 text-white',
  warning: 'bg-amber-500 text-white',
  info: 'bg-blue-500 text-white',
}

const STATUS_LABEL: Record<IncidentStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  reopened: 'Reopened',
}

const STATUS_COLOR: Record<IncidentStatus, string> = {
  open: 'bg-red-100 text-red-800 border-red-300',
  acknowledged: 'bg-amber-100 text-amber-800 border-amber-300',
  reopened: 'bg-orange-100 text-orange-800 border-orange-300',
  resolved: 'bg-green-100 text-green-800 border-green-300',
}

export function IncidentsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const openId = searchParams.get('id')
  const [tab, setTab] = useState<Tab>('active')
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // Fetch incidents for the current tab
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (tab === 'active') params.set('active', 'true')
    else if (tab === 'resolved') params.set('status', 'resolved')
    ;(async () => {
      try {
        const data = await apiFetch<{ incidents: Incident[] }>(`/alerts/incidents?${params}`)
        if (!cancelled) setIncidents(data.incidents)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load incidents')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, refreshKey])

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  const activeCount = useMemo(
    () => incidents.filter(i => i.status === 'open' || i.status === 'acknowledged' || i.status === 'reopened').length,
    [incidents]
  )

  function closeDetail() {
    searchParams.delete('id')
    setSearchParams(searchParams)
  }

  function openDetail(id: string) {
    searchParams.set('id', id)
    setSearchParams(searchParams)
  }

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Incidents</h1>
          <p className="text-sm text-muted-foreground">
            {tab === 'active'
              ? `${activeCount} active incident${activeCount === 1 ? '' : 's'}`
              : `${incidents.length} incident${incidents.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh}>Refresh</Button>
          <Button size="sm" onClick={() => setManualOpen(true)}>+ New Incident</Button>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {(['active', 'resolved', 'all'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ' +
              (tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t}
          </button>
        ))}
      </div>

      {loading && <NectarLoader size="sm" message="Loading incidents..." className="mt-8" />}
      {error && <p className="text-sm text-red-600">Error: {error}</p>}

      {!loading && !error && incidents.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {tab === 'active' ? 'No active incidents — all clear.' : 'No incidents found.'}
          </CardContent>
        </Card>
      )}

      {!loading && !error && incidents.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Severity</th>
                  <th className="px-4 py-2 font-medium">Summary</th>
                  <th className="px-4 py-2 font-medium">Customer / Env</th>
                  <th className="px-4 py-2 font-medium">Opened</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Assignee</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map(inc => (
                  <tr
                    key={inc.id}
                    onClick={() => openDetail(inc.id)}
                    className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${SEVERITY_COLOR[inc.severity]}`}>
                        {inc.severity}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium">{inc.summary}</div>
                      {inc.source === 'manual' && (
                        <div className="text-[10px] text-muted-foreground">Manual</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {inc.customerId || '—'}
                      {inc.envId ? ` / ${inc.envId}` : ''}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground" title={inc.openedAt}>
                      {relativeTime(inc.openedAt)}
                    </td>
                    <td className="px-4 py-2">
                      <Badge className={`${STATUS_COLOR[inc.status]} border`}>
                        {STATUS_LABEL[inc.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {inc.assigneeUserId || <span className="italic">unassigned</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {openId && (
        <IncidentDetail
          incidentId={openId}
          onClose={closeDetail}
          onChanged={refresh}
        />
      )}

      {manualOpen && (
        <ManualIncidentDialog
          onClose={() => setManualOpen(false)}
          onCreated={(id) => { setManualOpen(false); refresh(); openDetail(id); }}
        />
      )}
    </div>
  )
}

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffSec = Math.floor((now - then) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}
