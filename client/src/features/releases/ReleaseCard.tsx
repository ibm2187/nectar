import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { ZohoImpactBadge } from './CustomerImpact'
import { CustomerPills } from '../../components/CustomerPill'
import { timeAgo, riskLabel, cn } from '../../lib/utils'
import type { Release } from '../../api/client'

const stateColors: Record<string, string> = {
  planning: 'state-planning',
  cutting: 'state-cutting',
  stabilizing: 'state-stabilizing',
  approved: 'state-approved',
  deploying: 'state-deploying',
  done: 'state-done',
}

interface ReleaseCardProps {
  release: Release
  onClick: () => void
}

export function ReleaseCard({ release: r, onClick }: ReleaseCardProps) {
  const picked = r.tickets.filter(t => t.state === 'cherry-picked').length
  const pending = r.tickets.filter(t => t.state === 'pending').length
  const deployDone = r.deployments.filter(d => d.status === 'deployed').length

  return (
    <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          {r.repo && (
            <Badge variant="secondary" className="text-xs">{r.repo}</Badge>
          )}
          <span className="text-lg font-bold font-mono">{r.version}</span>
          <Badge className={cn(stateColors[r.state])} variant="outline">
            {r.state}
          </Badge>
          {r.risk.numericScore !== null && (
            <Badge variant={r.risk.score === 'low' ? 'success' : r.risk.score === 'medium' ? 'warning' : 'destructive'}>
              {riskLabel(r.risk.numericScore)}
            </Badge>
          )}
          {r.ci.status && (
            <Badge variant={r.ci.status === 'passing' ? 'success' : 'warning'}>
              CI: {r.ci.status}
            </Badge>
          )}
          {r.targetCustomers != null && (
            <CustomerPills customerIds={r.targetCustomers} />
          )}
          <ZohoImpactBadge count={(r as any).zohoTickets?.length || 0} />
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {r.tickets.length > 0 && (
            <span>{r.tickets.length} tickets · {picked} picked · {pending} pending</span>
          )}
          {r.deployments.length > 0 && (
            <span>Deploy: {deployDone}/{r.deployments.length}</span>
          )}
          {r.approvals.length > 0 && (
            <span>Approvals: {r.approvals.map(a => a.role).join(', ')}</span>
          )}
          <span>{timeAgo(r.createdAt)}</span>
        </div>
      </CardContent>
    </Card>
  )
}
