import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../api/client'
import type { AlertSeverity } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { SearchableSelect } from '../../components/SearchableSelect'
import { useCustomers } from '../../lib/customer-utils'
import { useWsStore } from '../../stores/wsStore'
import { useBasicUsers } from '../../lib/use-basic-users'

interface SlackChannel {
  id: string
  name: string
  isPrivate: boolean
}

interface SlackPostResult {
  channel: string
  ok: boolean
  error?: string
  code?: string
  ts?: string | null
}

interface CreateResponse {
  id: string
  slackPostResults?: SlackPostResult[] | null
}

interface Props {
  onClose: () => void
  onCreated: (id: string) => void
}

export function ManualIncidentDialog({ onClose, onCreated }: Props) {
  const { customers } = useCustomers()
  const environments = useWsStore(s => s.environments)
  const { users: accessUsers } = useBasicUsers()

  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<AlertSeverity>('warning')
  const [customerId, setCustomerId] = useState('')
  const [envId, setEnvId] = useState('')
  const [slackChannel, setSlackChannel] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slackFailure, setSlackFailure] = useState<SlackPostResult | null>(null)
  const [createdIncidentId, setCreatedIncidentId] = useState<string | null>(null)

  // Slack channels — fetched once on mount, cached per dialog open.
  const [slackChannels, setSlackChannels] = useState<SlackChannel[] | null>(null)
  const [slackChannelsError, setSlackChannelsError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    apiFetch<{ ok: boolean; channels: SlackChannel[]; error?: string }>('/alerts/slack/channels')
      .then(r => {
        if (cancelled) return
        if (!r.ok) setSlackChannelsError(r.error || 'Slack not connected')
        setSlackChannels(r.channels || [])
      })
      .catch(err => { if (!cancelled) setSlackChannelsError(err.message) })
    return () => { cancelled = true }
  }, [])

  // Environments narrowed to the selected customer (if any). Sorted by tier
  // then name so the most-relevant production env tends to land first.
  const customerEnvs = useMemo(() => {
    if (!customerId) return []
    return environments
      .filter(e => e.customerId === customerId && !e.disabled)
      .sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name))
  }, [environments, customerId])

  // Reset env if it no longer belongs to the selected customer.
  useEffect(() => {
    if (envId && !customerEnvs.some(e => e.id === envId)) setEnvId('')
  }, [envId, customerEnvs])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!summary.trim()) { setError('Summary is required'); return }
    setSubmitting(true)
    setError(null)
    setSlackFailure(null)
    try {
      const created = await apiFetch<CreateResponse>('/alerts/incidents', {
        method: 'POST',
        body: JSON.stringify({
          summary: summary.trim(),
          description: description.trim() || null,
          severity,
          customerId: customerId || null,
          envId: envId || null,
          slackChannel: slackChannel || null,
          assigneeUserId: assigneeUserId || null,
        }),
      })

      // Surface Slack post failures inline. The incident IS created (the
      // backend doesn't roll back); the user gets to choose: continue
      // without Slack, or fix the channel and retry from the detail modal.
      const failure = (created.slackPostResults || []).find(p => !p.ok)
      if (failure) {
        setSlackFailure(failure)
        setCreatedIncidentId(created.id)
        return
      }
      onCreated(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create incident')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Incident</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Summary *" hint="One-line description">
            <input
              className="w-full border rounded px-3 py-2 text-sm bg-background"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Slow page loads for Bayada users"
              maxLength={200}
              autoFocus
              required
            />
          </Field>
          <Field label="Description" hint="Optional longer detail">
            <textarea
              className="w-full border rounded px-3 py-2 text-sm bg-background"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional context, steps to reproduce, etc."
              rows={3}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Severity">
              <select
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as AlertSeverity)}
              >
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </Field>
            <Field label="Assign to (optional)">
              <select
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {accessUsers.map(u => (
                  <option key={u.email} value={u.email}>{u.name || u.email}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer (optional)">
              <select
                className="w-full border rounded px-3 py-2 text-sm bg-background"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">— None —</option>
                {customers.filter(c => !c.hidden).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Environment (optional)"
              hint={!customerId ? 'Pick a customer first' : undefined}
            >
              <select
                className="w-full border rounded px-3 py-2 text-sm bg-background disabled:opacity-50"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
                disabled={!customerId || customerEnvs.length === 0}
              >
                <option value="">— None —</option>
                {customerEnvs.map(env => (
                  <option key={env.id} value={env.id}>{env.name} ({env.tier})</option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label="Slack channel (optional)"
            hint={
              slackChannelsError
                ? `Slack: ${slackChannelsError}`
                : slackChannels && slackChannels.length === 0
                  ? 'Bot is not in any channels yet — add @Nectar to a channel and reopen this dialog'
                  : 'Posts a broadcast and threads future updates'
            }
          >
            <SearchableSelect
              className="w-full"
              items={(slackChannels || []).map(c => ({
                value: c.name,
                label: c.name,
                icon: c.isPrivate ? '🔒' : '#',
              }))}
              value={slackChannel || null}
              onChange={(v) => setSlackChannel(v || '')}
              placeholder="Don't post to Slack"
              searchPlaceholder="Search Slack channels…"
              clearable
              disabled={!slackChannels || slackChannels.length === 0 || !!slackChannelsError}
            />
          </Field>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {slackFailure && createdIncidentId && (
            <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm space-y-2">
              <p className="font-medium">Incident created — but Slack post failed.</p>
              <p className="text-xs">
                <strong>{slackFailure.channel}</strong>: {slackFailure.error || slackFailure.code}
                {slackFailure.code === 'not_in_channel' && (
                  <> — invite the Nectar bot to the channel and try again from the detail view.</>
                )}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onCreated(createdIncidentId)}
                >
                  Continue to incident
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !summary.trim() || !!slackFailure}>
              {submitting ? 'Creating...' : 'Create Incident'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}
