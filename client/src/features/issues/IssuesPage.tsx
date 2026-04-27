import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface IssueLabel {
  name: string
  color: string | null
}

interface IssueAuthor {
  login: string
  avatarUrl: string
}

interface Issue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  url: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: number
  author: IssueAuthor | null
  reporter: { email: string; name: string | null } | null
  labels: IssueLabel[]
}

interface IssuesResponse {
  repo: string
  issues: Issue[]
}

type StateFilter = 'open' | 'closed' | 'all'

export function IssuesPage() {
  const [data, setData] = useState<IssuesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState<StateFilter>('open')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const result = await apiFetch<IssuesResponse>(`/issues?state=${stateFilter}`)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issues')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [stateFilter])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.toLowerCase().trim()
    if (!q) return data.issues
    return data.issues.filter(i => {
      if (i.title.toLowerCase().includes(q)) return true
      if (i.number.toString().includes(q)) return true
      if (i.author?.login.toLowerCase().includes(q)) return true
      if (i.reporter?.email.toLowerCase().includes(q)) return true
      if (i.reporter?.name?.toLowerCase().includes(q)) return true
      if (i.labels.some(l => l.name.toLowerCase().includes(q))) return true
      return false
    })
  }, [data, search])

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Issues</h2>
          <p className="text-sm text-muted-foreground mt-1">
            File bugs, feature requests, and feedback for Nectar itself.
            {data && (
              <>
                {' · '}
                <a
                  href={`https://github.com/${data.repo}/issues`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {data.repo} on GitHub ↗
                </a>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>New Issue</Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search title, number, author, label..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex rounded-md border text-xs">
          {(['open', 'closed', 'all'] as const).map((s, i, arr) => (
            <button
              key={s}
              type="button"
              onClick={() => setStateFilter(s)}
              className={cn(
                "px-3 py-2 transition-colors capitalize",
                i === 0 && "rounded-l-md",
                i === arr.length - 1 && "rounded-r-md",
                i > 0 && "border-l",
                stateFilter === s ? "bg-primary text-primary-foreground" : "hover:bg-accent"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <NectarLoader size="lg" message="Loading issues..." className="mt-16" />
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={load} className="mt-2">Retry</Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground text-sm">
            {data && data.issues.length === 0
              ? `No ${stateFilter === 'all' ? '' : stateFilter + ' '}issues yet. Be the first to file one!`
              : 'No issues match your search.'}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-border/50">
              {filtered.map(issue => (
                <IssueRow key={issue.number} issue={issue} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <CreateIssueDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false)
          setStateFilter('open')
          load()
        }}
      />
    </div>
  )
}

function IssueRow({ issue }: { issue: Issue }) {
  const created = new Date(issue.createdAt)
  const relative = formatRelative(created)

  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block px-4 py-3 hover:bg-accent/20 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {issue.state === 'open' ? (
            <span className="inline-block w-4 h-4 rounded-full border-2 border-green-500" title="Open" />
          ) : (
            <span className="inline-block w-4 h-4 rounded-full bg-purple-500" title="Closed" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-medium text-sm">{issue.title}</span>
            <span className="text-xs text-muted-foreground">#{issue.number}</span>
            {issue.labels.map(label => (
              <Badge
                key={label.name}
                variant="outline"
                className="text-xs"
                style={label.color ? { borderColor: `#${label.color}`, color: `#${label.color}` } : undefined}
              >
                {label.name}
              </Badge>
            ))}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            opened {relative}
            <IssueOpenedBy reporter={issue.reporter} author={issue.author} />
            {issue.comments > 0 && <> · 💬 {issue.comments}</>}
          </div>
        </div>
      </div>
    </a>
  )
}

function IssueOpenedBy({ reporter, author }: {
  reporter: Issue['reporter']
  author: IssueAuthor | null
}) {
  if (reporter) {
    return (
      <> by <span className="font-medium" title={reporter.email}>
        {reporter.name || reporter.email}
      </span></>
    )
  }
  if (author) return <> by {author.login}</>
  return null
}

function CreateIssueDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setLabels('')
      setErr(null)
    }
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    setErr(null)
    try {
      const labelList = labels.split(',').map(l => l.trim()).filter(Boolean)
      await apiFetch('/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          labels: labelList,
        }),
      })
      onCreated()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Failed to create issue')
    }
    setSubmitting(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New Issue</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 mt-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Title *</label>
            <Input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Short summary of the issue"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Description <span className="font-normal">(Markdown supported)</span>
            </label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="What's the problem? Steps to reproduce? Expected vs actual?"
              rows={8}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Labels <span className="font-normal">(comma-separated, optional)</span>
            </label>
            <Input
              value={labels}
              onChange={e => setLabels(e.target.value)}
              placeholder="bug, feature-request, feedback"
            />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? 'Creating...' : 'Create Issue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}
