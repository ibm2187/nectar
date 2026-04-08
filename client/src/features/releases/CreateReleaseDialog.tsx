import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { apiFetch } from '../../api/client'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateReleaseDialog({ open, onOpenChange }: Props) {
  const [version, setVersion] = useState('')
  const [branch, setBranch] = useState('')
  const [cutFrom, setCutFrom] = useState('')
  const [cutBy, setCutBy] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const body: Record<string, string> = { version }
      if (branch) body.branch = branch
      if (cutFrom) body.cutFrom = cutFrom
      if (cutBy) body.cutBy = cutBy
      await apiFetch('/releases', { method: 'POST', body: JSON.stringify(body) })
      onOpenChange(false)
      setVersion(''); setBranch(''); setCutFrom(''); setCutBy('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Release</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="version">Version</Label>
            <Input id="version" placeholder="4.2.1" value={version} onChange={e => setVersion(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch">Branch</Label>
            <Input id="branch" placeholder="releases/4.2.1" value={branch} onChange={e => setBranch(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cutFrom">Cut from (SHA)</Label>
            <Input id="cutFrom" placeholder="abc1234" value={cutFrom} onChange={e => setCutFrom(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cutBy">Cut by</Label>
            <Input id="cutBy" placeholder="nukulb" value={cutBy} onChange={e => setCutBy(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading || !version}>
              {loading ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
