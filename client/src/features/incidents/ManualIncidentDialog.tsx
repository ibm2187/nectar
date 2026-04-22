import { useState } from 'react'
import { apiFetch } from '../../api/client'
import type { Incident, AlertSeverity } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'

interface Props {
  onClose: () => void
  onCreated: (id: string) => void
}

export function ManualIncidentDialog({ onClose, onCreated }: Props) {
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<AlertSeverity>('warning')
  const [customerId, setCustomerId] = useState('')
  const [envId, setEnvId] = useState('')
  const [slackChannel, setSlackChannel] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!summary.trim()) { setError('Summary is required'); return }
    setSubmitting(true)
    setError(null)
    try {
      const created = await apiFetch<Incident>('/alerts/incidents', {
        method: 'POST',
        body: JSON.stringify({
          summary: summary.trim(),
          description: description.trim() || null,
          severity,
          customerId: customerId.trim() || null,
          envId: envId.trim() || null,
          slackChannel: slackChannel.trim() || null,
          assigneeUserId: assigneeUserId.trim() || null,
        }),
      })
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
              className="w-full border rounded px-3 py-2 text-sm"
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
              className="w-full border rounded px-3 py-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional context, steps to reproduce, etc."
              rows={3}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Severity">
              <select
                className="w-full border rounded px-3 py-2 text-sm"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as AlertSeverity)}
              >
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </Field>
            <Field label="Assign to (optional)">
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="email@viv..."
                value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer ID (optional)">
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="bayada"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              />
            </Field>
            <Field label="Env ID (optional)">
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="bayada-prod"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Slack channel (optional)" hint="If set, posts a broadcast to this channel and threads future updates">
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="#alerts-prod"
              value={slackChannel}
              onChange={(e) => setSlackChannel(e.target.value)}
            />
          </Field>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !summary.trim()}>
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
