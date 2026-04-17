import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'
import { IntegrationsConfigPage } from '../integrations-config/IntegrationsConfigPage'
import { UpdatePage } from '../admin/UpdatePage'
import { SortableHeader, useSortableData, useSortState } from '../../components/SortableHeader'

// ── Tab types ─────────────────────────────────────────

type Tab = 'themes' | 'api-keys' | 'users' | 'connections' | 'notifications' | 'logs' | 'backfills' | 'update'

const TABS: { key: Tab; label: string }[] = [
  { key: 'themes', label: 'Themes' },
  { key: 'api-keys', label: 'API Keys' },
  { key: 'users', label: 'Users' },
  { key: 'connections', label: 'Connections' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'logs', label: 'Logs' },
  { key: 'backfills', label: 'Backfills' },
  { key: 'update', label: 'Update' },
]

// ── Theme types ───────────────────────────────────────

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
  const [activeTab, setActiveTab] = useState<Tab>('themes')

  return (
    <div className="w-full space-y-6 max-w-4xl">
      {/* Tab bar */}
      <div>
        <h2 className="text-2xl font-bold">Config</h2>
        <div className="flex items-center gap-1 mt-3">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                activeTab === tab.key
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'themes' && <ThemesTab />}
      {activeTab === 'api-keys' && <ApiKeysSection />}
      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'connections' && <IntegrationsConfigPage />}
      {activeTab === 'notifications' && <NotificationsTab />}
      {activeTab === 'logs' && <LogsTab />}
      {activeTab === 'backfills' && <BackfillsTab />}
      {activeTab === 'update' && <UpdatePage />}
    </div>
  )
}

// ── Themes Tab ────────────────────────────────────────

function ThemesTab() {
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
      const mergedThemes = [...config.themes]
      for (const suggestion of result.suggestions) {
        // Check if a theme with this name already exists
        const existingIdx = mergedThemes.findIndex(t =>
          t.name.toLowerCase() === suggestion.name.toLowerCase()
        )
        if (existingIdx >= 0) {
          // Add new components to existing theme
          const existing = new Set(mergedThemes[existingIdx].components.map(c => c.toLowerCase()))
          const newComps = suggestion.components.filter(c => !existing.has(c.toLowerCase()))
          if (newComps.length > 0) {
            mergedThemes[existingIdx] = {
              ...mergedThemes[existingIdx],
              components: [...mergedThemes[existingIdx].components, ...newComps],
            }
          }
        } else {
          mergedThemes.push(suggestion)
        }
      }
      mergedThemes.sort((a, b) => a.name.localeCompare(b.name))
      setConfig({ ...config, themes: mergedThemes })
      setDirty(true)
      // Re-compute unmapped after merge
      const mappedSet = new Set<string>()
      for (const t of mergedThemes) for (const c of t.components) mappedSet.add(c)
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
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

// ── Users Tab ────────────────────────────────────────

const PERMISSION_KEYS = [
  { key: 'releases', label: 'Releases' },
  { key: 'roadmap', label: 'Roadmap' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'environments', label: 'Environments' },
  { key: 'features', label: 'Features' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'issues', label: 'Issues' },
  { key: 'tasks', label: 'Tasks' },
] as const

interface UserRecord {
  email: string
  name: string
  picture: string | null
  role: 'admin' | 'user'
  permissions: Record<string, boolean>
  notificationPrefs?: Record<string, boolean>
  isEnvAdmin: boolean
  lastLoginAt: string | null
  createdAt: string
}

const NOTIFICATION_PREF_KEYS = [
  { key: 'dailyDigest', label: 'Daily Digest DM' },
  { key: 'buildFailures', label: 'Build Failure DMs' },
] as const

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function countPermissions(perms: Record<string, boolean>): number {
  return PERMISSION_KEYS.filter(p => perms[p.key]).length
}

function UsersTab() {
  const [users, setUsers] = useState<UserRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingEmail, setEditingEmail] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<'admin' | 'user'>('user')
  const [editPermissions, setEditPermissions] = useState<Record<string, boolean>>({})
  const [editNotifPrefs, setEditNotifPrefs] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  type UserSortKey = 'user' | 'role' | 'lastLogin' | 'permissions'
  const [sortState, onSort] = useSortState<UserSortKey>('lastLogin', 'desc')
  const accessors = useMemo(() => ({
    user:        (u: UserRecord) => u.name || u.email,
    role:        (u: UserRecord) => u.role,
    lastLogin:   (u: UserRecord) => u.lastLoginAt,
    permissions: (u: UserRecord) => u.role === 'admin' ? 99 : countPermissions(u.permissions),
  }), [])
  const sortedUsers = useSortableData<UserRecord, UserSortKey>(users, sortState, accessors)

  async function loadUsers() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<UserRecord[]>('/users')
      setUsers(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
      setUsers([])
    }
    setLoading(false)
  }

  useEffect(() => { loadUsers() }, [])

  function startEdit(user: UserRecord) {
    setEditingEmail(user.email)
    setEditRole(user.role)
    setEditPermissions({ ...user.permissions })
    setEditNotifPrefs({ ...(user.notificationPrefs || { dailyDigest: true, buildFailures: true }) })
    setSaveMsg(null)
  }

  function cancelEdit() {
    setEditingEmail(null)
    setSaveMsg(null)
  }

  async function saveUser() {
    if (!editingEmail) return
    setSaving(true)
    setSaveMsg(null)
    setError(null)
    try {
      const updated = await apiFetch<UserRecord>(`/users/${encodeURIComponent(editingEmail)}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: editRole, permissions: editPermissions, notificationPrefs: editNotifPrefs }),
      })
      setUsers(prev => prev.map(u => u.email === updated.email ? updated : u))
      setEditingEmail(null)
      setSaveMsg('User updated')
      setTimeout(() => setSaveMsg(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user')
    }
    setSaving(false)
  }

  function togglePermission(key: string) {
    setEditPermissions(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function toggleNotifPref(key: string) {
    setEditNotifPrefs(prev => ({ ...prev, [key]: !prev[key] }))
  }

  if (loading) {
    return <NectarLoader size="lg" message="Loading users..." className="mt-32" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Manage user roles and per-page permissions. Users are recorded on login.
        </p>
        <div className="flex items-center gap-2">
          {saveMsg && <span className="text-xs text-green-400">{saveMsg}</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Users ({users.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <SortableHeader label="User"        sortKey="user"        state={sortState} onSort={k => onSort(k as UserSortKey)} />
                  <SortableHeader label="Role"        sortKey="role"        state={sortState} onSort={k => onSort(k as UserSortKey)} className="w-24" />
                  <SortableHeader label="Last Login"  sortKey="lastLogin"   state={sortState} onSort={k => onSort(k as UserSortKey)} className="w-28" />
                  <SortableHeader label="Permissions" sortKey="permissions" state={sortState} onSort={k => onSort(k as UserSortKey)} className="w-28" />
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-16"></th>
                </tr>
              </thead>
              <tbody>
                {sortedUsers.map(user => (
                  <UserRow
                    key={user.email}
                    user={user}
                    isEditing={editingEmail === user.email}
                    editRole={editRole}
                    editPermissions={editPermissions}
                    editNotifPrefs={editNotifPrefs}
                    saving={saving}
                    onStartEdit={() => startEdit(user)}
                    onCancelEdit={cancelEdit}
                    onSave={saveUser}
                    onRoleChange={setEditRole}
                    onTogglePermission={togglePermission}
                    onToggleNotifPref={toggleNotifPref}
                  />
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground text-xs italic">
                      No users have logged in yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function UserRow({ user, isEditing, editRole, editPermissions, editNotifPrefs, saving, onStartEdit, onCancelEdit, onSave, onRoleChange, onTogglePermission, onToggleNotifPref }: {
  user: UserRecord
  isEditing: boolean
  editRole: 'admin' | 'user'
  editPermissions: Record<string, boolean>
  editNotifPrefs: Record<string, boolean>
  saving: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onRoleChange: (role: 'admin' | 'user') => void
  onTogglePermission: (key: string) => void
  onToggleNotifPref: (key: string) => void
}) {
  const isAdmin = user.role === 'admin'
  const permCount = countPermissions(user.permissions)
  const totalPerms = PERMISSION_KEYS.length

  return (
    <>
      <tr className={cn(
        "border-b border-border/30 hover:bg-accent/20",
        isEditing && "bg-accent/10"
      )}>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2.5">
            {user.picture ? (
              <img
                src={user.picture}
                alt=""
                className="w-6 h-6 rounded-full shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-accent shrink-0 flex items-center justify-center text-xs font-medium">
                {(user.name || user.email)[0].toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            </div>
          </div>
        </td>
        <td className="px-3 py-2">
          {isAdmin ? (
            <Badge variant="default" className="text-[10px]">Admin</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">User</span>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {formatRelativeTime(user.lastLoginAt)}
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {isAdmin ? (
            <span>All pages</span>
          ) : (
            <span>{permCount}/{totalPerms} pages</span>
          )}
        </td>
        <td className="px-3 py-2">
          {!isEditing && (
            <button
              onClick={onStartEdit}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              Edit
            </button>
          )}
          {isEditing && (
            <button
              onClick={onCancelEdit}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          )}
        </td>
      </tr>

      {/* Expanded edit row */}
      {isEditing && (
        <tr className="border-b border-border/30 bg-accent/5">
          <td colSpan={5} className="px-3 py-3">
            <div className="space-y-3">
              {/* Permission toggles */}
              <div className="grid grid-cols-4 gap-x-6 gap-y-2">
                {PERMISSION_KEYS.map(p => (
                  <label key={p.key} className="flex items-center gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={editRole === 'admin' || editPermissions[p.key] !== false}
                      disabled={editRole === 'admin'}
                      onChange={() => onTogglePermission(p.key)}
                      className="rounded border-border"
                    />
                    <span className={cn(
                      "text-xs",
                      editRole === 'admin' ? "text-muted-foreground" : "group-hover:text-foreground"
                    )}>
                      {p.label}
                    </span>
                  </label>
                ))}
              </div>

              {/* Notification preferences */}
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">Slack Notifications</p>
                <div className="grid grid-cols-4 gap-x-6 gap-y-2">
                  {NOTIFICATION_PREF_KEYS.map(p => (
                    <label key={p.key} className="flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={editNotifPrefs[p.key] !== false}
                        onChange={() => onToggleNotifPref(p.key)}
                        className="rounded border-border"
                      />
                      <span className="text-xs group-hover:text-foreground">{p.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Role + Save */}
              <div className="flex items-center gap-3 pt-1">
                <label className="text-xs text-muted-foreground">Role:</label>
                <select
                  value={editRole}
                  onChange={e => onRoleChange(e.target.value as 'admin' | 'user')}
                  className="h-7 px-2 rounded border border-border bg-background text-xs"
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                {editRole === 'admin' && (
                  <span className="text-[10px] text-muted-foreground">
                    Admins have all permissions
                  </span>
                )}
                <div className="flex-1" />
                <Button size="sm" onClick={onSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
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

  type ApiKeySortKey = 'label' | 'created' | 'lastUsed'
  const [sortState, onSort] = useSortState<ApiKeySortKey>('created', 'desc')
  const accessors = useMemo(() => ({
    label:    (k: ApiKey) => k.label,
    created:  (k: ApiKey) => k.createdAt,
    lastUsed: (k: ApiKey) => k.lastUsedAt,
  }), [])
  const sortedKeys = useSortableData<ApiKey, ApiKeySortKey>(keys, sortState, accessors)

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
                <SortableHeader label="Label"     sortKey="label"    state={sortState} onSort={k => onSort(k as ApiKeySortKey)} className="px-2 py-1.5" />
                <SortableHeader label="Created"   sortKey="created"  state={sortState} onSort={k => onSort(k as ApiKeySortKey)} className="px-2 py-1.5" />
                <SortableHeader label="Last Used" sortKey="lastUsed" state={sortState} onSort={k => onSort(k as ApiKeySortKey)} className="px-2 py-1.5" />
                <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-16"></th>
              </tr>
            </thead>
            <tbody>
              {sortedKeys.map(key => (
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

// ── Backfills Tab ─────────────────────────────────────

interface BackfillResult {
  processed: number
  captured: number
  failed: number
  skipped: number
  errors: string[]
}

// ── Notifications Tab ─────────────────────────────────

interface NotifSettings {
  enabled: boolean
  channels: Record<string, boolean>
}

interface PeopleEntry {
  name: string
  slackId: string
  username: string
}

const CHANNEL_TOGGLES: { key: string; label: string; description: string }[] = [
  { key: 'releases', label: 'Release Lifecycle', description: 'Cut, state transitions, and approvals — posted to the per-release channel (e.g. #releases-4-2-0)' },
  { key: 'deploys', label: 'Deployments', description: 'Deployment success and failure alerts — posted to the per-release channel' },
  { key: 'releaseStatus', label: 'Scheduled Status Updates', description: '9 AM and 2 PM status digests, date changes, and environment deployments — per-release channel' },
  { key: 'buildFailures', label: 'Build Failure Alerts', description: 'DMs to dev and QA assignees when a build fails or recovers' },
  { key: 'dailyDigest', label: 'Daily Digest', description: 'Morning DM to each person with their undone tickets across upcoming releases' },
]

function ToggleSwitch({ enabled, disabled, onToggle }: { enabled: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer',
        disabled && 'opacity-40 cursor-not-allowed',
        enabled ? 'bg-green-500' : 'bg-zinc-600'
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
        enabled ? 'translate-x-4' : 'translate-x-0'
      )} />
    </button>
  )
}

function NotificationsTab() {
  const [settings, setSettings] = useState<NotifSettings | null>(null)
  const [directory, setDirectory] = useState<{ loaded: boolean; entries: PeopleEntry[]; unresolved: { name: string; queryCount: number }[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testUser, setTestUser] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testSending, setTestSending] = useState(false)
  const [resolvingName, setResolvingName] = useState<string | null>(null)
  const [resolveQuery, setResolveQuery] = useState('')
  const [resolveResults, setResolveResults] = useState<{ id: string; name: string; username: string }[]>([])
  const [resolveSearching, setResolveSearching] = useState(false)

  type DirSortKey = 'name' | 'username' | 'slackId'
  const [dirSortState, onDirSort] = useSortState<DirSortKey>('name', 'asc')
  const dirAccessors = useMemo(() => ({
    name:     (e: PeopleEntry) => e.name,
    username: (e: PeopleEntry) => e.username,
    slackId:  (e: PeopleEntry) => e.slackId,
  }), [])
  const sortedDirEntries = useSortableData<PeopleEntry, DirSortKey>(directory?.entries || [], dirSortState, dirAccessors)

  async function load() {
    setLoading(true)
    try {
      const [s, d] = await Promise.all([
        apiFetch<NotifSettings>('/notifications/settings'),
        apiFetch<{ loaded: boolean; entries: PeopleEntry[]; unresolved: { name: string; queryCount: number }[] }>('/people/directory'),
      ])
      setSettings(s)
      setDirectory(d)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function updateSettings(patch: Partial<NotifSettings>) {
    if (!settings) return
    setSaving(true)
    try {
      const updated = await apiFetch<NotifSettings>('/notifications/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      })
      setSettings(updated)
    } catch { /* ignore */ }
    setSaving(false)
  }

  async function reloadDirectory() {
    try {
      await apiFetch('/people/directory/reload', { method: 'POST' })
      await load()
    } catch { /* ignore */ }
  }

  async function testDigest() {
    if (!testUser) return
    setTestSending(true)
    setTestResult(null)
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>('/notifications/test-digest', {
        method: 'POST',
        body: JSON.stringify({ slackId: testUser }),
      })
      setTestResult(res.message)
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Failed')
    }
    setTestSending(false)
    setTimeout(() => setTestResult(null), 5000)
  }

  async function searchSlack(query: string) {
    if (!query.trim()) return
    setResolveSearching(true)
    try {
      const res = await apiFetch<{ results: { id: string; name: string; username: string }[] }>('/people/directory/search-slack', {
        method: 'POST',
        body: JSON.stringify({ query }),
      })
      setResolveResults(res.results)
    } catch { setResolveResults([]) }
    setResolveSearching(false)
  }

  async function mapName(jiraName: string, slackId: string) {
    try {
      await apiFetch('/people/directory/resolve', {
        method: 'POST',
        body: JSON.stringify({ jiraName, slackId }),
      })
      setResolvingName(null)
      setResolveQuery('')
      setResolveResults([])
      await load()
    } catch { /* ignore */ }
  }

  if (loading || !settings) {
    return <NectarLoader size="lg" message="Loading notification settings..." className="mt-32" />
  }

  return (
    <div className="space-y-4">
      {/* Master toggle */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">All Slack Notifications</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Master toggle — when off, no Slack messages are sent (channels or DMs)
              </p>
            </div>
            <ToggleSwitch
              enabled={settings.enabled}
              disabled={saving}
              onToggle={() => updateSettings({ enabled: !settings.enabled })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Channel toggles */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Notification Types</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border/30">
            {CHANNEL_TOGGLES.map(({ key, label, description }) => (
              <div key={key} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <ToggleSwitch
                  enabled={settings.channels[key] ?? true}
                  disabled={saving || !settings.enabled}
                  onToggle={() => updateSettings({ channels: { ...settings.channels, [key]: !settings.channels[key] } })}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Test — send digest to a specific person */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Test Daily Digest</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0 space-y-2">
          <p className="text-xs text-muted-foreground">Send a test digest DM to a specific person.</p>
          <div className="flex items-center gap-2">
            <select
              value={testUser}
              onChange={e => setTestUser(e.target.value)}
              className="h-8 px-2 rounded border border-border bg-background text-xs flex-1 max-w-xs"
            >
              <option value="">Select a person...</option>
              {directory?.entries.map(e => (
                <option key={e.slackId} value={e.slackId}>{e.name} (@{e.username})</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={testDigest} disabled={!testUser || testSending || !settings.enabled}>
              {testSending ? 'Sending...' : 'Send Test'}
            </Button>
          </div>
          {testResult && <p className="text-xs text-muted-foreground">{testResult}</p>}
        </CardContent>
      </Card>

      {/* People directory */}
      {directory && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                People Directory ({directory.entries.length} loaded)
              </CardTitle>
              <Button variant="outline" size="sm" onClick={reloadDirectory}>Reload</Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* Unresolved names with resolve action */}
            {directory.unresolved.length > 0 && (
              <div className="px-4 pb-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Unresolved JIRA names ({directory.unresolved.length}) — click to map to a Slack user:
                </p>
                <div className="flex flex-wrap gap-1">
                  {directory.unresolved.map(u => (
                    <button
                      key={u.name}
                      onClick={() => { setResolvingName(u.name); setResolveQuery(u.name); setResolveResults([]) }}
                      className={cn(
                        'inline-flex items-center px-2 py-0.5 rounded text-[10px] border cursor-pointer transition-colors',
                        resolvingName === u.name
                          ? 'bg-orange-500/20 text-orange-300 border-orange-500/50'
                          : 'text-orange-400 border-orange-500/30 hover:bg-orange-500/10'
                      )}
                    >
                      {u.name}
                    </button>
                  ))}
                </div>

                {/* Resolve panel */}
                {resolvingName && (
                  <div className="rounded border border-border p-3 space-y-2 bg-accent/5">
                    <p className="text-xs font-medium">Map "{resolvingName}" to a Slack user</p>
                    <div className="flex items-center gap-2">
                      <Input
                        value={resolveQuery}
                        onChange={e => setResolveQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && searchSlack(resolveQuery)}
                        placeholder="Search Slack by name..."
                        className="h-7 text-xs flex-1 max-w-xs"
                      />
                      <Button variant="outline" size="sm" onClick={() => searchSlack(resolveQuery)} disabled={resolveSearching}>
                        {resolveSearching ? 'Searching...' : 'Search Slack'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setResolvingName(null); setResolveResults([]) }}>
                        Cancel
                      </Button>
                    </div>
                    {resolveResults.length > 0 && (
                      <div className="space-y-1">
                        {resolveResults.map(r => (
                          <button
                            key={r.id}
                            onClick={() => mapName(resolvingName, r.id)}
                            className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-accent/30 text-left transition-colors"
                          >
                            <span className="text-xs font-medium">{r.name}</span>
                            <span className="text-[10px] text-muted-foreground">@{r.username}</span>
                            <span className="text-[10px] text-muted-foreground font-mono ml-auto">{r.id}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {resolveResults.length === 0 && resolveSearching === false && resolveQuery && (
                      <p className="text-xs text-muted-foreground">No results. Try a different search term.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Directory table */}
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b text-left">
                    <SortableHeader label="Name"     sortKey="name"     state={dirSortState} onSort={k => onDirSort(k as DirSortKey)} className="px-4 py-1.5 text-[10px]" />
                    <SortableHeader label="Username" sortKey="username" state={dirSortState} onSort={k => onDirSort(k as DirSortKey)} className="px-4 py-1.5 text-[10px]" />
                    <SortableHeader label="Slack ID" sortKey="slackId"  state={dirSortState} onSort={k => onDirSort(k as DirSortKey)} className="px-4 py-1.5 text-[10px]" />
                  </tr>
                </thead>
                <tbody>
                  {sortedDirEntries.map(e => (
                    <tr key={e.slackId} className="border-b border-border/20">
                      <td className="px-4 py-1.5 text-xs">{e.name}</td>
                      <td className="px-4 py-1.5 text-xs text-muted-foreground">{e.username}</td>
                      <td className="px-4 py-1.5 text-xs text-muted-foreground font-mono">{e.slackId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Logs Tab ──────────────────────────────────────────

interface LogEntry {
  ts: string
  level: 'INFO' | 'WARN' | 'ERROR'
  message: string
}

function LogsTab() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [timeFrom, setTimeFrom] = useState('')
  const [timeTo, setTimeTo] = useState('')
  const [copied, setCopied] = useState(false)

  const load = async () => {
    try {
      const params = new URLSearchParams()
      params.set('limit', '2000')
      if (levelFilter) params.set('level', levelFilter)
      if (search) params.set('q', search)
      const data = await apiFetch<{ entries: LogEntry[] }>(`/admin/logs?${params}`)
      setEntries(data.entries || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [levelFilter, search])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [autoRefresh, levelFilter, search])

  // Time-filtered view
  const filtered = useMemo(() => {
    if (!timeFrom && !timeTo) return entries
    // Pad to HH:MM:SS — browser may return HH:MM without seconds
    const from = timeFrom ? (timeFrom.length === 5 ? timeFrom + ':00' : timeFrom) : ''
    const to = timeTo ? (timeTo.length === 5 ? timeTo + ':59' : timeTo) : ''
    return entries.filter(e => {
      const time = e.ts.slice(11, 19) // HH:MM:SS
      if (from && time < from) return false
      if (to && time > to) return false
      return true
    })
  }, [entries, timeFrom, timeTo])

  const levelCounts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 }
    for (const e of filtered) {
      if (c[e.level] !== undefined) c[e.level]++
    }
    return c
  }, [filtered])

  const copyToClipboard = () => {
    const text = filtered.map(e =>
      `${e.ts.slice(0, 19)}  ${e.level.padEnd(5)}  ${e.message}`
    ).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  // Time range quick selects
  const setTimeRange = (label: string) => {
    const now = new Date()
    const fmt = (d: Date) => d.toTimeString().slice(0, 8)
    switch (label) {
      case 'last-15m': {
        const from = new Date(now.getTime() - 15 * 60000)
        setTimeFrom(fmt(from)); setTimeTo(fmt(now)); break
      }
      case 'last-1h': {
        const from = new Date(now.getTime() - 60 * 60000)
        setTimeFrom(fmt(from)); setTimeTo(fmt(now)); break
      }
      case 'last-3h': {
        const from = new Date(now.getTime() - 180 * 60000)
        setTimeFrom(fmt(from)); setTimeTo(fmt(now)); break
      }
      case '9am': {
        setTimeFrom('13:00:00'); setTimeTo('13:20:00'); break // 9 AM ET = 13:00 UTC
      }
      case 'clear': {
        setTimeFrom(''); setTimeTo(''); break
      }
    }
  }

  return (
    <div className="space-y-3">
      {/* Row 1: Level filter + search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
          {(['', 'ERROR', 'WARN', 'ERROR,WARN', 'INFO'] as const).map(lvl => {
            const label = lvl === '' ? 'All' : lvl === 'ERROR,WARN' ? 'Errors + Warnings' : lvl
            const count = lvl === '' ? filtered.length
              : lvl === 'ERROR,WARN' ? levelCounts.ERROR + levelCounts.WARN
              : levelCounts[lvl as keyof typeof levelCounts] || 0
            return (
              <button
                key={lvl}
                onClick={() => setLevelFilter(lvl)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                  levelFilter === lvl
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            )
          })}
        </div>

        <Input
          placeholder="Search logs..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-7 text-xs max-w-xs"
        />

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => setAutoRefresh(e.target.checked)}
            className="rounded border-border"
          />
          Auto-refresh
        </label>

        <Button variant="outline" size="sm" onClick={load} className="text-xs h-7">
          Refresh
        </Button>
      </div>

      {/* Row 2: Time range filter + copy */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">Time (UTC):</span>
        <Input
          type="time"
          step="1"
          value={timeFrom}
          onChange={e => setTimeFrom(e.target.value)}
          className="h-7 text-xs w-28"
          placeholder="From"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="time"
          step="1"
          value={timeTo}
          onChange={e => setTimeTo(e.target.value)}
          className="h-7 text-xs w-28"
          placeholder="To"
        />

        {/* Quick presets */}
        <div className="flex items-center gap-1">
          {[
            { key: 'last-15m', label: '15m' },
            { key: 'last-1h', label: '1h' },
            { key: 'last-3h', label: '3h' },
            { key: '9am', label: '9 AM ET' },
          ].map(p => (
            <button
              key={p.key}
              onClick={() => setTimeRange(p.key)}
              className="px-2 py-0.5 text-[10px] rounded border border-border/40 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
            >
              {p.label}
            </button>
          ))}
          {(timeFrom || timeTo) && (
            <button
              onClick={() => setTimeRange('clear')}
              className="px-2 py-0.5 text-[10px] rounded text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{filtered.length} entries</span>
          <Button variant="outline" size="sm" onClick={copyToClipboard} className="text-xs h-7">
            {copied ? 'Copied!' : 'Copy to Clipboard'}
          </Button>
        </div>
      </div>

      {/* Log table */}
      <Card>
        <CardContent className="p-0">
          <div className="max-h-[600px] overflow-y-auto font-mono text-[11px] leading-relaxed">
            {loading && filtered.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-xs">Loading logs...</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-xs italic">No log entries match the current filter.</div>
            ) : (
              <table className="w-full">
                <tbody>
                  {filtered.map((e, i) => (
                    <tr
                      key={`${e.ts}-${i}`}
                      className={cn(
                        'border-b border-border/10 hover:bg-accent/20',
                        e.level === 'ERROR' && 'bg-red-500/5',
                        e.level === 'WARN' && 'bg-yellow-500/5'
                      )}
                    >
                      <td className="px-2 py-1 text-muted-foreground whitespace-nowrap align-top w-40 select-all">
                        {e.ts.slice(11, 19)}
                      </td>
                      <td className={cn(
                        'px-2 py-1 w-12 text-center align-top font-semibold',
                        e.level === 'ERROR' ? 'text-red-400' :
                        e.level === 'WARN' ? 'text-yellow-400' :
                        'text-muted-foreground'
                      )}>
                        {e.level === 'ERROR' ? 'ERR' : e.level === 'WARN' ? 'WRN' : 'INF'}
                      </td>
                      <td className="px-2 py-1 text-foreground break-all">
                        {e.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Backfills Tab ─────────────────────────────────────

function BackfillsTab() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BackfillResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])

  async function runBackfill(type: string, endpoint: string) {
    setRunning(true)
    setError(null)
    setResult(null)
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] Starting ${type} backfill...`])
    try {
      const data = await apiFetch<BackfillResult>(endpoint, { method: 'POST' })
      setResult(data)
      setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${type} complete: ${data.captured} captured, ${data.skipped} skipped, ${data.failed} failed`])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      setError(msg)
      setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${type} failed: ${msg}`])
    }
    setRunning(false)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Run backfill jobs to populate historical data. These query external APIs
        for past deployments and store the results locally.
      </p>

      {/* Datadog Deployment Impact */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Datadog Deployment Impact</CardTitle>
          <p className="text-xs text-muted-foreground">
            Queries Datadog metrics (error rate, latency, throughput) for each historical deployment.
            Compares 30 minutes before → 2 hours after each deploy. Processes up to 50 deployments per run.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            size="sm"
            onClick={() => runBackfill('Datadog Impact', '/admin/datadog/backfill')}
            disabled={running}
          >
            {running ? 'Running...' : 'Run Datadog Backfill'}
          </Button>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-md border bg-muted/10 px-3 py-2 text-xs space-y-1">
              <div className="flex gap-4">
                <span>Processed: <span className="font-medium">{result.processed}</span></span>
                <span className="text-green-400">Captured: <span className="font-medium">{result.captured}</span></span>
                <span className="text-muted-foreground">Skipped: <span className="font-medium">{result.skipped}</span></span>
                {result.failed > 0 && <span className="text-red-400">Failed: <span className="font-medium">{result.failed}</span></span>}
              </div>
              {result.errors && result.errors.length > 0 && (
                <div className="text-red-400 mt-1">
                  {result.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Log */}
      {log.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Log</CardTitle>
              <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setLog([])}>Clear</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="bg-background rounded-md border p-3 max-h-48 overflow-auto font-mono text-xs space-y-0.5">
              {log.map((line, i) => (
                <div key={i} className="text-muted-foreground">{line}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
