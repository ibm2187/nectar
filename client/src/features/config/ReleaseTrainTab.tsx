import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'
import { TemplateApplyDialog } from './TemplateApplyDialog'

interface Milestone {
  key: string
  label: string
  tMinus: number
  owner: string
  gate: boolean
  autoCheck: string | null
  description: string | null
  missAction: string | null
}

interface Template {
  key: string
  label: string
  shipDay: string | null
  bufferDay: string | null
  skipWeekends: boolean
  milestones: Milestone[]
  version: number
  updatedAt: string
  updatedBy: string | null
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const COMMON_OWNERS = ['PM', 'Dev Lead', 'Dev', 'QA Lead', 'QA', 'DBA', 'Release Lead', 'CTO', 'Mobile Lead']

export function ReleaseTrainTab() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [applyDialog, setApplyDialog] = useState<{ key: string; label: string; version: number } | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const list = await apiFetch<Template[]>('/settings/release-templates')
      setTemplates(list)
      if (list.length > 0 && !activeKey) setActiveKey(list[0].key)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (activeKey) {
      const t = templates.find(x => x.key === activeKey)
      if (t) setDraft(JSON.parse(JSON.stringify(t)))
    }
  }, [activeKey, templates])

  function updateDraft(patch: Partial<Template>) {
    if (!draft) return
    setDraft({ ...draft, ...patch })
  }

  function updateMilestone(idx: number, patch: Partial<Milestone>) {
    if (!draft) return
    const milestones = [...draft.milestones]
    milestones[idx] = { ...milestones[idx], ...patch }
    setDraft({ ...draft, milestones })
  }

  function moveMilestone(idx: number, dir: -1 | 1) {
    if (!draft) return
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= draft.milestones.length) return
    const milestones = [...draft.milestones]
    const [item] = milestones.splice(idx, 1)
    milestones.splice(newIdx, 0, item)
    setDraft({ ...draft, milestones })
  }

  function removeMilestone(idx: number) {
    if (!draft) return
    if (!confirm(`Remove "${draft.milestones[idx].label}"?`)) return
    const milestones = draft.milestones.filter((_, i) => i !== idx)
    setDraft({ ...draft, milestones })
  }

  function addMilestone() {
    if (!draft) return
    const milestones = [...draft.milestones, {
      key: `new-${Date.now()}`,
      label: 'New Milestone',
      tMinus: 0,
      owner: 'PM',
      gate: false,
      autoCheck: null,
      description: null,
      missAction: null,
    }]
    setDraft({ ...draft, milestones })
  }

  function isDirty(): boolean {
    if (!draft || !activeKey) return false
    const orig = templates.find(t => t.key === activeKey)
    if (!orig) return false
    return JSON.stringify(orig) !== JSON.stringify(draft)
  }

  async function save() {
    if (!draft || !activeKey) return
    setSaving(true)
    setError(null)
    try {
      const updated = await apiFetch<Template>(`/settings/release-templates/${activeKey}`, {
        method: 'PUT',
        body: JSON.stringify({
          label: draft.label,
          shipDay: draft.shipDay,
          bufferDay: draft.bufferDay,
          skipWeekends: draft.skipWeekends,
          milestones: draft.milestones,
          updatedBy: 'ui',
        }),
      })
      setTemplates(prev => prev.map(t => t.key === activeKey ? updated : t))
      setDraft(JSON.parse(JSON.stringify(updated)))
      setSavedAt(new Date().toLocaleTimeString())
      // Open the apply dialog so user can decide which existing releases to refresh
      setApplyDialog({ key: updated.key, label: updated.label, version: updated.version })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  function discard() {
    if (!activeKey) return
    const orig = templates.find(t => t.key === activeKey)
    if (orig) setDraft(JSON.parse(JSON.stringify(orig)))
  }

  if (loading) return <div className="py-12 flex items-center justify-center"><NectarLoader /></div>

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Release Train Templates</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Configure the milestone process for each release type. Changes apply to new releases only.
        </p>
      </div>

      {/* Template selector */}
      <div className="flex items-center gap-2 flex-wrap">
        {templates.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveKey(t.key)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium border transition-colors',
              activeKey === t.key
                ? 'bg-accent text-accent-foreground border-border'
                : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-muted-foreground/40'
            )}
          >
            {t.label}
            <span className="ml-2 text-[10px] text-muted-foreground font-mono">v{t.version}</span>
          </button>
        ))}
      </div>

      {draft && (
        <>
          {/* General settings */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <h4 className="text-sm font-semibold">General</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Label</Label>
                  <Input
                    value={draft.label}
                    onChange={e => updateDraft({ label: e.target.value })}
                    className="h-8 text-sm mt-1"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Ship Day</Label>
                  <select
                    value={draft.shipDay || ''}
                    onChange={e => updateDraft({ shipDay: e.target.value || null })}
                    className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm mt-1"
                  >
                    <option value="">N/A</option>
                    {DAYS.map(d => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Buffer Day</Label>
                  <select
                    value={draft.bufferDay || ''}
                    onChange={e => updateDraft({ bufferDay: e.target.value || null })}
                    className="flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm mt-1"
                  >
                    <option value="">N/A</option>
                    {DAYS.map(d => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm cursor-pointer pb-1">
                    <input
                      type="checkbox"
                      checked={draft.skipWeekends}
                      onChange={e => updateDraft({ skipWeekends: e.target.checked })}
                      className="rounded"
                    />
                    Skip weekends in T-minus
                  </label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Milestones */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold">Milestones</h4>
                <Button variant="outline" size="sm" className="text-xs h-7" onClick={addMilestone}>
                  + Add Milestone
                </Button>
              </div>

              {draft.milestones.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No milestones. Add one to get started.</p>
              ) : (
                <div className="space-y-2">
                  {/* Header row */}
                  <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-muted-foreground font-medium px-2">
                    <div className="col-span-1">Order</div>
                    <div className="col-span-2">T-minus</div>
                    <div className="col-span-4">Label</div>
                    <div className="col-span-2">Owner</div>
                    <div className="col-span-1 text-center">Gate</div>
                    <div className="col-span-2 text-right">Actions</div>
                  </div>

                  {draft.milestones.map((m, idx) => (
                    <MilestoneRow
                      key={m.key + idx}
                      milestone={m}
                      idx={idx}
                      total={draft.milestones.length}
                      onChange={p => updateMilestone(idx, p)}
                      onMove={dir => moveMilestone(idx, dir)}
                      onRemove={() => removeMilestone(idx)}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!isDirty() || saving}
              onClick={save}
            >
              {saving ? 'Saving\u2026' : 'Save Changes'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!isDirty() || saving}
              onClick={discard}
            >
              Discard
            </Button>
            {savedAt && !isDirty() && (
              <span className="text-xs text-muted-foreground">Saved {savedAt}</span>
            )}
            {isDirty() && (
              <span className="text-xs text-warning">Unsaved changes</span>
            )}
            <div className="ml-auto text-xs text-muted-foreground">
              Version {draft.version}
              {draft.updatedAt && ` \u2022 updated ${new Date(draft.updatedAt).toLocaleString()}`}
              {draft.updatedBy && ` by ${draft.updatedBy}`}
            </div>
          </div>

          {/* Help text */}
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <strong className="text-foreground">How this works:</strong> T-minus is the number of business days before ship.
            Gates block downstream progress when missed. Auto-check values: <code className="font-mono">all-prs-merged</code>,{' '}
            <code className="font-mono">branch-exists</code>, <code className="font-mono">truth-all-certified</code>,{' '}
            <code className="font-mono">migrations-approved</code>, <code className="font-mono">time-based</code>,{' '}
            <code className="font-mono">state-is-done</code> — or leave blank for manual check.
            After saving, you'll choose which existing releases to refresh.
          </div>
        </>
      )}

      {applyDialog && (
        <TemplateApplyDialog
          open={!!applyDialog}
          onOpenChange={(open) => { if (!open) setApplyDialog(null) }}
          templateKey={applyDialog.key}
          templateLabel={applyDialog.label}
          templateVersion={applyDialog.version}
          onApplied={(count) => setSavedAt(`${new Date().toLocaleTimeString()} (applied to ${count})`)}
        />
      )}
    </div>
  )
}

function MilestoneRow({
  milestone, idx, total, onChange, onMove, onRemove,
}: {
  milestone: Milestone
  idx: number
  total: number
  onChange: (patch: Partial<Milestone>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border rounded-md bg-card">
      <div className="grid grid-cols-12 gap-2 items-center px-2 py-1.5">
        <div className="col-span-1 flex items-center gap-0.5">
          <button
            onClick={() => onMove(-1)}
            disabled={idx === 0}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 px-1"
            title="Move up"
          >
            {'\u25B2'}
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={idx === total - 1}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 px-1"
            title="Move down"
          >
            {'\u25BC'}
          </button>
        </div>
        <div className="col-span-2">
          <Input
            type="number"
            value={milestone.tMinus}
            onChange={e => onChange({ tMinus: parseInt(e.target.value, 10) || 0 })}
            className="h-7 text-xs"
          />
        </div>
        <div className="col-span-4">
          <Input
            value={milestone.label}
            onChange={e => onChange({ label: e.target.value })}
            className="h-7 text-xs"
          />
        </div>
        <div className="col-span-2">
          <select
            value={milestone.owner}
            onChange={e => onChange({ owner: e.target.value })}
            className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs"
          >
            {COMMON_OWNERS.map(o => <option key={o} value={o}>{o}</option>)}
            {!COMMON_OWNERS.includes(milestone.owner) && (
              <option value={milestone.owner}>{milestone.owner}</option>
            )}
          </select>
        </div>
        <div className="col-span-1 flex justify-center">
          <label className="cursor-pointer" title={milestone.gate ? 'Gate (blocks progress)' : 'Informational'}>
            <input
              type="checkbox"
              checked={milestone.gate}
              onChange={e => onChange({ gate: e.target.checked })}
              className="rounded"
            />
          </label>
        </div>
        <div className="col-span-2 flex justify-end gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
          >
            {expanded ? 'Less' : 'More'}
          </button>
          <button
            onClick={onRemove}
            className="text-[10px] text-destructive hover:bg-destructive/10 px-2 py-1 rounded"
          >
            Remove
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-2 pb-3 pt-1 border-t grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Key (internal)</Label>
            <Input
              value={milestone.key}
              onChange={e => onChange({ key: e.target.value })}
              className="h-7 text-xs mt-0.5 font-mono"
              placeholder="e.g. scope-lock"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Auto-check</Label>
            <select
              value={milestone.autoCheck || ''}
              onChange={e => onChange({ autoCheck: e.target.value || null })}
              className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs mt-0.5"
            >
              <option value="">Manual</option>
              <option value="all-prs-merged">All PRs merged</option>
              <option value="branch-exists">Branch exists</option>
              <option value="truth-all-certified">Truth: all certified</option>
              <option value="migrations-approved">Migrations approved</option>
              <option value="time-based">Time-based (past due date)</option>
              <option value="state-is-done">Release state = done</option>
            </select>
          </div>
          <div className="col-span-2">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Description</Label>
            <Input
              value={milestone.description || ''}
              onChange={e => onChange({ description: e.target.value || null })}
              className="h-7 text-xs mt-0.5"
              placeholder="What this gate means"
            />
          </div>
          <div className="col-span-2">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">If Missed</Label>
            <Input
              value={milestone.missAction || ''}
              onChange={e => onChange({ missAction: e.target.value || null })}
              className="h-7 text-xs mt-0.5"
              placeholder="Consequence of missing this gate"
            />
          </div>
        </div>
      )}
    </div>
  )
}

