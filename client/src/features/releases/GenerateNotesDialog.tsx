import { useState, useMemo } from 'react'
import { useWsStore } from '../../stores/wsStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { cn } from '../../lib/utils'

type Tab = 'customer' | 'branch' | 'environment'

interface CompareTarget {
  type: Tab
  version: string
  label: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGenerate: (compareVersion: string, prompt: string) => void
  releaseVersion: string
  loading?: boolean
  initialPrompt?: string
}

export function GenerateNotesDialog({
  open,
  onOpenChange,
  onGenerate,
  releaseVersion,
  loading,
  initialPrompt = '',
}: Props) {
  const [step, setStep] = useState<'compare' | 'prompt'>('compare')
  const [selectedTarget, setSelectedTarget] = useState<CompareTarget | null>(null)
  const [prompt, setPrompt] = useState(initialPrompt)
  const [tab, setTab] = useState<Tab>('customer')
  const [search, setSearch] = useState('')

  const releases = useWsStore(s => s.releases)
  const environments = useWsStore(s => s.environments)
  const customers = useWsStore(s => s.customers)

  const q = search.toLowerCase()

  // Reset state when dialog opens
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setStep('compare')
      setSelectedTarget(null)
      setPrompt(initialPrompt)
      setSearch('')
      setTab('customer')
    }
    onOpenChange(nextOpen)
  }

  const pickTarget = (target: CompareTarget) => {
    setSelectedTarget(target)
    setStep('prompt')
  }

  const handleGenerate = () => {
    if (!selectedTarget) return
    onGenerate(selectedTarget.version, prompt)
  }

  // ── Customer Production options ─────────────────────────
  const customerOptions = useMemo(() => {
    const prodEnvs = environments.filter(e => e.tier === 'production' && e.currentVersion)
    const byCustomer = new Map<string, Map<string, number>>()
    for (const e of prodEnvs) {
      if (!byCustomer.has(e.customerId)) byCustomer.set(e.customerId, new Map())
      const versions = byCustomer.get(e.customerId)!
      versions.set(e.currentVersion!, (versions.get(e.currentVersion!) || 0) + 1)
    }
    const customerNames = new Map(customers.map(c => [c.id, c.name]))
    const options: { customerId: string; name: string; version: string; envCount: number }[] = []
    for (const [customerId, versions] of byCustomer) {
      for (const [version, count] of versions) {
        options.push({ customerId, name: customerNames.get(customerId) || customerId, version, envCount: count })
      }
    }
    return options.sort((a, b) => b.envCount - a.envCount)
  }, [environments, customers])

  // ── Branch options ──────────────────────────────────
  const branchOptions = useMemo(() => {
    return releases
      .filter(r => r.branch && r.version !== releaseVersion)
      .map(r => ({ version: r.version, branch: r.branch!, repo: r.repo, state: r.state }))
      .sort((a, b) => b.version.localeCompare(a.version))
  }, [releases, releaseVersion])

  // ── Environment options ─────────────────────────────
  const envOptions = useMemo(() => {
    return environments
      .filter(e => e.currentVersion)
      .map(e => ({ id: e.id, customerId: e.customerId, tier: e.tier, version: e.currentVersion!, name: e.name || e.id }))
      .sort((a, b) => a.customerId.localeCompare(b.customerId) || a.id.localeCompare(b.id))
  }, [environments])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'customer', label: 'Customer Production' },
    { key: 'branch', label: 'Branch / Release' },
    { key: 'environment', label: 'Environment' },
  ]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'compare'
              ? `Generate release notes for ${releaseVersion}`
              : 'Generation instructions'}
          </DialogTitle>
        </DialogHeader>

        {step === 'compare' && (
          <>
            <p className="text-sm text-muted-foreground mb-2">
              Compare <span className="font-mono font-medium text-foreground">{releaseVersion}</span> against...
            </p>

            {/* Tabs */}
            <div className="flex gap-1 border-b mb-3">
              {tabs.map(t => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { setTab(t.key); setSearch('') }}
                  className={cn(
                    "px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px",
                    tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Search */}
            <Input
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="mb-3"
              autoFocus
            />

            {/* List */}
            <div className="flex-1 overflow-auto space-y-1 min-h-0">
              {tab === 'customer' && (
                customerOptions
                  .filter(o => !q || o.name.toLowerCase().includes(q) || o.version.includes(q) || o.customerId.includes(q))
                  .map(o => (
                    <button
                      key={`${o.customerId}:${o.version}`}
                      type="button"
                      onClick={() => pickTarget({ type: 'customer', version: o.version, label: `${o.name} (${o.version})` })}
                      className="w-full text-left px-3 py-2 rounded hover:bg-accent/50 flex items-center justify-between"
                    >
                      <div>
                        <span className="font-medium text-sm">{o.name}</span>
                        <span className="text-muted-foreground text-sm ml-2">{o.version}</span>
                      </div>
                      <Badge variant="secondary" className="text-xs">{o.envCount} env{o.envCount > 1 ? 's' : ''}</Badge>
                    </button>
                  ))
              )}

              {tab === 'branch' && (
                <>
                  <div className="flex gap-2 mb-2">
                    <Input
                      placeholder="Enter any version (e.g., 4.1.1)..."
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && search.trim()) {
                          pickTarget({ type: 'branch', version: search.trim(), label: search.trim() })
                        }
                      }}
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      disabled={!search.trim()}
                      onClick={() => pickTarget({ type: 'branch', version: search.trim(), label: search.trim() })}
                    >
                      Go
                    </Button>
                  </div>
                  {branchOptions
                    .filter(o => !q || o.version.includes(q) || (o.branch && o.branch.includes(q)))
                    .map(o => (
                      <button
                        key={o.version}
                        type="button"
                        onClick={() => pickTarget({ type: 'branch', version: o.version, label: `${o.version} (${o.branch})` })}
                        className="w-full text-left px-3 py-2 rounded hover:bg-accent/50 flex items-center justify-between"
                      >
                        <div>
                          <span className="font-mono text-sm">{o.version}</span>
                          <span className="text-muted-foreground text-xs ml-2">{o.branch}</span>
                        </div>
                        <Badge variant="outline" className="text-xs">{o.state}</Badge>
                      </button>
                    ))
                  }
                </>
              )}

              {tab === 'environment' && (
                envOptions
                  .filter(o => !q || o.id.toLowerCase().includes(q) || o.customerId.includes(q) || o.version.includes(q))
                  .map(o => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => pickTarget({ type: 'environment', version: o.version, label: `${o.id} (${o.version})` })}
                      className="w-full text-left px-3 py-2 rounded hover:bg-accent/50 flex items-center justify-between"
                    >
                      <div>
                        <span className="text-sm font-medium">{o.id}</span>
                        <span className="text-muted-foreground text-xs ml-2">{o.customerId} · {o.tier}</span>
                      </div>
                      <span className="text-xs font-mono text-muted-foreground">{o.version}</span>
                    </button>
                  ))
              )}
            </div>
          </>
        )}

        {step === 'prompt' && selectedTarget && (
          <div className="space-y-4">
            {/* Selected compare target */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Comparing against:</span>
              <Badge variant="secondary" className="text-xs font-mono">{selectedTarget.label}</Badge>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setStep('compare')}
              >
                Change
              </button>
            </div>

            {/* Prompt textarea */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Generation instructions
                <span className="text-muted-foreground font-normal ml-1">(optional)</span>
              </label>
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[100px]"
                placeholder="e.g. Focus on billing improvements, keep it short, executive summary style..."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={4}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Guide the AI on emphasis, audience, length, or tone. Leave blank for default release notes.
              </p>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleGenerate} disabled={loading}>
                {loading ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                    Creating...
                  </>
                ) : (
                  'Generate'
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
