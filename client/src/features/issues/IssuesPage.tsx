import { useEffect, useMemo, useRef, useState } from 'react'
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
            {issue.author && <> by {issue.author.login}</>}
            {issue.comments > 0 && <> · 💬 {issue.comments}</>}
          </div>
        </div>
      </div>
    </a>
  )
}

const ATTACHMENT_MAX_BYTES = 1 * 1024 * 1024
const ATTACHMENT_MAX_COUNT = 5
const ATTACHMENT_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

interface PendingAttachment {
  id: string
  filename: string
  contentType: string
  dataBase64: string
  previewUrl: string
  sizeBytes: number
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      // Strip "data:<mime>;base64," prefix.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const attachmentsRef = useRef<PendingAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Mirror state into a ref so the unmount cleanup always sees the latest.
  attachmentsRef.current = attachments

  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setLabels('')
      setErr(null)
      setAttachments(prev => {
        prev.forEach(a => URL.revokeObjectURL(a.previewUrl))
        return []
      })
    }
  }, [open])

  // Revoke object URLs on unmount to avoid leaks.
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(a => URL.revokeObjectURL(a.previewUrl))
    }
  }, [])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setErr(null)
    const next: PendingAttachment[] = []
    for (const file of Array.from(files)) {
      if (!ATTACHMENT_MIME.includes(file.type)) {
        setErr(`${file.name}: unsupported type (PNG, JPEG, GIF, or WebP only)`)
        continue
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setErr(`${file.name}: exceeds 1 MB limit`)
        continue
      }
      try {
        const dataBase64 = await readFileAsBase64(file)
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: file.name,
          contentType: file.type,
          dataBase64,
          previewUrl: URL.createObjectURL(file),
          sizeBytes: file.size,
        })
      } catch {
        setErr(`${file.name}: failed to read file`)
      }
    }
    setAttachments(prev => {
      const combined = [...prev, ...next].slice(0, ATTACHMENT_MAX_COUNT)
      if (prev.length + next.length > ATTACHMENT_MAX_COUNT) {
        setErr(`Only ${ATTACHMENT_MAX_COUNT} attachments allowed; extra files were dropped`)
      }
      return combined
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeAttachment(id: string) {
    setAttachments(prev => {
      const target = prev.find(a => a.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(a => a.id !== id)
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    setErr(null)
    try {
      const labelList = labels.split(',').map(l => l.trim()).filter(Boolean)
      const payloadAttachments = attachments.map(a => ({
        filename: a.filename,
        contentType: a.contentType,
        dataBase64: a.dataBase64,
      }))
      await apiFetch('/issues', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          labels: labelList,
          attachments: payloadAttachments,
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
            <label htmlFor="issue-attachments-input" className="text-xs font-medium text-muted-foreground mb-1 block">
              Attachments{' '}
              <span className="font-normal">
                {attachments.length >= ATTACHMENT_MAX_COUNT
                  ? '(max reached — remove one to add more)'
                  : `(images, max ${ATTACHMENT_MAX_COUNT} × 1 MB)`}
              </span>
            </label>
            <input
              id="issue-attachments-input"
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_MIME.join(',')}
              multiple
              onChange={e => handleFiles(e.target.files)}
              disabled={attachments.length >= ATTACHMENT_MAX_COUNT}
              className="block text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-secondary file:text-secondary-foreground file:px-3 file:py-1.5 file:text-xs file:font-medium file:cursor-pointer hover:file:bg-accent hover:file:text-accent-foreground disabled:opacity-50"
            />
            {attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {attachments.map(a => (
                  <div key={a.id} className="relative group">
                    <img
                      src={a.previewUrl}
                      alt={a.filename}
                      className="h-20 w-20 rounded-md object-cover border border-border"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={`Remove ${a.filename}`}
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-xs leading-none flex items-center justify-center shadow"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
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
          {submitting && attachments.length > 0 && (
            <p className="text-xs text-muted-foreground flex items-center gap-2" role="status" aria-live="polite">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground animate-spin" />
              Uploading {attachments.length} attachment{attachments.length === 1 ? '' : 's'}…
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting
                ? attachments.length > 0 ? 'Uploading…' : 'Creating…'
                : 'Create Issue'}
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
