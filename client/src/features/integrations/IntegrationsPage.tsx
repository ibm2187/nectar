import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { EnvDetailPanel, type EnvDetailItem } from '../../components/EnvDetailPanel'
import { useWsStore } from '../../stores/wsStore'
import { cn } from '../../lib/utils'

type Bucket = 'everywhere-on' | 'mixed' | 'everywhere-off' | 'dev-only'
type CustomerState = 'on' | 'off' | 'partial' | 'unknown'

interface IntegrationOutlier {
  envId: string
  customerId: string
  enabled: boolean
  configured: boolean
}

interface IntegrationEnvDetail {
  envId: string
  envName: string
  tier: string
  franchise: string | null
  franchiseDisplayName: string | null
  enabled: boolean | null
  configured: boolean | null
}

interface AggregatedIntegration {
  type: string
  bucket: Bucket
  customerStates: Record<string, CustomerState>
  customerConfigured: Record<string, boolean>
  customerEnvs: Record<string, IntegrationEnvDetail[]>
  outliers: IntegrationOutlier[]
  enabledInAnyNonProd: boolean
}

interface AggregatedResponse {
  integrations: AggregatedIntegration[]
  customers: string[]
  stats: {
    totalIntegrations: number
    totalProdEnvs: number
    totalCustomers: number
    totalEnvsWithData: number
    buckets: Record<Bucket, number>
  }
}

const BUCKET_META: Record<Bucket, { label: string; subtitle: string; accent: string; color: string }> = {
  'everywhere-on': {
    label: 'Everywhere On',
    subtitle: 'Enabled for every customer in production',
    accent: 'border-l-green-500',
    color: 'text-green-400',
  },
  'mixed': {
    label: 'Mixed Rollout',
    subtitle: 'Customer-specific — enabled for some, not others',
    accent: 'border-l-yellow-500',
    color: 'text-yellow-400',
  },
  'everywhere-off': {
    label: 'Everywhere Off',
    subtitle: 'Not enabled anywhere — unused integration',
    accent: 'border-l-red-500',
    color: 'text-red-400',
  },
  'dev-only': {
    label: 'Dev / Staging Only',
    subtitle: 'Still being tested — not rolled out to production',
    accent: 'border-l-blue-500',
    color: 'text-blue-400',
  },
}

const BUCKET_ORDER: Bucket[] = ['everywhere-on', 'mixed', 'everywhere-off', 'dev-only']

// Friendlier display names for known integration types
const TYPE_LABELS: Record<string, string> = {
  quickBooks: 'QuickBooks',
  rcmV2quickBooks: 'QuickBooks (RCM v2)',
  rcmV2quickBooksDesktop: 'QuickBooks Desktop (RCM v2)',
  quickBooksPayroll: 'QuickBooks Payroll',
  salesforce: 'Salesforce',
  salesforceLumen: 'Salesforce (Lumen)',
  hubspot: 'HubSpot',
  hubspotV2: 'HubSpot V2',
  docusign: 'DocuSign',
  ringCentral: 'RingCentral',
  vivSinch: 'Sinch',
  vivZoho: 'Zoho',
  stax: 'Stax Payments',
  stripe: 'Stripe',
  iSolved: 'iSolved',
  adp: 'ADP',
  ceridian: 'Ceridian',
  paychex: 'Paychex',
  paycor: 'Paycor',
  viventium: 'Viventium',
  nevvon: 'Nevvon',
  workday: 'Workday',
  paradox: 'Paradox',
  careAcademy: 'Care Academy',
  checkr: 'Checkr',
  businessCentral: 'Business Central',
}

function labelFor(type: string) {
  return TYPE_LABELS[type] || type
}

export function IntegrationsPage() {
  const [data, setData] = useState<AggregatedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeBucket, setActiveBucket] = useState<Bucket | 'all'>('all')
  const [panel, setPanel] = useState<{ customerName: string; integrationType: string; envs: EnvDetailItem[] } | null>(null)

  const customersMap = useWsStore(s => s.customers)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const result = await apiFetch<AggregatedResponse>('/integrations/aggregated')
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const customerNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of customersMap) map[c.id] = c.name
    return map
  }, [customersMap])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.toLowerCase().trim()
    return data.integrations.filter(i => {
      if (!q) return true

      if (i.type.toLowerCase().includes(q)) return true
      if (labelFor(i.type).toLowerCase().includes(q)) return true

      for (const [customerId, state] of Object.entries(i.customerStates)) {
        if (state !== 'on' && state !== 'partial') continue
        if (customerId.toLowerCase().includes(q)) return true
        const name = (customerNames[customerId] || '').toLowerCase()
        if (name.includes(q)) return true
      }

      for (const outlier of i.outliers) {
        if (outlier.envId.toLowerCase().includes(q)) return true
      }

      return false
    })
  }, [data, search, customerNames])

  const bucketed = useMemo(() => {
    const result: Record<Bucket, AggregatedIntegration[]> = {
      'everywhere-on': [],
      'mixed': [],
      'everywhere-off': [],
      'dev-only': [],
    }
    for (const i of filtered) result[i.bucket].push(i)
    return result
  }, [filtered])

  const displayItems = useMemo(() => {
    if (activeBucket === 'all') return filtered
    return filtered.filter(i => i.bucket === activeBucket)
  }, [filtered, activeBucket])

  if (loading) {
    return <NectarLoader size="lg" message="Aggregating integrations..." className="mt-32" />
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={load} className="mt-2">Retry</Button>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-bold">Integrations</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {data.stats.totalIntegrations} integrations across {data.customers.length} customers · {data.stats.totalProdEnvs} prod envs polled
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>

      </div>

      {/* Bucket tabs + search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          <button
            onClick={() => setActiveBucket('all')}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              activeBucket === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            All ({filtered.length})
          </button>
          {BUCKET_ORDER.map(b => {
            const meta = BUCKET_META[b]
            const count = bucketed[b].length
            return (
              <button
                key={b}
                onClick={() => setActiveBucket(b)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  activeBucket === b ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  count === 0 && 'opacity-40'
                )}
              >
                <span className={cn(activeBucket === b && meta.color)}>{meta.label}</span>
                {count > 0 && <span className="ml-1 text-xs text-muted-foreground">{count}</span>}
              </button>
            )
          })}
        </div>

        <Input
          placeholder="Search integrations, customers, or environments..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm h-8"
        />
      </div>

      {/* Single unified table */}
      <Card>
        <CardContent className="p-0">
          <div className="divide-y divide-border/50">
            {displayItems.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground italic">No integrations match the current filter</div>
            ) : (
              displayItems.map(integ => (
                <IntegrationRow
                  key={integ.type}
                  integration={integ}
                  customers={data.customers}
                  customerNames={customerNames}
                  onClickCustomer={(customerName, envs) => setPanel({ customerName, integrationType: integ.type, envs })}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <EnvDetailPanel
        open={!!panel}
        onClose={() => setPanel(null)}
        customerName={panel?.customerName || ''}
        itemName={panel?.integrationType || ''}
        itemType="integration"
        envs={panel?.envs || []}
      />
    </div>
  )
}

function IntegrationRow({ integration, customers, customerNames, onClickCustomer }: {
  integration: AggregatedIntegration
  onClickCustomer: (customerName: string, envs: EnvDetailItem[]) => void
  customers: string[]
  customerNames: Record<string, string>
}) {
  return (
    <div className="px-4 py-3 hover:bg-accent/20 transition-colors">
      <div className="flex items-center gap-3">
        {/* Integration name */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{labelFor(integration.type)}</span>
            <code className="text-xs text-muted-foreground font-mono">{integration.type}</code>
          </div>
          {integration.outliers.length > 0 && (
            <div className="text-xs text-yellow-400 mt-1">
              ⚠ {integration.outliers.length} outlier env{integration.outliers.length === 1 ? '' : 's'}
            </div>
          )}
        </div>

        {/* Customer state pills */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end max-w-[60%]">
          {customers.map(customerId => {
            const state = integration.customerStates[customerId] || 'unknown'
            const configured = integration.customerConfigured[customerId]
            const name = customerNames[customerId] || customerId
            const envs = integration.customerEnvs?.[customerId] || []
            return (
              <CustomerPill
                key={customerId}
                name={name}
                state={state}
                configured={configured}
                onClick={() => onClickCustomer(name, envs)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CustomerPill({ name, state, configured, onClick }: {
  name: string
  state: CustomerState
  configured?: boolean
  onClick: () => void
}) {
  const classes = {
    on:      'bg-green-500/15 border-green-500/40 text-green-300',
    off:     'bg-muted/30 border-border text-muted-foreground/60 line-through',
    partial: 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300',
    unknown: 'bg-transparent border-dashed border-muted-foreground/20 text-muted-foreground/40',
  }[state]
  const dot = {
    on:      'bg-green-500',
    off:     'bg-muted-foreground/30',
    partial: 'bg-yellow-500',
    unknown: 'bg-transparent border border-dashed border-muted-foreground/30',
  }[state]

  const showWarning = state === 'on' && configured === false

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all",
        classes
      )}
      title={`${name}: ${state} — click for details`}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
      {name}
      {showWarning && <span className="text-yellow-400 ml-0.5">⚠</span>}
    </button>
  )
}
