import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWsStore } from '../../stores/wsStore'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { apiFetch } from '../../api/client'
import type { Release } from '../../api/client'
import { ReleaseCard } from './ReleaseCard'
import { CreateReleaseDialog } from './CreateReleaseDialog'
import { NectarLoader } from '../../components/NectarLoader'

const STATE_OPTIONS = [
  { value: 'active', label: 'Active (planned)' },
  { value: '', label: 'All states' },
  { value: 'planning', label: 'Planning' },
  { value: 'cutting', label: 'Cutting' },
  { value: 'stabilizing', label: 'Stabilizing' },
  { value: 'approved', label: 'Approved' },
  { value: 'deploying', label: 'Deploying' },
  { value: 'done', label: 'Done' },
] as const

const SORT_OPTIONS = [
  { value: 'version-desc', label: 'Version (newest)' },
  { value: 'version-asc', label: 'Version (oldest)' },
  { value: 'release-date', label: 'Release date (soonest)' },
  { value: 'updated', label: 'Last updated' },
  { value: 'tickets', label: 'Most tickets' },
  { value: 'repo', label: 'By repo' },
] as const

type SortOption = typeof SORT_OPTIONS[number]['value']

// Compare semver-ish versions: 4.2.10 > 4.2.9
function compareVersions(a: string, b: string): number {
  const ap = a.match(/^(\d+)\.(\d+)\.(\d+)/)
  const bp = b.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!ap || !bp) return a.localeCompare(b)
  for (let i = 1; i <= 3; i++) {
    const diff = parseInt(ap[i]) - parseInt(bp[i])
    if (diff !== 0) return diff
  }
  return a.localeCompare(b)
}

function getReleaseDate(r: Release): string {
  return r.jiraReleaseDate || r.cutAt || r.createdAt || ''
}

export function ReleasesPage() {
  const releases = useWsStore(s => s.releases)
  const [stateFilter, setStateFilter] = useState<string>('active')
  const [repoFilter, setRepoFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortOption>('version-desc')
  const [showCreate, setShowCreate] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const navigate = useNavigate()

  const repos = useMemo(() => {
    const set = new Set(releases.map(r => r.repo).filter(Boolean))
    return ['', ...Array.from(set).sort()] as string[]
  }, [releases])

  const filtered = useMemo(() => {
    let result = releases.filter(r => {
      // State filter
      if (stateFilter === 'active') {
        if (r.state === 'done') return false
        if (r.jiraReleased) return false
      } else if (stateFilter && r.state !== stateFilter) {
        return false
      }

      // Repo filter
      if (repoFilter && r.repo !== repoFilter) return false

      // Search filter
      if (search) {
        const q = search.toLowerCase()
        const haystack = `${r.version} ${r.repo || ''} ${r.branch || ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }

      return true
    })

    // Sort
    result = [...result].sort((a, b) => {
      switch (sort) {
        case 'version-desc':
          return compareVersions(b.version, a.version)
        case 'version-asc':
          return compareVersions(a.version, b.version)
        case 'release-date': {
          const ad = getReleaseDate(a) || '9999'
          const bd = getReleaseDate(b) || '9999'
          return ad.localeCompare(bd)
        }
        case 'updated':
          return (b.updatedAt || '').localeCompare(a.updatedAt || '')
        case 'tickets':
          return b.tickets.length - a.tickets.length
        case 'repo':
          return (a.repo || '').localeCompare(b.repo || '') || compareVersions(b.version, a.version)
        default:
          return 0
      }
    })

    return result
  }, [releases, stateFilter, repoFilter, search, sort])

  async function handleSync() {
    setSyncing(true)
    try {
      await apiFetch('/discover', { method: 'POST' })
    } catch { /* handled by ws updates */ }
    setSyncing(false)
  }

  const activeCount = releases.filter(r => r.state !== 'done' && !r.jiraReleased).length

  if (releases.length === 0) {
    return <NectarLoader message="Loading releases..." className="mt-32" />
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Releases</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {filtered.length} of {releases.length} · {activeCount} active · {repos.length - 1} repos
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync'}
          </Button>
          <Button onClick={() => setShowCreate(true)}>+ New Release</Button>
        </div>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Input
          placeholder="Search by version, repo, branch..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={repoFilter}
          onChange={e => setRepoFilter(e.target.value)}
        >
          {repos.map(r => (
            <option key={r} value={r}>{r || 'All repos'}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={stateFilter}
          onChange={e => setStateFilter(e.target.value)}
        >
          {STATE_OPTIONS.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          value={sort}
          onChange={e => setSort(e.target.value as SortOption)}
        >
          {SORT_OPTIONS.map(s => (
            <option key={s.value} value={s.value}>Sort: {s.label}</option>
          ))}
        </select>
        {(search || repoFilter || stateFilter !== 'active') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSearch(''); setRepoFilter(''); setStateFilter('active') }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm italic py-8 text-center">
            No releases match your filters.
          </p>
        ) : (
          filtered.map(r => (
            <ReleaseCard
              key={r.id}
              release={r}
              onClick={() => navigate(`/releases/${encodeURIComponent(r.repo ? `${r.repo}:${r.version}` : r.version)}`)}
            />
          ))
        )}
      </div>

      <CreateReleaseDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  )
}
