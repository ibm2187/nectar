import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../api/client'
import type { AlertRule, AlertTrigger, AlertSeverity, ChannelValidationResult, Customer } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { Badge } from '../../components/ui/badge'
import { useWsStore } from '../../stores/wsStore'

const SEVERITY_BADGE: Record<AlertSeverity, string> = {
  critical: 'bg-red-100 text-red-800 border-red-300',
  warning: 'bg-amber-100 text-amber-800 border-amber-300',
  info: 'bg-blue-100 text-blue-800 border-blue-300',
}

export function AlertRulesPanel() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [triggers, setTriggers] = useState<AlertTrigger[]>([])
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<{ rule?: AlertRule } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [rulesRes, triggersRes] = await Promise.all([
        apiFetch<{ rules: AlertRule[] }>('/alerts/rules'),
        apiFetch<{ triggers: AlertTrigger[] }>('/alerts/triggers'),
      ])
      setRules(rulesRes.rules)
      setTriggers(triggersRes.triggers)
    } catch (err) {
      console.error('Failed to load alert rules', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function toggle(rule: AlertRule) {
    setBusyId(rule.id)
    try {
      await apiFetch(`/alerts/rules/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !rule.enabled }),
      })
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  async function remove(rule: AlertRule) {
    if (!confirm(`Delete rule "${rule.name}"?`)) return
    setBusyId(rule.id)
    try {
      await apiFetch(`/alerts/rules/${rule.id}`, { method: 'DELETE' })
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  async function test(rule: AlertRule) {
    setBusyId(rule.id)
    try {
      await apiFetch(`/alerts/rules/${rule.id}/test`, { method: 'POST' })
      alert(`Test alert sent to ${rule.channels.join(', ')}`)
      await refresh()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setBusyId(null)
    }
  }

  const triggerLabel = useCallback((key: string) =>
    triggers.find(t => t.key === key)?.label || key, [triggers])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Alert Rules</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Configure where Nectar sends alerts when environments become unhealthy, deploys fail, etc.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditor({})}>+ New Rule</Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {!loading && rules.length === 0 && (
          <p className="text-sm text-muted-foreground italic py-4">
            No alert rules configured. Click "New Rule" to get started.
          </p>
        )}
        {!loading && rules.length > 0 && (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium">Channels</th>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Filters</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b">
                  <td className="px-3 py-2 font-medium">{rule.name}</td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">{triggerLabel(rule.triggerType)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {rule.channels.map(c => <Badge key={c} variant="outline">{c}</Badge>)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge className={`${SEVERITY_BADGE[rule.severity]} border`}>{rule.severity}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{summarizeFilter(rule.filter)}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => toggle(rule)}
                      disabled={busyId === rule.id}
                      className={
                        'text-xs px-2 py-0.5 rounded ' +
                        (rule.enabled
                          ? 'bg-green-100 text-green-800 border border-green-300'
                          : 'bg-gray-100 text-gray-700 border border-gray-300')
                      }
                    >
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => test(rule)} disabled={busyId === rule.id}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditor({ rule })}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(rule)} disabled={busyId === rule.id}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      {editor && triggers.length > 0 && (
        <RuleEditor
          triggers={triggers}
          initial={editor.rule}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); refresh() }}
        />
      )}
    </Card>
  )
}

function summarizeFilter(filter: AlertRule['filter']): string {
  const parts: string[] = []
  if (filter.customerIds?.length) parts.push(`customers: ${filter.customerIds.join(', ')}`)
  if (filter.envIds?.length) parts.push(`envs: ${filter.envIds.length}`)
  if (filter.envTier?.length) parts.push(`tier: ${filter.envTier.join(', ')}`)
  if (filter.components?.length) parts.push(`components: ${filter.components.join(', ')}`)
  if (typeof filter.sustainedMinutes === 'number') parts.push(`≥${filter.sustainedMinutes}m`)
  return parts.length ? parts.join(' · ') : 'any'
}

// ══════════════════════════════════════════════════════════════
// RuleEditor
// ══════════════════════════════════════════════════════════════

function RuleEditor({ triggers, initial, onClose, onSaved }: {
  triggers: AlertTrigger[]
  initial?: AlertRule
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [triggerType, setTriggerType] = useState(initial?.triggerType || triggers[0]?.key || '')
  const [channelsText, setChannelsText] = useState((initial?.channels || []).join(', '))
  const [mention, setMention] = useState(initial?.mention || '')
  const [severity, setSeverity] = useState<AlertSeverity>(initial?.severity || 'critical')
  const [enabled, setEnabled] = useState(initial ? initial.enabled : true)
  const [filter, setFilter] = useState<AlertRule['filter']>(initial?.filter || {})

  const [channelValidation, setChannelValidation] = useState<Record<string, ChannelValidationResult | 'pending' | null>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTrigger = triggers.find(t => t.key === triggerType)

  const channels = useMemo(
    () => channelsText.split(',').map(c => c.trim()).filter(Boolean),
    [channelsText]
  )

  // Validate all channels on blur (or when channels change + user stops typing)
  async function validateAll() {
    for (const ch of channels) {
      if (channelValidation[ch]) continue // already validated
      setChannelValidation(v => ({ ...v, [ch]: 'pending' }))
      try {
        const res = await apiFetch<ChannelValidationResult>('/alerts/validate-channel', {
          method: 'POST',
          body: JSON.stringify({ channel: ch }),
        })
        setChannelValidation(v => ({ ...v, [ch]: res }))
      } catch (err) {
        setChannelValidation(v => ({
          ...v,
          [ch]: { ok: false, error: err instanceof Error ? err.message : 'Validation failed' },
        }))
      }
    }
  }

  // Reset validation when channel text changes so edits re-validate
  useEffect(() => {
    setChannelValidation(prev => {
      const next: typeof prev = {}
      for (const ch of channels) {
        if (prev[ch]) next[ch] = prev[ch]
      }
      return next
    })
  }, [channelsText])  // eslint-disable-line react-hooks/exhaustive-deps

  const allChannelsOk = channels.length > 0 && channels.every(ch => {
    const v = channelValidation[ch]
    return v && v !== 'pending' && v.ok
  })

  async function save() {
    setError(null)
    if (!name.trim()) { setError('Name is required'); return }
    if (channels.length === 0) { setError('At least one channel is required'); return }
    if (!allChannelsOk) { setError('All channels must be validated before saving'); return }

    setSaving(true)
    try {
      const body = {
        name: name.trim(),
        triggerType,
        channels,
        mention: mention.trim() || null,
        severity,
        enabled,
        filter,
      }
      if (initial) {
        await apiFetch(`/alerts/rules/${initial.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await apiFetch('/alerts/rules', { method: 'POST', body: JSON.stringify(body) })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit Rule' : 'New Alert Rule'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name *</label>
            <input
              className="w-full border rounded px-3 py-2 text-sm mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Prod health alerts"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Trigger</label>
            <select
              className="w-full border rounded px-3 py-2 text-sm mt-1"
              value={triggerType}
              onChange={(e) => {
                setTriggerType(e.target.value)
                setFilter({}) // reset filter when trigger changes — field schema differs
              }}
            >
              {triggers.map(t => (
                <option key={t.key} value={t.key}>
                  {t.label} {t.tier > 1 ? `(tier ${t.tier})` : ''}
                </option>
              ))}
            </select>
            {selectedTrigger && (
              <p className="text-xs text-muted-foreground mt-1">{selectedTrigger.description}</p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Channels * <span className="font-normal">(comma-separated)</span>
            </label>
            <input
              className="w-full border rounded px-3 py-2 text-sm mt-1"
              value={channelsText}
              onChange={(e) => setChannelsText(e.target.value)}
              onBlur={validateAll}
              placeholder="#alerts-prod, #on-call"
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {channels.map(ch => <ChannelValidationBadge key={ch} channel={ch} state={channelValidation[ch]} />)}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Mention (optional)</label>
            <div className="flex gap-2 mt-1">
              <div className="flex gap-1">
                <Button type="button" size="sm" variant="outline" onClick={() => setMention('@here')}>@here</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setMention('@channel')}>@channel</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setMention('')}>None</Button>
              </div>
              <input
                className="flex-1 border rounded px-3 py-2 text-sm"
                value={mention}
                onChange={(e) => setMention(e.target.value)}
                placeholder="@here, <@U12345>, or <!subteam^S12345>"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Severity</label>
            <select
              className="w-full border rounded px-3 py-2 text-sm mt-1"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as AlertSeverity)}
            >
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </div>

          <FilterEditor trigger={selectedTrigger} value={filter} onChange={setFilter} />

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="rule-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor="rule-enabled" className="text-sm">Enabled</label>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={save} disabled={saving || !allChannelsOk || !name.trim()}>
            {saving ? 'Saving...' : (initial ? 'Save' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChannelValidationBadge({ channel, state }: {
  channel: string
  state: ChannelValidationResult | 'pending' | null | undefined
}) {
  if (!state) return <Badge variant="outline" className="text-muted-foreground">{channel} · not checked</Badge>
  if (state === 'pending') return <Badge variant="outline">{channel} · checking...</Badge>
  if (state.ok) return <Badge className="bg-green-100 text-green-800 border-green-300 border">{channel} ✓</Badge>
  return (
    <Badge className="bg-red-100 text-red-800 border-red-300 border" title={state.error}>
      {channel} ✗ {state.code || state.error}
    </Badge>
  )
}

// ══════════════════════════════════════════════════════════════
// FilterEditor — renders fields based on the trigger's schema
// ══════════════════════════════════════════════════════════════

function FilterEditor({ trigger, value, onChange }: {
  trigger?: AlertTrigger
  value: AlertRule['filter']
  onChange: (patch: AlertRule['filter']) => void
}) {
  // Source real customer/env data from the WS-synced store so we never
  // rely on the user to remember IDs. Envs narrow to selected customers
  // when a customer filter is active.
  const customers = useWsStore(s => s.customers)
  const environments = useWsStore(s => s.environments)

  if (!trigger) return null
  const patch = (key: keyof AlertRule['filter'], val: unknown) =>
    onChange({ ...value, [key]: val })

  const customerOptions: SelectOption[] = [...customers]
    .filter(c => !c.hidden)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id.localeCompare(b.id))
    .map(c => ({ value: c.id, label: c.shortName || c.name || c.id }))

  const selectedCustomerIds = value.customerIds || []
  const envOptions: SelectOption[] = environments
    .filter(e => selectedCustomerIds.length === 0 || selectedCustomerIds.includes(e.customerId))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(e => ({
      value: e.id,
      label: e.id,
      subLabel: `${customerLabel(customers, e.customerId)} · ${e.tier}`,
    }))

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="text-xs font-medium text-muted-foreground">Filters</div>
      {trigger.filterFields.map(f => {
        if (f.key === 'customerIds') {
          return (
            <MultiSelectDropdown
              key={f.key}
              label={f.label}
              description={f.description}
              options={customerOptions}
              value={value.customerIds || []}
              onChange={(v) => {
                // When customers change, drop any envs that no longer belong
                const newEnvs = (value.envIds || []).filter(eid => {
                  const env = environments.find(e => e.id === eid)
                  return env && (v.length === 0 || v.includes(env.customerId))
                })
                onChange({
                  ...value,
                  customerIds: v.length ? v : undefined,
                  envIds: newEnvs.length ? newEnvs : undefined,
                })
              }}
              emptyLabel="Any customer"
            />
          )
        }
        if (f.key === 'envIds') {
          return (
            <MultiSelectDropdown
              key={f.key}
              label={f.label}
              description={
                selectedCustomerIds.length > 0
                  ? `${f.description || ''} (narrowed to selected customers)`.trim()
                  : f.description
              }
              options={envOptions}
              value={value.envIds || []}
              onChange={(v) => patch('envIds', v.length ? v : undefined)}
              emptyLabel={selectedCustomerIds.length > 0 ? 'Any env in selected customers' : 'Any environment'}
            />
          )
        }
        if (f.key === 'envTier') {
          return (
            <ChipMultiSelect
              key={f.key}
              label={f.label}
              description={f.description}
              options={(f.options || []).map(o => ({ value: o, label: o }))}
              value={value.envTier || []}
              onChange={(v) => patch('envTier', v.length ? v : undefined)}
            />
          )
        }
        if (f.key === 'components') {
          return (
            <ChipMultiSelect
              key={f.key}
              label={f.label}
              description={f.description}
              options={(f.options || []).map(o => ({ value: o, label: o }))}
              value={value.components || []}
              onChange={(v) => patch('components', v.length ? v : undefined)}
            />
          )
        }
        if (f.key === 'sustainedMinutes') {
          return (
            <div key={f.key}>
              <label className="text-xs font-medium text-muted-foreground">{f.label}</label>
              <input
                type="number"
                min={f.min}
                max={f.max}
                className="w-full border rounded px-3 py-2 text-sm mt-1"
                value={value.sustainedMinutes ?? f.default ?? 15}
                onChange={(e) => patch('sustainedMinutes', Number(e.target.value) || undefined)}
              />
              {f.description && <p className="text-xs text-muted-foreground mt-1">{f.description}</p>}
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function customerLabel(customers: Customer[], id: string): string {
  const c = customers.find(x => x.id === id)
  return c?.shortName || c?.name || id
}

// ══════════════════════════════════════════════════════════════
// Multi-select primitives
// ══════════════════════════════════════════════════════════════

interface SelectOption {
  value: string
  label: string
  subLabel?: string
}

/**
 * Chip-style multi-select — good for small, fixed option sets
 * (envTier, components). Users toggle chips; no search needed.
 */
function ChipMultiSelect({ label, description, options, value, onChange }: {
  label: string
  description?: string
  options: SelectOption[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="flex flex-wrap gap-1 mt-1">
        {options.map(opt => {
          const checked = value.includes(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(checked ? value.filter(v => v !== opt.value) : [...value, opt.value])}
              className={
                'text-xs px-2 py-1 rounded border ' +
                (checked
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground hover:bg-accent')
              }
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
    </div>
  )
}

/**
 * Dropdown-style multi-select with search and checkbox rows — for
 * longer option lists (customers, environments). Opens a popover.
 */
function MultiSelectDropdown({ label, description, options, value, onChange, emptyLabel }: {
  label: string
  description?: string
  options: SelectOption[]
  value: string[]
  onChange: (v: string[]) => void
  emptyLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      o.label.toLowerCase().includes(q) ||
      o.value.toLowerCase().includes(q) ||
      (o.subLabel || '').toLowerCase().includes(q)
    )
  }, [options, search])

  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
  }

  const selectAll = () => onChange(filtered.map(o => o.value))
  const clear = () => onChange([])

  return (
    <div className="relative" ref={ref}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full border rounded px-3 py-2 text-sm mt-1 text-left bg-background hover:bg-accent/30 flex items-center gap-2 min-h-[38px]"
      >
        {value.length === 0 ? (
          <span className="text-muted-foreground italic">{emptyLabel || 'Any'}</span>
        ) : (
          <div className="flex flex-wrap gap-1 flex-1">
            {value.map(v => {
              const opt = options.find(o => o.value === v)
              return (
                <span
                  key={v}
                  className="bg-primary/10 text-primary text-xs px-1.5 py-0.5 rounded flex items-center gap-1"
                >
                  {opt?.label || v}
                  <span
                    onClick={(e) => { e.stopPropagation(); toggle(v) }}
                    className="hover:text-red-600 cursor-pointer"
                    role="button"
                    aria-label={`Remove ${opt?.label || v}`}
                  >
                    ×
                  </span>
                </span>
              )
            })}
          </div>
        )}
        <span className="ml-auto text-muted-foreground text-xs">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        // z-[70] sits above the Dialog content (z-50). bg-card is a
        // guaranteed-opaque surface from the Tailwind theme — don't use
        // bg-popover, it resolves to a transparent var in this theme.
        <div className="absolute z-[70] mt-1 w-full border border-border rounded-md bg-card text-card-foreground shadow-xl max-h-64 flex flex-col">
          <div className="p-2 border-b bg-card flex gap-2 items-center">
            <input
              className="flex-1 text-sm border rounded px-2 py-1 bg-background"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            {filtered.length > 0 && (
              <button type="button" onClick={selectAll} className="text-xs text-primary hover:underline whitespace-nowrap">
                All ({filtered.length})
              </button>
            )}
            {value.length > 0 && (
              <button type="button" onClick={clear} className="text-xs text-muted-foreground hover:text-foreground">
                Clear
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto bg-card">
            {filtered.length === 0 && (
              <div className="p-4 text-xs text-muted-foreground italic text-center">
                {options.length === 0 ? 'No options available' : 'No matches'}
              </div>
            )}
            {filtered.map(opt => {
              const checked = value.includes(opt.value)
              return (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt.value)}
                  />
                  <span className="flex-1">{opt.label}</span>
                  {opt.subLabel && (
                    <span className="text-xs text-muted-foreground">{opt.subLabel}</span>
                  )}
                </label>
              )
            })}
          </div>
        </div>
      )}
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
    </div>
  )
}
