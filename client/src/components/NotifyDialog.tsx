import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog'
import { cn } from '../lib/utils'
import { apiFetch } from '../api/client'
import { JiraLink } from './JiraLink'

// ── Types ─────────────────────────────────────────────────

interface CannedMessage {
  id: string
  label: string
  text: string
}

interface NotifyTicket {
  key: string
  summary: string
  assignee?: string | null
  qaAssignee?: string | null
  jiraStatus?: string
}

type RecipientType = 'dev' | 'qa' | 'both'
type Channel = 'dm' | 'release'

interface NotifyDialogProps {
  open: boolean
  onClose: () => void
  tickets: NotifyTicket[]
  version?: string
  senderName?: string
}

interface NotifyResult {
  sent: number
  recipients: string[]
  errors: string[]
}

// ── Component ─────────────────────────────────────────────

const CANNED_MESSAGES: CannedMessage[] = [
  { id: 'cherry-pick',     label: 'Cherry-pick request',  text: 'Can you cherry-pick this change?' },
  { id: 'status-update',   label: 'Status update',        text: 'Can you provide a status update on this?' },
  { id: 'release-blocker', label: 'Release blocker',      text: 'This is blocking the release — please prioritize.' },
  { id: 'ready-for-qa',    label: 'Ready for QA',         text: 'Ready for QA — please test when available.' },
  { id: 'testing-failed',  label: 'Testing failed',       text: 'Testing failed — please investigate and fix.' },
  { id: 'needs-retest',    label: 'Needs retest',         text: 'Cherry-pick is on the branch — please retest.' },
  { id: 'custom',          label: 'Custom message',       text: '' },
]

export function NotifyDialog({ open, onClose, tickets, version, senderName }: NotifyDialogProps) {
  const [recipientType, setRecipientType] = useState<RecipientType>('dev')
  const [channel, setChannel] = useState<Channel>('dm')
  const [selectedCanned, setSelectedCanned] = useState('cherry-pick')
  const [messageText, setMessageText] = useState(CANNED_MESSAGES[0].text)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<NotifyResult | null>(null)

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setResult(null)
      setSending(false)
    }
  }, [open])

  const handleCannedChange = (id: string) => {
    setSelectedCanned(id)
    const msg = CANNED_MESSAGES.find(m => m.id === id)
    if (msg) setMessageText(msg.text)
  }

  const handleSend = async () => {
    if (!messageText.trim() || sending) return
    setSending(true)
    try {
      const res = await apiFetch<NotifyResult>('/notify/tickets', {
        method: 'POST',
        body: JSON.stringify({
          ticketKeys: tickets.map(t => t.key),
          recipientType,
          channel,
          message: messageText.trim(),
          version,
          senderName,
        }),
      })
      setResult(res)
    } catch (err) {
      setResult({ sent: 0, recipients: [], errors: [(err as Error).message] })
    }
    setSending(false)
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="md:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Notify about {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
          </DialogTitle>
        </DialogHeader>

        {/* Result state */}
        {result ? (
          <div className="space-y-3 py-2">
            {result.sent > 0 ? (
              <div className="flex items-center gap-2 text-green-400">
                <span className="text-lg">✓</span>
                <span>Sent to {result.recipients.join(', ')}</span>
              </div>
            ) : (
              <div className="text-red-400">
                Failed to send{result.errors.length > 0 && `: ${result.errors[0]}`}
              </div>
            )}
            {result.errors.length > 0 && result.sent > 0 && (
              <div className="text-xs text-amber-400">
                {result.errors.length} warning{result.errors.length !== 1 ? 's' : ''}: {result.errors.join('; ')}
              </div>
            )}
            <DialogFooter>
              <button onClick={onClose} className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-accent">
                Close
              </button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Ticket list */}
            <div className="max-h-32 overflow-y-auto space-y-1 text-sm">
              {tickets.map(t => (
                <div key={t.key} className="flex items-center gap-2">
                  <JiraLink jiraKey={t.key} className="font-mono text-xs shrink-0" />
                  <span className="truncate text-foreground/80">{t.summary}</span>
                </div>
              ))}
            </div>

            {/* Recipient toggle */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">To</label>
              <div className="flex gap-1">
                {([['dev', 'Dev'], ['qa', 'QA'], ['both', 'Both']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setRecipientType(value)}
                    className={cn(
                      'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                      recipientType === value
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Channel toggle */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Via</label>
              <div className="flex gap-1">
                <button
                  onClick={() => setChannel('dm')}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                    channel === 'dm'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  DM
                </button>
                {version && (
                  <button
                    onClick={() => setChannel('release')}
                    className={cn(
                      'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
                      channel === 'release'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Release Channel
                  </button>
                )}
              </div>
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Message</label>
              <select
                value={selectedCanned}
                onChange={e => handleCannedChange(e.target.value)}
                className="w-full h-8 px-2 text-sm rounded-md border bg-background text-foreground"
              >
                {CANNED_MESSAGES.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <textarea
                value={messageText}
                onChange={e => setMessageText(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground resize-none"
                placeholder="Type your message..."
              />
            </div>

            {/* Footer */}
            <DialogFooter>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={!messageText.trim() || sending}
                className={cn(
                  'px-4 py-2 rounded-md text-sm font-medium transition-colors',
                  messageText.trim() && !sending
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
                )}
              >
                {sending ? 'Sending...' : 'Send Message'}
              </button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
