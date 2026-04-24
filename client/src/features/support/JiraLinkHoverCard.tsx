import { useState, useRef, useEffect } from 'react'
import { JiraLink } from '../../components/JiraLink'
import type { SupportLinkedJira, SupportLinkedJiraTruth } from '../../stores/supportStore'
import { cn } from '../../lib/utils'

/**
 * JIRA key with a hover-card showing summary + per-release health.
 *
 * The bare JiraLink still click-navigates to JIRA. Hover reveals:
 *   - Summary, priority, assignee
 *   - One line per fix version with the ticket_truth healthCategory,
 *     PR link, and a one-sentence message
 *
 * Implementation uses plain CSS hover (group + group-hover) with a
 * portal-free absolute overlay — avoids dragging in a new tooltip
 * primitive and keeps mobile tap-through on the underlying JiraLink.
 */
interface JiraLinkHoverCardProps {
  /** Enriched data from the support API. If absent, renders a plain JiraLink. */
  link: SupportLinkedJira
  className?: string
}

export function JiraLinkHoverCard({ link, className }: JiraLinkHoverCardProps) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'below' | 'above'>('below')
  const timerRef = useRef<number | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  const show = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      // Flip above if there isn't room below
      const rect = anchorRef.current?.getBoundingClientRect()
      if (rect && rect.bottom + 240 > window.innerHeight) setPlacement('above')
      else setPlacement('below')
      setOpen(true)
    }, 250)
  }
  const hide = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setOpen(false), 100)
  }
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current) }, [])

  return (
    <span
      ref={anchorRef}
      className={cn('relative inline-block', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <JiraLink jiraKey={link.jiraKey} className="font-mono" />
      {open && (
        <div
          className={cn(
            'absolute z-50 w-[380px] rounded-lg border border-border bg-card text-foreground shadow-2xl',
            placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1',
            'left-0 p-3 text-xs'
          )}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <HoverContent link={link} />
        </div>
      )}
    </span>
  )
}

function HoverContent({ link }: { link: SupportLinkedJira }) {
  const truth = link.truth || []
  const hasAny = link.summary || link.status || link.fixVersions.length > 0 || truth.length > 0

  if (!hasAny) {
    return (
      <div className="text-muted-foreground italic">
        {link.jiraKey} — not yet in JIRA sync.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Header: key + summary */}
      <div>
        <div className="font-mono text-[11px] text-muted-foreground">{link.jiraKey}</div>
        {link.summary && (
          <div className="text-sm font-medium leading-snug">{link.summary}</div>
        )}
      </div>

      {/* Status / priority / assignee */}
      {(link.status || link.priority || link.assignee) && (
        <div className="flex items-center gap-2 flex-wrap text-muted-foreground">
          {link.status && <span>{link.status}</span>}
          {link.priority && <span>· {link.priority}</span>}
          {link.assignee && <span>· {link.assignee}</span>}
        </div>
      )}

      {/* Per-release health rows */}
      {truth.length > 0 ? (
        <div className="pt-1 border-t border-border/40 space-y-1">
          {truth.map(t => <TruthRow key={`${t.repo}:${t.version}`} truth={t} />)}
        </div>
      ) : link.fixVersions.length > 0 ? (
        <div className="pt-1 border-t border-border/40 text-muted-foreground">
          Ships in {link.fixVersions.join(', ')}
          <div className="text-[10px] italic mt-0.5">No release-health data computed yet.</div>
        </div>
      ) : null}
    </div>
  )
}

const HEALTH_COLOR: Record<string, string> = {
  attention:    'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
  'awaiting-cp':'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  'in-qa':      'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30',
  'in-dev':     'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30',
  done:         'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
}
const HEALTH_LABEL: Record<string, string> = {
  attention: 'Attention',
  'awaiting-cp': 'Awaiting CP',
  'in-qa': 'In QA',
  'in-dev': 'In Dev',
  done: 'Done',
}

function TruthRow({ truth }: { truth: SupportLinkedJiraTruth }) {
  const hc = truth.healthCategory || 'in-dev'
  const color = HEALTH_COLOR[hc] || HEALTH_COLOR['in-dev']
  const label = HEALTH_LABEL[hc] || hc
  return (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span className="font-mono text-[11px] font-medium w-20">{truth.version}</span>
      <span className={cn('inline-block px-1.5 rounded border text-[10px]', color)}>{label}</span>
      {truth.prNumber && (
        truth.prUrl ? (
          <a href={truth.prUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline">
            PR #{truth.prNumber}
          </a>
        ) : (
          <span className="text-[10px] text-muted-foreground">PR #{truth.prNumber}</span>
        )
      )}
      {truth.healthMessage && (
        <span className="text-[10px] text-muted-foreground flex-1 min-w-0 truncate">{truth.healthMessage}</span>
      )}
    </div>
  )
}
