import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../../api/client'
import type { IncidentWithEvents, IncidentEvent, AlertSeverity, IncidentStatus } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Badge } from '../../components/ui/badge'

const STATUS_BADGE: Record<IncidentStatus, string> = {
  open: 'bg-red-100 text-red-800 border-red-300',
  acknowledged: 'bg-amber-100 text-amber-800 border-amber-300',
  reopened: 'bg-orange-100 text-orange-800 border-orange-300',
  resolved: 'bg-green-100 text-green-800 border-green-300',
}

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  critical: '🚨',
  warning: '⚠️',
  info: 'ℹ️',
}

const EVENT_ICON: Record<string, string> = {
  opened: '🔔',
  acknowledged: '👀',
  resolved: '✅',
  reopened: '🔁',
  note: '📝',
  assigned: '👤',
  'severity-changed': '🏷',
  'recovery-detected': '💚',
  sustained: '⏱',
  'dedup-suppressed': '🔕',
}

interface Props {
  incidentId: string
  onClose: () => void
  onChanged: () => void
}

export function IncidentDetail({ incidentId, onClose, onChanged }: Props) {
  const [incident, setIncident] = useState<IncidentWithEvents | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [working, setWorking] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<IncidentWithEvents>(`/alerts/incidents/${incidentId}`)
      setIncident(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [incidentId])

  useEffect(() => { refresh() }, [refresh])

  async function doAction(path: string, body: Record<string, unknown> = {}) {
    setWorking(true)
    try {
      await apiFetch(`/alerts/incidents/${incidentId}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      await refresh()
      onChanged()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setWorking(false)
    }
  }

  async function submitNote() {
    if (!noteText.trim()) return
    await doAction('/note', { text: noteText })
    setNoteText('')
  }

  async function changeSeverity(severity: AlertSeverity) {
    setWorking(true)
    try {
      await apiFetch(`/alerts/incidents/${incidentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ severity }),
      })
      await refresh()
      onChanged()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Severity change failed')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{incident ? SEVERITY_ICON[incident.severity] : '🚨'}</span>
            <span>{incident?.summary || 'Incident'}</span>
          </DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {error && <p className="text-sm text-red-600">Error: {error}</p>}

        {incident && (
          <div className="space-y-4">
            {/* Metadata row */}
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Status</div>
                <Badge className={`${STATUS_BADGE[incident.status]} border`}>
                  {incident.status}
                </Badge>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Severity</div>
                <span className="font-medium capitalize">{incident.severity}</span>
              </div>
              {incident.customerId && (
                <div>
                  <div className="text-xs text-muted-foreground">Customer</div>
                  <span>{incident.customerId}</span>
                </div>
              )}
              {incident.envId && (
                <div>
                  <div className="text-xs text-muted-foreground">Environment</div>
                  <span>{incident.envId}</span>
                </div>
              )}
              <div>
                <div className="text-xs text-muted-foreground">Opened</div>
                <span>{new Date(incident.openedAt).toLocaleString()}</span>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Assignee</div>
                <span>{incident.assigneeUserId || <em className="text-muted-foreground">unassigned</em>}</span>
              </div>
            </div>

            {incident.description && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Description</div>
                <p className="text-sm">{incident.description}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              {incident.status === 'open' && (
                <Button size="sm" disabled={working} onClick={() => doAction('/acknowledge')}>
                  Acknowledge
                </Button>
              )}
              {incident.status !== 'resolved' && (
                <Button size="sm" variant="outline" disabled={working} onClick={() => doAction('/resolve')}>
                  Resolve
                </Button>
              )}
              {incident.status === 'resolved' && (
                <Button size="sm" variant="outline" disabled={working} onClick={() => doAction('/reopen')}>
                  Reopen
                </Button>
              )}
              <AssignButton
                incidentId={incidentId}
                currentUserId={incident.assigneeUserId}
                onAssigned={() => { refresh(); onChanged() }}
              />
              <select
                className="border rounded px-2 py-1 text-sm"
                value={incident.severity}
                disabled={working}
                onChange={(e) => changeSeverity(e.target.value as AlertSeverity)}
              >
                <option value="critical">Severity: Critical</option>
                <option value="warning">Severity: Warning</option>
                <option value="info">Severity: Info</option>
              </select>
              {incident.slackChannel && incident.slackTs && (
                <a
                  href={slackThreadUrl(incident.slackChannel, incident.slackTs)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline text-primary self-center"
                >
                  View in Slack
                </a>
              )}
            </div>

            {/* Add note */}
            <div className="pt-2 border-t space-y-2">
              <div className="text-xs text-muted-foreground">Add a note</div>
              <div className="flex gap-2">
                <input
                  className="flex-1 border rounded px-3 py-2 text-sm"
                  placeholder="e.g. Restarted Redis, monitoring..."
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNote() }}
                />
                <Button size="sm" disabled={working || !noteText.trim()} onClick={submitNote}>
                  Post
                </Button>
              </div>
            </div>

            {/* Timeline */}
            <div className="pt-2 border-t">
              <div className="text-xs text-muted-foreground mb-2">Timeline</div>
              <ol className="space-y-2">
                {incident.events.map(ev => <TimelineEntry key={ev.id} event={ev} />)}
              </ol>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TimelineEntry({ event }: { event: IncidentEvent }) {
  const icon = EVENT_ICON[event.type] || '•'
  const actor = event.actorName || 'system'
  const time = new Date(event.at).toLocaleString()
  const details = formatEventDetails(event)

  return (
    <li className="flex gap-3 text-sm">
      <span className="w-5 text-center">{icon}</span>
      <div className="flex-1">
        <div>
          <span className="font-medium capitalize">{event.type.replace(/-/g, ' ')}</span>
          {' by '}
          <span className="text-muted-foreground">{actor}</span>
        </div>
        {details && <div className="text-xs text-muted-foreground mt-0.5">{details}</div>}
        <div className="text-xs text-muted-foreground">{time}</div>
      </div>
    </li>
  )
}

function formatEventDetails(event: IncidentEvent): string | null {
  const p = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'note': return typeof p.text === 'string' ? p.text : null
    case 'assigned': return typeof p.assigneeName === 'string' ? `→ ${p.assigneeName}` : null
    case 'severity-changed': return typeof p.from === 'string' && typeof p.to === 'string' ? `${p.from} → ${p.to}` : null
    case 'sustained': return typeof p.ageMinutes === 'number' ? `Unhealthy for ${p.ageMinutes}m` : null
    case 'resolved': return typeof p.resolution === 'string' ? `resolution: ${p.resolution}` : null
    case 'dedup-suppressed': return typeof p.reason === 'string' ? p.reason : null
    default: return null
  }
}

function AssignButton({ incidentId, currentUserId, onAssigned }: {
  incidentId: string
  currentUserId: string | null
  onAssigned: () => void
}) {
  async function assign() {
    const name = prompt('Assign to (email or leave blank to unassign):', currentUserId || '')
    if (name === null) return
    try {
      await apiFetch(`/alerts/incidents/${incidentId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          assigneeUserId: name.trim() || null,
          assigneeName: name.trim() || null,
        }),
      })
      onAssigned()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Assign failed')
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={assign}>
      {currentUserId ? 'Reassign' : 'Assign'}
    </Button>
  )
}

function slackThreadUrl(channel: string, ts: string): string {
  // Slack deep-link format: /archives/CHANNEL/pTIMESTAMP_WITHOUT_DOT
  const bareTs = String(ts).replace(/\./g, '')
  return `slack://channel?team=&id=${encodeURIComponent(channel)}&message=p${bareTs}`
}
