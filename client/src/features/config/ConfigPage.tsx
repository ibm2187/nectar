import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface ThemeEntry {
  name: string
  components: string[]
  icon: string | null
}

interface ThemeConfig {
  themes: ThemeEntry[]
  unmappedLabel: string
  updatedAt: string | null
}

export function ConfigPage() {
  const [config, setConfig] = useState<ThemeConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  // All observed components (from the roadmap endpoint)
  const [observedComponents, setObservedComponents] = useState<string[]>([])
  const [autoLoading, setAutoLoading] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [themeData, roadmapData] = await Promise.all([
        apiFetch<ThemeConfig>('/config/themes'),
        apiFetch<{ unmappedComponents: string[] }>('/roadmap'),
      ])
      setConfig(themeData)
      setObservedComponents(roadmapData.unmappedComponents || [])
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function save() {
    if (!config) return
    setSaving(true)
    setSaveMsg(null)
    setError(null)
    try {
      const result = await apiFetch<ThemeConfig>('/config/themes', {
        method: 'PUT',
        body: JSON.stringify({
          themes: config.themes,
          unmappedLabel: config.unmappedLabel,
        }),
      })
      setConfig(result)
      setDirty(false)
      setSaveMsg('Saved! Roadmap will reflect changes on next refresh.')
      setTimeout(() => setSaveMsg(null), 4000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  function updateTheme(index: number, field: 'name' | 'components' | 'icon', value: string) {
    if (!config) return
    const updated = [...config.themes]
    if (field === 'components') {
      updated[index] = { ...updated[index], components: value.split(',').map(s => s.trim()).filter(Boolean) }
    } else {
      updated[index] = { ...updated[index], [field]: value || null }
    }
    setConfig({ ...config, themes: updated })
    setDirty(true)
  }

  function deleteTheme(index: number) {
    if (!config) return
    const updated = config.themes.filter((_, i) => i !== index)
    setConfig({ ...config, themes: updated })
    setDirty(true)
  }

  function addTheme() {
    if (!config) return
    setConfig({
      ...config,
      themes: [...config.themes, { name: '', components: [], icon: null }],
    })
    setDirty(true)
  }

  function mergeThemes(targetIndex: number, sourceIndex: number) {
    if (!config || targetIndex === sourceIndex) return
    const updated = [...config.themes]
    const target = updated[targetIndex]
    const source = updated[sourceIndex]
    // Merge components from source into target
    const merged = new Set([...target.components, ...source.components])
    updated[targetIndex] = { ...target, components: Array.from(merged) }
    updated.splice(sourceIndex, 1)
    setConfig({ ...config, themes: updated })
    setDirty(true)
  }

  async function autoCategorize() {
    if (!config) return
    setAutoLoading(true)
    setError(null)
    try {
      const result = await apiFetch<{ suggestions: ThemeEntry[] }>('/config/themes/auto', {
        method: 'POST',
      })
      if (result.suggestions.length === 0) {
        setSaveMsg('No new groupings found.')
        setTimeout(() => setSaveMsg(null), 3000)
        return
      }
      // Merge suggestions into existing themes
      const merged = [...config.themes]
      for (const suggestion of result.suggestions) {
        // Check if a theme with this name already exists
        const existingIdx = merged.findIndex(t =>
          t.name.toLowerCase() === suggestion.name.toLowerCase()
        )
        if (existingIdx >= 0) {
          // Add new components to existing theme
          const existing = new Set(merged[existingIdx].components.map(c => c.toLowerCase()))
          const newComps = suggestion.components.filter(c => !existing.has(c.toLowerCase()))
          if (newComps.length > 0) {
            merged[existingIdx] = {
              ...merged[existingIdx],
              components: [...merged[existingIdx].components, ...newComps],
            }
          }
        } else {
          merged.push(suggestion)
        }
      }
      merged.sort((a, b) => a.name.localeCompare(b.name))
      setConfig({ ...config, themes: merged })
      setDirty(true)
      // Re-compute unmapped after merge
      const mappedSet = new Set<string>()
      for (const t of merged) for (const c of t.components) mappedSet.add(c)
      setObservedComponents(prev => prev.filter(c => !mappedSet.has(c)))
      setSaveMsg(`Added ${result.suggestions.length} theme groups. Review and save.`)
      setTimeout(() => setSaveMsg(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-categorize failed')
    }
    setAutoLoading(false)
  }

  function assignUnmapped(component: string, themeIndex: number) {
    if (!config) return
    const updated = [...config.themes]
    const existing = new Set(updated[themeIndex].components)
    existing.add(component)
    updated[themeIndex] = { ...updated[themeIndex], components: Array.from(existing) }
    setConfig({ ...config, themes: updated })
    setObservedComponents(prev => prev.filter(c => c !== component))
    setDirty(true)
  }

  if (loading) {
    return <NectarLoader size="lg" message="Loading configuration..." className="mt-32" />
  }

  if (!config) {
    return (
      <div className="w-full text-center mt-32">
        <p className="text-sm text-destructive">{error || 'Failed to load'}</p>
        <Button variant="outline" size="sm" onClick={load} className="mt-2">Retry</Button>
      </div>
    )
  }

  // Compute all mapped components for the "unmapped" indicator
  const mappedComponents = new Set<string>()
  for (const theme of config.themes) {
    for (const c of theme.components) mappedComponents.add(c)
  }

  return (
    <div className="w-full space-y-6 max-w-4xl">
      {/* API Keys section */}
      <ApiKeysSection />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Configuration</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Map JIRA components to display themes on the roadmap.
            {config.updatedAt && (
              <> · Last saved {new Date(config.updatedAt).toLocaleDateString()}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saveMsg && <span className="text-xs text-green-400">{saveMsg}</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
          <Button variant="outline" size="sm" onClick={autoCategorize} disabled={saving || autoLoading}>
            {autoLoading ? 'Categorizing...' : 'Auto-categorize'}
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={saving}>Reset</Button>
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving...' : dirty ? 'Save Changes' : 'Saved'}
          </Button>
        </div>
      </div>

      {/* Theme table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Roadmap Themes ({config.themes.length})</CardTitle>
            <Button variant="outline" size="sm" onClick={addTheme}>+ Add Theme</Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-48">Display Name</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">JIRA Components</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-16 text-center">Merge</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-12"></th>
                </tr>
              </thead>
              <tbody>
                {config.themes.map((theme, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-accent/20">
                    <td className="px-3 py-2">
                      <Input
                        value={theme.name}
                        onChange={e => updateTheme(i, 'name', e.target.value)}
                        placeholder="Theme name"
                        className="h-8 text-sm"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={theme.components.join(', ')}
                        onChange={e => updateTheme(i, 'components', e.target.value)}
                        placeholder="Component1, Component2, ..."
                        className="h-8 text-sm font-mono"
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <MergeDropdown
                        themes={config.themes}
                        currentIndex={i}
                        onMerge={(targetIdx) => mergeThemes(targetIdx, i)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => deleteTheme(i)}
                        className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                        title="Delete this theme"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Unmapped components */}
      {observedComponents.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Unmapped Components ({observedComponents.length})
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              These JIRA components appear on tickets but aren't assigned to any theme.
              Click one to assign it.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {observedComponents.map(comp => (
                <UnmappedChip
                  key={comp}
                  component={comp}
                  themes={config.themes}
                  onAssign={(themeIdx) => assignUnmapped(comp, themeIdx)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Unmapped label config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Fallback Label</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <label className="text-sm text-muted-foreground">
              Tickets with no matching theme appear under:
            </label>
            <Input
              value={config.unmappedLabel}
              onChange={e => {
                setConfig({ ...config, unmappedLabel: e.target.value })
                setDirty(true)
              }}
              className="max-w-xs h-8 text-sm"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Merge dropdown ─────────────────────────────────────

function MergeDropdown({ themes, currentIndex, onMerge }: {
  themes: ThemeEntry[]
  currentIndex: number
  onMerge: (targetIndex: number) => void
}) {
  const [open, setOpen] = useState(false)

  if (themes.length < 2) return null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground text-xs transition-colors"
        title="Merge into another theme"
      >
        merge
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-lg py-1 min-w-[180px] max-h-64 overflow-auto">
            <div className="px-2 py-1 text-xs text-muted-foreground border-b mb-1">Merge into:</div>
            {themes.map((t, i) => {
              if (i === currentIndex) return null
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => { onMerge(i); setOpen(false) }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors"
                >
                  {t.name || '(unnamed)'}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Unmapped component chip ────────────────────────────

function UnmappedChip({ component, themes, onAssign }: {
  component: string
  themes: ThemeEntry[]
  onAssign: (themeIndex: number) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "px-2.5 py-1 rounded-md border text-xs transition-colors",
          "bg-yellow-500/10 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/20"
        )}
      >
        {component}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-lg py-1 min-w-[180px] max-h-64 overflow-auto">
            <div className="px-2 py-1 text-xs text-muted-foreground border-b mb-1">Assign to theme:</div>
            {themes.map((t, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { onAssign(i); setOpen(false) }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors"
              >
                {t.name || '(unnamed)'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── API Keys section ──────────────────────────────────

interface ApiKey {
  id: string
  label: string
  createdAt: string
  createdBy: string | null
  lastUsedAt: string | null
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newLabel, setNewLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [newRawKey, setNewRawKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadKeys() {
    setLoading(true)
    try {
      const data = await apiFetch<ApiKey[]>('/keys')
      setKeys(data)
    } catch {
      // API keys endpoint may not exist yet — silently handle
      setKeys([])
    }
    setLoading(false)
  }

  useEffect(() => { loadKeys() }, [])

  async function createKey() {
    if (!newLabel.trim()) return
    setCreating(true)
    setError(null)
    setNewRawKey(null)
    try {
      const result = await apiFetch<{ id: string; rawKey: string; label: string; createdAt: string }>('/keys', {
        method: 'POST',
        body: JSON.stringify({ label: newLabel.trim() }),
      })
      setNewRawKey(result.rawKey)
      setNewLabel('')
      loadKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key')
    }
    setCreating(false)
  }

  async function revokeKey(id: string) {
    try {
      await apiFetch(`/keys/${id}`, { method: 'DELETE' })
      setKeys(prev => prev.filter(k => k.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key')
    }
  }

  function formatDate(d: string | null) {
    if (!d) return 'Never'
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">API Keys</CardTitle>
        <p className="text-xs text-muted-foreground">
          Create API keys for service-to-service authentication (Hive, MCP clients).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Create new key */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Key label (e.g., hive-production)"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createKey()}
            className="h-8 text-sm max-w-xs"
          />
          <Button size="sm" onClick={createKey} disabled={creating || !newLabel.trim()}>
            {creating ? 'Creating...' : 'Create Key'}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Show newly created key (one time) */}
        {newRawKey && (
          <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 space-y-2">
            <p className="text-xs text-green-400 font-medium">
              Key created! Copy it now — it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-background px-2 py-1 rounded border flex-1 break-all select-all">
                {newRawKey}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(newRawKey)
                }}
              >
                Copy
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => setNewRawKey(null)}>
              Dismiss
            </Button>
          </div>
        )}

        {/* Existing keys */}
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : keys.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No API keys created yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Label</th>
                <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Created</th>
                <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Last Used</th>
                <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-16"></th>
              </tr>
            </thead>
            <tbody>
              {keys.map(key => (
                <tr key={key.id} className="border-b border-border/30 hover:bg-accent/20">
                  <td className="px-2 py-1.5">
                    <span className="font-medium">{key.label}</span>
                    {key.createdBy && (
                      <span className="text-xs text-muted-foreground ml-2">by {key.createdBy}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{formatDate(key.createdAt)}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{formatDate(key.lastUsedAt)}</td>
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => revokeKey(key.id)}
                      className="text-xs text-destructive hover:text-destructive/80 transition-colors"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
