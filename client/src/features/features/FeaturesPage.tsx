import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { useWsStore } from '../../stores/wsStore'
import { cn } from '../../lib/utils'

type Bucket = 'everywhere-on' | 'mixed' | 'everywhere-off' | 'dev-only'
type CustomerState = 'on' | 'off' | 'partial' | 'unknown'

interface FlagOutlier {
  envId: string
  customerId: string
  enabled: boolean
}

interface AggregatedFlag {
  key: string
  bucket: Bucket
  isMobileFeature: boolean
  customerStates: Record<string, CustomerState>
  outliers: FlagOutlier[]
  enabledInAnyNonProd: boolean
}

interface AggregatedResponse {
  flags: AggregatedFlag[]
  customers: string[]
  stats: {
    totalFlags: number
    totalProdEnvs: number
    totalCustomers: number
    totalEnvsWithData: number
    buckets: Record<Bucket, number>
  }
}

const BUCKET_META: Record<Bucket, { label: string; subtitle: string; accent: string; color: string }> = {
  'everywhere-on': {
    label: 'Everywhere On',
    subtitle: 'Ready to remove — feature is universal',
    accent: 'border-l-green-500',
    color: 'text-green-400',
  },
  'mixed': {
    label: 'Mixed Rollout',
    subtitle: 'Intentional differentiation per customer',
    accent: 'border-l-yellow-500',
    color: 'text-yellow-400',
  },
  'everywhere-off': {
    label: 'Everywhere Off',
    subtitle: 'Unused in production — candidate for removal',
    accent: 'border-l-red-500',
    color: 'text-red-400',
  },
  'dev-only': {
    label: 'Dev / Staging Only',
    subtitle: 'Still being rolled out — do not remove',
    accent: 'border-l-blue-500',
    color: 'text-blue-400',
  },
}

const BUCKET_ORDER: Bucket[] = ['everywhere-on', 'everywhere-off', 'mixed', 'dev-only']

export function FeaturesPage() {
  const [data, setData] = useState<AggregatedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'portal' | 'mobile'>('all')
  const [expandedBuckets, setExpandedBuckets] = useState<Set<Bucket>>(
    new Set(['everywhere-on', 'everywhere-off'])
  )

  const customersMap = useWsStore(s => s.customers)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const result = await apiFetch<AggregatedResponse>('/features/aggregated')
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load features')
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
    return data.flags.filter(f => {
      if (scopeFilter === 'portal' && f.isMobileFeature) return false
      if (scopeFilter === 'mobile' && !f.isMobileFeature) return false
      if (!q) return true

      // Match flag name
      if (f.key.toLowerCase().includes(q)) return true

      // Match customer name/id where the flag is enabled
      for (const [customerId, state] of Object.entries(f.customerStates)) {
        if (state !== 'on' && state !== 'partial') continue
        if (customerId.toLowerCase().includes(q)) return true
        const name = (customerNames[customerId] || '').toLowerCase()
        if (name.includes(q)) return true
      }

      // Match environment id in outliers
      for (const outlier of f.outliers) {
        if (outlier.envId.toLowerCase().includes(q)) return true
      }

      return false
    })
  }, [data, search, scopeFilter, customerNames])

  const bucketed = useMemo(() => {
    const result: Record<Bucket, AggregatedFlag[]> = {
      'everywhere-on': [],
      'mixed': [],
      'everywhere-off': [],
      'dev-only': [],
    }
    for (const f of filtered) result[f.bucket].push(f)
    return result
  }, [filtered])

  function toggleBucket(b: Bucket) {
    setExpandedBuckets(prev => {
      const next = new Set(prev)
      if (next.has(b)) next.delete(b)
      else next.add(b)
      return next
    })
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key).catch(() => {})
  }

  if (loading) {
    return <NectarLoader size="lg" message="Aggregating feature flags..." className="mt-32" />
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
            <h2 className="text-2xl font-bold">Feature Flag Cleanup</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {data.stats.totalFlags} flags across {data.customers.length} customers · {data.stats.totalProdEnvs} prod envs polled
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>

        {/* Bucket summary pills */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {BUCKET_ORDER.map(b => {
            const meta = BUCKET_META[b]
            const count = bucketed[b].length
            const total = data.stats.buckets[b]
            return (
              <button
                key={b}
                type="button"
                onClick={() => toggleBucket(b)}
                className={cn(
                  "rounded-lg border border-l-4 p-3 text-left transition-all hover:bg-accent/30",
                  meta.accent,
                  count === 0 && "opacity-50"
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-2xl font-bold", meta.color)}>{count}</span>
                  {count !== total && (
                    <span className="text-xs text-muted-foreground">of {total}</span>
                  )}
                </div>
                <div className={cn("text-xs uppercase tracking-wider font-semibold", meta.color)}>{meta.label}</div>
                <div className="text-xs text-muted-foreground mt-1">{meta.subtitle}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search flags, customers, or environments..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex rounded-md border text-xs">
          {(['all', 'portal', 'mobile'] as const).map((s, i, arr) => (
            <button
              key={s}
              type="button"
              onClick={() => setScopeFilter(s)}
              className={cn(
                "px-3 py-1 transition-colors",
                i === 0 && "rounded-l-md",
                i === arr.length - 1 && "rounded-r-md",
                i > 0 && "border-l",
                scopeFilter === s ? "bg-primary text-primary-foreground" : "hover:bg-accent"
              )}
            >
              {s === 'all' ? 'All' : s === 'portal' ? 'Portal' : 'Mobile'}
            </button>
          ))}
        </div>
      </div>

      {/* Bucket sections */}
      {BUCKET_ORDER.map(bucket => {
        const flags = bucketed[bucket]
        if (flags.length === 0) return null
        const meta = BUCKET_META[bucket]
        const expanded = expandedBuckets.has(bucket)

        return (
          <div key={bucket}>
            <button
              type="button"
              onClick={() => toggleBucket(bucket)}
              className={cn("w-full flex items-center gap-2 mb-2 text-left hover:opacity-80")}
            >
              <span className="text-sm">{expanded ? '▾' : '▸'}</span>
              <h3 className={cn("text-sm font-semibold uppercase tracking-wider", meta.color)}>{meta.label}</h3>
              <span className="text-xs text-muted-foreground">{flags.length}</span>
              <div className="flex-1 h-px bg-border ml-2"></div>
              <span className="text-xs text-muted-foreground italic">{meta.subtitle}</span>
            </button>

            {expanded && (
              <Card>
                <CardContent className="p-0">
                  <div className="divide-y divide-border/50">
                    {flags.map(flag => (
                      <FlagRow
                        key={flag.key}
                        flag={flag}
                        customers={data.customers}
                        customerNames={customerNames}
                        onCopy={copyKey}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )
      })}
    </div>
  )
}

function FlagRow({ flag, customers, customerNames, onCopy }: {
  flag: AggregatedFlag
  customers: string[]
  customerNames: Record<string, string>
  onCopy: (key: string) => void
}) {
  const githubUrl = `https://github.com/mavencare/webplatform/search?q=${encodeURIComponent(flag.key)}`

  return (
    <div className="px-4 py-3 hover:bg-accent/20 transition-colors">
      <div className="flex items-center gap-3">
        {/* Flag name + scope */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-medium">{flag.key}</span>
            {flag.isMobileFeature ? (
              <Badge variant="outline" className="text-xs bg-purple-500/10 border-purple-500/30 text-purple-400">Mobile</Badge>
            ) : (
              <Badge variant="outline" className="text-xs bg-blue-500/10 border-blue-500/30 text-blue-400">Portal</Badge>
            )}
          </div>
          {flag.outliers.length > 0 && (
            <div className="text-xs text-yellow-400 mt-1">
              ⚠ {flag.outliers.length} outlier env{flag.outliers.length === 1 ? '' : 's'}
            </div>
          )}
        </div>

        {/* Customer state pills */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end max-w-[60%]">
          {customers.map(customerId => {
            const state = flag.customerStates[customerId] || 'unknown'
            const name = customerNames[customerId] || customerId
            return (
              <CustomerPill
                key={customerId}
                name={name}
                state={state}
              />
            )
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onCopy(flag.key)}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Copy flag name"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Find in webplatform code"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </a>
        </div>
      </div>
    </div>
  )
}

function CustomerPill({ name, state }: { name: string; state: CustomerState }) {
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
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", classes)}
      title={`${name}: ${state}`}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
      {name}
    </span>
  )
}
