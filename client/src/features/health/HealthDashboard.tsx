import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn, timeAgo } from '../../lib/utils'
import { apiFetch } from '../../api/client'
import type { HealthOverview, HealthCustomer, HealthEnvironment, HealthStatus, HealthCheck, DatadogAlert, DatadogAlertsResponse } from '../../api/client'

// ── Constants ──────────────────────────────────────────────

const SERVICE_NAMES: Record<string, string> = {
  mongodb: 'Database',
  redis: 'Cache',
  s3: 'File Storage',
  sqs: 'Message Queue',
  twilio: 'Messaging',
  sendgrid: 'Email',
}

const STATUS_ORDER: Record<HealthStatus, number> = {
  unhealthy: 0,
  degraded: 1,
  unreachable: 2,
  healthy: 3,
}

const STATUS_CONFIG: Record<HealthStatus, { label: string; dotClass: string; badgeVariant: 'destructive' | 'warning' | 'success' | 'secondary' }> = {
  healthy: { label: 'Operational', dotClass: 'bg-green-500', badgeVariant: 'success' },
  degraded: { label: 'Degraded', dotClass: 'bg-yellow-500', badgeVariant: 'warning' },
  unhealthy: { label: 'Unhealthy', dotClass: 'bg-red-500', badgeVariant: 'destructive' },
  unreachable: { label: 'Unreachable', dotClass: 'bg-gray-500', badgeVariant: 'secondary' },
}

const REFRESH_INTERVAL_MS = 60_000

type Tab = 'production' | 'lower'
type StatusFilter = 'all' | 'healthy' | 'degraded' | 'unhealthy'

// ── Helper: flatten customers into environment cards ────────

interface EnvCard {
  customerId: string
  customerName: string
  env: HealthEnvironment
  status: HealthStatus
}

const flattenToCards = (customers: HealthCustomer[], tab: Tab): EnvCard[] => {
  const cards: EnvCard[] = []
  for (const customer of customers) {
    if (!customer.active) continue
    for (const env of customer.environments) {
      const isProd = env.tier === 'production'
      if (tab === 'production' && !isProd) continue
      if (tab === 'lower' && isProd) continue

      cards.push({
        customerId: customer.id,
        customerName: customer.name,
        env,
        status: env.health?.status ?? (env.reachable ? 'healthy' : 'unreachable'),
      })
    }
  }
  return cards
}

// ── Helper: get friendly service name ───────────────────────

const friendlyName = (name: string): string => SERVICE_NAMES[name] ?? name

// ── Helper: get all checks from health data as a flat list ─

const getAllChecks = (env: HealthEnvironment): HealthCheck[] => {
  if (!env.health?.checks) return []
  const checks: HealthCheck[] = []
  const sections = [
    env.health.checks.criticalFunctionality,
    env.health.checks.externalServices,
  ]
  for (const section of sections) {
    if (!section?.services) continue
    for (const [name, svc] of Object.entries(section.services)) {
      checks.push({
        name,
        status: svc.status || 'unknown',
        responseTimeMs: svc.responseTimeMs,
        details: svc.details,
      })
    }
  }
  return checks
}

// ── Helper: check status dot color ──────────────────────────

const checkDotClass = (status: string): string => {
  if (status === 'healthy' || status === 'pass') return 'bg-green-500'
  if (status === 'unhealthy' || status === 'fail') return 'bg-red-500'
  if (status === 'degraded') return 'bg-yellow-500'
  return 'bg-gray-400' // skipped or unknown
}

// ── Component ───────────────────────────────────────────────

export function HealthDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<HealthOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('production')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [alerts, setAlerts] = useState<DatadogAlert[]>([])
  const [alertsExpanded, setAlertsExpanded] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const result = await apiFetch<HealthOverview>('/health/overview')
      setData(result)
      setLastRefreshed(new Date().toISOString())
    } catch {
      // keep stale data visible
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAlerts = useCallback(async () => {
    try {
      const result = await apiFetch<DatadogAlertsResponse>('/datadog/alerts')
      if (result.configured && result.events) {
        setAlerts(result.events)
      }
    } catch {
      // Datadog alerts are optional — don't break if unavailable
    }
  }, [])

  // Initial fetch + auto-refresh
  useEffect(() => {
    fetchData()
    fetchAlerts()
    const timer = setInterval(fetchData, REFRESH_INTERVAL_MS)
    const alertTimer = setInterval(fetchAlerts, REFRESH_INTERVAL_MS)
    return () => { clearInterval(timer); clearInterval(alertTimer) }
  }, [fetchData, fetchAlerts])

  // Flatten, filter, and sort cards
  const cards = useMemo(() => {
    if (!data) return []
    let list = flattenToCards(data.customers, tab)

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c =>
        c.customerName.toLowerCase().includes(q) ||
        c.env.name.toLowerCase().includes(q) ||
        (c.env.currentVersion ?? '').toLowerCase().includes(q)
      )
    }

    // Status filter
    if (statusFilter !== 'all') {
      list = list.filter(c => c.status === statusFilter)
    }

    // Sort: unhealthy first, then degraded, then unreachable, then healthy.
    // Within each group, sort by customer name.
    list.sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 99
      const sb = STATUS_ORDER[b.status] ?? 99
      if (sa !== sb) return sa - sb
      return a.customerName.localeCompare(b.customerName)
    })

    return list
  }, [data, tab, search, statusFilter])

  const stats = data?.stats ?? { total: 0, healthy: 0, degraded: 0, unhealthy: 0, unreachable: 0 }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-sm text-muted-foreground">Loading health data...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">System Health</h1>
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
            <span className="text-green-400">{stats.healthy} healthy</span>
            <span className="text-yellow-400">{stats.degraded} degraded</span>
            <span className="text-red-400">{stats.unhealthy} unhealthy</span>
            {stats.unreachable > 0 && (
              <span className="text-gray-400">{stats.unreachable} unreachable</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {lastRefreshed && (
            <span>Refreshed {timeAgo(lastRefreshed)}</span>
          )}
          <Button variant="outline" size="sm" onClick={fetchData}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Datadog Alert Banner */}
      {alerts.length > 0 && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                <span className="text-sm font-semibold text-yellow-400">
                  {alerts.length} Active Datadog Alert{alerts.length !== 1 ? 's' : ''}
                </span>
              </div>
              {alerts.length > 5 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6"
                  onClick={() => setAlertsExpanded(!alertsExpanded)}
                >
                  {alertsExpanded ? 'Show less' : `Show all ${alerts.length}`}
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              {(alertsExpanded ? alerts : alerts.slice(0, 5)).map(alert => {
                const envTag = (alert.tags || []).find(t => t.startsWith('env:'))
                const envName = envTag ? envTag.replace('env:', '') : null
                const severity = alert.alertType === 'error' ? 'destructive' : alert.alertType === 'warning' ? 'warning' : 'secondary'
                return (
                  <div key={alert.id} className="flex items-center gap-2 text-xs">
                    <Badge variant={severity} className="text-[10px] px-1.5 py-0 shrink-0">
                      {alert.alertType || 'info'}
                    </Badge>
                    <a href={alert.url} target="_blank" rel="noopener noreferrer" className="truncate text-foreground hover:text-primary hover:underline">{alert.title}</a>
                    {envName && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                        {envName}
                      </Badge>
                    )}
                    <span className="text-muted-foreground shrink-0 ml-auto">
                      {timeAgo(new Date(alert.dateHappened * 1000).toISOString())}
                    </span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b pb-2">
        <button
          onClick={() => setTab('production')}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-t-md transition-colors',
            tab === 'production'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
          )}
        >
          Production
        </button>
        <button
          onClick={() => setTab('lower')}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-t-md transition-colors',
            tab === 'lower'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
          )}
        >
          Lower Environments
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="Search customer, environment, or version..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        <div className="flex gap-2">
          {(['all', 'healthy', 'degraded', 'unhealthy'] as const).map(f => (
            <Button
              key={f}
              variant={statusFilter === f ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {/* Grid of cards */}
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          No environments match the current filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map(card => (
            <EnvironmentCard
              key={card.env.id}
              card={card}
              onClick={() => navigate(`/health/${card.env.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── EnvironmentCard ─────────────────────────────────────────

function EnvironmentCard({ card, onClick }: { card: EnvCard; onClick: () => void }) {
  const { env, customerName, status } = card
  const cfg = STATUS_CONFIG[status]
  const checks = getAllChecks(env)
  const summary = env.health?.summary

  const tierLabel = env.tier.charAt(0).toUpperCase() + env.tier.slice(1)
  const displayName = env.franchiseDisplayName
    ? `${customerName} - ${env.franchiseDisplayName}`
    : customerName

  return (
    <Card className="hover:border-accent/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <button
              onClick={onClick}
              className="text-sm font-semibold text-foreground hover:underline truncate block text-left"
              title={displayName}
            >
              {displayName}
            </button>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tierLabel}
              {env.currentVersion && <span className="ml-2">v{env.currentVersion}</span>}
            </p>
          </div>
          <Badge variant={cfg.badgeVariant} className="shrink-0 text-xs">
            {cfg.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Service health grid */}
        {checks.length > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {checks.map(check => (
              <div key={check.name} className="flex items-center gap-2 text-xs">
                <div className={cn('w-2 h-2 rounded-full shrink-0', checkDotClass(check.status))} />
                <span className="text-muted-foreground truncate">{friendlyName(check.name)}</span>
                {check.responseTimeMs != null && check.responseTimeMs > 0 && (
                  <span className="text-muted-foreground/60 ml-auto shrink-0">
                    {Math.round(check.responseTimeMs)}ms
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Summary + last checked */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/50">
          {summary ? (
            <span>
              {summary.passed}/{summary.totalChecks} passed
              {summary.degraded > 0 && <span className="text-yellow-400"> · {summary.degraded} degraded</span>}
              {summary.failed > 0 && <span className="text-red-400"> · {summary.failed} failed</span>}
            </span>
          ) : (
            <span>No health data</span>
          )}
          <span>{timeAgo(env.health?.checkedAt ?? env.lastChecked)}</span>
        </div>
      </CardContent>
    </Card>
  )
}
