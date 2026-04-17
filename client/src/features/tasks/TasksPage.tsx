import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { timeAgo, cn } from '../../lib/utils'

interface TaskOutput {
  gammaUrl?: string
  notes?: string
}

interface TaskInput {
  version?: string
  repo?: string
  compareVersion?: string
}

interface Task {
  id: string
  type: string
  status: 'pending' | 'in-progress' | 'completed' | 'failed'
  input: TaskInput | null
  output: TaskOutput | null
  requestedBy: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
}

interface TasksResponse {
  tasks: Task[]
  total: number
  hasMore: boolean
}

type StatusFilter = 'all' | 'active' | 'completed' | 'failed'

const PAGE_SIZE = 50

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  'in-progress': 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  completed: 'bg-green-500/20 text-green-400 border-green-500/40',
  failed: 'bg-red-500/20 text-red-400 border-red-500/40',
}

const TYPE_LABELS: Record<string, string> = {
  'release-presentation': 'Presentation',
  'release-notes': 'Notes',
}

export function TasksPage() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState<Task[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')

  const loadTasks = useCallback(async (offset = 0, append = false) => {
    if (!append) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    try {
      // Build query params based on filter
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(offset))
      if (statusFilter === 'active') {
        // Active = pending + in-progress; we need two fetches or no filter and post-filter
        // Since the backend supports one status at a time, fetch all and filter client-side
        // for "active" which combines two statuses
      } else if (statusFilter === 'completed') {
        params.set('status', 'completed')
      } else if (statusFilter === 'failed') {
        params.set('status', 'failed')
      }

      const result = await apiFetch<TasksResponse>(`/tasks?${params.toString()}`)
      let fetched = result.tasks

      // Client-side filter for "active" (pending + in-progress)
      if (statusFilter === 'active') {
        fetched = fetched.filter(t => t.status === 'pending' || t.status === 'in-progress')
      }

      if (append) {
        setTasks(prev => [...prev, ...fetched])
      } else {
        setTasks(fetched)
      }
      setTotal(result.total)
      setHasMore(result.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    }
    setLoading(false)
    setLoadingMore(false)
  }, [statusFilter])

  useEffect(() => {
    loadTasks(0, false)
  }, [loadTasks])

  const loadMore = useCallback(() => {
    loadTasks(tasks.length, true)
  }, [loadTasks, tasks.length])

  // Compute summary counts from all loaded tasks
  const counts = useMemo(() => {
    const active = tasks.filter(t => t.status === 'pending' || t.status === 'in-progress').length
    const completed = tasks.filter(t => t.status === 'completed').length
    const failed = tasks.filter(t => t.status === 'failed').length
    return { active, completed, failed }
  }, [tasks])

  // Filter by search term
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return tasks
    return tasks.filter(t => {
      const version = t.input?.version || ''
      const repo = t.input?.repo || ''
      const requestedBy = t.requestedBy || ''
      const type = t.type || ''
      return (
        version.toLowerCase().includes(q) ||
        repo.toLowerCase().includes(q) ||
        requestedBy.toLowerCase().includes(q) ||
        type.toLowerCase().includes(q)
      )
    })
  }, [tasks, search])

  // Group tasks by release version, newest first
  const grouped = useMemo(() => {
    const groups = new Map<string, Task[]>()
    for (const task of filtered) {
      const key = task.input?.version || 'unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(task)
    }
    // Sort groups by the newest task's createdAt
    const entries = Array.from(groups.entries()).sort((a, b) => {
      const aNewest = a[1][0]?.createdAt || ''
      const bNewest = b[1][0]?.createdAt || ''
      return bNewest.localeCompare(aNewest)
    })
    return entries
  }, [filtered])

  // Track latest task per version to dim superseded ones
  const latestByVersion = useMemo(() => {
    const map = new Map<string, string>()
    for (const task of tasks) {
      const version = task.input?.version || 'unknown'
      if (!map.has(version)) {
        map.set(version, task.id)
      }
    }
    return map
  }, [tasks])

  const cancelTask = useCallback(async (taskId: string) => {
    try {
      await apiFetch(`/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', error: 'Cancelled by user' }),
      })
      loadTasks(0, false)
    } catch {
      // silently fail — refresh will show current state
    }
  }, [loadTasks])

  const filters: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
  ]

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Tasks</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {total} total
            {counts.active > 0 && <> / <span className="text-blue-400">{counts.active} active</span></>}
            {counts.completed > 0 && <> / <span className="text-green-400">{counts.completed} completed</span></>}
            {counts.failed > 0 && <> / <span className="text-red-400">{counts.failed} failed</span></>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadTasks(0, false)}>
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search by version, type, requester..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex rounded-md border text-xs">
          {filters.map((f, i, arr) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                "px-3 py-2 transition-colors",
                i === 0 && "rounded-l-md",
                i === arr.length - 1 && "rounded-r-md",
                i > 0 && "border-l",
                statusFilter === f.key ? "bg-primary text-primary-foreground" : "hover:bg-accent"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Task list */}
      {loading ? (
        <NectarLoader size="lg" message="Loading tasks..." className="mt-16" />
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => loadTasks(0, false)} className="mt-2">Retry</Button>
          </CardContent>
        </Card>
      ) : grouped.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            {tasks.length === 0
              ? 'No tasks yet. Generate a presentation from a release page to create one.'
              : 'No tasks match your search.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map(([version, groupTasks]) => (
            <Card key={version}>
              <CardContent className="p-0">
                {/* Group header — release version */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50 bg-muted/20">
                  <button
                    type="button"
                    onClick={() => navigate(`/releases/${version}`)}
                    className="text-sm font-mono font-medium text-primary hover:underline"
                  >
                    {version}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {groupTasks.length} task{groupTasks.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Task rows */}
                <div className="divide-y divide-border/30">
                  {groupTasks.map(task => {
                    const isLatest = latestByVersion.get(task.input?.version || 'unknown') === task.id
                    const isSuperseded = !isLatest && (task.status === 'completed' || task.status === 'failed')

                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "px-4 py-3 flex items-center gap-3 flex-wrap",
                          isSuperseded && "opacity-40"
                        )}
                      >
                        {/* Type badge */}
                        <Badge variant="outline" className="text-xs shrink-0">
                          {TYPE_LABELS[task.type] || task.type}
                        </Badge>

                        {/* Status badge */}
                        <Badge
                          variant="outline"
                          className={cn("text-xs shrink-0", STATUS_COLORS[task.status])}
                        >
                          {task.status === 'in-progress' ? 'In Progress' : task.status.charAt(0).toUpperCase() + task.status.slice(1)}
                        </Badge>

                        {/* Compare version indicator */}
                        {task.input?.compareVersion && (
                          <span className="text-xs text-muted-foreground">
                            vs {task.input.compareVersion}
                          </span>
                        )}

                        {/* Gamma link for completed tasks */}
                        {task.status === 'completed' && task.output?.gammaUrl && (
                          <a
                            href={task.output.gammaUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 hover:underline shrink-0"
                          >
                            View Presentation
                          </a>
                        )}

                        {/* Error message for failed tasks */}
                        {task.status === 'failed' && task.error && (
                          <span className="text-xs text-destructive truncate max-w-xs" title={task.error}>
                            {task.error}
                          </span>
                        )}

                        {/* Cancel button for active tasks */}
                        {(task.status === 'pending' || task.status === 'in-progress') && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-6 text-destructive border-destructive/30 hover:bg-destructive/10"
                            onClick={() => cancelTask(task.id)}
                          >
                            Cancel
                          </Button>
                        )}

                        {/* Spacer */}
                        <div className="flex-1" />

                        {/* Requested by */}
                        {task.requestedBy && (
                          <span className="text-xs text-muted-foreground shrink-0">
                            {task.requestedBy}
                          </span>
                        )}

                        {/* Time */}
                        <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
                          {timeAgo(task.completedAt || task.startedAt || task.createdAt)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Load more */}
          {hasMore && (
            <div className="text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
