import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../../api/client'
import type { IncidentWithEvents, IncidentEvent, AlertSeverity, IncidentStatus } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '../../components/ui/sheet'
import { Badge } from '../../components/ui/badge'
import { SearchableSelect } from '../../components/SearchableSelect'
import { useBasicUsers } from '../../lib/use-basic-users'
import { slackChannelToPickerItem, type SlackChannel } from './slackChannel'

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

interface SlackPostResult { channel: string; ok: boolean; error?: string; code?: string }

interface Props {
  incidentId: string
  onClose: () => void
  onChanged: () => void
}

export function IncidentDetail({ incidentId, onClose, onChanged }: Props) {
  // Basic user directory — non-admin (the previous useAccessStore.loadAll
  // hit /access/* which is user.admin-gated, leaving non-admins with an
  // empty assignee picker).
  const { users: accessUsers } = useBasicUsers()

  const [incident, setIncident] = useState<IncidentWithEvents | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updateText, setUpdateText] = useState('')
  const [postToSlack, setPostToSlack] = useState(true)
  const [working, setWorking] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<IncidentWithEvents>(`/alerts/incidents/${incidentId}`)
      setIncident(data)
      // Default the broadcast checkbox to true only when there's a thread
      // to broadcast into; otherwise the post would have nowhere to land.
      setPostToSlack((data.slackPosts?.length ?? 0) > 0)
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

  async function submitUpdate() {
    if (!updateText.trim()) return
    await doAction('/note', { text: updateText, broadcast: postToSlack })
    setUpdateText('')
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
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="md:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 pr-8">
            <span>{incident ? SEVERITY_ICON[incident.severity] : '🚨'}</span>
            <span>{incident?.summary || 'Incident'}</span>
          </SheetTitle>
        </SheetHeader>
        <SheetBody>

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

            {/* Slack status panel — surfaces threading state instead of leaving
                "did the Slack post work?" as an invisible question. */}
            <SlackStatusPanel
              incident={incident}
              onPosted={async () => { await refresh(); onChanged() }}
            />

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
              <AssignControl
                incidentId={incidentId}
                currentUserId={incident.assigneeUserId}
                users={accessUsers}
                onAssigned={() => { refresh(); onChanged() }}
              />
              <select
                className="border rounded px-2 py-1 text-sm bg-background"
                value={incident.severity}
                disabled={working}
                onChange={(e) => changeSeverity(e.target.value as AlertSeverity)}
              >
                <option value="critical">Severity: Critical</option>
                <option value="warning">Severity: Warning</option>
                <option value="info">Severity: Info</option>
              </select>
            </div>

            {/* Post an update */}
            <div className="pt-2 border-t space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">Post an update</div>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={postToSlack}
                    disabled={(incident.slackPosts?.length ?? 0) === 0}
                    onChange={(e) => setPostToSlack(e.target.checked)}
                  />
                  <span className={(incident.slackPosts?.length ?? 0) === 0 ? 'text-muted-foreground/60' : ''}>
                    Also post to Slack thread
                    {(incident.slackPosts?.length ?? 0) === 0 && ' (no thread yet)'}
                  </span>
                </label>
              </div>
              <div className="flex gap-2">
                <input
                  className="flex-1 border rounded px-3 py-2 text-sm bg-background"
                  placeholder={postToSlack
                    ? 'Status update — e.g. Restarted Redis, monitoring...'
                    : 'Internal note (won\'t be posted to Slack)'}
                  value={updateText}
                  onChange={(e) => setUpdateText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitUpdate() }}
                />
                <Button size="sm" disabled={working || !updateText.trim()} onClick={submitUpdate}>
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
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function TimelineEntry({ event }: { event: IncidentEvent }) {
  const icon = EVENT_ICON[event.type] || '•'
  const actor = event.actorName || 'system'
  const time = new Date(event.at).toLocaleString()
  const details = formatEventDetails(event)
  const isUpdate = event.type === 'note'
  const broadcast = isUpdate && (event.payload as Record<string, unknown>)?.broadcast !== false

  return (
    <li className="flex gap-3 text-sm">
      <span className="w-5 text-center">{icon}</span>
      <div className="flex-1">
        <div>
          <span className="font-medium capitalize">
            {isUpdate ? 'Update' : event.type.replace(/-/g, ' ')}
          </span>
          {' by '}
          <span className="text-muted-foreground">{actor}</span>
          {isUpdate && (
            <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0">
              {broadcast ? 'Slack' : 'Internal'}
            </Badge>
          )}
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

function AssignControl({ incidentId, currentUserId, users, onAssigned }: {
  incidentId: string
  currentUserId: string | null
  users: { email: string; name: string | null }[]
  onAssigned: () => void
}) {
  const [open, setOpen] = useState(false)
  async function assign(email: string | null) {
    setOpen(false)
    try {
      const user = email ? users.find(u => u.email === email) : null
      await apiFetch(`/alerts/incidents/${incidentId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          assigneeUserId: email,
          assigneeName: user?.name || email,
        }),
      })
      onAssigned()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Assign failed')
    }
  }

  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen(o => !o)}>
        {currentUserId ? `Assigned: ${currentUserId}` : 'Assign'}
        <span className="ml-1 text-[10px]">▾</span>
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-64 max-h-72 overflow-y-auto rounded-md border border-border bg-card shadow-xl">
            <button
              type="button"
              onClick={() => assign(null)}
              className="w-full text-left px-3 py-2 text-xs hover:bg-accent border-b text-muted-foreground"
            >
              Unassign
            </button>
            {users.map(u => (
              <button
                key={u.email}
                type="button"
                onClick={() => assign(u.email)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-accent ${u.email === currentUserId ? 'bg-accent/50' : ''}`}
              >
                {u.name || u.email}
                <div className="text-[10px] text-muted-foreground">{u.email}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Slack threading status — shows which channels the incident is threaded
 * to (or, when none, exposes a late-post button so the user can recover
 * from "bot wasn't in the channel" without recreating the incident).
 */
function SlackStatusPanel({
  incident,
  onPosted,
}: {
  incident: IncidentWithEvents
  onPosted: () => void | Promise<void>
}) {
  const [picking, setPicking] = useState(false)
  const [channels, setChannels] = useState<SlackChannel[] | null>(null)
  const [picked, setPicked] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  const slackPosts = incident.slackPosts || []

  useEffect(() => {
    if (!picking || channels) return
    apiFetch<{ ok: boolean; channels: SlackChannel[]; error?: string }>('/alerts/slack/channels')
      .then(r => setChannels(r.channels || []))
      .catch(() => setChannels([]))
  }, [picking, channels])

  async function postNow() {
    if (!picked) return
    setPosting(true)
    setPostError(null)
    try {
      const res = await apiFetch<{ slackPostResults: SlackPostResult[] }>(
        `/alerts/incidents/${incident.id}/post-to-slack`,
        { method: 'POST', body: JSON.stringify({ channel: picked }) },
      )
      const failure = (res.slackPostResults || []).find(p => !p.ok)
      if (failure) {
        setPostError(`${failure.channel}: ${failure.error || failure.code}`)
      } else {
        setPicking(false)
        setPicked('')
        await onPosted()
      }
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Post failed')
    } finally {
      setPosting(false)
    }
  }

  if (slackPosts.length > 0) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-emerald-700 dark:text-emerald-400">Threaded in:</span>{' '}
            {slackPosts.map((p, i) => (
              <span key={p.channel + p.ts}>
                {i > 0 && ', '}
                <a
                  href={slackThreadUrl(p.channel, p.ts)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline font-mono"
                >#{p.channel}</a>
              </span>
            ))}
          </div>
          {!picking && (
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
              + Add channel
            </Button>
          )}
        </div>
        {picking && (
          <ChannelPickerInline
            channels={channels}
            picked={picked}
            setPicked={setPicked}
            posting={posting}
            postNow={postNow}
            cancel={() => { setPicking(false); setPicked(''); setPostError(null) }}
            error={postError}
          />
        )}
      </div>
    )
  }

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-amber-700 dark:text-amber-400">
          Not posted to Slack — updates won't broadcast.
        </div>
        {!picking && (
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
            Post to Slack…
          </Button>
        )}
      </div>
      {picking && (
        <ChannelPickerInline
          channels={channels}
          picked={picked}
          setPicked={setPicked}
          posting={posting}
          postNow={postNow}
          cancel={() => { setPicking(false); setPicked(''); setPostError(null) }}
          error={postError}
        />
      )}
    </div>
  )
}

function ChannelPickerInline({
  channels, picked, setPicked, posting, postNow, cancel, error,
}: {
  channels: SlackChannel[] | null
  picked: string
  setPicked: (s: string) => void
  posting: boolean
  postNow: () => void
  cancel: () => void
  error: string | null
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <SearchableSelect
          className="flex-1"
          items={(channels || []).map(c => slackChannelToPickerItem(c))}
          value={picked || null}
          onChange={(v) => setPicked(v || '')}
          placeholder={channels ? 'Pick a channel…' : 'Loading channels…'}
          searchPlaceholder="Search Slack channels…"
          emptyHint="No Slack channels available — check Slack connection / scopes."
          disabled={!channels}
        />
        <Button size="sm" disabled={posting || !picked} onClick={postNow}>
          {posting ? 'Posting…' : 'Post'}
        </Button>
        <Button size="sm" variant="outline" onClick={cancel}>Cancel</Button>
      </div>
      {channels && channels.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          The Nectar bot isn't in any channels yet — invite @Nectar to a channel and reopen this incident.
        </p>
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  )
}

function slackThreadUrl(channel: string, ts: string): string {
  const bareTs = String(ts).replace(/\./g, '')
  return `slack://channel?team=&id=${encodeURIComponent(channel)}&message=p${bareTs}`
}
