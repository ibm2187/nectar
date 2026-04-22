import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useWsStore } from '../../stores/wsStore'
import { useAuthStore } from '../../stores/authStore'
import { apiFetch } from '../../api/client'
import type { AuditEntry, ValidationReport, DatadogImpactResponse, ReleaseComment, DeliveryForecast, Release, PipelineData } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '../../components/ui/sheet'
import { timeAgo, cn } from '../../lib/utils'
import { TruthView } from './TruthView'
import { CustomerImpact } from './CustomerImpact'
import { PipelineView } from './PipelineView'
import { NectarLoader } from '../../components/NectarLoader'
import { GatePipeline } from './GatePipeline'
import { ReleaseScorecard } from './ReleaseScorecard'
import { GenerateNotesDialog } from './GenerateNotesDialog'
import { EditDraftDialog } from './EditDraftDialog'
import { CustomerPills } from '../../components/CustomerPill'

interface TaskArtifact {
  type: string
  filename: string
  bytes?: number
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
  const [commentPanel, setCommentPanel] = useState(false)
  const [pipeline, setPipeline] = useState<PipelineData | null>(null)
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

  // WS slimRelease drops tickets + pipeline to avoid OOM on broadcast, so the
  // detail page fetches them per-release. pipelineSyncTick keeps the card
  // fresh when new builds land without a navigation refresh.
  const pipelineSyncTick = useWsStore(s => s.pipelineSyncTick)
  useEffect(() => {
    if (!version) return
    let cancelled = false
    apiFetch<Release>(`/releases/${version}`)
      .then(r => {
        if (cancelled) return
        setPipeline(r.pipeline ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setPipeline(null)
      })
    return () => { cancelled = true }
  }, [version, release?.updatedAt, pipelineSyncTick])

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
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setCommentPanel(true)}>
            {'\uD83D\uDCAC'} {comments.length} Comments
          </Button>
          {/* Release Notes button */}
          {notesTaskLoading || (notesTask && (notesTask.status === 'pending' || notesTask.status === 'in-progress')) ? (
            <Button variant="outline" size="sm" className="text-xs h-7" disabled>
              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
              {notesTaskLoading ? 'Creating...' : notesTask?.status === 'pending' ? 'Queued...' : 'Generating notes...'}
            </Button>
          ) : notesTask && notesTask.status === 'completed' && (notesTask.output?.artifacts?.length || notesTask.output?.notes) ? (
            <>
              {notesTask.output.artifacts?.filter(a => a.type === 'pdf').map(a => (
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

      {/* Release Train — gate pipeline + inline editors */}
      <GatePipeline
        version={release.version}
        releaseType={release.releaseType ?? null}
        shipDate={release.shipDate ?? null}
        jiraReleaseDate={release.jiraReleaseDate ?? null}
        milestones={release.milestones ?? []}
        templateVersion={release.templateVersion ?? null}
        onUpdate={() => {
          apiFetch(`/releases/${encodeURIComponent(version!)}`).catch(() => {})
        }}
      />

      {/* Scorecard — appears post-ship or when gates have been acted on */}
      <ReleaseScorecard
        version={release.version}
        shouldRender={
          !!release.milestones && release.milestones.length > 0 && (
            release.state === 'done' ||
            release.milestones.some(m => m.gate && (m.status === 'met' || m.status === 'missed' || m.status === 'skipped'))
          )
        }
      />

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

      {/* Delivery Forecast + Pipeline side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Delivery Forecast card */}
        {forecast && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-sm font-semibold">Delivery Forecast</span>
                {forecast.risk === 'unknown' ? (
                  <span className="text-[10px] text-muted-foreground italic">insufficient velocity data</span>
                ) : (
                  <ForecastRiskBadge risk={forecast.risk} />
                )}
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

              {/* Key metrics + velocity on one line */}
              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap mb-1">
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
                {forecast.velocity && (
                  <>
                    <span className="text-muted-foreground/50">|</span>
                    <span>Dev: <span className="text-foreground font-medium">{forecast.velocity.devTotal}</span>/d</span>
                    <span>QA: <span className="text-foreground font-medium">{forecast.velocity.qaTotal}</span>/d</span>
                  </>
                )}
              </div>

              {/* Projected date vs deadline */}
              {forecast.projectedDate && (
                <div className="text-xs text-muted-foreground mb-1">
                  Projected: <span className={cn(
                    "font-medium",
                    forecast.deadlineDate && forecast.projectedDate > forecast.deadlineDate ? 'text-red-400' : 'text-green-400'
                  )}>{forecast.projectedDate}</span>
                  {forecast.deadlineDate && (
                    <span className="ml-1 text-muted-foreground">(deadline: {forecast.deadlineDate})</span>
                  )}
                </div>
              )}

              {/* Risk message */}
              <div className="text-xs text-muted-foreground mb-1">
                {forecast.riskMessage}
              </div>

              {/* Bottlenecks — dev and QA */}
              {/* Bottlenecks — dev and QA */}
              {forecast.bottleneck && (forecast.bottleneck.devBottleneck || forecast.bottleneck.qaBottleneck) && (
                <div className="flex items-center gap-2 text-xs text-red-400 flex-wrap">
                  {forecast.bottleneck.devBottleneck && (forecast.bottleneck.devBottleneck.queueSize ?? 0) > 0 && (
                    <span>Dev: {forecast.bottleneck.devBottleneck.person} — {forecast.bottleneck.devBottleneck.queueSize} tickets at {forecast.bottleneck.devBottleneck.velocity}/day</span>
                  )}
                  {forecast.bottleneck.devBottleneck && (forecast.bottleneck.devBottleneck.queueSize ?? 0) > 0 && forecast.bottleneck.qaBottleneck && (forecast.bottleneck.qaBottleneck.queueSize ?? 0) > 0 && (
                    <span className="text-muted-foreground">|</span>
                  )}
                  {forecast.bottleneck.qaBottleneck && (forecast.bottleneck.qaBottleneck.queueSize ?? 0) > 0 && (
                    <span>QA: {forecast.bottleneck.qaBottleneck.person} — {forecast.bottleneck.qaBottleneck.queueSize} tickets at {forecast.bottleneck.qaBottleneck.velocity}/day</span>
                  )}
                </div>
              )}

              {/* Suggestions — expandable */}
              {forecast.suggestions && forecast.suggestions.length > 0 && (
                <SuggestionsList suggestions={forecast.suggestions} />
              )}

              {/* Status breakdown — stacked bar */}
              {forecast.breakdown && forecast.remaining > 0 && (() => {
                const b = forecast.breakdown
                const total = b.notStarted + b.inDev + b.blocked + b.readyForQa + b.inQa + b.awaitingCp
                if (total === 0) return null
                const pct = (v: number) => (v / total) * 100
                return (
                  <div className="mt-2">
                    <div className="flex h-2 rounded-full overflow-hidden bg-muted">
                      {b.notStarted > 0 && <div className="bg-gray-400" style={{ width: `${pct(b.notStarted)}%` }} title={`${b.notStarted} not started`} />}
                      {b.inDev > 0 && <div className="bg-yellow-400" style={{ width: `${pct(b.inDev)}%` }} title={`${b.inDev} in dev`} />}
                      {b.blocked > 0 && <div className="bg-red-400" style={{ width: `${pct(b.blocked)}%` }} title={`${b.blocked} blocked`} />}
                      {b.readyForQa > 0 && <div className="bg-purple-400" style={{ width: `${pct(b.readyForQa)}%` }} title={`${b.readyForQa} ready for QA`} />}
                      {b.inQa > 0 && <div className="bg-blue-400" style={{ width: `${pct(b.inQa)}%` }} title={`${b.inQa} in QA`} />}
                      {b.awaitingCp > 0 && <div className="bg-cyan-400" style={{ width: `${pct(b.awaitingCp)}%` }} title={`${b.awaitingCp} awaiting CP`} />}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground flex-wrap">
                      {b.notStarted > 0 && <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-400" />{b.notStarted}</span>}
                      {b.inDev > 0 && <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />{b.inDev}</span>}
                      {b.blocked > 0 && <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-red-400" />{b.blocked}</span>}
                      {b.readyForQa > 0 && <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-purple-400" />{b.readyForQa} QA</span>}
                      {b.inQa > 0 && <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-400" />{b.inQa}</span>}
                      {b.awaitingCp > 0 && <span className="inline-flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />{b.awaitingCp} CP</span>}
                    </div>
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        )}

        {/* Pipeline card */}
        {release.repo === 'webplatform' && (
          <Card>
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-sm font-semibold">
                {`Pipeline${pipeline?.latest ? ` — Build #${pipeline.latest.buildNumber} ${pipeline.latest.status}` : ''}`}
              </span>
            </button>
            <CardContent className="pt-0">
              <PipelineView pipeline={pipeline} />
            </CardContent>
          </Card>
        )}
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

      {/* Comments slide-out panel */}
      <Sheet open={commentPanel} onOpenChange={setCommentPanel}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Comments ({comments.length})</SheetTitle>
          </SheetHeader>
          <SheetBody>
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
              <div className="space-y-3">
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
          </SheetBody>
        </SheetContent>
      </Sheet>

    </div>
  )
}

function SuggestionsList({ suggestions }: { suggestions: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? suggestions : suggestions.slice(0, 2)

  return (
    <div className="text-xs text-muted-foreground mt-1">
      {visible.join('; ')}
      {suggestions.length > 2 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="ml-1 text-primary hover:underline cursor-pointer"
        >
          +{suggestions.length - 2} more
        </button>
      )}
      {expanded && suggestions.length > 2 && (
        <button
          onClick={() => setExpanded(false)}
          className="ml-1 text-primary hover:underline cursor-pointer"
        >
          show less
        </button>
      )}
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

