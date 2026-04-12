import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { cn, timeAgo } from '../../lib/utils'
import { apiFetch } from '../../api/client'
import type { CustomerHealthResponse, HealthEnvironment, HealthStatus, HealthCheck } from '../../api/client'

// ── Constants ──────────────────────────────────────────────

const SERVICE_NAMES: Record<string, string> = {
  mongodb: 'Database',
  redis: 'Cache',
  s3: 'File Storage',
  sqs: 'Message Queue',
  twilio: 'Messaging',
  sendgrid: 'Email',
}

const REFRESH_INTERVAL_MS = 60_000

// Tier ordering for display
const TIER_ORDER = [
  'production', 'staging', 'uat', 'qa', 'integration',
  'sandbox', 'test', 'training', 'demo', 'loadtest', 'dev', 'other',
]

// ── Helpers ─────────────────────────────────────────────────

const friendlyName = (name: string): string => SERVICE_NAMES[name] ?? name

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
      checks.push({ name, status: svc.status || 'unknown', responseTimeMs: svc.responseTimeMs, details: svc.details })
    }
  }
  return checks
}

const checkDotClass = (status: string): string => {
  if (status === 'healthy' || status === 'pass') return 'bg-green-500'
  if (status === 'unhealthy' || status === 'fail') return 'bg-red-500'
  if (status === 'degraded') return 'bg-yellow-500'
  return 'bg-gray-400'
}

const overallBanner = (status: HealthStatus): { text: string; className: string } => {
  switch (status) {
    case 'healthy':
      return { text: 'All Systems Operational', className: 'bg-green-500/10 border-green-500/30 text-green-400' }
    case 'degraded':
      return { text: 'Some Systems Degraded', className: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' }
    case 'unhealthy':
      return { text: 'System Outage', className: 'bg-red-500/10 border-red-500/30 text-red-400' }
    case 'unreachable':
      return { text: 'Systems Unreachable', className: 'bg-gray-500/10 border-gray-500/30 text-gray-400' }
  }
}

// ── Component ───────────────────────────────────────────────

export function CustomerStatusPage() {
  const { customerId } = useParams<{ customerId: string }>()
  const [data, setData] = useState<CustomerHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (!customerId) return
    try {
      // Try customer-level first, fall back to environment-level
      let result: CustomerHealthResponse
      try {
        result = await apiFetch<CustomerHealthResponse>(`/health/${customerId}`)
      } catch {
        // Not a customer — try as an environment ID
        const envResult = await apiFetch<{ customer: { id: string; name: string } | null; environment: any; overallStatus: string }>(`/health/env/${customerId}`)
        result = {
          customer: envResult.customer || { id: customerId, name: customerId },
          overallStatus: envResult.overallStatus as any,
          environments: [envResult.environment],
        }
      }
      setData(result)
      setError(null)
      setLastRefreshed(new Date().toISOString())
    } catch (err) {
      if (!data) setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [fetchData])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-sm text-muted-foreground">Loading status...</p>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Link to="/health-dashboard" className="text-sm text-primary hover:underline">
          Back to Health Dashboard
        </Link>
      </div>
    )
  }

  if (!data) return null

  const banner = overallBanner(data.overallStatus)

  // Sort environments by tier order
  const sortedEnvs = [...data.environments].sort((a, b) => {
    const ai = TIER_ORDER.indexOf(a.tier)
    const bi = TIER_ORDER.indexOf(b.tier)
    return (ai >= 0 ? ai : 99) - (bi >= 0 ? bi : 99)
  })

  // Find most recent checkedAt across all environments
  const latestCheck = data.environments
    .map(e => e.health?.checkedAt ?? e.lastChecked)
    .filter(Boolean)
    .sort()
    .pop()

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Back link */}
      <div className="flex items-center justify-between">
        <Link
          to="/health-dashboard"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; Health Dashboard
        </Link>
        <Button variant="outline" size="sm" onClick={fetchData}>
          Refresh
        </Button>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{data.customer.name} &mdash; System Status</h1>
        {lastRefreshed && (
          <p className="text-sm text-muted-foreground mt-1">
            Last checked {timeAgo(latestCheck ?? lastRefreshed)}
          </p>
        )}
      </div>

      {/* Overall status banner */}
      <div className={cn('rounded-lg border px-6 py-4 text-center font-semibold text-lg', banner.className)}>
        {banner.text}
      </div>

      {/* Environment sections */}
      {sortedEnvs.map(env => (
        <EnvironmentSection key={env.id} env={env} />
      ))}

      {/* Past 24 hours placeholder */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Past 24 Hours</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No incidents reported.</p>
        </CardContent>
      </Card>
    </div>
  )
}

// ── EnvironmentSection ──────────────────────────────────────

function EnvironmentSection({ env }: { env: HealthEnvironment }) {
  const checks = getAllChecks(env)
  const status = env.health?.status ?? 'unreachable'
  const tierLabel = env.tier.charAt(0).toUpperCase() + env.tier.slice(1)
  const sectionTitle = env.franchiseDisplayName
    ? `${tierLabel} - ${env.franchiseDisplayName}`
    : tierLabel

  const statusBadge = (): { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' } => {
    switch (status) {
      case 'healthy': return { label: 'Operational', variant: 'success' }
      case 'degraded': return { label: 'Degraded', variant: 'warning' }
      case 'unhealthy': return { label: 'Unhealthy', variant: 'destructive' }
      case 'unreachable': return { label: 'Unreachable', variant: 'secondary' }
    }
  }

  const badge = statusBadge()

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{sectionTitle}</CardTitle>
          <Badge variant={badge.variant} className="text-xs">
            {badge.label}
          </Badge>
        </div>
        {env.currentVersion && (
          <p className="text-xs text-muted-foreground">v{env.currentVersion}</p>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {checks.length > 0 ? (
          <div className="space-y-2">
            {checks.map(check => (
              <div
                key={check.name}
                className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0"
              >
                <div className="flex items-center gap-2.5">
                  <div className={cn('w-2.5 h-2.5 rounded-full', checkDotClass(check.status))} />
                  <span className="text-sm">{friendlyName(check.name)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {check.responseTimeMs != null && check.responseTimeMs > 0 && (
                    <span>{Math.round(check.responseTimeMs)}ms</span>
                  )}
                  <span className={cn(
                    (check.status === 'healthy' || check.status === 'pass') && 'text-green-400',
                    (check.status === 'unhealthy' || check.status === 'fail') && 'text-red-400',
                    check.status === 'degraded' && 'text-yellow-400',
                    check.status === 'skipped' && 'text-muted-foreground',
                  )}>
                    {(check.status === 'healthy' || check.status === 'pass') ? 'Operational' :
                     (check.status === 'unhealthy' || check.status === 'fail') ? 'Down' :
                     check.status === 'degraded' ? 'Degraded' :
                     check.status === 'skipped' ? 'Skipped' :
                     'Operational'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No health data available for this environment.</p>
        )}
      </CardContent>
    </Card>
  )
}
