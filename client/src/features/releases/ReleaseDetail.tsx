import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useWsStore } from '../../stores/wsStore'
import { apiFetch } from '../../api/client'
import type { AuditEntry, ValidationReport } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { timeAgo, cn } from '../../lib/utils'
import { TruthView } from './TruthView'
import { NectarLoader } from '../../components/NectarLoader'

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
  const location = useLocation()

  // Determine where to go back based on navigation state
  const from = (location.state as { from?: string } | null)?.from
  const backPaths: Record<string, { path: string; label: string }> = {
    calendar: { path: '/calendar', label: 'Back to calendar' },
    roadmap:  { path: '/roadmap',  label: 'Back to roadmap' },
    tickets:  { path: '/tickets',  label: 'Back to tickets' },
  }
  const { path: backPath, label: backLabel } = backPaths[from || ''] || { path: '/', label: 'Back to releases' }

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
  const jiraBaseUrl = useWsStore(s => s.config.jiraBaseUrl)
  const jiraProject = useWsStore(s => s.config.jiraProject || 'DEV')
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  useEffect(() => {
    if (version) {
      apiFetch<AuditEntry[]>(`/audit/${version}`).then(setAudit).catch(() => {})
    }
  }, [version, release?.updatedAt])

  if (!release) {
    return <NectarLoader message="Loading release..." className="mt-32" />
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

  // ── Date helpers (consistent ISO format) ──────────────
  const fmtDate = (d: string | null | undefined) => d ? d.slice(0, 10) : null

  const cutDate = fmtDate(release.cutAt) || fmtDate(release.createdAt)
  const releaseDate = fmtDate(release.jiraReleaseDate)
  const today = new Date().toISOString().slice(0, 10)
  const isOverdue = releaseDate && !release.jiraReleased && releaseDate < today
  const isReleased = !!release.jiraReleased

  // Timeline progress: how far between cut → release date are we?
  const timelineProgress = (() => {
    if (!cutDate || !releaseDate) return null
    const start = new Date(cutDate).getTime()
    const end = new Date(releaseDate).getTime()
    const now = Date.now()
    if (end <= start) return 100
    return Math.min(100, Math.max(0, Math.round(((now - start) / (end - start)) * 100)))
  })()

  // Ticket health distribution for the timeline bar
  const ticketCounts = release.tickets.reduce(
    (acc, t) => {
      const s = (t.state || '').toLowerCase()
      if (s === 'done' || s === 'cherry-picked' || s === 'ready-for-testing') acc.done++
      else if (s === 'in-progress') acc.inProgress++
      else acc.pending++
      return acc
    },
    { done: 0, inProgress: 0, pending: 0 }
  )
  const totalTickets = release.tickets.length

  return (
    <div className="w-full">
      <Button variant="link" className="mb-2 px-0 text-xs" onClick={() => navigate(backPath)}>
        &larr; {backLabel}
      </Button>

      {/* Compact header: version + state + meta + actions all in one block */}
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {release.repo && (
            <Badge variant="secondary" className="text-xs">{release.repo}</Badge>
          )}
          <h2 className="text-2xl font-bold font-mono">{release.version}</h2>
          <Badge className={cn(stateColors[release.state], "text-xs px-2 py-0.5")} variant="outline">
            {release.state}
          </Badge>
          {release.risk.numericScore !== null && (
            <span className={cn("text-xs font-medium", release.risk.score === 'low' ? 'text-green-400' : release.risk.score === 'medium' ? 'text-yellow-400' : 'text-red-400')}>
              Risk: {release.risk.score?.toUpperCase()}
            </span>
          )}
          {jiraBaseUrl && release.jiraVersionId && (
            <a
              href={`${jiraBaseUrl}/projects/${jiraProject}/versions/${release.jiraVersionId}/tab/release-report-all-issues`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 hover:underline"
            >
              JIRA
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {nextStates.map(s => (
            <Button key={s} variant="outline" size="sm" className="text-xs h-7" onClick={() => transition(s)}>
              {s}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={validate}>Validate</Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={assessRisk}>Risk</Button>
          {release.presentationUrl && (
            <a href={release.presentationUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="text-xs h-7">Presentation</Button>
            </a>
          )}
        </div>
      </div>

      {/* Release timeline */}
      <div className="rounded-lg border bg-card p-4 mb-4">
        {/* Timeline bar */}
        <div className="flex items-center gap-3 mb-3">
          {/* Cut date anchor */}
          <div className="text-xs text-muted-foreground shrink-0 w-20 text-center">
            <div className="font-medium text-foreground">{cutDate}</div>
            <div className="text-[10px]">{release.cutAt ? 'cut' : 'created'}</div>
          </div>

          {/* Bar */}
          <div className="flex-1 relative">
            <div className="h-2 rounded-full bg-muted/30 overflow-hidden">
              {totalTickets > 0 ? (
                <div className="h-full flex">
                  <div
                    className="h-full bg-green-500/70 transition-all"
                    style={{ width: `${(ticketCounts.done / totalTickets) * 100}%` }}
                  />
                  <div
                    className="h-full bg-yellow-500/70 transition-all"
                    style={{ width: `${(ticketCounts.inProgress / totalTickets) * 100}%` }}
                  />
                  <div
                    className="h-full bg-muted-foreground/20 transition-all"
                    style={{ width: `${(ticketCounts.pending / totalTickets) * 100}%` }}
                  />
                </div>
              ) : (
                <div className="h-full bg-muted/50" />
              )}
            </div>
            {/* Today marker */}
            {timelineProgress !== null && !isReleased && (
              <div
                className="absolute top-0 w-0.5 h-4 -mt-1 bg-foreground/60"
                style={{ left: `${timelineProgress}%` }}
                title={`Today: ${today}`}
              >
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] text-muted-foreground whitespace-nowrap">
                  today
                </div>
              </div>
            )}
          </div>

          {/* Release date anchor */}
          <div className="text-xs shrink-0 w-20 text-center">
            <div className={cn("font-medium", isReleased ? 'text-green-400' : isOverdue ? 'text-yellow-400' : 'text-foreground')}>
              {releaseDate || '—'}
            </div>
            <div className={cn("text-[10px]", isReleased ? 'text-green-400' : isOverdue ? 'text-yellow-400' : 'text-muted-foreground')}>
              {isReleased ? 'released' : isOverdue ? 'overdue' : 'target'}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          <span><span className="font-mono text-foreground">{release.branch}</span></span>
          {release.cutFrom && (
            <span>from <span className="font-mono">{release.cutFrom.substring(0, 7)}</span></span>
          )}
          {release.cutBy && <span>by {release.cutBy}</span>}
          {release.cherryPicks.length > 0 && (
            <span>{release.cherryPicks.length} cherry-picks</span>
          )}
          {totalTickets > 0 && (
            <span className="ml-auto flex items-center gap-2">
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500/70" />{ticketCounts.done} done</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500/70" />{ticketCounts.inProgress} in progress</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/30" />{ticketCounts.pending} pending</span>
            </span>
          )}
        </div>
      </div>

      {/* Validation report (collapsible, only shown when triggered) */}
      {validation && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Badge variant={validation.ready ? 'success' : 'warning'}>
                {validation.ready ? 'Ready for release' : 'Not ready'}
              </Badge>
              <span className="text-xs text-muted-foreground">Validation Report</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {(['jira', 'git', 'ci', 'approvals'] as const).map(section => (
                <div key={section}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn("w-2 h-2 rounded-full", validation[section].ok ? "bg-green-400" : "bg-red-400")} />
                    <span className="font-medium capitalize text-xs">{section}</span>
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
          </CardContent>
        </Card>
      )}

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
