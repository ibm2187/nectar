import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useWsStore } from '../../stores/wsStore'
import { useAuthStore } from '../../stores/authStore'
import { apiFetch } from '../../api/client'
import type { AuditEntry, ValidationReport, DatadogImpactResponse, ReleaseComment, DeliveryForecast } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { timeAgo, cn } from '../../lib/utils'
import { TruthView } from './TruthView'
import { CustomerImpact } from './CustomerImpact'
import { PipelineView } from './PipelineView'
import { NectarLoader } from '../../components/NectarLoader'
import { GenerateNotesDialog } from './GenerateNotesDialog'
import { EditDraftDialog } from './EditDraftDialog'
import { CustomerPills } from '../../components/CustomerPill'

interface TaskArtifact {
  type: string
  filename: string
  bytes: number
}

interface TaskInfo {
  id: string
  type: string
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  output: { gammaUrl?: string; notes?: string; artifacts?: TaskArtifact[] } | null
  input?: { prompt?: string } | null
  error: string | null
  createdAt: string
}

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
    home:     { path: '/',          label: 'Back to home' },
    releases: { path: '/releases',  label: 'Back to releases' },
    roadmap:  { path: '/roadmap',   label: 'Back to roadmap' },
    tickets:  { path: '/tickets',   label: 'Back to tickets' },
  }
  const { path: backPath, label: backLabel } = backPaths[from || ''] || { path: '/', label: 'Back to home' }

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
  const [notesDialogOpen, setNotesDialogOpen] = useState(false)
  const [editDraftOpen, setEditDraftOpen] = useState(false)
  const [notesTask, setNotesTask] = useState<TaskInfo | null>(null)
  const [notesTaskLoading, setNotesTaskLoading] = useState(false)
  const [notesTaskError, setNotesTaskError] = useState<string | null>(null)
  const [impactData, setImpactData] = useState<DatadogImpactResponse | null>(null)
  const [forecast, setForecast] = useState<DeliveryForecast | null>(null)
  const [comments, setComments] = useState<ReleaseComment[]>([])
  const [commentText, setCommentText] = useState('')
  const [commentPosting, setCommentPosting] = useState(false)
  const authUser = useAuthStore(s => s.user)
  const ssoEnabled = useAuthStore(s => s.ssoEnabled)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (version) {
      apiFetch<AuditEntry[]>(`/audit/${version}`).then(setAudit).catch(() => {})
    }
  }, [version, release?.updatedAt])

  // Fetch comments for this release
  useEffect(() => {
    if (!version) return
    apiFetch<ReleaseComment[]>(`/releases/${version}/comments`)
      .then(setComments)
      .catch(() => {})
  }, [version, release?.updatedAt])

  const postComment = useCallback(async () => {
    if (!version || !commentText.trim() || commentPosting) return
    setCommentPosting(true)
    try {
      const comment = await apiFetch<ReleaseComment>(`/releases/${version}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text: commentText.trim() }),
      })
      setComments(prev => [comment, ...prev])
      setCommentText('')
    } catch {
      // silently fail
    }
    setCommentPosting(false)
  }, [version, commentText, commentPosting])

  const deleteComment = useCallback(async (commentId: string) => {
    if (!version) return
    try {
      await apiFetch(`/releases/${version}/comments/${commentId}`, {
        method: 'DELETE',
      })
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch {
      // silently fail
    }
  }, [version])

  const currentUserEmail = authUser?.email || null
  const isAdmin = authUser?.role === 'admin' || !ssoEnabled

  // Fetch Datadog deployment impact for this version
  useEffect(() => {
    if (!version) return
    apiFetch<DatadogImpactResponse>(`/datadog/impact/${version}`)
      .then(setImpactData)
      .catch(() => {})
  }, [version])

  // Fetch delivery forecast for this version
  useEffect(() => {
    if (!version || !release?.repo) return
    apiFetch<DeliveryForecast>(`/releases/${release.repo}/${version}/forecast`)
      .then(setForecast)
      .catch(() => {})
  }, [version, release?.repo])

  // Check for existing release-notes task for this release
  const refreshNotesTask = useCallback(() => {
    if (!version) return
    apiFetch<TaskInfo[]>(`/tasks?type=release-notes&limit=1`)
      .then(tasks => {
        const match = tasks.find((t: any) => t.input?.version === version)
        if (match) setNotesTask(match)
      })
      .catch(() => {})
  }, [version])

  useEffect(() => { refreshNotesTask() }, [refreshNotesTask])

  // Poll for notes task status when pending or in-progress
  useEffect(() => {
    if (!notesTask || (notesTask.status !== 'pending' && notesTask.status !== 'in-progress')) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }

    pollRef.current = setInterval(() => {
      apiFetch<TaskInfo>(`/tasks/${notesTask.id}`)
        .then(updated => {
          setNotesTask(updated)
          if (updated.status === 'completed' || updated.status === 'failed') {
            if (pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
            }
          }
        })
        .catch(() => {})
    }, 5000)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [notesTask?.id, notesTask?.status])

  const generateNotes = useCallback(async (compareVersion: string, prompt: string) => {
    if (!version) return
    setNotesTaskLoading(true)
    setNotesTaskError(null)
    setNotesTask(null)
    try {
      const body: Record<string, unknown> = {
        type: 'release-notes',
        version,
        compareVersion,
        prompt: prompt || undefined,
      }
      const newTask = await apiFetch<TaskInfo>('/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setNotesTask(newTask)
      setNotesDialogOpen(false)
    } catch (err) {
      setNotesTaskError(err instanceof Error ? err.message : 'Failed to create task')
    }
    setNotesTaskLoading(false)
  }, [version])

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
        <div className="flex flex-wrap gap-1 md:gap-1.5 overflow-x-auto">
          {nextStates.map(s => (
            <Button key={s} variant="outline" size="sm" className="text-xs h-7" onClick={() => transition(s)}>
              {s}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={validate}>Validate</Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={assessRisk}>Risk</Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={async () => {
            try {
              const res = await apiFetch<{ ok: boolean; channel: string }>(`/releases/${version}/notify`, { method: 'POST' })
              if (res.ok) alert(`Posted to ${res.channel}`)
            } catch (err) {
              alert(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
            }
          }}>Notify Channel</Button>
          {/* Release Notes button */}
          {notesTaskLoading || (notesTask && (notesTask.status === 'pending' || notesTask.status === 'in-progress')) ? (
            <Button variant="outline" size="sm" className="text-xs h-7" disabled>
              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
              {notesTaskLoading ? 'Creating...' : notesTask?.status === 'pending' ? 'Queued...' : 'Generating notes...'}
            </Button>
          ) : notesTask && notesTask.status === 'completed' && notesTask.output?.artifacts?.length ? (
            <>
              {notesTask.output.artifacts.filter(a => a.type === 'pdf').map(a => (
                <a key={a.filename} href={`/api/releases/${version}/artifacts/${a.filename}`} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="text-xs h-7">Release Notes</Button>
                </a>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => setEditDraftOpen(true)}
              >
                Edit Draft
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 text-muted-foreground"
                onClick={() => setNotesDialogOpen(true)}
              >
                Regenerate Notes
              </Button>
            </>
          ) : notesTask && notesTask.status === 'failed' ? (
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => setNotesDialogOpen(true)}
            >
              Retry Notes
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="text-xs h-7"
              onClick={() => setNotesDialogOpen(true)}
            >
              Release Notes
            </Button>
          )}
        </div>
      </div>

      {/* Target customers */}
      {release.targetCustomers != null && (
        <div className="flex items-center gap-1.5 mb-4 -mt-2">
          <CustomerPills customerIds={release.targetCustomers} />
        </div>
      )}

      {/* Notes task error/status banner */}
      {notesTaskError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 mb-3 text-xs text-destructive">
          {notesTaskError}
        </div>
      )}
      {notesTask && notesTask.status === 'failed' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 mb-3 flex items-center justify-between">
          <span className="text-xs text-destructive">
            Release notes generation failed: {notesTask.error || 'Unknown error'}
          </span>
          <Button variant="outline" size="sm" className="text-xs h-6" onClick={() => setNotesDialogOpen(true)}>
            Retry
          </Button>
        </div>
      )}

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

      {/* Delivery Forecast */}
      {forecast && forecast.remaining > 0 && (
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-sm font-semibold">Delivery Forecast</span>
              <ForecastRiskBadge risk={forecast.risk} />
            </div>

            {/* Progress bar */}
            <div className="h-2 rounded-full bg-muted/30 overflow-hidden mb-2">
              <div
                className="h-full bg-green-500/70 transition-all"
                style={{ width: `${forecast.uniqueRemaining != null && forecast.remaining > 0
                  ? Math.max(0, 100 - (forecast.remaining / (forecast.remaining + (forecast.uniqueRemaining || 0))) * 100)
                  : 0}%` }}
              />
            </div>

            {/* Key metrics */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap mb-2">
              <span>
                <span className="text-foreground font-medium">{forecast.remaining}</span> remaining
              </span>
              {forecast.daysLate !== 0 && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className={cn("font-medium", forecast.daysLate > 0 ? 'text-red-400' : 'text-green-400')}>
                    {forecast.daysLate > 0 ? `${forecast.daysLate}d late` : `${Math.abs(forecast.daysLate)}d early`}
                  </span>
                </>
              )}
            </div>

            {/* Velocity summary */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap mb-2">
              <span>
                Dev: <span className="text-foreground font-medium">{forecast.velocity.devTotal}</span>/day total
              </span>
              <span className="text-muted-foreground/50">|</span>
              <span>
                QA: <span className="text-foreground font-medium">{forecast.velocity.qaTotal}</span>/day total
              </span>
            </div>

            {/* Risk message */}
            <div className="text-xs text-muted-foreground mb-2">
              {forecast.riskMessage}
            </div>

            {/* Projected date vs deadline */}
            {forecast.projectedDate && (
              <div className="text-xs text-muted-foreground mb-2">
                Projected completion: <span className={cn(
                  "font-medium",
                  forecast.deadlineDate && forecast.projectedDate > forecast.deadlineDate ? 'text-red-400' : 'text-green-400'
                )}>{forecast.projectedDate}</span>
                {forecast.deadlineDate && (
                  <span className="ml-1">
                    (deadline: {forecast.deadlineDate})
                  </span>
                )}
              </div>
            )}

            {/* Bottleneck section */}
            {forecast.bottleneck && (
              <div className="text-xs text-orange-400/90 bg-orange-500/10 rounded px-2 py-1.5 mb-2">
                Bottleneck: <span className="font-medium">{forecast.bottleneck.person}</span>
                {' '}({forecast.bottleneck.role}) — {forecast.bottleneck.queueSize} tickets at {forecast.bottleneck.velocity}/day
              </div>
            )}

            {/* Suggestions list */}
            {forecast.suggestions && forecast.suggestions.length > 0 && (
              <div className="text-xs text-muted-foreground mb-2">
                <ul className="list-disc list-inside space-y-0.5">
                  {forecast.suggestions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Status breakdown */}
            {forecast.breakdown && forecast.remaining > 0 && (
              <div className="flex items-center gap-3 mt-3 text-[10px] text-muted-foreground flex-wrap">
                {forecast.breakdown.notStarted > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />{forecast.breakdown.notStarted} not started
                  </span>
                )}
                {forecast.breakdown.inDev > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-blue-500/70" />{forecast.breakdown.inDev} in dev
                  </span>
                )}
                {forecast.breakdown.blocked > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500/70" />{forecast.breakdown.blocked} blocked
                  </span>
                )}
                {forecast.breakdown.readyForQa > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-purple-500/70" />{forecast.breakdown.readyForQa} ready for QA
                  </span>
                )}
                {forecast.breakdown.inQa > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-yellow-500/70" />{forecast.breakdown.inQa} in QA
                  </span>
                )}
                {forecast.breakdown.awaitingCp > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-cyan-500/70" />{forecast.breakdown.awaitingCp} awaiting CP
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

      {/* Comments — at the top for visibility */}
      <CollapsibleSection title={`Comments${comments.length > 0 ? ` (${comments.length})` : ''}`} defaultOpen>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Add a comment..."
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postComment()
            }}
            disabled={commentPosting}
          />
          <Button variant="outline" size="sm" className="text-xs h-9" onClick={postComment} disabled={!commentText.trim() || commentPosting}>
            {commentPosting ? 'Posting...' : 'Post'}
          </Button>
        </div>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No comments yet. Add one to share context with your team.</p>
        ) : (
          <div className="space-y-3 max-h-80 overflow-auto">
            {comments.map(comment => {
              const canDelete = isAdmin || (currentUserEmail && comment.user === currentUserEmail)
              return (
                <div key={comment.id} className="flex items-start justify-between gap-2 py-2 border-b border-border/50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium">{comment.user}</span>
                      <span className="text-xs text-muted-foreground">{timeAgo(comment.createdAt)}</span>
                    </div>
                    <p className="text-sm text-foreground whitespace-pre-wrap break-words">{comment.text}</p>
                  </div>
                  {canDelete && (
                    <button className="text-muted-foreground hover:text-destructive text-xs shrink-0 mt-1" onClick={() => deleteComment(comment.id)} title="Delete comment">x</button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleSection>

      {/* Pipeline — Build + Deploy status */}
      {release.repo === 'webplatform' && (
        <CollapsibleSection
          title={`Pipeline${(release as any).pipeline?.latest ? ` — Build #${(release as any).pipeline.latest.buildNumber} ${(release as any).pipeline.latest.status}` : ''}`}
          defaultOpen={!!(release as any).pipeline?.latest}
        >
          <PipelineView pipeline={(release as any).pipeline || null} />
        </CollapsibleSection>
      )}

      {/* Truth view — JIRA + Git + PR reconciliation */}
      {release.repo && (
        <div className="mb-4">
          <TruthView repo={release.repo} version={release.version} prsByJiraKey={(release as any).prsByJiraKey || {}} buildByJiraKey={(release as any).buildByJiraKey || {}} />
        </div>
      )}

      {/* Customer Impact — Zoho support tickets linked to JIRA issues in this release */}
      <CollapsibleSection
        title={`Customer Impact${(release as any).zohoTickets?.length ? ` (${(release as any).zohoTickets.length} support tickets)` : ''}`}
        defaultOpen={(release as any).zohoTickets?.length > 0}
      >
        <CustomerImpact version={release.version} />
      </CollapsibleSection>

      {/* Deployment Impact */}
      {impactData && impactData.total > 0 && (
        <div className="rounded-lg border bg-card px-4 py-3 mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <span>Deployed to <span className="font-medium text-foreground">{impactData.total}</span> environment{impactData.total !== 1 ? 's' : ''}</span>
          {impactData.withImpactData > 0 && (() => {
            const totalAlerts = impactData.deployments.reduce((sum, d) => sum + (d.datadogImpact?.alertsTriggered ?? 0), 0)
            return (
              <span>
                &middot; <span className={cn('font-medium', totalAlerts > 0 ? 'text-red-400' : 'text-green-400')}>{totalAlerts}</span> alert{totalAlerts !== 1 ? 's' : ''} triggered
              </span>
            )
          })()}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CollapsibleSection title={`Approvals (${release.approvals.length})`} defaultOpen={release.approvals.length > 0}>
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
        </CollapsibleSection>

        <CollapsibleSection title={`Deployments (${release.deployments.length})`} defaultOpen={release.deployments.length > 0}>
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
        </CollapsibleSection>
      </div>

      <CollapsibleSection title={`Audit Trail (${audit.length})`} defaultOpen={false}>
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
      </CollapsibleSection>

      {/* Generate release notes dialog */}
      <GenerateNotesDialog
        open={notesDialogOpen}
        onOpenChange={setNotesDialogOpen}
        onGenerate={generateNotes}
        releaseVersion={release.version}
        loading={notesTaskLoading}
        initialPrompt={notesTask?.input?.prompt || ''}
      />

      {/* Edit draft dialog */}
      <EditDraftDialog
        open={editDraftOpen}
        onOpenChange={setEditDraftOpen}
        releaseVersion={release.version}
        onRegenerated={refreshNotesTask}
      />

    </div>
  )
}

function ForecastRiskBadge({ risk }: { risk: string }) {
  const config: Record<string, { label: string; cls: string }> = {
    'on-track': { label: 'ON TRACK', cls: 'bg-green-500/20 text-green-400 border-green-500/30' },
    tight:      { label: 'TIGHT',    cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
    'at-risk':  { label: 'AT RISK',  cls: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
    critical:   { label: 'CRITICAL', cls: 'bg-red-500/30 text-red-300 border-red-500/50' },
    unknown:    { label: 'UNKNOWN',  cls: 'bg-muted text-muted-foreground border-border' },
    // Legacy risk levels (fallback)
    low:        { label: 'LOW',      cls: 'bg-green-500/20 text-green-400 border-green-500/30' },
    medium:     { label: 'MEDIUM',   cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
    high:       { label: 'HIGH',     cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
  }
  const c = config[risk] || config.unknown
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-semibold", c.cls)}>
      {c.label}
    </span>
  )
}

function CollapsibleSection({ title, defaultOpen = true, children }: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Card className="mb-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-accent/30 transition-colors rounded-t-lg"
      >
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>
      {open && <CardContent className="pt-0">{children}</CardContent>}
    </Card>
  )
}

