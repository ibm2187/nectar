import { useEffect, useState, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/authStore'
import { useAccessStore } from '../../stores/accessStore'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

// ── Tab types ─────────────────────────────────────────

type Tab = 'users' | 'roles' | 'api-keys'

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' },
  { key: 'api-keys', label: 'API Keys' },
]

// ── Shared helpers ────────────────────────────────────

function formatDate(d: string | null | undefined): string {
  if (!d) return 'Never'
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function ToggleSwitch({ enabled, disabled, onToggle }: {
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer',
        disabled && 'opacity-40 cursor-not-allowed',
        enabled ? 'bg-green-500' : 'bg-zinc-600',
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
        enabled ? 'translate-x-4' : 'translate-x-0',
      )} />
    </button>
  )
}

/** Group capabilities by namespace (e.g. "user.admin" -> "user") */
function groupByNamespace(caps: ReadonlyArray<{ id: string } | string>): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const cap of caps) {
    const capId = typeof cap === 'string' ? cap : cap.id
    const dot = capId.indexOf('.')
    const ns = dot > 0 ? capId.slice(0, dot) : 'general'
    const existing = groups[ns] ?? []
    groups[ns] = [...existing, capId]
  }
  return groups
}

// ── Main page ─────────────────────────────────────────

export function AccessPage({ embedded }: { embedded?: boolean } = {}) {
  const hasCap = useAuthStore(s => s.hasCap)
  const { loadAll, loading } = useAccessStore()
  const [activeTab, setActiveTab] = useState<Tab>('users')

  useEffect(() => { loadAll() }, [loadAll])

  // When standalone (not embedded in Config), gate by user.admin
  if (!embedded && !hasCap('user.admin')) {
    return <Navigate to="/" replace />
  }

  if (loading) {
    return <NectarLoader size="lg" message="Loading access control..." className="mt-32" />
  }

  // When embedded in Config, skip the outer heading — Config already provides it
  return (
    <div className={embedded ? 'space-y-4' : 'w-full space-y-6 max-w-4xl'}>
      {!embedded && (
        <div>
          <h2 className="text-2xl font-bold">Access Control</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage users, roles, and API keys
          </p>
        </div>
      )}

      {/* Sub-tab bar */}
      <div className="flex items-center gap-1">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'roles' && <RolesTab />}
      {activeTab === 'api-keys' && <ApiKeysTab />}
    </div>
  )
}

// ── Users Tab ─────────────────────────────────────────

interface AccessUser {
  email: string
  name: string
  roleIds: string[]
  lastLoginAt: string | null
  createdAt: string
}

function UsersTab() {
  const { users, roles, updateUserRoles } = useAccessStore()
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null)
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  function expandUser(user: AccessUser) {
    if (expandedEmail === user.email) {
      setExpandedEmail(null)
      return
    }
    setExpandedEmail(user.email)
    setSelectedRoleIds([...user.roleIds])
    setError(null)
    setSuccessMsg(null)
  }

  function toggleRole(roleId: string) {
    setSelectedRoleIds(prev =>
      prev.includes(roleId)
        ? prev.filter(id => id !== roleId)
        : [...prev, roleId],
    )
  }

  async function saveRoles(email: string) {
    setSaving(true)
    setError(null)
    setSuccessMsg(null)
    try {
      await updateUserRoles(email, selectedRoleIds)
      setSuccessMsg('Roles updated')
      setTimeout(() => setSuccessMsg(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update roles')
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Users ({users.length})</CardTitle>
        <p className="text-xs text-muted-foreground">
          Assign roles to users. Users appear after their first login.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Name</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Roles</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-32">Last Login</th>
                <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-32">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user: AccessUser) => {
                const isExpanded = expandedEmail === user.email
                return (
                  <UserRow
                    key={user.email}
                    user={user}
                    allRoles={roles}
                    isExpanded={isExpanded}
                    selectedRoleIds={isExpanded ? selectedRoleIds : user.roleIds}
                    saving={saving}
                    error={isExpanded ? error : null}
                    successMsg={isExpanded ? successMsg : null}
                    onExpand={() => expandUser(user)}
                    onToggleRole={toggleRole}
                    onSave={() => saveRoles(user.email)}
                  />
                )
              })}
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
  )
}

interface AccessRole {
  id: string
  name: string
  description: string | null
  capabilities: string[]
  system: boolean
}

function UserRow({ user, allRoles, isExpanded, selectedRoleIds, saving, error, successMsg, onExpand, onToggleRole, onSave }: {
  user: AccessUser
  allRoles: AccessRole[]
  isExpanded: boolean
  selectedRoleIds: string[]
  saving: boolean
  error: string | null
  successMsg: string | null
  onExpand: () => void
  onToggleRole: (roleId: string) => void
  onSave: () => void
}) {
  const roleNames = user.roleIds
    .map(rid => allRoles.find(r => r.id === rid)?.name ?? rid)

  return (
    <>
      <tr
        onClick={onExpand}
        className={cn(
          'border-b border-border/30 hover:bg-accent/20 cursor-pointer transition-colors',
          isExpanded && 'bg-accent/10',
        )}
      >
        <td className="px-3 py-2 font-medium">{user.name || '(unnamed)'}</td>
        <td className="px-3 py-2 text-muted-foreground">{user.email}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {roleNames.length > 0 ? roleNames.map(name => (
              <Badge key={name} variant="secondary" className="text-[11px]">{name}</Badge>
            )) : (
              <span className="text-xs text-muted-foreground italic">No roles</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(user.lastLoginAt)}</td>
        <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(user.createdAt)}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={5} className="px-3 py-4 bg-accent/5 border-b border-border/30">
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Assign Roles</p>
              <div className="flex flex-wrap gap-2">
                {allRoles.map(role => {
                  const selected = selectedRoleIds.includes(role.id)
                  return (
                    <button
                      key={role.id}
                      onClick={() => onToggleRole(role.id)}
                      className={cn(
                        'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
                        selected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:border-primary/50',
                      )}
                    >
                      {role.name}
                      {role.system && <span className="ml-1 opacity-60">&#128274;</span>}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={onSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Roles'}
                </Button>
                {error && <span className="text-xs text-destructive">{error}</span>}
                {successMsg && <span className="text-xs text-green-400">{successMsg}</span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Roles Tab ─────────────────────────────────────────

function RolesTab() {
  const { roles, capabilities, createRole, updateRole, deleteRole } = useAccessStore()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editState, setEditState] = useState<{
    name: string
    description: string
    capabilities: string[]
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const groupedCaps = groupByNamespace(capabilities)

  function expandRole(role: AccessRole) {
    if (expandedId === role.id) {
      setExpandedId(null)
      setEditState(null)
      return
    }
    setExpandedId(role.id)
    setEditState({
      name: role.name,
      description: role.description ?? '',
      capabilities: [...role.capabilities],
    })
    setError(null)
    setSuccessMsg(null)
  }

  function toggleCap(cap: string) {
    if (!editState) return
    const newCaps = editState.capabilities.includes(cap)
      ? editState.capabilities.filter(c => c !== cap)
      : [...editState.capabilities, cap]
    setEditState({ ...editState, capabilities: newCaps })
  }

  async function saveRole(roleId: string) {
    if (!editState) return
    setSaving(true)
    setError(null)
    setSuccessMsg(null)
    try {
      await updateRole(roleId, {
        name: editState.name,
        description: editState.description,
        capabilities: editState.capabilities,
      })
      setSuccessMsg('Role updated')
      setTimeout(() => setSuccessMsg(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role')
    }
    setSaving(false)
  }

  async function handleDelete(roleId: string) {
    setSaving(true)
    setError(null)
    try {
      await deleteRole(roleId)
      setDeleteConfirm(null)
      setExpandedId(null)
      setEditState(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete role')
    }
    setSaving(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Define roles and their capabilities. System roles cannot be deleted.
        </p>
        <Button size="sm" onClick={() => setShowCreateForm(true)}>
          Create Role
        </Button>
      </div>

      {showCreateForm && (
        <CreateRoleForm
          groupedCaps={groupedCaps}
          onClose={() => setShowCreateForm(false)}
          onCreate={createRole}
        />
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Name</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-28">Capabilities</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-20">Type</th>
                </tr>
              </thead>
              <tbody>
                {roles.map(role => {
                  const isExpanded = expandedId === role.id
                  return (
                    <RoleRow
                      key={role.id}
                      role={role}
                      isExpanded={isExpanded}
                      editState={isExpanded ? editState : null}
                      groupedCaps={groupedCaps}
                      saving={saving}
                      error={isExpanded ? error : null}
                      successMsg={isExpanded ? successMsg : null}
                      deleteConfirm={deleteConfirm}
                      onExpand={() => expandRole(role)}
                      onEditName={name => editState && setEditState({ ...editState, name })}
                      onEditDesc={description => editState && setEditState({ ...editState, description })}
                      onToggleCap={toggleCap}
                      onSave={() => saveRole(role.id)}
                      onRequestDelete={() => setDeleteConfirm(role.id)}
                      onConfirmDelete={() => handleDelete(role.id)}
                      onCancelDelete={() => setDeleteConfirm(null)}
                    />
                  )
                })}
                {roles.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground text-xs italic">
                      No roles defined yet.
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

function RoleRow({ role, isExpanded, editState, groupedCaps, saving, error, successMsg, deleteConfirm, onExpand, onEditName, onEditDesc, onToggleCap, onSave, onRequestDelete, onConfirmDelete, onCancelDelete }: {
  role: AccessRole
  isExpanded: boolean
  editState: { name: string; description: string; capabilities: string[] } | null
  groupedCaps: Record<string, string[]>
  saving: boolean
  error: string | null
  successMsg: string | null
  deleteConfirm: string | null
  onExpand: () => void
  onEditName: (name: string) => void
  onEditDesc: (description: string) => void
  onToggleCap: (cap: string) => void
  onSave: () => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  return (
    <>
      <tr
        onClick={onExpand}
        className={cn(
          'border-b border-border/30 hover:bg-accent/20 cursor-pointer transition-colors',
          isExpanded && 'bg-accent/10',
        )}
      >
        <td className="px-3 py-2 font-medium">
          {role.name}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{role.description}</td>
        <td className="px-3 py-2">
          <Badge variant="secondary" className="text-[11px]">
            {role.capabilities.length}
          </Badge>
        </td>
        <td className="px-3 py-2">
          {role.system
            ? <span className="text-xs text-muted-foreground" title="System role">&#128274; System</span>
            : <span className="text-xs text-muted-foreground">Custom</span>
          }
        </td>
      </tr>
      {isExpanded && editState && (
        <tr>
          <td colSpan={4} className="px-3 py-4 bg-accent/5 border-b border-border/30">
            <div className="space-y-4">
              {/* Name + description (editable for custom roles) */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
                  <Input
                    value={editState.name}
                    onChange={e => onEditName(e.target.value)}
                    disabled={role.system}
                    className="h-8 text-sm mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</label>
                  <Input
                    value={editState.description}
                    onChange={e => onEditDesc(e.target.value)}
                    disabled={role.system}
                    className="h-8 text-sm mt-1"
                  />
                </div>
              </div>

              {/* Capability grid grouped by namespace */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Capabilities</p>
                <div className="space-y-3">
                  {Object.entries(groupedCaps).sort(([a], [b]) => a.localeCompare(b)).map(([ns, caps]) => (
                    <div key={ns}>
                      <p className="text-xs font-semibold text-foreground/80 mb-1 capitalize">{ns}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                        {caps.map(cap => (
                          <label key={cap} className="flex items-center gap-2 text-xs py-0.5">
                            <ToggleSwitch
                              enabled={editState.capabilities.includes(cap)}
                              onToggle={() => onToggleCap(cap)}
                            />
                            <span className="text-muted-foreground">{cap}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={onSave} disabled={saving}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
                {!role.system && (
                  deleteConfirm === role.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-destructive">Delete this role?</span>
                      <Button variant="destructive" size="sm" onClick={onConfirmDelete} disabled={saving}>
                        Confirm
                      </Button>
                      <Button variant="ghost" size="sm" onClick={onCancelDelete}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={onRequestDelete} className="text-destructive hover:text-destructive">
                      Delete
                    </Button>
                  )
                )}
                {error && <span className="text-xs text-destructive">{error}</span>}
                {successMsg && <span className="text-xs text-green-400">{successMsg}</span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function CreateRoleForm({ groupedCaps, onClose, onCreate }: {
  groupedCaps: Record<string, string[]>
  onClose: () => void
  onCreate: (data: { id: string; name: string; description?: string; capabilities: string[] }) => Promise<unknown>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedCaps, setSelectedCaps] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleCap(cap: string) {
    setSelectedCaps(prev =>
      prev.includes(cap)
        ? prev.filter(c => c !== cap)
        : [...prev, cap],
    )
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      await onCreate({ id: slug, name: name.trim(), description: description.trim(), capabilities: selectedCaps })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create role')
    }
    setSaving(false)
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">New Role</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. release-manager"
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</label>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What this role is for"
              className="h-8 text-sm mt-1"
            />
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Capabilities</p>
          <div className="space-y-3">
            {Object.entries(groupedCaps).sort(([a], [b]) => a.localeCompare(b)).map(([ns, caps]) => (
              <div key={ns}>
                <p className="text-xs font-semibold text-foreground/80 mb-1 capitalize">{ns}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                  {caps.map(cap => (
                    <label key={cap} className="flex items-center gap-2 text-xs py-0.5">
                      <ToggleSwitch
                        enabled={selectedCaps.includes(cap)}
                        onToggle={() => toggleCap(cap)}
                      />
                      <span className="text-muted-foreground">{cap}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleCreate} disabled={saving}>
            {saving ? 'Creating...' : 'Create Role'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// ── API Keys Tab ──────────────────────────────────────

interface AccessApiKey {
  id: string
  label: string
  roleId: string | null
  createdAt: string
  lastUsedAt: string | null
}

function ApiKeysTab() {
  const { keys, roles, createKey, updateKeyRole, revokeKey } = useAccessStore()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newRawKey, setNewRawKey] = useState<string | null>(null)
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = useCallback(async (label: string, roleId: string | null) => {
    setError(null)
    try {
      const result = await createKey({ label, roleId: roleId ?? '' })
      setNewRawKey(result.rawKey)
      setShowCreateForm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key')
    }
  }, [createKey])

  async function handleRevoke(keyId: string) {
    setError(null)
    try {
      await revokeKey(keyId)
      setRevokeConfirm(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key')
    }
  }

  async function handleRoleChange(keyId: string, roleId: string | null) {
    setError(null)
    try {
      await updateKeyRole(keyId, roleId ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update key role')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Create API keys for service-to-service authentication.
        </p>
        <Button size="sm" onClick={() => setShowCreateForm(true)}>
          Create API Key
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {showCreateForm && (
        <CreateKeyForm
          roles={roles}
          onClose={() => setShowCreateForm(false)}
          onCreate={handleCreate}
        />
      )}

      {/* New key reveal modal */}
      <Dialog open={newRawKey !== null} onOpenChange={() => setNewRawKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Copy this key now. It will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-background px-2 py-1.5 rounded border flex-1 break-all select-all">
                {newRawKey}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (newRawKey) navigator.clipboard.writeText(newRawKey)
                }}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-yellow-400">
              Store this key securely. You will not be able to retrieve it later.
            </p>
          </div>
          <DialogFooter>
            <Button size="sm" onClick={() => setNewRawKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Label</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-36">Role</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-36">Created</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-36">Last Used</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground w-20"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key: AccessApiKey) => {
                  return (
                    <tr key={key.id} className="border-b border-border/30 hover:bg-accent/20">
                      <td className="px-3 py-2 font-medium">{key.label}</td>
                      <td className="px-3 py-2">
                        <select
                          value={key.roleId ?? ''}
                          onChange={e => handleRoleChange(key.id, e.target.value || null)}
                          className="bg-background border border-border rounded px-2 py-1 text-xs"
                        >
                          <option value="">No role</option>
                          {roles.map(r => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(key.createdAt)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(key.lastUsedAt)}</td>
                      <td className="px-3 py-2">
                        {revokeConfirm === key.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleRevoke(key.id)}
                              className="text-xs text-destructive hover:text-destructive/80 font-medium"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setRevokeConfirm(null)}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setRevokeConfirm(key.id)}
                            className="text-xs text-destructive hover:text-destructive/80 transition-colors"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {keys.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground text-xs italic">
                      No API keys created yet.
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

function CreateKeyForm({ roles, onClose, onCreate }: {
  roles: AccessRole[]
  onClose: () => void
  onCreate: (label: string, roleId: string | null) => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [roleId, setRoleId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!label.trim()) {
      setError('Label is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate(label.trim(), roleId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key')
    }
    setSaving(false)
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">New API Key</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Label</label>
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="e.g. hive-production"
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Role</label>
            <select
              value={roleId ?? ''}
              onChange={e => setRoleId(e.target.value || null)}
              className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mt-1"
            >
              <option value="">No role</option>
              {roles.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Creating...' : 'Create Key'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
