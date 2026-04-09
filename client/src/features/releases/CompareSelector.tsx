import { useState, useMemo } from 'react'
import { useWsStore } from '../../stores/wsStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { cn } from '../../lib/utils'

type Tab = 'customer' | 'branch' | 'environment'

export interface CompareTarget {
  type: Tab
  version: string
  label: string // e.g., "Bayada Production (4.1.1)" or "releases/4.1.0.3"
}

const STORAGE_KEY = 'nectar:compare-target'

function loadSaved(releaseVersion: string): CompareTarget | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${releaseVersion}`)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function save(releaseVersion: string, target: CompareTarget) {
  try {
    localStorage.setItem(`${STORAGE_KEY}:${releaseVersion}`, JSON.stringify(target))
  } catch { /* quota */ }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (target: CompareTarget) => void
  releaseVersion: string
}

export function CompareSelector({ open, onOpenChange, onSelect, releaseVersion }: Props) {
  const [tab, setTab] = useState<Tab>('customer')
  const [search, setSearch] = useState('')

  const releases = useWsStore(s => s.releases)
  const environments = useWsStore(s => s.environments)
  const customers = useWsStore(s => s.customers)

  const q = search.toLowerCase()

  // ── Customer Production tab ─────────────────────────
  const customerOptions = useMemo(() => {
    const prodEnvs = environments.filter(e => e.tier === 'production' && e.currentVersion)
    // Group by customerId → pick the most common version
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
        options.push({
          customerId,
          name: customerNames.get(customerId) || customerId,
          version,
          envCount: count,
        })
      }
    }
    return options.sort((a, b) => b.envCount - a.envCount)
  }, [environments, customers])

  // ── Branch tab ──────────────────────────────────────
  const branchOptions = useMemo(() => {
    return releases
      .filter(r => r.branch && r.version !== releaseVersion)
      .map(r => ({ version: r.version, branch: r.branch!, repo: r.repo, state: r.state }))
      .sort((a, b) => b.version.localeCompare(a.version))
  }, [releases, releaseVersion])

  // ── Environment tab ─────────────────────────────────
  const envOptions = useMemo(() => {
    return environments
      .filter(e => e.currentVersion)
      .map(e => ({
        id: e.id,
        customerId: e.customerId,
        tier: e.tier,
        version: e.currentVersion!,
        name: e.name || e.id,
      }))
      .sort((a, b) => a.customerId.localeCompare(b.customerId) || a.id.localeCompare(b.id))
  }, [environments])

  function pick(target: CompareTarget) {
    save(releaseVersion, target)
    onSelect(target)
    onOpenChange(false)
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'customer', label: 'Customer Production' },
    { key: 'branch', label: 'Branch / Release' },
    { key: 'environment', label: 'Environment' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Compare {releaseVersion} against...</DialogTitle>
        </DialogHeader>

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
                  onClick={() => pick({ type: 'customer', version: o.version, label: `${o.name} (${o.version})` })}
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
              {/* Manual entry */}
              <div className="flex gap-2 mb-2">
                <Input
                  placeholder="Enter any version (e.g., 4.1.1)..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && search.trim()) {
                      pick({ type: 'branch', version: search.trim(), label: search.trim() })
                    }
                  }}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  disabled={!search.trim()}
                  onClick={() => pick({ type: 'branch', version: search.trim(), label: search.trim() })}
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
                    onClick={() => pick({ type: 'branch', version: o.version, label: `${o.version} (${o.branch})` })}
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
                  onClick={() => pick({ type: 'environment', version: o.version, label: `${o.id} (${o.version})` })}
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
      </DialogContent>
    </Dialog>
  )
}

export { loadSaved as loadCompareTarget }
