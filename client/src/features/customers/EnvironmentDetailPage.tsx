import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useWsStore } from '../../stores/wsStore'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import type { Environment, EnvUpgradeItem } from '../../api/client'
import { apiFetch } from '../../api/client'
import { cn, timeAgo } from '../../lib/utils'
import { SetVersionDialog } from './SetVersionDialog'
import { UpgradeDetailDialog } from './UpgradeDetailDialog'

type Tab = 'overview' | 'features' | 'integrations' | 'upgrades'

export function EnvironmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const environments = useWsStore(s => s.environments)
  const customers = useWsStore(s => s.customers)
  const env = environments.find(e => e.id === id)
  const customer = env ? customers.find(c => c.id === env.customerId) : null

  const [tab, setTab] = useState<Tab>('overview')
  const [editingVersion, setEditingVersion] = useState(false)
  const [polling, setPolling] = useState(false)
  const [selectedUpgrade, setSelectedUpgrade] = useState<EnvUpgradeItem | null>(null)

  if (!env) {
    return (
      <div className="w-full">
        <Button variant="link" onClick={() => navigate('/customers')} className="mb-4 px-0">
          ← Back to customers
        </Button>
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground italic">
            Environment not found
          </CardContent>
        </Card>
      </div>
    )
  }

  async function handlePoll() {
    setPolling(true)
    try {
      await apiFetch('/environments/poll', { method: 'POST' })
    } catch { /* ws updates handle it */ }
    setPolling(false)
  }

  const tabs: { key: Tab; label: string; badge?: number | string; badgeVariant?: 'default' | 'destructive' | 'warning' }[] = [
    { key: 'overview', label: 'Overview' },
    {
      key: 'features',
      label: 'Features',
      badge: env.features ? Object.keys(env.features.portalFeatureFlag || {}).length + Object.keys(env.features.mobileFeatureFlag || {}).length : undefined,
    },
    {
      key: 'integrations',
      label: 'Integrations',
      badge: env.integrations
        ? [env.integrations.ascend?.enabled, env.integrations.bayadaHub?.enabled, env.integrations.hah?.enabled, env.integrations.sqsOutbound?.enabled, env.integrations.sqsInbound?.enabled].filter(Boolean).length
        : undefined,
    },
    {
      key: 'upgrades',
      label: 'Upgrades',
      badge: env.upgrades ? `${env.upgrades.summary.pending}/${env.upgrades.summary.totalInPool}` : undefined,
      badgeVariant: env.upgrades && env.upgrades.summary.failedVerification > 0 ? 'destructive'
        : env.upgrades && env.upgrades.summary.pending > 0 ? 'warning' : 'default',
    },
  ]

  return (
    <div className="w-full">
      <Button variant="link" onClick={() => navigate('/customers')} className="mb-2 px-0 text-sm">
        ← Back to customers
      </Button>

      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            {customer && (
              <Badge variant="secondary" className="text-xs">{customer.name}</Badge>
            )}
            <Badge variant="outline" className="text-xs">{env.tier}</Badge>
            {env.franchise && (
              <Badge variant="secondary" className="text-xs">Franchise {env.franchise}</Badge>
            )}
          </div>
          <h2 className="text-2xl font-bold font-mono">{env.id}</h2>
          {env.url && (
            <a href={env.url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
              {env.url}
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handlePoll} disabled={polling}>
            {polling ? 'Polling...' : 'Poll now'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditingVersion(true)}>
            Set version
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {t.badge !== undefined && (
              <Badge
                variant={t.badgeVariant === 'destructive' ? 'destructive' : t.badgeVariant === 'warning' ? 'warning' : 'secondary'}
                className="text-xs"
              >
                {t.badge}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab env={env} />}
      {tab === 'features' && <FeaturesTab env={env} />}
      {tab === 'integrations' && <IntegrationsTab env={env} />}
      {tab === 'upgrades' && <UpgradesTab env={env} onSelectUpgrade={setSelectedUpgrade} />}

      {/* Dialogs */}
      <SetVersionDialog
        open={editingVersion}
        onOpenChange={setEditingVersion}
        environment={env}
      />
      <UpgradeDetailDialog
        open={!!selectedUpgrade}
        onOpenChange={(open) => { if (!open) setSelectedUpgrade(null) }}
        upgrade={selectedUpgrade}
      />
    </div>
  )
}

// ── Overview tab ────────────────────────────────────────────

function OverviewTab({ env }: { env: Environment }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Deployment</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Field label="Node env" value={env.nodeEnv} mono />
          <Field label="Version" value={env.currentVersion} mono />
          <Field label="Branch" value={env.currentBranch} mono />
          <Field label="URL" value={env.url} mono />
          <Field label="Last checked" value={env.lastChecked ? timeAgo(env.lastChecked) : '—'} />
          <Field label="Reachable" value={env.reachable === null ? '—' : env.reachable ? 'Yes' : 'No'} />
          {env.versionSetManually && (
            <div className="text-xs text-yellow-400 border-l-2 border-yellow-400 pl-2 mt-2">
              ✎ Version set manually {env.versionSetBy ? `by ${env.versionSetBy}` : ''}
              {env.versionSetAt && ` · ${timeAgo(env.versionSetAt)}`}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Status Checks</CardTitle></CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          <StatusRow label="/api/status/version" lastChecked={env.lastChecked} ok={env.reachable} />
          <StatusRow label="/api/status/features" lastChecked={env.lastFeaturesCheckedAt} ok={!!env.features} />
          <StatusRow label="/api/status/integrations" lastChecked={env.lastIntegrationsCheckedAt} ok={!!env.integrations} />
          <StatusRow label="/api/status/upgrades" lastChecked={env.lastUpgradesCheckedAt} ok={!!env.upgrades} />
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-right break-all", mono && "font-mono text-xs")}>
        {value || <span className="text-muted-foreground italic">—</span>}
      </span>
    </div>
  )
}

function StatusRow({ label, lastChecked, ok }: { label: string; lastChecked: string | null | undefined; ok: boolean | null | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="font-mono">{label}</span>
      <div className="flex items-center gap-2">
        <span className={cn(
          "w-2 h-2 rounded-full",
          ok === true ? "bg-green-400" : ok === false ? "bg-red-400" : "bg-muted"
        )} />
        <span className="text-muted-foreground">{lastChecked ? timeAgo(lastChecked) : 'never'}</span>
      </div>
    </div>
  )
}

// ── Features tab ────────────────────────────────────────────

function FeaturesTab({ env }: { env: Environment }) {
  if (!env.features) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground italic">
          No feature data. The /api/status/features endpoint is not yet responding for this environment.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <FlagCard title="Portal Feature Flags" flags={env.features.portalFeatureFlag} />
      <FlagCard title="Mobile Feature Flags" flags={env.features.mobileFeatureFlag} />
      <FlagCard title="Workflow" flags={env.features.workflow} />
    </div>
  )
}

function FlagCard({ title, flags }: { title: string; flags: Record<string, unknown> }) {
  const entries = Object.entries(flags || {})
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title} <span className="text-xs font-normal text-muted-foreground ml-1">({entries.length})</span></CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No flags</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {entries.map(([key, value]) => (
              <FlagRow key={key} name={key} value={value} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FlagRow({ name, value }: { name: string; value: unknown }) {
  // Value can be a nested object (e.g. {key, disableView, disableEdit}) or a primitive
  const isObject = value && typeof value === 'object'
  const flagObj = isObject ? value as Record<string, unknown> : null

  // Determine visual state
  let state: 'enabled' | 'view-only' | 'disabled' | 'unknown' = 'unknown'
  if (flagObj) {
    const disableView = flagObj.disableView
    const disableEdit = flagObj.disableEdit
    if (disableView === true) state = 'disabled'
    else if (disableEdit === true) state = 'view-only'
    else state = 'enabled'
  } else if (value === true) state = 'enabled'
  else if (value === false) state = 'disabled'

  const color = {
    enabled: 'bg-green-500/15 text-green-400 border-green-500/30',
    'view-only': 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    disabled: 'bg-red-500/15 text-red-400 border-red-500/30',
    unknown: 'bg-muted text-muted-foreground border-border',
  }[state]

  return (
    <div className="flex items-start justify-between gap-2 border rounded-md p-2 text-sm">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs truncate" title={name}>{name}</div>
        {flagObj && flagObj.key !== undefined && (
          <div className="text-xs text-muted-foreground truncate">{String(flagObj.key)}</div>
        )}
      </div>
      <Badge variant="outline" className={cn("text-xs shrink-0", color)}>
        {state === 'view-only' ? 'read-only' : state}
      </Badge>
    </div>
  )
}

// ── Integrations tab ────────────────────────────────────────

function IntegrationsTab({ env }: { env: Environment }) {
  if (!env.integrations) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground italic">
          No integrations data. The /api/status/integrations endpoint is not yet responding.
        </CardContent>
      </Card>
    )
  }

  const i = env.integrations
  const items = [
    { key: 'ascend', label: 'Ascend (Blue Summit)', enabled: i.ascend?.enabled, details: i.ascend },
    { key: 'bayadaHub', label: 'Bayada Hub', enabled: i.bayadaHub?.enabled },
    { key: 'hah', label: 'Help at Home', enabled: i.hah?.enabled },
    { key: 'sqsOutbound', label: 'SQS Outbound', enabled: i.sqsOutbound?.enabled },
    { key: 'sqsInbound', label: 'SQS Inbound', enabled: i.sqsInbound?.enabled },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Partner Integrations</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {items.map(item => (
              <div
                key={item.key}
                className={cn(
                  "border rounded-md p-3 flex items-center justify-between",
                  item.enabled ? "bg-green-500/5 border-green-500/30" : "bg-muted border-border"
                )}
              >
                <div>
                  <div className="text-sm font-medium">{item.label}</div>
                  {item.details && 'syncAllData' in item.details && item.details.syncAllData && (
                    <div className="text-xs text-muted-foreground">syncAllData: true</div>
                  )}
                </div>
                <Badge variant={item.enabled ? 'success' : 'secondary'} className="text-xs">
                  {item.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Data Publishing</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-4 text-sm">
            {Object.entries(i.dataPublishing || {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <span className={cn("w-2 h-2 rounded-full", v ? "bg-green-400" : "bg-muted")} />
                <span>{k}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 ml-auto">
              <span className={cn("w-2 h-2 rounded-full", i.disableOutgoingCommunication ? "bg-red-400" : "bg-green-400")} />
              <span className="text-muted-foreground">
                Outgoing communication: {i.disableOutgoingCommunication ? 'disabled' : 'enabled'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">SQS Queues</CardTitle></CardHeader>
        <CardContent>
          {Object.keys(i.sqsQueues || {}).length === 0 ? (
            <p className="text-sm text-muted-foreground italic">None configured</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(i.sqsQueues).map(([provider, directions]) => (
                <div key={provider}>
                  <div className="text-sm font-semibold mb-1">{provider}</div>
                  {Object.entries(directions || {}).map(([direction, queues]) => (
                    <div key={direction} className="ml-4 text-xs">
                      <span className="text-muted-foreground">{direction}: </span>
                      <span className="font-mono">{(queues as string[]).join(', ')}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Upgrades tab ────────────────────────────────────────────

function UpgradesTab({ env, onSelectUpgrade }: { env: Environment; onSelectUpgrade: (u: EnvUpgradeItem) => void }) {
  const [search, setSearch] = useState('')

  if (!env.upgrades) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground italic">
          No upgrades data. The /api/status/upgrades endpoint is not yet responding.
        </CardContent>
      </Card>
    )
  }

  const u = env.upgrades
  const s = u.summary

  const filterFn = (list: EnvUpgradeItem[]) => {
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(item => item.upgradeName.toLowerCase().includes(q))
  }

  return (
    <div className="space-y-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <SummaryTile label="Total" value={s.totalInPool} />
        <SummaryTile label="Applied" value={s.applied} color="green" />
        <SummaryTile label="Pending" value={s.pending} color={s.pending > 0 ? 'yellow' : undefined} />
        <SummaryTile label="In Progress" value={s.inProgress} color={s.inProgress > 0 ? 'blue' : undefined} />
        <SummaryTile label="Failed Verify" value={s.failedVerification} color={s.failedVerification > 0 ? 'red' : undefined} />
        <SummaryTile label="Skipped" value={s.skipped} />
      </div>

      {/* Latest */}
      {u.latest && (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Latest Applied</CardTitle></CardHeader>
          <CardContent>
            <div className="text-sm font-mono">{u.latest.upgradeName}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {u.latest.completedAt && `Completed ${timeAgo(u.latest.completedAt)}`}
              {u.latest.verificationStatus && ` · Verification: ${u.latest.verificationStatus}`}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <Input
        placeholder="Search upgrades..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {/* Failed verification (most actionable) */}
      {u.failedVerification.length > 0 && (
        <UpgradeList
          title="Failed Verification"
          items={filterFn(u.failedVerification)}
          severity="error"
          onSelect={onSelectUpgrade}
        />
      )}

      {/* In progress */}
      {u.inProgress.length > 0 && (
        <UpgradeList
          title="In Progress"
          items={filterFn(u.inProgress)}
          severity="warning"
          onSelect={onSelectUpgrade}
        />
      )}

      {/* Pending */}
      {u.pending.length > 0 && (
        <UpgradeList
          title={`Pending (${u.pending.length}${s.pending > u.pending.length ? ' of ' + s.pending + ' — capped' : ''})`}
          items={filterFn(u.pending)}
          severity="warning"
          onSelect={onSelectUpgrade}
        />
      )}

      {/* Skipped */}
      {u.skipped.length > 0 && (
        <UpgradeList
          title="Skipped"
          items={filterFn(u.skipped)}
          severity="muted"
          onSelect={onSelectUpgrade}
        />
      )}
    </div>
  )
}

function SummaryTile({ label, value, color }: { label: string; value: number; color?: 'green' | 'yellow' | 'red' | 'blue' }) {
  const colorMap: Record<string, string> = {
    green: 'bg-green-500/15 text-green-400',
    yellow: 'bg-yellow-500/15 text-yellow-400',
    red: 'bg-red-500/15 text-red-400',
    blue: 'bg-blue-500/15 text-blue-400',
  }
  const colorClass = (color && colorMap[color]) || 'bg-muted text-muted-foreground'
  return (
    <div className={cn("rounded-lg border p-3 text-center", colorClass)}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs uppercase tracking-wider opacity-80">{label}</div>
    </div>
  )
}

function UpgradeList({
  title, items, severity, onSelect,
}: {
  title: string
  items: EnvUpgradeItem[]
  severity: 'error' | 'warning' | 'muted'
  onSelect: (u: EnvUpgradeItem) => void
}) {
  const color = severity === 'error' ? 'text-red-400' : severity === 'warning' ? 'text-yellow-400' : 'text-muted-foreground'
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className={cn("text-base", color)}>{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-1 max-h-96 overflow-auto">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No matching upgrades</p>
          ) : (
            items.map(item => (
              <button
                key={item.upgradeName}
                type="button"
                onClick={() => onSelect(item)}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-accent/30 border-b border-border/30 last:border-0"
              >
                <div className="font-mono text-xs truncate" title={item.upgradeName}>
                  {item.upgradeName}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                  {item.desiredEnvs && item.desiredEnvs.length > 0 && (
                    <span>envs: {item.desiredEnvs.join(', ')}</span>
                  )}
                  {item.nonBlocking && <span>· non-blocking</span>}
                  {item.hasVerify && <span>· has verify</span>}
                  {item.completedAt && <span>· completed {timeAgo(item.completedAt)}</span>}
                  {item.verificationStatus && <span className={item.verificationStatus === 'FAILED' ? 'text-red-400' : 'text-green-400'}>· {item.verificationStatus}</span>}
                  {item.verificationError && <span className="text-red-400">· {item.verificationError}</span>}
                  {item.skippedReason && <span>· {item.skippedReason}</span>}
                </div>
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
