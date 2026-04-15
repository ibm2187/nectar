import { useEffect } from 'react'
import { cn, timeAgo } from '../lib/utils'

export interface PrInfo {
  prNumber: number
  prTitle: string | null
  prAuthor: string | null
  prUrl: string
  prCreatedAt: string | null
  prUpdatedAt?: string | null
  status: 'open' | 'merged' | 'closed' | string
  repo?: string | null
  baseBranch?: string | null
}

type PrCategory = 'cherry-pick' | 'original' | 'other'

function categorizePr(pr: PrInfo): PrCategory {
  const base = pr.baseBranch || ''
  if (base.startsWith('releases/') || base.startsWith('VIV/') || base.startsWith('release/')) {
    return 'cherry-pick'
  }
  if (base === 'master' || base === 'main' || base === 'develop') {
    return 'original'
  }
  return 'other'
}

function categorizePrs(prs: PrInfo[]) {
  const cherryPicks: PrInfo[] = []
  const originals: PrInfo[] = []
  const others: PrInfo[] = []
  for (const pr of prs) {
    const cat = categorizePr(pr)
    if (cat === 'cherry-pick') cherryPicks.push(pr)
    else if (cat === 'original') originals.push(pr)
    else others.push(pr)
  }
  return { cherryPicks, originals, others }
}

// ── Panel ────────────────────────────────────────────────

interface PrDetailPanelProps {
  open: boolean
  onClose: () => void
  jiraKey: string
  summary: string
  prs: PrInfo[]
  githubSearchUrl?: string
  /** Current release version — used to highlight the matching cherry-pick */
  releaseVersion?: string | null
}

export function PrDetailPanel({ open, onClose, jiraKey, summary, prs, githubSearchUrl, releaseVersion }: PrDetailPanelProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  const { cherryPicks, originals, others } = categorizePrs(prs)

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-96 max-w-[90vw] bg-card border-l shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-mono font-semibold text-primary">{jiraKey}</h3>
            <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{summary}</p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* PR list — grouped by category */}
        <div className="flex-1 overflow-y-auto">
          {prs.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-muted-foreground">No pull requests found</p>
              {githubSearchUrl && (
                <a href={githubSearchUrl} target="_blank" rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline mt-2 inline-block">
                  Search on GitHub
                </a>
              )}
            </div>
          ) : (
            <>
              {cherryPicks.length > 0 && (
                <PrSection title={`Cherry-Picks${releaseVersion ? ` for ${releaseVersion}` : ''}`} icon="🍒" prs={cherryPicks} accentColor="green" releaseVersion={releaseVersion} />
              )}
              {originals.length > 0 && (
                <PrSection title="Original" icon="⑂" prs={originals} accentColor="blue" />
              )}
              {others.length > 0 && (
                <PrSection title="Other" icon="·" prs={others} accentColor="gray" />
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {githubSearchUrl && (
          <div className="px-5 py-3 border-t">
            <a href={githubSearchUrl} target="_blank" rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary">
              Search all PRs on GitHub
            </a>
          </div>
        )}
      </div>
    </>
  )
}

// ── Section ──────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  open:   'bg-green-500/15 text-green-400 border-green-500/30',
  merged: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  closed: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

const STATUS_DOTS: Record<string, string> = {
  open: 'bg-green-500',
  merged: 'bg-purple-500',
  closed: 'bg-gray-500',
}

function PrSection({ title, icon, prs, accentColor, releaseVersion }: {
  title: string
  icon: string
  prs: PrInfo[]
  accentColor: 'green' | 'blue' | 'gray'
  releaseVersion?: string | null
}) {
  const headerColors = {
    green: 'text-green-400',
    blue: 'text-blue-400',
    gray: 'text-muted-foreground',
  }

  return (
    <div className="px-5 py-3 border-b border-border/20 last:border-0">
      <h4 className={cn("text-xs font-semibold uppercase tracking-wider mb-2", headerColors[accentColor])}>
        {icon} {title} ({prs.length})
      </h4>
      <div className="space-y-2">
        {prs.map(pr => {
          // Highlight the cherry-pick that matches the current release
          const isMatch = !!(releaseVersion && pr.baseBranch && (
            pr.baseBranch.includes(releaseVersion) ||
            pr.baseBranch.endsWith(releaseVersion)
          ))
          return (
          <a
            key={pr.prNumber}
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "block rounded-lg border p-3 hover:border-primary/30 hover:bg-accent/20 transition-colors",
              isMatch ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20' : 'border-border/50'
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={cn("w-2 h-2 rounded-full shrink-0", STATUS_DOTS[pr.status] || STATUS_DOTS.closed)} />
              <span className="font-mono text-sm font-semibold text-primary">#{pr.prNumber}</span>
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border font-medium",
                STATUS_STYLES[pr.status] || STATUS_STYLES.closed
              )}>
                {pr.status}
              </span>
              {pr.baseBranch && (
                <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[120px]">
                  → {pr.baseBranch}
                </span>
              )}
            </div>
            {pr.prTitle && (
              <p className="text-sm text-foreground line-clamp-2 ml-[14px]">{pr.prTitle}</p>
            )}
            <div className="text-xs text-muted-foreground mt-1 ml-[14px] flex items-center gap-2">
              {pr.prAuthor && <span>{pr.prAuthor}</span>}
              {pr.prCreatedAt && <span>{timeAgo(pr.prCreatedAt)}</span>}
            </div>
          </a>
          )
        })}
      </div>
    </div>
  )
}

// ── Table badge ──────────────────────────────────────────

/**
 * Compact PR badge for table cells — shows cherry-pick and original counts.
 */
export function PrCellBadge({ prs, onClick }: { prs: PrInfo[]; onClick: () => void }) {
  if (prs.length === 0) return <span className="text-[11px] text-muted-foreground/30">—</span>

  const { cherryPicks, originals, others } = categorizePrs(prs)

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="inline-flex items-center gap-0.5 whitespace-nowrap cursor-pointer hover:opacity-80 transition-opacity"
      title={`${cherryPicks.length} cherry-pick, ${originals.length} original, ${others.length} other PRs`}
    >
      {cherryPicks.length > 0 && (
        <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-400">
          CP{cherryPicks.length}
        </span>
      )}
      {originals.length > 0 && (
        <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400">
          PR{originals.length}
        </span>
      )}
      {others.length > 0 && (
        <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium bg-gray-500/15 text-gray-400">
          +{others.length}
        </span>
      )}
    </button>
  )
}

// JIRA statuses that imply code activity
const CODE_STATUSES = new Set([
  'In Review', 'Development In Progress', 'In Progress',
  'Cherry Picked', 'Testing in Branch', 'Waiting for Cherry Pick', 'In Testing',
])

export function isCodeStatus(status: string): boolean {
  return CODE_STATUSES.has(status)
}
