import { useEffect, useRef, useState } from 'react'
import { JiraLink } from './JiraLink'
import { cn } from '../lib/utils'

/**
 * JiraLink with a hover-card showing the Zoho support tickets linked to it.
 *
 * Pairs with the support mirror: when hovering a JIRA reference anywhere in
 * Nectar, the user can see which customer issues are tied to it without
 * leaving the page. Plain `JiraLink` is left untouched — opt in here only
 * for surfaces where the linkage is useful (ticket tables, releases, etc.).
 *
 * Implementation details:
 * - Lazy fetch on hover (200ms delay) so scrolling doesn't fire requests.
 * - Cached per-mount on success only — transient failures retry on the next
 *   hover so a one-off network blip doesn't permanently say "no tickets".
 * - JS event handlers (mouseenter/leave/focus/blur) drive open state.
 *   Mobile-tap-through is *not* attempted; the wrapped `<a>` opens JIRA
 *   in a new tab as before.
 * - Renders the fallback "no linked tickets" message inside the popup
 *   when the JIRA has zero links — never silently empty.
 */
interface JiraHoverCardProps {
  jiraKey: string
  className?: string
  children?: React.ReactNode
}

/**
 * Shape returned by GET /api/support/jira/:jiraKey/links → `tickets[]`.
 * These are *enriched ticket rows* (primary key `id`), not raw link rows
 * — `jira_zoho_links.zohoTicketId` is server-side only.
 */
interface EnrichedZohoTicket {
  id: string
  ticketNumber: string | null
  subject: string | null
  status: string | null
  statusType: string | null
  accountName: string | null
  webUrl: string | null
  ageDays: number | null
}

export function JiraHoverCard({ jiraKey, className, children }: JiraHoverCardProps) {
  const [open, setOpen] = useState(false)
  const [tickets, setTickets] = useState<EnrichedZohoTicket[] | null>(null)
  const [placement, setPlacement] = useState<'below' | 'above'>('below')
  const timerRef = useRef<number | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const fetchedRef = useRef(false)

  const show = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect()
      // Popup body can grow to ~320px (header + max-h-72 + padding); flip
      // above when there isn't room below.
      if (rect && rect.bottom + 320 > window.innerHeight) setPlacement('above')
      else setPlacement('below')
      setOpen(true)
      if (!fetchedRef.current) {
        ;(async () => {
          try {
            const res = await fetch(`/api/support/jira/${encodeURIComponent(jiraKey)}/links`)
            if (!res.ok) { setTickets([]); return }
            const data = await res.json() as { tickets?: EnrichedZohoTicket[] }
            setTickets(Array.isArray(data.tickets) ? data.tickets : [])
            // Only mark as cached on a successful response — transient
            // failures should retry on next hover.
            fetchedRef.current = true
          } catch {
            setTickets([])
          }
        })()
      }
    }, 200)
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
      <JiraLink jiraKey={jiraKey}>{children}</JiraLink>
      {open && (
        // bg-card (not bg-popover): bg-popover resolves transparent in this theme.
        <div
          className={cn(
            'absolute z-50 w-[420px] rounded-lg border border-border bg-card text-card-foreground shadow-2xl p-3 text-xs',
            placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1',
            'left-0'
          )}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <HoverContent jiraKey={jiraKey} tickets={tickets} />
        </div>
      )}
    </span>
  )
}

function HoverContent({ jiraKey, tickets }: { jiraKey: string; tickets: EnrichedZohoTicket[] | null }) {
  if (tickets === null) {
    return <div className="text-muted-foreground italic">Loading linked support tickets…</div>
  }
  if (tickets.length === 0) {
    return (
      <div className="text-muted-foreground italic">
        {jiraKey} — no linked Zoho support tickets.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{jiraKey}</span>
        <span className="text-[11px] text-muted-foreground">
          {tickets.length} linked support {tickets.length === 1 ? 'ticket' : 'tickets'}
        </span>
      </div>
      <div className="space-y-1.5 max-h-72 overflow-y-auto">
        {tickets.map(t => (
          <div key={t.id} className="flex items-baseline gap-2">
            {t.webUrl ? (
              <a
                href={t.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] text-primary hover:underline shrink-0"
              >
                {t.ticketNumber || '(unknown)'}
              </a>
            ) : (
              <span className="font-mono text-[11px] shrink-0">{t.ticketNumber || '(unknown)'}</span>
            )}
            {t.statusType && (
              <span className={cn(
                'text-[10px] px-1.5 rounded border shrink-0',
                t.statusType === 'Open' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' :
                t.statusType === 'Closed' ? 'bg-muted text-muted-foreground border-muted-foreground/20' :
                'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
              )}>
                {t.status || t.statusType}
              </span>
            )}
            {typeof t.ageDays === 'number' && (
              <span className="text-[10px] text-muted-foreground shrink-0">{t.ageDays}d</span>
            )}
            <span className="flex-1 min-w-0 truncate">{t.subject || '(no subject)'}</span>
            {t.accountName && (
              <span className="text-[10px] text-muted-foreground truncate max-w-[10rem] shrink-0">
                {t.accountName}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
