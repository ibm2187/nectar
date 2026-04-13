import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { cn } from '../../lib/utils'

interface ZohoTicket {
  id: string
  ticketNumber: string | null
  subject: string
  status: string
  statusType: string | null
  priority: string | null
  category: string | null
  departmentId: string | null
  email: string | null
  createdTime: string | null
  webUrl: string | null
  ticketType: string | null
}

interface CustomerGroup {
  departmentId: string
  customerName: string | null
  tickets: ZohoTicket[]
  count: number
}

interface CustomerImpactData {
  version: string
  repo: string | null
  totalZohoTickets: number
  zohoSyncedAt: string | null
  byCustomer: CustomerGroup[]
  byJiraKey: Record<string, ZohoTicket[]>
}

// Known department ID → customer name mapping (built from Zoho departments)
const DEPT_NAMES: Record<string, string> = {
  '1078812000000006907': 'Viv Technologies',
  '1078812000000503059': 'Comfort Keepers',
  '1078812000000547039': 'Tribute Home Care',
  '1078812000000553358': 'Bayada',
  '1078812000011550519': 'Help-at-Home',
}

const priorityColors: Record<string, string> = {
  High: 'text-red-400',
  Medium: 'text-yellow-400',
  Low: 'text-green-400',
}

export function CustomerImpact({ version }: { version: string }) {
  const [data, setData] = useState<CustomerImpactData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    apiFetch<CustomerImpactData>(`/releases/${version}/customer-impact`)
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [version])

  if (loading) return <div className="text-sm text-muted-foreground py-2">Loading customer impact...</div>
  if (error) return <div className="text-sm text-red-400 py-2">Failed to load: {error}</div>
  if (!data || data.totalZohoTickets === 0) {
    return (
      <div className="text-sm text-muted-foreground italic py-2">
        No linked support tickets found
        {data?.zohoSyncedAt && (
          <span className="ml-2 text-xs">
            (last synced {new Date(data.zohoSyncedAt).toLocaleString()})
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{data.totalZohoTickets}</span>
        support ticket{data.totalZohoTickets !== 1 ? 's' : ''} resolved
        {data.zohoSyncedAt && (
          <span className="text-xs ml-auto">
            synced {new Date(data.zohoSyncedAt).toLocaleString()}
          </span>
        )}
      </div>

      {data.byCustomer.map(group => {
        const customerName = group.customerName || DEPT_NAMES[group.departmentId] || 'Unknown Customer'
        return (
          <Card key={group.departmentId} className="border-border/50">
            <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
              <span className="text-sm font-semibold">{customerName}</span>
              <Badge variant="secondary" className="text-xs">
                {group.count} ticket{group.count !== 1 ? 's' : ''}
              </Badge>
            </div>
            <CardContent className="pt-2 pb-2">
              <div className="space-y-1.5">
                {group.tickets.map(ticket => (
                  <div key={ticket.id} className="flex items-start gap-2 text-sm py-1">
                    <span className="text-muted-foreground font-mono text-xs shrink-0 mt-0.5">
                      {ticket.ticketNumber || ticket.id.slice(-6)}
                    </span>
                    {ticket.webUrl ? (
                      <a
                        href={ticket.webUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex-1 min-w-0 truncate"
                      >
                        {ticket.subject}
                      </a>
                    ) : (
                      <span className="flex-1 min-w-0 truncate">{ticket.subject}</span>
                    )}
                    {ticket.priority && (
                      <span className={cn('text-xs shrink-0', priorityColors[ticket.priority] || 'text-muted-foreground')}>
                        {ticket.priority}
                      </span>
                    )}
                    <Badge
                      variant={ticket.statusType === 'Closed' ? 'success' : 'secondary'}
                      className="text-xs shrink-0"
                    >
                      {ticket.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

/**
 * Compact badge showing Zoho ticket count — for use on release cards.
 */
export function ZohoImpactBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 font-medium"
      title={`${count} linked support ticket${count !== 1 ? 's' : ''}`}
    >
      {count} support
    </span>
  )
}
