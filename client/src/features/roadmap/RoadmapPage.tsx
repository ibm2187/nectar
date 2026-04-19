import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '../../components/ui/sheet'
import { JiraLink } from '../../components/JiraLink'
import { NectarLoader, NectarSpinner } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'
import { getStatusBadgeColor } from '../../lib/status-colors'

// ── Types ──────────────────────────────────────────────

interface ReleaseCard {
  repo: string
  version: string
  state: string
  jiraReleaseDate: string | null
  month: string
  customers: string[]
  tickets: number
  done: number
  inProgress: number
  pending: number
  progress: number
}

interface ComponentEntry {
  name: string
  months: Record<string, ReleaseCard[]>
  totalTickets: number
  totalDone: number
  progress: number
}

interface ModuleEntry {
  name: string
  months: Record<string, ReleaseCard[]>
  components: ComponentEntry[]
  totalTickets: number
  totalDone: number
  progress: number
}

interface MonthColumn {
  key: string
  label: string
  start: string
  end: string
}

interface RoadmapResponse {
  months: MonthColumn[]
  modules: ModuleEntry[]
  customers: string[]
  projects: string[]
  products: string[]
  stats: {
    totalModules: number
    totalReleases: number
    totalTickets: number
  }
}

interface DrillDownTicket {
  key: string
  summary: string
  jiraStatus: string
  state: string
  type: string | null
  assignee: string | null
  module: string | null
  component: string | null
  customerTags: string[]
  projects: string[]
  product: string[]
  labels: string[]
  inTarget: boolean
  inFixVersion: boolean
}

interface DrillDownResponse {
  module: string
  component: string | null
  version: string
  repo: string
  state: string
  jiraReleaseDate: string | null
  tickets: DrillDownTicket[]
  stats: { total: number; done: number; remaining: number }
}

// ── Module colors ─────────────────────────────────────

const MODULE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'Scheduling':                  { bg: 'bg-blue-50 dark:bg-blue-950/30',      border: 'border-blue-300 dark:border-blue-700',      text: 'text-blue-700 dark:text-blue-300' },
  'Billing':                     { bg: 'bg-green-50 dark:bg-green-950/30',    border: 'border-green-300 dark:border-green-700',    text: 'text-green-700 dark:text-green-300' },
  'Payroll':                     { bg: 'bg-emerald-50 dark:bg-emerald-950/30', border: 'border-emerald-300 dark:border-emerald-700', text: 'text-emerald-700 dark:text-emerald-300' },
  'CRM':                         { bg: 'bg-purple-50 dark:bg-purple-950/30',  border: 'border-purple-300 dark:border-purple-700',  text: 'text-purple-700 dark:text-purple-300' },
  'Client & Caregiver Profiles': { bg: 'bg-violet-50 dark:bg-violet-950/30',  border: 'border-violet-300 dark:border-violet-700',  text: 'text-violet-700 dark:text-violet-300' },
  'ATS':                         { bg: 'bg-pink-50 dark:bg-pink-950/30',      border: 'border-pink-300 dark:border-pink-700',      text: 'text-pink-700 dark:text-pink-300' },
  'Workflows & Tasks':           { bg: 'bg-orange-50 dark:bg-orange-950/30',  border: 'border-orange-300 dark:border-orange-700',  text: 'text-orange-700 dark:text-orange-300' },
  'Clinical':                    { bg: 'bg-red-50 dark:bg-red-950/30',        border: 'border-red-300 dark:border-red-700',        text: 'text-red-700 dark:text-red-300' },
  'Compliance':                  { bg: 'bg-amber-50 dark:bg-amber-950/30',    border: 'border-amber-300 dark:border-amber-700',    text: 'text-amber-700 dark:text-amber-300' },
  'Data Import & Onboarding':    { bg: 'bg-cyan-50 dark:bg-cyan-950/30',      border: 'border-cyan-300 dark:border-cyan-700',      text: 'text-cyan-700 dark:text-cyan-300' },
  'Reporting':                   { bg: 'bg-indigo-50 dark:bg-indigo-950/30',  border: 'border-indigo-300 dark:border-indigo-700',  text: 'text-indigo-700 dark:text-indigo-300' },
  'Integrations':                { bg: 'bg-teal-50 dark:bg-teal-950/30',      border: 'border-teal-300 dark:border-teal-700',      text: 'text-teal-700 dark:text-teal-300' },
  'AI':                          { bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/30', border: 'border-fuchsia-300 dark:border-fuchsia-700', text: 'text-fuchsia-700 dark:text-fuchsia-300' },
  'Messaging':                   { bg: 'bg-sky-50 dark:bg-sky-950/30',        border: 'border-sky-300 dark:border-sky-700',        text: 'text-sky-700 dark:text-sky-300' },
}

function getModuleColor(mod: string) {
  return MODULE_COLORS[mod] || { bg: 'bg-gray-50 dark:bg-gray-900/30', border: 'border-gray-300 dark:border-gray-700', text: 'text-gray-700 dark:text-gray-300' }
}

// ── Page ──────────────────────────────────────────────

export function RoadmapPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('q') || ''
  const customerFilter = searchParams.get('customer') || ''
  const projectFilter = searchParams.get('project') || ''

  const [data, setData] = useState<RoadmapResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<{ module: string; version: string; component?: string } | null>(null)

  function updateParams(updates: Record<string, string | null>) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      return next
    }, { replace: true })
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (customerFilter) params.set('customer', customerFilter)
      if (projectFilter) params.set('project', projectFilter)
      const qs = params.toString()
      const result = await apiFetch<RoadmapResponse>(`/roadmap${qs ? `?${qs}` : ''}`)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roadmap')
    }
    setLoading(false)
  }, [customerFilter, projectFilter])

  useEffect(() => { load() }, [load])

  function toggleModule(mod: string) {
    setExpandedModules(prev => {
      const next = new Set(prev)
      if (next.has(mod)) next.delete(mod)
      else next.add(mod)
      return next
    })
  }

  // Filter modules by search
  const filteredModules = useMemo(() => {
    if (!data) return []
    if (!search.trim()) return data.modules
    const q = search.toLowerCase()
    return data.modules.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.components.some(c => c.name.toLowerCase().includes(q))
    )
  }, [data, search])

  // Visible months (skip empty past months)
  const visibleMonths = useMemo(() => {
    if (!data) return []
    return data.months
  }, [data])

  if (loading) return <NectarLoader size="lg" message="Loading roadmap..." className="mt-32" />

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={load} className="mt-2">Retry</Button>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  return (
    <div className="w-full space-y-4">
      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Roadmap</h1>
          <p className="text-sm text-muted-foreground">
            {data.stats.totalTickets.toLocaleString()} tickets across {data.stats.totalModules} modules
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* ── Filters ─────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Search modules, components..."
          value={search}
          onChange={e => updateParams({ q: e.target.value || null })}
          className="max-w-xs"
        />

        <select
          value={customerFilter}
          onChange={e => updateParams({ customer: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Customers</option>
          {data.customers.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          value={projectFilter}
          onChange={e => updateParams({ project: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Projects</option>
          {data.projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        {(customerFilter || projectFilter) && (
          <Button variant="ghost" size="sm" onClick={() => updateParams({ customer: null, project: null })}>
            Clear filters
          </Button>
        )}

        {customerFilter && (
          <span className="text-xs text-muted-foreground">
            Showing: {customerFilter} + untagged tickets
          </span>
        )}
      </div>

      {/* ── Roadmap grid ────────────────────────────────── */}
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full border-collapse text-sm min-w-[900px]">
          <thead className="sticky top-0 bg-muted/50 z-20">
            <tr>
              <th className="text-left px-4 py-3 w-72 text-xs font-semibold uppercase tracking-wider text-muted-foreground sticky left-0 bg-muted/50 z-30 border-r border-b">
                Module / Component
              </th>
              {visibleMonths.map((m, i) => {
                const isCurrentMonth = m.key === `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
                return (
                  <th key={m.key} className={cn(
                    "text-center px-2 py-3 text-xs font-semibold uppercase tracking-wider min-w-[140px] border-b",
                    isCurrentMonth ? 'text-primary bg-primary/5' : 'text-muted-foreground',
                    i > 0 && 'border-l',
                  )}>
                    {m.label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {filteredModules.map(mod => (
              <ModuleRows
                key={mod.name}
                module={mod}
                months={visibleMonths}
                expanded={expandedModules.has(mod.name)}
                onToggle={() => toggleModule(mod.name)}
                onCellClick={(version, component) => setDrawer({ module: mod.name, version, component })}
              />
            ))}
          </tbody>
        </table>
      </div>

      {filteredModules.length === 0 && (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            No modules match your search.
          </CardContent>
        </Card>
      )}

      {/* ── Drill-down drawer ───────────────────────────── */}
      <Sheet open={!!drawer} onOpenChange={() => setDrawer(null)}>
        <SheetContent className="md:max-w-xl">
          {drawer && (
            <DrillDownDrawer
              module={drawer.module}
              version={drawer.version}
              component={drawer.component}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

// ── Module rows (expandable) ──────────────────────────

function ModuleRows({
  module: mod,
  months,
  expanded,
  onToggle,
  onCellClick,
}: {
  module: ModuleEntry
  months: MonthColumn[]
  expanded: boolean
  onToggle: () => void
  onCellClick: (version: string, component?: string) => void
}) {
  const color = getModuleColor(mod.name)

  return (
    <>
      {/* Module header row */}
      <tr className={cn('cursor-pointer hover:brightness-95 transition-all', color.bg)}>
        <td
          className={cn('px-4 py-3 font-medium sticky left-0 z-10 border-r border-b', color.bg)}
          onClick={onToggle}
        >
          <div className="flex items-center gap-2">
            <span className={cn('text-xs transition-transform', expanded && 'rotate-90')}>▶</span>
            <div className={cn('w-1.5 h-6 rounded-full', color.border.replace('border-', 'bg-'))} />
            <span className={cn('font-semibold text-sm', color.text)}>{mod.name}</span>
            <span className="text-xs text-muted-foreground font-normal">({mod.totalTickets})</span>
            <div className="ml-auto flex items-center gap-2">
              <ProgressBar progress={mod.progress} className="w-20" />
              <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{mod.progress}%</span>
            </div>
          </div>
        </td>
        {months.map((m, i) => {
          const cards = mod.months[m.key] || []
          return (
            <td key={m.key} className={cn('px-1.5 py-1.5 align-top border-b', i > 0 && 'border-l')}>
              {cards.map((card, ci) => (
                <ReleaseCardCell key={`${card.version}-${ci}`} card={card} color={color} onClick={() => onCellClick(card.version)} />
              ))}
            </td>
          )
        })}
      </tr>

      {/* Component rows (visible when expanded) */}
      {expanded && mod.components.map(comp => (
        <tr key={comp.name} className="hover:bg-accent/10 transition-colors">
          <td className="px-4 py-1.5 sticky left-0 bg-background z-10 border-r border-b">
            <div className="flex items-center gap-2 pl-7">
              <span className="text-xs">{comp.name}</span>
              <span className="text-xs text-muted-foreground opacity-50">({comp.totalTickets})</span>
              <div className="ml-auto flex items-center gap-2">
                <ProgressBar progress={comp.progress} className="w-12" />
                <span className="text-[10px] text-muted-foreground tabular-nums w-7 text-right">{comp.progress}%</span>
              </div>
            </div>
          </td>
          {months.map((m, i) => {
            const cards = comp.months[m.key] || []
            return (
              <td key={m.key} className={cn('px-1.5 py-0.5 align-top border-b', i > 0 && 'border-l')}>
                {cards.map((card, ci) => (
                  <ReleaseCardCell key={`${card.version}-${ci}`} card={card} color={color} mini onClick={() => onCellClick(card.version, comp.name)} />
                ))}
              </td>
            )
          })}
        </tr>
      ))}

      {/* Show unscheduled if any */}
      {(mod.months['unscheduled'] || []).length > 0 && expanded && (
        <tr className="border-b bg-muted/20">
          <td className="px-3 py-1 sticky left-0 bg-muted/20 z-10 pl-9 text-xs text-muted-foreground italic">
            Unscheduled
          </td>
          <td colSpan={months.length} className="px-3 py-1">
            <div className="flex gap-2 flex-wrap">
              {(mod.months['unscheduled'] || []).map((card, i) => (
                <button
                  key={`${card.version}-${i}`}
                  onClick={() => onCellClick(card.version)}
                  className="text-xs px-2 py-0.5 rounded border bg-background hover:bg-accent/30 transition-colors"
                >
                  {card.version} ({card.tickets})
                </button>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Release card cell ─────────────────────────────────

function ReleaseCardCell({
  card,
  color,
  mini,
  onClick,
}: {
  card: ReleaseCard
  color: ReturnType<typeof getModuleColor>
  mini?: boolean
  onClick: () => void
}) {
  const isDone = card.progress === 100
  const isOverdue = !isDone && card.jiraReleaseDate && new Date(card.jiraReleaseDate) < new Date()

  return (
    <button
      onClick={onClick}
      className={cn(
        'block w-full text-left rounded-md border px-2.5 transition-all hover:shadow-md mb-1',
        mini ? 'py-1' : 'py-1.5',
        isDone && 'border-green-400 bg-green-50 dark:bg-green-950/30',
        isOverdue && 'border-red-400 bg-red-50 dark:bg-red-950/30',
        !isDone && !isOverdue && cn(color.border, 'bg-background hover:bg-accent/20'),
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('font-mono font-medium', mini ? 'text-[10px]' : 'text-xs')}>
          {card.version}
        </span>
        <span className={cn('ml-auto tabular-nums', mini ? 'text-[10px] text-muted-foreground' : 'text-xs font-medium')}>
          {isDone ? (
            <span className="text-green-600">Done</span>
          ) : (
            <span>{card.done}<span className="text-muted-foreground">/{card.tickets}</span></span>
          )}
        </span>
      </div>
      {!mini && (
        <>
          <ProgressBar progress={card.progress} className="mt-1" small />
          {card.inProgress > 0 && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {card.inProgress} in progress, {card.pending} pending
            </div>
          )}
        </>
      )}
    </button>
  )
}

// ── Progress bar ──────────────────────────────────────

function ProgressBar({ progress, className, small }: { progress: number; className?: string; small?: boolean }) {
  return (
    <div className={cn('rounded-full bg-muted overflow-hidden', small ? 'h-1' : 'h-1.5', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-all',
          progress === 100 ? 'bg-green-500' : progress > 50 ? 'bg-yellow-500' : 'bg-blue-500',
        )}
        style={{ width: `${Math.min(progress, 100)}%` }}
      />
    </div>
  )
}

// ── Drill-down drawer ─────────────────────────────────

function DrillDownDrawer({ module, version, component }: { module: string; version: string; component?: string }) {
  const [data, setData] = useState<DrillDownResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const params = component ? `?component=${encodeURIComponent(component)}` : ''
    apiFetch<DrillDownResponse>(`/roadmap/${encodeURIComponent(module)}/${encodeURIComponent(version)}${params}`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [module, version, component])

  if (loading) return <NectarSpinner className="mt-12" />
  if (!data) return null

  const color = getModuleColor(module)

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          <span className={color.text}>{module}</span>
          {component && <span className="text-muted-foreground font-normal"> / {component}</span>}
          <span className="text-muted-foreground font-normal"> — {version}</span>
        </SheetTitle>
      </SheetHeader>
      <SheetBody>
        <div className="space-y-3">
          {/* Stats */}
          <div className="flex gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Total: </span>
              <span className="font-medium">{data.stats.total}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Done: </span>
              <span className="font-medium text-green-600">{data.stats.done}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Remaining: </span>
              <span className="font-medium">{data.stats.remaining}</span>
            </div>
          </div>

          <ProgressBar progress={data.stats.total > 0 ? Math.round((data.stats.done / data.stats.total) * 100) : 0} />

          {/* Ticket list */}
          <div className="space-y-1">
            {data.tickets.map(t => {
              const statusColor = getStatusBadgeColor(t.jiraStatus)
              return (
                <div key={t.key} className="flex items-start gap-2 py-1.5 border-b last:border-0">
                  <JiraLink jiraKey={t.key} className="text-xs shrink-0 w-20" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm line-clamp-1">{t.summary}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {statusColor && (
                        <span className={cn("text-xs px-1.5 py-0 rounded-full", statusColor)}>
                          {t.jiraStatus}
                        </span>
                      )}
                      {t.component && !component && (
                        <span className="text-xs text-muted-foreground">{t.component}</span>
                      )}
                      {t.assignee && (
                        <span className="text-xs text-muted-foreground">{t.assignee}</span>
                      )}
                      {t.customerTags.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {t.customerTags.join(', ')}
                        </span>
                      )}
                      {!t.inFixVersion && t.inTarget && (
                        <Badge variant="outline" className="text-xs px-1 py-0 text-amber-600 border-amber-300">
                          planned only
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {data.tickets.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No tickets in this release.</p>
          )}
        </div>
      </SheetBody>
    </>
  )
}
