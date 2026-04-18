import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../../api/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  releaseVersion: string
  onRegenerated: () => void // callback to refresh task state after regeneration
}

export function EditDraftDialog({ open, onOpenChange, releaseVersion, onRegenerated }: Props) {
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const isDirty = content !== originalContent

  // Fetch draft when dialog opens
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

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen && isDirty) {
      if (!confirm('You have unsaved changes. Discard?')) return
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Edit Release Notes — {releaseVersion}</DialogTitle>
            {isDirty && (
              <span className="text-xs text-yellow-400 font-medium">Unsaved changes</span>
            )}
          </div>
        </DialogHeader>

        {loading ? (
          <NectarLoader size="lg" message="Loading draft..." className="my-16" />
        ) : error && !content ? (
          <div className="text-center py-16">
            <p className="text-sm text-destructive mb-2">{error}</p>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        ) : (
          <>
            {/* Editor */}
            <textarea
              className={cn(
                "flex-1 min-h-[400px] w-full rounded-md border border-border bg-background",
                "px-4 py-3 font-mono text-sm leading-relaxed resize-none",
                "focus:outline-none focus:ring-1 focus:ring-ring",
                "placeholder:text-muted-foreground"
              )}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Draft markdown content..."
              spellCheck={false}
            />

            {/* Messages */}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {saveMsg && <p className="text-xs text-green-400">{saveMsg}</p>}

            {/* Hint */}
            <p className="text-xs text-muted-foreground">
              Edit the markdown above. The PDF will be regenerated from this draft with Viv branding, cover page, and styling applied automatically.
            </p>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" size="sm" onClick={() => handleClose(false)} disabled={saving}>
                Cancel
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveOnly}
                  disabled={saving || !isDirty}
                >
                  Save Draft
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveAndRegenerate}
                  disabled={saving}
                >
                  {saving ? (
                    <>
                      <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                      Saving...
                    </>
                  ) : (
                    'Save & Regenerate PDF'
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
