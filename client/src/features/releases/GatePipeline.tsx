import { useState, useEffect } from 'react'
import { cn } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '../../components/ui/sheet'
import { apiFetch } from '../../api/client'

interface Milestone {
  key: string
  label: string
  tMinus: number
  computedDate: string
  overrideDate: string | null
  effectiveDate: string
  status: 'pending' | 'met' | 'missed' | 'skipped'
  completedAt: string | null
  completedBy: string | null
  owner: string
  gate: boolean
  autoCheck: string | null
  description: string | null
  missAction: string | null
}

interface Props {
  version: string
  releaseType: string | null
  shipDate: string | null
  jiraReleaseDate?: string | null
  milestones: Milestone[]
  templateVersion?: number | null
  onUpdate?: () => void
}

const typeLabels: Record<string, string> = { monthly: 'Monthly', point: 'Point', hotfix: 'Hotfix' }

function getEffectiveStatus(m: Milestone): 'met' | 'missed' | 'skipped' | 'active' | 'pending' {
  if (m.status === 'met' || m.status === 'missed' || m.status === 'skipped') return m.status
  const today = new Date().toISOString().split('T')[0]
  if (m.effectiveDate && m.effectiveDate <= today) return 'active'
  return 'pending'
}

function formatDateShort(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatDateLong(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

const nodeStyles: Record<string, { container: string; icon: string; label: string; date: string }> = {
  met: {
    container: 'bg-green-500/10 border-green-500/30 hover:border-green-500/50',
    icon: 'text-green-500',
    label: 'text-foreground',
    date: 'text-green-600 dark:text-green-400',
  },
  missed: {
    container: 'bg-destructive/10 border-destructive/30 hover:border-destructive/50',
    icon: 'text-destructive',
    label: 'text-foreground',
    date: 'text-destructive',
  },
  skipped: {
    container: 'bg-muted border-border opacity-60',
    icon: 'text-muted-foreground',
    label: 'text-muted-foreground line-through',
    date: 'text-muted-foreground',
  },
  active: {
    container: 'bg-primary/10 border-primary/40 hover:border-primary/60 ring-1 ring-primary/20',
    icon: 'text-primary',
    label: 'text-foreground font-semibold',
    date: 'text-primary',
  },
  pending: {
    container: 'bg-card border-border hover:border-muted-foreground/40',
    icon: 'text-muted-foreground',
    label: 'text-muted-foreground',
    date: 'text-muted-foreground',
  },
}

const statusIcons: Record<string, string> = {
  met: '\u2713', missed: '\u2717', skipped: '\u2014', active: '\u25CF', pending: '\u25CB',
}

const statusLabels: Record<string, string> = {
  met: 'Met', missed: 'Missed', skipped: 'Skipped', active: 'In Progress', pending: 'Pending',
}

export function GatePipeline({ version, releaseType, shipDate, jiraReleaseDate, milestones, templateVersion, onUpdate }: Props) {
  const [gateKey, setGateKey] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [currentTemplateVersion, setCurrentTemplateVersion] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Fetch current template version to detect staleness
  useEffect(() => {
    if (!releaseType) return
    let cancelled = false
    apiFetch<{ version: number }>(`/settings/release-templates/${releaseType}`)
      .then(t => { if (!cancelled) setCurrentTemplateVersion(t.version) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [releaseType])

  const gates = (milestones || []).filter(m => m.gate)
  const metCount = gates.filter(g => g.status === 'met').length
  const missedCount = gates.filter(g => g.status === 'missed').length
  const hasMilestones = gates.length > 0
  const activeMilestone = gateKey ? milestones.find(m => m.key === gateKey) ?? null : null
  const isStale = !!templateVersion && !!currentTemplateVersion && templateVersion < currentTemplateVersion

  async function refreshFromTemplate() {
    setRefreshing(true)
    try {
      await apiFetch(`/releases/${encodeURIComponent(version)}/refresh-template`, { method: 'POST' })
      onUpdate?.()
    } catch { /* silent */ }
    setRefreshing(false)
  }

  // Compact state: no milestones yet
  if (!hasMilestones) {
    return (
      <>
        <div className="rounded-lg border bg-card px-4 py-2.5 mb-4 flex items-center gap-3 text-xs">
          <span className="text-muted-foreground font-medium">Release Train</span>
          <span className="text-muted-foreground">—</span>
          <span className="text-muted-foreground ml-auto">
            {!releaseType && !shipDate && 'Not configured'}
            {releaseType && !shipDate && `${typeLabels[releaseType]} — ship date missing`}
          </span>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setSettingsOpen(true)}>
            Configure
          </Button>
        </div>
        <TrainSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          version={version}
          releaseType={releaseType}
          shipDate={shipDate}
          jiraReleaseDate={jiraReleaseDate}
          onUpdate={onUpdate}
        />
      </>
    )
  }

  return (
    <>
      {isStale && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 mb-2 flex items-center gap-3 text-xs">
          <span className="text-primary font-medium">Template updated</span>
          <span className="text-muted-foreground">
            v{templateVersion} {'\u2192'} v{currentTemplateVersion} available. Refresh to apply new T-minus, owners, and added gates.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto text-xs h-7"
            disabled={refreshing}
            onClick={refreshFromTemplate}
          >
            {refreshing ? 'Refreshing\u2026' : 'Refresh'}
          </Button>
        </div>
      )}
      <div className="rounded-lg border bg-card p-4 mb-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs">
            <h3 className="text-sm font-semibold">Release Train</h3>
            {releaseType && (
              <Badge variant="secondary" className="text-[10px] capitalize">
                {typeLabels[releaseType]}
              </Badge>
            )}
            {shipDate && (
              <span className="text-muted-foreground">
                Ship <span className="text-foreground font-medium">{formatDateShort(shipDate)}</span>
              </span>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
              title="Train settings"
              aria-label="Train settings"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              <span className="text-green-600 dark:text-green-400 font-medium">{metCount}</span>
              <span className="mx-1">/</span>
              {gates.length} gates
            </span>
            {missedCount > 0 && (
              <span className="text-destructive font-medium">{missedCount} missed</span>
            )}
          </div>
        </div>

        {/* Pipeline — full width with arrows */}
        <div className="flex items-stretch w-full">
          {gates.map((gate, i) => {
            const effective = getEffectiveStatus(gate)
            const style = nodeStyles[effective]
            const isExpanded = gateKey === gate.key
            const prevMet = i > 0 && gates[i - 1].status === 'met'

            return (
              <div key={gate.key} className="flex items-stretch flex-1 min-w-0">
                {i > 0 && (
                  <div className={cn(
                    'flex items-center justify-center px-1.5 text-sm select-none flex-shrink-0',
                    prevMet ? 'text-green-500/60' : 'text-muted-foreground/30'
                  )}>
                    {'\u2192'}
                  </div>
                )}
                <button
                  onClick={() => setGateKey(gate.key)}
                  className={cn(
                    'flex-1 min-w-0 flex flex-col items-center justify-center gap-1 px-2 py-2.5 rounded-md border transition-all cursor-pointer',
                    style.container,
                    isExpanded && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
                  )}
                >
                  <span className={cn('text-base leading-none font-bold', style.icon)}>
                    {statusIcons[effective]}
                  </span>
                  <span className={cn('text-[11px] font-medium leading-tight text-center break-words w-full', style.label)}>
                    {gate.label}
                  </span>
                  <span className={cn('text-[10px] font-mono', style.date)}>
                    {gate.effectiveDate ? formatDateShort(gate.effectiveDate) : '\u2014'}
                  </span>
                  {gate.overrideDate && (
                    <span className="text-[9px] font-mono text-warning uppercase tracking-wide">override</span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <GateDetailSheet
        milestone={activeMilestone}
        version={version}
        onOpenChange={(open) => !open && setGateKey(null)}
        onUpdate={() => { onUpdate?.() }}
      />

      <TrainSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        version={version}
        releaseType={releaseType}
        shipDate={shipDate}
        jiraReleaseDate={jiraReleaseDate}
        onUpdate={onUpdate}
      />
    </>
  )
}

// ── Gate detail panel (slides from right) ──────────────────────────────────
function GateDetailSheet({
  milestone, version, onOpenChange, onUpdate,
}: {
  milestone: Milestone | null
  version: string
  onOpenChange: (open: boolean) => void
  onUpdate?: () => void
}) {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overrideValue, setOverrideValue] = useState('')
  const [statusValue, setStatusValue] = useState<'pending' | 'met' | 'skipped'>('pending')

  useEffect(() => {
    if (milestone) {
      setOverrideValue(milestone.overrideDate || milestone.computedDate || '')
      setStatusValue((milestone.status === 'missed' ? 'pending' : milestone.status) as 'pending' | 'met' | 'skipped')
      setError(null)
    }
  }, [milestone?.key, milestone?.status, milestone?.overrideDate, milestone?.computedDate])

  if (!milestone) return null

  const effective = getEffectiveStatus(milestone)

  const hasChanges =
    statusValue !== milestone.status ||
    (overrideValue || null) !== (milestone.overrideDate || null)

  const m = milestone
  async function saveAll() {
    setLoading('save')
    setError(null)
    try {
      const newOverride = overrideValue || null
      const currentOverride = m.overrideDate || null
      if (newOverride !== currentOverride) {
        await apiFetch(`/releases/${encodeURIComponent(version)}/milestones/${m.key}`, {
          method: 'PATCH',
          body: JSON.stringify({ overrideDate: newOverride }),
        })
      }
      if (statusValue !== m.status) {
        if (statusValue === 'met') {
          await apiFetch(`/releases/${encodeURIComponent(version)}/milestones/${m.key}/complete`, {
            method: 'POST', body: JSON.stringify({ user: 'ui' }),
          })
        } else if (statusValue === 'skipped') {
          await apiFetch(`/releases/${encodeURIComponent(version)}/milestones/${m.key}/skip`, {
            method: 'POST', body: JSON.stringify({ user: 'ui' }),
          })
        } else if (statusValue === 'pending') {
          await apiFetch(`/releases/${encodeURIComponent(version)}/milestones/${m.key}`, {
            method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
          })
        }
      }
      onUpdate?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(null)
    }
  }

  return (
    <Sheet open={!!milestone} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center gap-2 mb-1">
            <Badge
              variant="outline"
              className={cn(
                'text-[10px]',
                effective === 'met' && 'border-green-500/40 text-green-600 dark:text-green-400',
                effective === 'missed' && 'border-destructive/40 text-destructive',
                effective === 'active' && 'border-primary/40 text-primary',
                effective === 'skipped' && 'text-muted-foreground',
              )}
            >
              {statusLabels[effective]}
            </Badge>
            <span className="text-[10px] text-muted-foreground font-mono">T-{milestone.tMinus}</span>
            <span className="text-[10px] text-muted-foreground">Owner: <span className="text-foreground">{milestone.owner}</span></span>
          </div>
          <SheetTitle>{milestone.label}</SheetTitle>
        </SheetHeader>

        <SheetBody className="space-y-5">
          {/* Description + miss consequence */}
          {milestone.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{milestone.description}</p>
          )}
          {milestone.missAction && statusValue !== 'met' && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-destructive font-semibold mb-1">If missed</div>
              <p className="text-xs text-destructive">{milestone.missAction}</p>
            </div>
          )}

          {/* Completed info — read-only */}
          {milestone.completedAt && milestone.status !== 'pending' && (
            <div className="text-[11px] text-muted-foreground">
              Last action: {new Date(milestone.completedAt).toLocaleDateString()}
              {milestone.completedBy && milestone.completedBy !== 'unknown' && ` by ${milestone.completedBy}`}
            </div>
          )}

          {/* Status */}
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</Label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {(['pending', 'met', 'skipped'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusValue(s)}
                  className={cn(
                    'px-3 py-2 rounded-md border text-xs font-medium transition-colors capitalize',
                    statusValue === s
                      ? s === 'met'
                        ? 'bg-green-500/10 border-green-500/40 text-green-600 dark:text-green-400'
                        : s === 'skipped'
                          ? 'bg-muted border-muted-foreground/40 text-muted-foreground'
                          : 'bg-primary/10 border-primary/40 text-primary'
                      : 'bg-card border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
                  )}
                >
                  {s === 'met' ? 'Complete' : s === 'skipped' ? 'Skipped' : 'Pending'}
                </button>
              ))}
            </div>
          </div>

          {/* Due date */}
          <div>
            <Label htmlFor="due-date" className="text-[10px] uppercase tracking-wide text-muted-foreground">Due date</Label>
            <Input
              id="due-date"
              type="date"
              value={overrideValue}
              onChange={e => setOverrideValue(e.target.value)}
              className="h-9 text-sm mt-1"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Template-computed date: <span className="font-medium">{formatDateLong(milestone.computedDate)}</span>
              {milestone.overrideDate && overrideValue !== milestone.computedDate && (
                <>
                  {' \u2022 '}
                  <button
                    type="button"
                    onClick={() => setOverrideValue(milestone.computedDate)}
                    className="text-primary hover:underline"
                  >
                    reset
                  </button>
                </>
              )}
            </p>
          </div>

          {error && (
            <div className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* Single action row */}
          <div className="pt-3 border-t flex gap-2">
            <Button
              size="sm"
              className="text-xs h-8"
              disabled={!hasChanges || loading !== null}
              onClick={saveAll}
            >
              {loading === 'save' ? 'Saving\u2026' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-8 ml-auto"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

// ── Train settings panel (slides from right) ──────────────────────────────
function TrainSettingsSheet({
  open, onOpenChange, version, releaseType, shipDate, jiraReleaseDate, onUpdate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  version: string
  releaseType: string | null
  shipDate: string | null
  jiraReleaseDate?: string | null
  onUpdate?: () => void
}) {
  const [typeValue, setTypeValue] = useState(releaseType || '')
  const [dateValue, setDateValue] = useState(shipDate || jiraReleaseDate || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTypeValue(releaseType || '')
      setDateValue(shipDate || jiraReleaseDate || '')
      setError(null)
    }
  }, [open, releaseType, shipDate, jiraReleaseDate])

  const typeChanged = typeValue !== (releaseType || '')
  const dateChanged = dateValue !== (shipDate || '')
  const canSave = !!typeValue && !!dateValue && (typeChanged || dateChanged)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await apiFetch(`/releases/${encodeURIComponent(version)}/train`, {
        method: 'PATCH',
        body: JSON.stringify({ releaseType: typeValue, shipDate: dateValue }),
      })
      onUpdate?.()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Release Train Settings</SheetTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Configure the release type and ship date. Milestones recompute automatically.
          </p>
        </SheetHeader>

        <SheetBody className="space-y-5">
          {/* Release type */}
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Release Type</Label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {(['monthly', 'point', 'hotfix'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTypeValue(t)}
                  className={cn(
                    'px-3 py-2 rounded-md border text-xs font-medium transition-colors',
                    typeValue === t
                      ? 'bg-primary/10 border-primary/40 text-primary'
                      : 'bg-card border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
                  )}
                >
                  {typeLabels[t]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Monthly = patch 0 (e.g. 4.3.0). Point = patch &gt; 0 (e.g. 4.2.7). Hotfix = urgent same-day fix.
            </p>
          </div>

          {/* Ship date */}
          <div>
            <Label htmlFor="ship-date" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Ship Date
            </Label>
            <Input
              id="ship-date"
              type="date"
              value={dateValue}
              onChange={e => setDateValue(e.target.value)}
              className="h-9 text-sm mt-1"
            />
            {jiraReleaseDate && dateValue !== jiraReleaseDate && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                JIRA release date: {formatDateLong(jiraReleaseDate)}
                {' '}
                <button
                  onClick={() => setDateValue(jiraReleaseDate)}
                  className="text-primary hover:underline"
                >
                  use this
                </button>
              </p>
            )}
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">
              Changing ship date recomputes all milestone dates (preserving any manual overrides).
              Changing release type resets milestones to the new template.
            </p>
          </div>

          {error && (
            <div className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div className="pt-2 border-t flex gap-2">
            <Button
              size="sm"
              className="text-xs h-8"
              disabled={!canSave || saving}
              onClick={save}
            >
              {saving ? 'Saving\u2026' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-8 ml-auto"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
