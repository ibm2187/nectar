import { useWsStore } from '../../stores/wsStore'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { timeAgo } from '../../lib/utils'

export function CustomersPage() {
  const customers = useWsStore(s => s.customers)

  if (customers.length === 0) {
    return (
      <div className="w-full">
        <h2 className="text-2xl font-bold mb-6">Customers</h2>
        <p className="text-muted-foreground text-sm italic py-8 text-center">
          No customers configured. Add customer environments to nectar.config.js to enable version tracking.
        </p>
      </div>
    )
  }

  return (
    <div className="w-full">
      <h2 className="text-2xl font-bold mb-6">Customer Version Map</h2>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Environments</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Production</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Staging</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-muted-foreground uppercase">Last Checked</th>
                </tr>
              </thead>
              <tbody>
                {customers.map(c => (
                  <tr key={c.name} className="border-b border-border/50 last:border-0">
                    <td className="py-2 px-3 font-semibold">{c.name}</td>
                    <td className="py-2 px-3">
                      {c.production ? (
                        <span className="font-mono">{c.production}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {c.productionReachable === false && (
                        <Badge variant="destructive" className="ml-2">unreachable</Badge>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {c.staging ? (
                        <span className="font-mono">{c.staging}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {c.stagingReachable === false && (
                        <Badge variant="destructive" className="ml-2">unreachable</Badge>
                      )}
                    </td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">
                      {timeAgo(c.productionLastChecked || c.stagingLastChecked)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
