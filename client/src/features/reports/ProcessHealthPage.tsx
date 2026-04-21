import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface ProcessHealthRelease {
  version: string
  releaseType: string | null
  shipDate: string | null
  state: string
  gateHitRate: number | null
  totalGates: number
  gatesMet: number
  gatesMissed: number
  onTimeShip: boolean | null
  createdAt: string
}

interface UpcomingMilestone {
  version: string
  releaseType: string | null
  milestone: string
  label: string
  date: string
  owner: string
  gate: boolean
}

function formatDateShort(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatDateRelative(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffMs = d.getTime() - today.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays < 0) return `${-diffDays}d ago`
  if (diffDays < 7) return `in ${diffDays}d`
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatHitRate(rate: number | null): string {
  if (rate == null) return '—'
  return `${Math.round(rate * 100)}%`
}

function hitRateColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground'
  if (rate >= 0.9) return 'text-green-600 dark:text-green-400'
  if (rate >= 0.7) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-destructive'
}

const typeLabels: Record<string, string> = { monthly: 'Monthly', point: 'Point', hotfix: 'Hotfix' }

export function ProcessHealthPage() {
  const [releases, setReleases] = useState<ProcessHealthRelease[]>([])
  const [upcoming, setUpcoming] = useState<UpcomingMilestone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      apiFetch<{ releases: ProcessHealthRelease[] }>('/reports/process-health?releases=10'),
      apiFetch<{ upcoming: UpcomingMilestone[] }>('/reports/upcoming-milestones?days=14'),
    ])
      .then(([health, ups]) => {
        if (cancelled) return
        setReleases(health.releases || [])
        setUpcoming(ups.upcoming || [])
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Aggregate stats across all releases
  const stats = useMemo(() => {
    if (releases.length === 0) return null
    const withRate = releases.filter(r => r.gateHitRate != null)
    const avgRate = withRate.length > 0
      ? withRate.reduce((sum, r) => sum + (r.gateHitRate || 0), 0) / withRate.length
      : null
    const shipped = releases.filter(r => r.state === 'done')
    const onTime = shipped.filter(r => r.onTimeShip === true).length
    const onTimeRate = shipped.length > 0 ? onTime / shipped.length : null
    const totalMissed = releases.reduce((sum, r) => sum + r.gatesMissed, 0)
    const totalGates = releases.reduce((sum, r) => sum + r.totalGates, 0)
    return { avgRate, onTimeRate, totalMissed, totalGates, shipped: shipped.length }
  }, [releases])

  // Group upcoming milestones by date
  const upcomingByDate = useMemo(() => {
    const groups = new Map<string, UpcomingMilestone[]>()
    for (const m of upcoming) {
      const list = groups.get(m.date) || []
      list.push(m)
      groups.set(m.date, list)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [upcoming])

  if (loading) {
    return <div className="w-full flex items-center justify-center py-20"><NectarLoader /></div>
  }

  if (error) {
    return (
      <div className="w-full">
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="w-full space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Process Health</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Gate compliance, ship cadence, and upcoming milestones across all active releases.
        </p>
      </div>

      {/* Summary stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Avg Gate Hit Rate"
            value={formatHitRate(stats.avgRate)}
            valueClass={hitRateColor(stats.avgRate)}
            sublabel="last 10 releases"
          />
          <StatCard
            label="On-Time Ship"
            value={stats.onTimeRate == null ? '—' : formatHitRate(stats.onTimeRate)}
            valueClass={hitRateColor(stats.onTimeRate)}
            sublabel={`${stats.shipped} shipped`}
          />
          <StatCard
            label="Gates Missed"
            value={String(stats.totalMissed)}
            valueClass={stats.totalMissed === 0 ? 'text-green-600 dark:text-green-400' : 'text-destructive'}
            sublabel={`of ${stats.totalGates} total`}
          />
          <StatCard
            label="Upcoming"
            value={String(upcoming.length)}
            sublabel="next 14 days"
          />
        </div>
      )}

      {/* Upcoming milestones */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Upcoming Milestones</h3>
            <span className="text-xs text-muted-foreground">Next 14 days</span>
          </div>

          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No milestones in the next 14 days.
            </p>
          ) : (
            <div className="space-y-3">
              {upcomingByDate.map(([date, items]) => (
                <div key={date}>
                  <div className="flex items-baseline gap-2 mb-1.5 pb-1 border-b">
                    <span className="text-xs font-semibold text-foreground">
                      {formatDateRelative(date)}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {formatDateShort(date)}
                    </span>
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {items.length} {items.length === 1 ? 'item' : 'items'}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {items.map((item, i) => (
                      <div key={`${item.version}-${item.milestone}-${i}`} className="flex items-center gap-3 py-1 text-xs">
                        <Link
                          to={`/releases/${encodeURIComponent(item.version)}`}
                          className="font-mono text-primary hover:underline shrink-0 w-28 truncate"
                        >
                          {item.version}
                        </Link>
                        <span className="flex-1 min-w-0 truncate text-foreground">
                          {item.gate && <span className="text-amber-500/80 mr-1">{'\u2022'}</span>}
                          {item.label}
                        </span>
                        <span className="text-muted-foreground shrink-0">{item.owner}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trend table */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Release Trends</h3>
            <span className="text-xs text-muted-foreground">Last {releases.length} releases</span>
          </div>

          {releases.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No configured releases yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Version</th>
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Ship</th>
                    <th className="py-2 pr-3 font-medium">State</th>
                    <th className="py-2 pr-3 font-medium text-right">Gate Hit</th>
                    <th className="py-2 pr-3 font-medium text-right">Met</th>
                    <th className="py-2 pr-3 font-medium text-right">Missed</th>
                    <th className="py-2 pr-3 font-medium text-center">On Time</th>
                  </tr>
                </thead>
                <tbody>
                  {releases.map(r => (
                    <tr key={r.version} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-3">
                        <Link
                          to={`/releases/${encodeURIComponent(r.version)}`}
                          className="font-mono text-primary hover:underline"
                        >
                          {r.version}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">
                        {r.releaseType ? (
                          <Badge variant="secondary" className="text-[10px] capitalize">
                            {typeLabels[r.releaseType] || r.releaseType}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {formatDateShort(r.shipDate)}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px]',
                            r.state === 'done' && 'border-green-500/40 text-green-600 dark:text-green-400',
                            r.state === 'planning' && 'text-muted-foreground',
                          )}
                        >
                          {r.state}
                        </Badge>
                      </td>
                      <td className={cn('py-2 pr-3 text-right font-medium', hitRateColor(r.gateHitRate))}>
                        {formatHitRate(r.gateHitRate)}
                      </td>
                      <td className="py-2 pr-3 text-right text-green-600 dark:text-green-400">
                        {r.gatesMet}
                      </td>
                      <td className={cn(
                        'py-2 pr-3 text-right',
                        r.gatesMissed > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'
                      )}>
                        {r.gatesMissed || '\u2014'}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        {r.onTimeShip === true && <span className="text-green-500">{'\u2713'}</span>}
                        {r.onTimeShip === false && <span className="text-destructive">{'\u2717'}</span>}
                        {r.onTimeShip == null && <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  label, value, valueClass, sublabel,
}: {
  label: string
  value: string
  valueClass?: string
  sublabel?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
        <div className={cn('text-2xl font-bold mt-1', valueClass)}>{value}</div>
        {sublabel && <div className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</div>}
      </CardContent>
    </Card>
  )
}
