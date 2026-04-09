import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useWsStore } from '../../stores/wsStore'
import { apiFetch } from '../../api/client'
import type { AuditEntry, ValidationReport } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { timeAgo, cn } from '../../lib/utils'
import { TruthView } from './TruthView'

const TRANSITIONS: Record<string, string[]> = {
  planning: ['cutting'],
  cutting: ['stabilizing'],
  stabilizing: ['approved'],
  approved: ['deploying'],
  deploying: ['done', 'stabilizing'],
  done: [],
}

const stateColors: Record<string, string> = {
  planning: 'state-planning',
  cutting: 'state-cutting',
  stabilizing: 'state-stabilizing',
  approved: 'state-approved',
  deploying: 'state-deploying',
  done: 'state-done',
}

export function ReleaseDetail() {
  const { key } = useParams<{ key: string }>()
  const navigate = useNavigate()

  // key can be "repo:version" or just "version"
  const release = useWsStore(s => {
    if (!key) return undefined
    // Try matching by id pattern first
    return s.releases.find(r => {
      if (key.includes(':')) {
        const [repo, ver] = key.split(':')
        return r.repo === repo && r.version === ver
      }
      return r.version === key
    })
  })

  const version = release?.version ?? key
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  useEffect(() => {
    if (version) {
      apiFetch<AuditEntry[]>(`/audit/${version}`).then(setAudit).catch(() => {})
    }
  }, [version, release?.updatedAt])

  if (!release) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Release {version} not found</p>
        <Button variant="link" onClick={() => navigate('/')}>Back to releases</Button>
      </div>
    )
  }

  const nextStates = TRANSITIONS[release.state] || []

  async function transition(toState: string) {
    await apiFetch(`/releases/${version}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: toState }),
    })
  }

  async function validate() {
    const report = await apiFetch<ValidationReport>(`/releases/${version}/validate`)
    setValidation(report)
  }

  async function assessRisk() {
    await apiFetch(`/releases/${version}/risk?refresh=true`)
  }

  return (
    <div className="w-full">
      <Button variant="link" className="mb-4 px-0" onClick={() => navigate('/')}>
        &larr; Back to releases
      </Button>

      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        {release.repo && (
          <Badge variant="secondary" className="text-sm">{release.repo}</Badge>
        )}
        <h2 className="text-3xl font-bold font-mono">{release.version}</h2>
        <Badge className={cn(stateColors[release.state], "text-sm px-3 py-1")} variant="outline">
          {release.state}
        </Badge>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-6">
        {nextStates.map(s => (
          <Button key={s} variant="outline" size="sm" onClick={() => transition(s)}>
            Move to {s}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={validate}>Validate</Button>
        <Button variant="outline" size="sm" onClick={assessRisk}>Assess Risk</Button>
      </div>

      {/* Validation report */}
      {validation && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Validation Report</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              {(['jira', 'git', 'ci', 'approvals'] as const).map(section => (
                <div key={section}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn("w-2 h-2 rounded-full", validation[section].ok ? "bg-green-400" : "bg-red-400")} />
                    <span className="font-medium capitalize">{section}</span>
                  </div>
                  {validation[section].issues.length > 0 ? (
                    <ul className="text-muted-foreground text-xs space-y-0.5">
                      {validation[section].issues.map((issue, i) => (
                        <li key={i}>{issue.problem}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-xs text-muted-foreground">OK</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t">
              <Badge variant={validation.ready ? 'success' : 'warning'}>
                {validation.ready ? 'Ready for release' : 'Not ready'}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Info */}
      <Card className="mb-4">
        <CardHeader className="pb-3"><CardTitle className="text-base">Info</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-muted-foreground">Branch:</span> <span className="font-mono">{release.branch}</span></div>
            {release.cutFrom && <div><span className="text-muted-foreground">Cut from:</span> <span className="font-mono">{release.cutFrom.substring(0, 7)}</span></div>}
            {release.cutBy && <div><span className="text-muted-foreground">Cut by:</span> {release.cutBy}</div>}
            {release.cutAt && <div><span className="text-muted-foreground">Cut at:</span> {new Date(release.cutAt).toLocaleDateString()}</div>}
            {release.risk.numericScore !== null && (
              <div>
                <span className="text-muted-foreground">Risk:</span>{' '}
                <span className={release.risk.score === 'low' ? 'text-green-400' : release.risk.score === 'medium' ? 'text-yellow-400' : 'text-red-400'}>
                  {release.risk.score?.toUpperCase()} ({release.risk.numericScore})
                </span>
              </div>
            )}
          </div>
          {release.risk.factors.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs text-muted-foreground mb-1">Risk factors:</p>
              <ul className="text-xs space-y-0.5">
                {release.risk.factors.map((f, i) => (
                  <li key={i} className="text-muted-foreground">+{f.points} {f.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Truth view — JIRA + Git + PR reconciliation */}
      {release.repo && (
        <div className="mb-4">
          <TruthView repo={release.repo} version={release.version} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Approvals */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Approvals</CardTitle></CardHeader>
          <CardContent>
            {release.approvals.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No approvals</p>
            ) : (
              <div className="space-y-2">
                {release.approvals.map(a => (
                  <div key={a.role} className="flex items-center gap-2 text-sm">
                    <Badge variant="success">{a.role}</Badge>
                    <span className="text-muted-foreground">{a.user}</span>
                    <span className="text-muted-foreground text-xs">{timeAgo(a.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deployments */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">Deployments</CardTitle></CardHeader>
          <CardContent>
            {release.deployments.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No deployments</p>
            ) : (
              <div className="space-y-2">
                {release.deployments.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="font-semibold">{d.customer}</span>
                    <span className="text-muted-foreground">{d.env}</span>
                    <Badge variant={d.status === 'deployed' ? 'success' : 'warning'}>{d.status}</Badge>
                    <span className="text-muted-foreground text-xs">{timeAgo(d.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Audit Trail */}
      <Card className="mt-4">
        <CardHeader className="pb-3"><CardTitle className="text-base">Audit Trail</CardTitle></CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No audit entries</p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-auto">
              {audit.map(entry => (
                <div key={entry.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-border/50 last:border-0">
                  <span className="text-muted-foreground w-16 shrink-0">{timeAgo(entry.at)}</span>
                  <span className="font-mono text-primary">{entry.action}</span>
                  {entry.user && <span className="text-muted-foreground">by {entry.user}</span>}
                  <span className="text-muted-foreground truncate">{JSON.stringify(entry.detail)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
