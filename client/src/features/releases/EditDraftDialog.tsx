import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../../api/client'
import { Button } from '../../components/ui/button'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  releaseVersion: string
  onRegenerated: () => void
}

export function EditDraftDialog({ open, onOpenChange, releaseVersion, onRegenerated }: Props) {
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const isDirty = content !== originalContent

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setSaveMsg(null)
    apiFetch<string>(`/releases/${releaseVersion}/draft`, { raw: true })
      .then(text => {
        setContent(text)
        setOriginalContent(text)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load draft')
      })
      .finally(() => setLoading(false))
  }, [open, releaseVersion])

  const handleSaveOnly = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSaveMsg(null)
    try {
      await apiFetch(`/releases/${releaseVersion}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content, regenerate: false }),
      })
      setOriginalContent(content)
      setSaveMsg('Draft saved')
      setTimeout(() => setSaveMsg(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }, [releaseVersion, content])

  const handleSaveAndRegenerate = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSaveMsg(null)
    try {
      await apiFetch(`/releases/${releaseVersion}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ content, regenerate: true }),
      })
      setOriginalContent(content)
      setSaveMsg('Saved — regenerating PDF...')
      onRegenerated()
      setTimeout(() => onOpenChange(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }, [releaseVersion, content, onRegenerated, onOpenChange])

  const handleClose = () => {
    if (isDirty) {
      if (!confirm('You have unsaved changes. Discard?')) return
    }
    onOpenChange(false)
  }

  // Line count for the gutter
  const lineCount = content.split('\n').length

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Edit Release Notes</h2>
          <span className="text-sm font-mono text-muted-foreground">{releaseVersion}</span>
          {isDirty && (
            <span className="text-xs text-yellow-400 font-medium px-2 py-0.5 rounded-full bg-yellow-400/10 border border-yellow-400/30">
              Unsaved changes
            </span>
          )}
          {saveMsg && (
            <span className="text-xs text-green-400 font-medium">{saveMsg}</span>
          )}
          {error && (
            <span className="text-xs text-destructive font-medium">{error}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground mr-2">{lineCount} lines</span>
          <Button variant="outline" size="sm" onClick={handleSaveOnly} disabled={saving || !isDirty}>
            Save Draft
          </Button>
          <Button size="sm" onClick={handleSaveAndRegenerate} disabled={saving}>
            {saving ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                Saving...
              </>
            ) : (
              'Save & Regenerate PDF'
            )}
          </Button>
          <div className="w-px h-6 bg-border mx-1" />
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
            Close
          </Button>
        </div>
      </div>

      {/* Editor body */}
      {loading ? (
        <NectarLoader size="lg" message="Loading draft..." className="mt-32" />
      ) : error && !content ? (
        <div className="text-center mt-32">
          <p className="text-sm text-destructive mb-3">{error}</p>
          <Button variant="outline" size="sm" onClick={handleClose}>Close</Button>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <textarea
            className={cn(
              "w-full h-full resize-none",
              "px-8 py-6 font-mono text-sm leading-[1.7]",
              "bg-background text-foreground",
              "focus:outline-none",
              "placeholder:text-muted-foreground"
            )}
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Draft markdown content..."
            spellCheck={false}
            autoFocus
          />
        </div>
      )}

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-6 py-2 border-t border-border shrink-0 text-xs text-muted-foreground">
        <span>
          Edit the markdown above. The PDF will be regenerated with Viv branding, cover page, and styling applied automatically.
        </span>
        <span className="font-mono">
          {content.length.toLocaleString()} chars
        </span>
      </div>
    </div>
  )
}
