import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { cn } from '../../lib/utils'

interface ScorecardMilestone {
  key: string
  label: string
  effectiveDate: string
  status: 'pending' | 'met' | 'missed' | 'skipped'
  completedAt: string | null
  gate: boolean
}

interface Scorecard {
  version: string
  releaseType: string | null
  shipDate: string | null
  state: string
  gateHitRate: number | null
  totalGates: number
  gatesMet: number
  gatesMissed: number
  gatesSkipped: number
  onTimeShip: boolean | null
  milestones: ScorecardMilestone[]
}

function formatDateShort(d: string | null): string {
  if (!d) return '\u2014'
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function hitRateColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground'
  if (rate >= 0.9) return 'text-green-600 dark:text-green-400'
  if (rate >= 0.7) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-destructive'
}

interface Props {
  version: string
  shouldRender: boolean
}

export function ReleaseScorecard({ version, shouldRender }: Props) {
  const [data, setData] = useState<Scorecard | null>(null)

  useEffect(() => {
    if (!shouldRender || !version) return
    let cancelled = false
    apiFetch<Scorecard>(`/releases/${encodeURIComponent(version)}/scorecard`)
      .then(r => { if (!cancelled) setData(r) })
      .catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [version, shouldRender])

  if (!shouldRender || !data) return null

  const gates = data.milestones.filter(m => m.gate)
  const missedGates = gates.filter(g => g.status === 'missed')
  const metGates = gates.filter(g => g.status === 'met')

  const hitRate = data.gateHitRate
  const hitPct = hitRate == null ? null : Math.round(hitRate * 100)

  return (
    <Card className="mb-4">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Release Scorecard</h3>
          {data.state === 'done' && data.onTimeShip === true && (
            <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-600 dark:text-green-400">
              Shipped On Time
            </Badge>
          )}
          {data.state === 'done' && data.onTimeShip === false && (
            <Badge variant="outline" className="text-[10px] border-yellow-500/40 text-yellow-600 dark:text-yellow-400">
              Shipped Late
            </Badge>
          )}
        </div>

        {/* Key metrics */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Gate Hit Rate</div>
            <div className={cn('text-xl font-bold', hitRateColor(hitRate))}>
              {hitPct == null ? '\u2014' : `${hitPct}%`}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {data.gatesMet}/{data.totalGates - data.gatesSkipped} gates met
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Gates Missed</div>
            <div className={cn(
              'text-xl font-bold',
              data.gatesMissed === 0 ? 'text-green-600 dark:text-green-400' : 'text-destructive'
            )}>
              {data.gatesMissed}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {data.gatesMissed === 0 ? 'clean' : missedGates.map(g => g.label).join(', ')}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Ship Date</div>
            <div className="text-xl font-bold">{formatDateShort(data.shipDate)}</div>
            {data.gatesSkipped > 0 && (
              <div className="text-[10px] text-muted-foreground">{data.gatesSkipped} skipped</div>
            )}
          </div>
        </div>

        {/* Missed gate detail */}
        {missedGates.length > 0 && (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 mb-3">
            <div className="text-[10px] uppercase tracking-wide text-destructive font-semibold mb-1">Missed Gates</div>
            <div className="space-y-1">
              {missedGates.map(g => (
                <div key={g.key} className="flex items-center justify-between text-xs">
                  <span className="text-destructive">{g.label}</span>
                  <span className="text-muted-foreground font-mono text-[10px]">due {formatDateShort(g.effectiveDate)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Progress visualization — compact inline bar */}
        {gates.length > 0 && (
          <div className="flex items-center gap-0.5 h-2 rounded-full overflow-hidden">
            {gates.map(g => (
              <div
                key={g.key}
                title={`${g.label}: ${g.status}`}
                className={cn(
                  'flex-1 h-full transition-colors',
                  g.status === 'met' && 'bg-green-500/70',
                  g.status === 'missed' && 'bg-destructive/70',
                  g.status === 'skipped' && 'bg-muted-foreground/30',
                  g.status === 'pending' && 'bg-muted-foreground/20',
                )}
              />
            ))}
          </div>
        )}

        {metGates.length === gates.length && gates.length > 0 && data.state === 'done' && (
          <p className="text-xs text-green-600 dark:text-green-400 mt-2 text-center font-medium">
            {'\u2713'} All gates met. Perfect process adherence.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
