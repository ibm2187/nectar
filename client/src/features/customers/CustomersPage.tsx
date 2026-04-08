import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWsStore } from '../../stores/wsStore'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { apiFetch } from '../../api/client'
import type { Customer, Environment, EnvTier } from '../../api/client'
import { cn, timeAgo } from '../../lib/utils'
import { SetVersionDialog } from './SetVersionDialog'

// Tier ordering for display (production first, then staging, etc.)
const TIER_ORDER: EnvTier[] = [
  'production',
  'staging',
  'uat',
  'qa',
  'integration',
  'sandbox',
  'test',
  'training',
  'demo',
  'loadtest',
  'dev',
  'other',
]

const TIER_COLORS: Record<string, string> = {
  production: 'bg-green-500/15 text-green-400 border-green-500/30',
  staging: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  uat: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  qa: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  integration: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  sandbox: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  training: 'bg-muted text-muted-foreground border-border',
  demo: 'bg-muted text-muted-foreground border-border',
  loadtest: 'bg-muted text-muted-foreground border-border',
  test: 'bg-muted text-muted-foreground border-border',
  dev: 'bg-muted text-muted-foreground border-border',
  other: 'bg-muted text-muted-foreground border-border',
}

export function CustomersPage() {
  const customers = useWsStore(s => s.customers)
  const environments = useWsStore(s => s.environments)
  const [search, setSearch] = useState('')
  const [showInternalEnvs, setShowInternalEnvs] = useState(false)
  const [expandedFranchises, setExpandedFranchises] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)

  // Dialog state for manual version setting
  const [editingEnv, setEditingEnv] = useState<Environment | null>(null)
  const [bulkEnvs, setBulkEnvs] = useState<Environment[] | null>(null)
  const [bulkTitle, setBulkTitle] = useState('')

  const navigate = useNavigate()

  // Group environments by customer
  const envsByCustomer = useMemo(() => {
    const map = new Map<string, Environment[]>()
    for (const env of environments) {
      if (!map.has(env.customerId)) map.set(env.customerId, [])
      map.get(env.customerId)!.push(env)
    }
    // Sort envs within each customer: non-franchise first, then by tier order, then by name
    for (const [, envs] of map) {
      envs.sort((a, b) => {
        if (!!a.franchise !== !!b.franchise) return a.franchise ? 1 : -1
        const tierA = TIER_ORDER.indexOf(a.tier) >= 0 ? TIER_ORDER.indexOf(a.tier) : 99
        const tierB = TIER_ORDER.indexOf(b.tier) >= 0 ? TIER_ORDER.indexOf(b.tier) : 99
        if (tierA !== tierB) return tierA - tierB
        return a.id.localeCompare(b.id)
      })
    }
    return map
  }, [environments])

  const filteredCustomers = useMemo(() => {
    let list = customers
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(c =>
        c.id.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        (envsByCustomer.get(c.id) || []).some(e =>
          e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)
        )
      )
    }
    return list
  }, [customers, search, envsByCustomer])

  async function handleScan() {
    setScanning(true)
    try {
      await apiFetch('/webplatform/scan', { method: 'POST' })
    } catch { /* ws updates handle it */ }
    setScanning(false)
  }

  function toggleFranchises(customerId: string) {
    setExpandedFranchises(prev => {
      const next = new Set(prev)
      if (next.has(customerId)) next.delete(customerId)
      else next.add(customerId)
      return next
    })
  }

  const totalEnvs = environments.length
  const activeEnvs = environments.filter(e => e.currentVersion).length

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Customer Environments</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {customers.length} customers · {totalEnvs} environments · {activeEnvs} with known version
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Sync from webplatform'}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <Input
          placeholder="Search customers, environments..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground ml-auto cursor-pointer">
          <input
            type="checkbox"
            checked={showInternalEnvs}
            onChange={e => setShowInternalEnvs(e.target.checked)}
          />
          Show internal/dev envs
        </label>
      </div>

      {filteredCustomers.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm italic">
            No customers match your filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredCustomers.map(customer => {
            const allEnvs = envsByCustomer.get(customer.id) || []
            const mainEnvs = allEnvs.filter(e => !e.franchise)
            const franchiseEnvs = allEnvs.filter(e => !!e.franchise)

            // Hide customer if it's viv and not showing internal
            if (!showInternalEnvs && customer.id === 'viv') return null

            return (
              <CustomerCard
                key={customer.id}
                customer={customer}
                mainEnvs={mainEnvs}
                franchiseEnvs={franchiseEnvs}
                expanded={expandedFranchises.has(customer.id)}
                onToggleFranchises={() => toggleFranchises(customer.id)}
                onEnvDrilldown={(env) => {
                  navigate(`/environments/${encodeURIComponent(env.id)}`)
                }}
                onEnvEdit={(env) => setEditingEnv(env)}
                onBulkSetFranchises={() => {
                  setBulkEnvs(franchiseEnvs)
                  setBulkTitle(`Set version for all ${franchiseEnvs.length} ${customer.name} franchises`)
                }}
                onBulkSetMain={() => {
                  setBulkEnvs(mainEnvs)
                  setBulkTitle(`Set version for all ${mainEnvs.length} ${customer.name} environments`)
                }}
              />
            )
          })}
        </div>
      )}

      {/* Single env version dialog */}
      <SetVersionDialog
        open={!!editingEnv}
        onOpenChange={(open) => { if (!open) setEditingEnv(null) }}
        environment={editingEnv}
      />

      {/* Bulk env version dialog */}
      <SetVersionDialog
        open={!!bulkEnvs}
        onOpenChange={(open) => { if (!open) { setBulkEnvs(null); setBulkTitle('') } }}
        environments={bulkEnvs || undefined}
        title={bulkTitle}
      />
    </div>
  )
}

// ── Customer card component ────────────────────────────────

interface CustomerCardProps {
  customer: Customer
  mainEnvs: Environment[]
  franchiseEnvs: Environment[]
  expanded: boolean
  onToggleFranchises: () => void
  onEnvDrilldown: (env: Environment) => void
  onEnvEdit: (env: Environment) => void
  onBulkSetFranchises: () => void
  onBulkSetMain: () => void
}

function CustomerCard({
  customer, mainEnvs, franchiseEnvs, expanded,
  onToggleFranchises, onEnvDrilldown, onEnvEdit, onBulkSetFranchises, onBulkSetMain,
}: CustomerCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <span>{customer.name}</span>
            <span className="text-xs font-normal text-muted-foreground font-mono">{customer.id}</span>
            {customer.integrations.map(i => (
              <Badge key={i} variant="secondary" className="text-xs">{i}</Badge>
            ))}
            {customer.hasFranchises && (
              <Badge variant="secondary" className="text-xs">
                {franchiseEnvs.length} franchises
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {mainEnvs.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={onBulkSetMain}
                className="text-xs h-7"
                title={`Set version for all ${mainEnvs.length} ${customer.name} environments`}
              >
                Set all versions
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {customer.domain}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Main environments */}
        {mainEnvs.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No environments configured</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {mainEnvs.map(env => (
              <EnvTile
                key={env.id}
                env={env}
                onDrilldown={() => onEnvDrilldown(env)}
                onEdit={() => onEnvEdit(env)}
              />
            ))}
          </div>
        )}

        {/* Franchises (collapsible) */}
        {franchiseEnvs.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex items-center justify-between mb-1">
              <button
                type="button"
                onClick={onToggleFranchises}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {expanded ? '▼' : '▶'} {franchiseEnvs.length} franchise environments
              </button>
              <Button
                variant="outline"
                size="sm"
                onClick={onBulkSetFranchises}
                className="text-xs h-7"
                title={`Set version for all ${franchiseEnvs.length} franchises at once`}
              >
                Set all franchise versions
              </Button>
            </div>
            {expanded && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 mt-3">
                {franchiseEnvs.map(env => (
                  <EnvTile
                    key={env.id}
                    env={env}
                    onDrilldown={() => onEnvDrilldown(env)}
                    onEdit={() => onEnvEdit(env)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Environment tile ────────────────────────────────────────

function EnvTile({
  env, onDrilldown, onEdit,
}: {
  env: Environment
  onDrilldown: () => void
  onEdit: () => void
}) {
  const tierColor = TIER_COLORS[env.tier] || TIER_COLORS.other

  return (
    <div className="group relative rounded-lg border p-3 transition-all hover:border-primary/50 hover:bg-accent/30">
      {/* Main clickable body — drill into env detail */}
      <button
        type="button"
        onClick={onDrilldown}
        className="text-left w-full cursor-pointer"
      >
        <div className="flex items-center gap-2 mb-1">
          <Badge className={cn("text-xs", tierColor)} variant="outline">
            {env.tier}
          </Badge>
          {env.franchise && (
            <span className="text-xs text-muted-foreground font-mono">{env.franchise}</span>
          )}
        </div>
        <div className="font-mono text-sm font-semibold truncate pr-8" title={env.id}>
          {env.id}
        </div>
        <div className="text-xs text-muted-foreground mt-1 pr-8">
          {env.currentVersion ? (
            <>
              <span className="text-foreground font-mono">{env.currentVersion}</span>
              {env.versionSetManually && (
                <span className="ml-1 text-yellow-400" title={`Manually set${env.versionSetBy ? ' by ' + env.versionSetBy : ''}`}>
                  ✎
                </span>
              )}
            </>
          ) : (
            <span className="italic">version unknown</span>
          )}
          {env.lastChecked && !env.versionSetManually && (
            <span className="ml-1">· {timeAgo(env.lastChecked)}</span>
          )}
          {env.versionSetAt && env.versionSetManually && (
            <span className="ml-1">· {timeAgo(env.versionSetAt)}</span>
          )}
          {env.reachable === false && !env.versionSetManually && (
            <span className="ml-1 text-red-400">· unreachable</span>
          )}
        </div>
      </button>

      {/* Edit icon button — always available */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEdit() }}
        className="absolute top-2 right-2 p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-accent transition-opacity"
        title="Set version manually"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
    </div>
  )
}
