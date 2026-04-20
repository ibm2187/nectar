import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/badge'
import { Card, CardContent } from '../../components/ui/card'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from '../../components/ui/sheet'
import { JiraLink } from '../../components/JiraLink'
import { PriorityBadge } from '../../components/TicketRow'
import { NectarLoader, NectarSpinner } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'
import { getStatusBadgeColor } from '../../lib/status-colors'

// ── Types ──────────────────────────────────────────────

interface TopTicket {
  key: string
  summary: string
  type: string | null
  status: string
  customerPriority: string | null
  assignee: string | null
}

interface TicketBreakdown {
  features: number
  tasks: number
  bugs: number
}

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
  ticketBreakdown: TicketBreakdown
  topTickets: TopTicket[]
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

interface TimeColumn {
  key: string
  label: string
  start: string
  end: string
}

interface RoadmapResponse {
  zoom: 'month' | 'week'
  months: TimeColumn[]
  modules: ModuleEntry[]
  customers: string[]
  projects: string[]
  products: string[]
  allModules: string[]
  allLabels: string[]
  allPeople: string[]
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
  priority: string | null
  customerPriority: string | null
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

type TicketTypeCategory = 'all' | 'features' | 'tasks' | 'bugs'

// ── Module colors ─────────────────────────────────────

const MODULE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'Scheduling':                  { bg: 'bg-blue-50 dark:bg-blue-900/40',      border: 'border-blue-300 dark:border-blue-600',      text: 'text-blue-700 dark:text-blue-200' },
  'Billing':                     { bg: 'bg-green-50 dark:bg-green-900/40',    border: 'border-green-300 dark:border-green-600',    text: 'text-green-700 dark:text-green-200' },
  'Payroll':                     { bg: 'bg-emerald-50 dark:bg-emerald-900/40', border: 'border-emerald-300 dark:border-emerald-600', text: 'text-emerald-700 dark:text-emerald-200' },
  'CRM':                         { bg: 'bg-purple-50 dark:bg-purple-900/40',  border: 'border-purple-300 dark:border-purple-600',  text: 'text-purple-700 dark:text-purple-200' },
  'Client & Caregiver Profiles': { bg: 'bg-violet-50 dark:bg-violet-900/40',  border: 'border-violet-300 dark:border-violet-600',  text: 'text-violet-700 dark:text-violet-200' },
  'ATS':                         { bg: 'bg-pink-50 dark:bg-pink-900/40',      border: 'border-pink-300 dark:border-pink-600',      text: 'text-pink-700 dark:text-pink-200' },
  'Workflows & Tasks':           { bg: 'bg-orange-50 dark:bg-orange-900/40',  border: 'border-orange-300 dark:border-orange-600',  text: 'text-orange-700 dark:text-orange-200' },
  'Clinical':                    { bg: 'bg-red-50 dark:bg-red-900/40',        border: 'border-red-300 dark:border-red-600',        text: 'text-red-700 dark:text-red-200' },
  'Compliance':                  { bg: 'bg-amber-50 dark:bg-amber-900/40',    border: 'border-amber-300 dark:border-amber-600',    text: 'text-amber-700 dark:text-amber-200' },
  'Data Import & Onboarding':    { bg: 'bg-cyan-50 dark:bg-cyan-900/40',      border: 'border-cyan-300 dark:border-cyan-600',      text: 'text-cyan-700 dark:text-cyan-200' },
  'Reporting':                   { bg: 'bg-indigo-50 dark:bg-indigo-900/40',  border: 'border-indigo-300 dark:border-indigo-600',  text: 'text-indigo-700 dark:text-indigo-200' },
  'Integrations':                { bg: 'bg-teal-50 dark:bg-teal-900/40',      border: 'border-teal-300 dark:border-teal-600',      text: 'text-teal-700 dark:text-teal-200' },
  'AI':                          { bg: 'bg-fuchsia-50 dark:bg-fuchsia-900/40', border: 'border-fuchsia-300 dark:border-fuchsia-600', text: 'text-fuchsia-700 dark:text-fuchsia-200' },
  'Messaging':                   { bg: 'bg-sky-50 dark:bg-sky-900/40',        border: 'border-sky-300 dark:border-sky-600',        text: 'text-sky-700 dark:text-sky-200' },
}

function getModuleColor(mod: string) {
  return MODULE_COLORS[mod] || { bg: 'bg-gray-50 dark:bg-gray-900/40', border: 'border-gray-300 dark:border-gray-600', text: 'text-gray-700 dark:text-gray-200' }
}

// ── Type badge colors ─────────────────────────────────

function getTypeColor(category: 'features' | 'tasks' | 'bugs') {
  if (category === 'features') return 'text-blue-600 dark:text-blue-400'
  if (category === 'bugs') return 'text-red-600 dark:text-red-400'
  return 'text-amber-600 dark:text-amber-400'
}

function getTypeLabel(category: 'features' | 'tasks' | 'bugs') {
  if (category === 'features') return 'F'
  if (category === 'bugs') return 'B'
  return 'T'
}

// ── Page ──────────────────────────────────────────────

export function RoadmapPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('q') || ''
  const customerFilter = searchParams.get('customer') || ''
  const projectFilter = searchParams.get('project') || ''
  const productFilter = searchParams.get('product') || ''
  const moduleFilter = searchParams.get('module') || ''
  const statusFilter = searchParams.get('status') || ''
  const labelFilter = searchParams.get('label') || ''
  const personFilter = searchParams.get('person') || ''
  const zoom = (searchParams.get('zoom') || 'month') as 'month' | 'week'

  const [data, setData] = useState<RoadmapResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<{ module: string; version: string; component?: string; typeFilter?: TicketTypeCategory } | null>(null)

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
      if (productFilter) params.set('product', productFilter)
      if (moduleFilter) params.set('module', moduleFilter)
      if (statusFilter) params.set('status', statusFilter)
      if (labelFilter) params.set('label', labelFilter)
      if (personFilter) params.set('person', personFilter)
      if (zoom) params.set('zoom', zoom)
      const qs = params.toString()
      const result = await apiFetch<RoadmapResponse>(`/roadmap${qs ? `?${qs}` : ''}`)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roadmap')
    }
    setLoading(false)
  }, [customerFilter, projectFilter, productFilter, moduleFilter, statusFilter, labelFilter, personFilter, zoom])

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

  // Visible time columns
  const visibleColumns = useMemo(() => {
    if (!data) return []
    return data.months
  }, [data])

  const isWeekly = zoom === 'week'
  const hasAnyFilter = customerFilter || projectFilter || productFilter || moduleFilter || statusFilter || labelFilter || personFilter

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
        <div className="flex items-center gap-2">
          {/* Zoom toggle */}
          <div className="flex rounded-md border border-input overflow-hidden">
            <button
              onClick={() => updateParams({ zoom: 'month' })}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                !isWeekly ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent/30',
              )}
            >
              Month
            </button>
            <button
              onClick={() => updateParams({ zoom: 'week' })}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors border-l border-input',
                isWeekly ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent/30',
              )}
            >
              Week
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
        </div>
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

        <select
          value={moduleFilter}
          onChange={e => updateParams({ module: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Modules</option>
          {data.allModules.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <select
          value={productFilter}
          onChange={e => updateParams({ product: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Products</option>
          {data.products.map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        <select
          value={labelFilter}
          onChange={e => updateParams({ label: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Labels</option>
          {data.allLabels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>

        <select
          value={personFilter}
          onChange={e => updateParams({ person: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All People</option>
          {data.allPeople.map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        <select
          value={statusFilter}
          onChange={e => updateParams({ status: e.target.value || null })}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="done">Done</option>
          <option value="notdone">Not Done</option>
        </select>

        {hasAnyFilter && (
          <Button variant="ghost" size="sm" onClick={() => updateParams({ customer: null, project: null, product: null, module: null, status: null, label: null, person: null })}>
            Clear filters
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={() => setExpandedModules(new Set(filteredModules.map(m => m.name)))}>
          Expand All
        </Button>
        <Button variant="outline" size="sm" onClick={() => setExpandedModules(new Set())}>
          Collapse All
        </Button>

        {customerFilter && (
          <span className="text-xs text-muted-foreground">
            Showing: {customerFilter} + untagged tickets
          </span>
        )}
      </div>

      {/* ── Roadmap grid ────────────────────────────────── */}
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full border-collapse text-sm min-w-[900px]">
          <thead className="sticky top-0 bg-muted/50 dark:bg-muted/70 z-20">
            <tr>
              <th className="text-left px-4 py-3 w-72 text-xs font-semibold uppercase tracking-wider text-muted-foreground sticky left-0 bg-muted/50 dark:bg-muted/70 z-30 border-r border-b">
                Module / Component
              </th>
              {visibleColumns.map((m, i) => {
                const isCurrentPeriod = isCurrentTimeBucket(m.key, isWeekly)
                return (
                  <th key={m.key} className={cn(
                    "text-center px-2 py-3 text-xs font-semibold uppercase tracking-wider border-b",
                    isWeekly ? 'min-w-[90px]' : 'min-w-[140px]',
                    isCurrentPeriod ? 'text-primary bg-primary/5' : 'text-muted-foreground',
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
                months={visibleColumns}
                expanded={expandedModules.has(mod.name)}
                onToggle={() => toggleModule(mod.name)}
                onCellClick={(version, component, typeFilter) => setDrawer({ module: mod.name, version, component, typeFilter })}
                isWeekly={isWeekly}
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
              initialTypeFilter={drawer.typeFilter}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

// ── Helper: check if a time bucket key is current ─────

function isCurrentTimeBucket(key: string, isWeekly: boolean): boolean {
  const now = new Date()
  if (isWeekly) {
    // Check if current date falls within this ISO week
    const dayOfWeek = now.getDay()
    const monday = new Date(now)
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7))
    monday.setHours(0, 0, 0, 0)
    const jan4 = new Date(monday.getFullYear(), 0, 4)
    const dayDiff = Math.floor((monday.getTime() - jan4.getTime()) / 86400000)
    const weekNum = Math.ceil((dayDiff + jan4.getDay() + 1) / 7)
    const currentKey = `${monday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
    return key === currentKey
  }
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return key === currentKey
}

// ── Module rows (expandable) ──────────────────────────

function ModuleRows({
  module: mod,
  months,
  expanded,
  onToggle,
  onCellClick,
  isWeekly,
}: {
  module: ModuleEntry
  months: TimeColumn[]
  expanded: boolean
  onToggle: () => void
  onCellClick: (version: string, component?: string, typeFilter?: TicketTypeCategory) => void
  isWeekly: boolean
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
            <span className={cn('text-xs transition-transform', expanded && 'rotate-90')}>&#9654;</span>
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
                <ReleaseCardCell
                  key={`${card.version}-${ci}`}
                  card={card}
                  color={color}
                  onClick={() => onCellClick(card.version)}
                  onTypeClick={(typeFilter) => onCellClick(card.version, undefined, typeFilter)}
                  isWeekly={isWeekly}
                />
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
                  <ReleaseCardCell
                    key={`${card.version}-${ci}`}
                    card={card}
                    color={color}
                    mini
                    onClick={() => onCellClick(card.version, comp.name)}
                    onTypeClick={(typeFilter) => onCellClick(card.version, comp.name, typeFilter)}
                    isWeekly={isWeekly}
                  />
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
  onTypeClick,
  isWeekly,
}: {
  card: ReleaseCard
  color: ReturnType<typeof getModuleColor>
  mini?: boolean
  onClick: () => void
  onTypeClick: (typeFilter: TicketTypeCategory) => void
  isWeekly: boolean
}) {
  const isDone = card.progress === 100
  const isOverdue = !isDone && card.jiraReleaseDate && new Date(card.jiraReleaseDate + 'T00:00:00') < new Date()
  const breakdown = card.ticketBreakdown
  const hasBreakdown = breakdown && (breakdown.features > 0 || breakdown.tasks > 0 || breakdown.bugs > 0)

  return (
    <div
      className={cn(
        'block w-full text-left rounded-md border px-2.5 transition-all hover:shadow-md mb-1',
        mini ? 'py-1' : 'py-1.5',
        isDone && 'border-green-400 bg-green-50 dark:bg-green-950/30',
        isOverdue && 'border-red-400 bg-red-50 dark:bg-red-950/30',
        !isDone && !isOverdue && cn(color.border, 'bg-background hover:bg-accent/20'),
      )}
    >
      {/* Header line: version + done count */}
      <button onClick={onClick} className="flex items-center gap-1.5 w-full text-left">
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
      </button>

      {/* Type breakdown: "3F 2T 1B" as clickable counts */}
      {!mini && hasBreakdown && (
        <div className="flex items-center gap-1.5 mt-1">
          {breakdown.features > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onTypeClick('features') }}
              className={cn('text-[10px] font-semibold tabular-nums hover:underline cursor-pointer', getTypeColor('features'))}
              title={`${breakdown.features} feature${breakdown.features > 1 ? 's' : ''}`}
            >
              {breakdown.features}{getTypeLabel('features')}
            </button>
          )}
          {breakdown.tasks > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onTypeClick('tasks') }}
              className={cn('text-[10px] font-semibold tabular-nums hover:underline cursor-pointer', getTypeColor('tasks'))}
              title={`${breakdown.tasks} task${breakdown.tasks > 1 ? 's' : ''}`}
            >
              {breakdown.tasks}{getTypeLabel('tasks')}
            </button>
          )}
          {breakdown.bugs > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onTypeClick('bugs') }}
              className={cn('text-[10px] font-semibold tabular-nums hover:underline cursor-pointer', getTypeColor('bugs'))}
              title={`${breakdown.bugs} bug${breakdown.bugs > 1 ? 's' : ''}`}
            >
              {breakdown.bugs}{getTypeLabel('bugs')}
            </button>
          )}
        </div>
      )}

      {/* Progress bar */}
      {!mini && (
        <ProgressBar progress={card.progress} className="mt-1" small />
      )}

      {/* Top tickets preview (non-mini, non-weekly only) */}
      {!mini && !isWeekly && card.topTickets && card.topTickets.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {card.topTickets.slice(0, 3).map(t => (
            <div key={t.key} className="text-[10px] text-muted-foreground leading-tight truncate" title={`${t.key}: ${t.summary}`}>
              <span className="font-medium text-foreground/70">{t.key.split('-').pop()}</span>{' '}
              {t.summary}
            </div>
          ))}
          {card.topTickets.length > 3 && (
            <button onClick={onClick} className="text-[10px] text-primary hover:underline">
              +{card.tickets - 3} more
            </button>
          )}
        </div>
      )}

      {/* In-progress/pending status line */}
      {!mini && !isDone && card.inProgress > 0 && (
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {card.inProgress} in progress, {card.pending} pending
        </div>
      )}
    </div>
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

function DrillDownDrawer({ module, version, component, initialTypeFilter }: { module: string; version: string; component?: string; initialTypeFilter?: TicketTypeCategory }) {
  const [data, setData] = useState<DrillDownResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState<TicketTypeCategory>(initialTypeFilter || 'all')

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (component) params.set('component', component)
    // We fetch all tickets and filter client-side for the type tabs
    const qs = params.toString()
    apiFetch<DrillDownResponse>(`/roadmap/${encodeURIComponent(module)}/${encodeURIComponent(version)}${qs ? `?${qs}` : ''}`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [module, version, component])

  // Reset type filter when drawer props change
  useEffect(() => {
    setTypeFilter(initialTypeFilter || 'all')
  }, [initialTypeFilter])

  const filteredTickets = useMemo(() => {
    if (!data) return []
    if (typeFilter === 'all') return data.tickets
    return data.tickets.filter(t => {
      const ticketType = (t.type || '').toLowerCase()
      if (typeFilter === 'features') return ticketType === 'story' || ticketType === 'feature' || ticketType === 'epic'
      if (typeFilter === 'bugs') return ticketType === 'bug'
      // tasks: everything else
      return ticketType !== 'story' && ticketType !== 'feature' && ticketType !== 'epic' && ticketType !== 'bug'
    })
  }, [data, typeFilter])

  // Count tickets by type for the tab labels
  const typeCounts = useMemo(() => {
    if (!data) return { all: 0, features: 0, tasks: 0, bugs: 0 }
    let features = 0, bugs = 0, tasks = 0
    for (const t of data.tickets) {
      const tt = (t.type || '').toLowerCase()
      if (tt === 'story' || tt === 'feature' || tt === 'epic') features++
      else if (tt === 'bug') bugs++
      else tasks++
    }
    return { all: data.tickets.length, features, tasks, bugs }
  }, [data])

  if (loading) return <NectarSpinner className="mt-12" />
  if (!data) return null

  const color = getModuleColor(module)

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          <span className={color.text}>{module}</span>
          {component && <span className="text-muted-foreground font-normal"> / {component}</span>}
          <span className="text-muted-foreground font-normal"> -- {version}</span>
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

          <Link to={`/releases/${data.repo}/${encodeURIComponent(data.version)}`} className="text-sm text-primary hover:underline">
            View full release &rarr;
          </Link>

          {/* Type filter tabs */}
          <div className="flex items-center gap-1 border-b pb-2">
            {(['all', 'features', 'tasks', 'bugs'] as const).map(tab => {
              const count = typeCounts[tab]
              const isActive = typeFilter === tab
              return (
                <button
                  key={tab}
                  onClick={() => setTypeFilter(tab)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent/30',
                  )}
                >
                  {tab === 'all' ? 'All' : tab === 'features' ? 'Features' : tab === 'tasks' ? 'Tasks' : 'Bugs'}
                  {' '}
                  <span className={cn('tabular-nums', isActive ? 'opacity-80' : 'opacity-60')}>({count})</span>
                </button>
              )
            })}
          </div>

          {/* Ticket list */}
          <div className="space-y-1">
            {filteredTickets.map(t => {
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
                      {t.type && (
                        <span className="text-[10px] text-muted-foreground italic">{t.type}</span>
                      )}
                      {t.component && !component && (
                        <span className="text-xs text-muted-foreground">{t.component}</span>
                      )}
                      {t.assignee && (
                        <span className="text-xs text-muted-foreground">{t.assignee}</span>
                      )}
                      {t.priority && (
                        <PriorityBadge value={t.priority} />
                      )}
                      {t.customerPriority && (
                        <PriorityBadge value={t.customerPriority} />
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

          {filteredTickets.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {typeFilter === 'all' ? 'No tickets in this release.' : `No ${typeFilter} in this release.`}
            </p>
          )}
        </div>
      </SheetBody>
    </>
  )
}
