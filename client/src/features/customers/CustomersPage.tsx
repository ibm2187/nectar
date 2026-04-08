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
                onEnvClick={(env) => {
                  // Drill into release detail for the env's running version (if known)
                  if (env.currentVersion) {
                    navigate(`/releases/webplatform:${encodeURIComponent(env.currentVersion)}`)
                  }
                }}
              />
            )
          })}
        </div>
      )}
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
  onEnvClick: (env: Environment) => void
}

function CustomerCard({ customer, mainEnvs, franchiseEnvs, expanded, onToggleFranchises, onEnvClick }: CustomerCardProps) {
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
          <span className="text-xs text-muted-foreground">
            {customer.domain}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {/* Main environments */}
        {mainEnvs.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No environments configured</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {mainEnvs.map(env => (
              <EnvTile key={env.id} env={env} onClick={() => onEnvClick(env)} />
            ))}
          </div>
        )}

        {/* Franchises (collapsible) */}
        {franchiseEnvs.length > 0 && (
          <div className="mt-4 pt-4 border-t">
            <button
              type="button"
              onClick={onToggleFranchises}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {expanded ? '▼' : '▶'} {franchiseEnvs.length} franchise environments
            </button>
            {expanded && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 mt-3">
                {franchiseEnvs.map(env => (
                  <EnvTile key={env.id} env={env} onClick={() => onEnvClick(env)} />
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

function EnvTile({ env, onClick }: { env: Environment; onClick: () => void }) {
  const tierColor = TIER_COLORS[env.tier] || TIER_COLORS.other
  const clickable = !!env.currentVersion

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className={cn(
        "text-left rounded-lg border p-3 transition-all",
        clickable ? "cursor-pointer hover:border-primary/50 hover:bg-accent/30" : "cursor-default"
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Badge className={cn("text-xs", tierColor)} variant="outline">
          {env.tier}
        </Badge>
        {env.franchise && (
          <span className="text-xs text-muted-foreground font-mono">{env.franchise}</span>
        )}
      </div>
      <div className="font-mono text-sm font-semibold truncate" title={env.id}>
        {env.id}
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {env.currentVersion ? (
          <span className="text-foreground font-mono">{env.currentVersion}</span>
        ) : (
          <span className="italic">version unknown</span>
        )}
        {env.lastChecked && (
          <span className="ml-1">· {timeAgo(env.lastChecked)}</span>
        )}
        {env.reachable === false && (
          <span className="ml-1 text-red-400">· unreachable</span>
        )}
      </div>
    </button>
  )
}
