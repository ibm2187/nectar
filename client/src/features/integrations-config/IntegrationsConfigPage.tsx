import { useEffect, useState } from 'react'
import { apiFetch } from '../../api/client'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { NectarLoader } from '../../components/NectarLoader'
import { cn } from '../../lib/utils'

interface IntegrationVar {
  label: string
  secret: boolean
  type: string
  value: string
  hasValue: boolean
}

interface IntegrationDef {
  name: string
  label: string
  configured: boolean
  vars: Record<string, IntegrationVar>
}

type IntegrationsData = Record<string, IntegrationDef>

export function IntegrationsConfigPage() {
  const [integrations, setIntegrations] = useState<IntegrationsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<IntegrationsData>('/config/integrations')
      setIntegrations(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return <NectarLoader size="lg" message="Loading integrations..." className="mt-32" />
  }

  if (!integrations) {
    return (
      <div className="w-full text-center mt-32">
        <p className="text-sm text-destructive">{error || 'Failed to load'}</p>
        <Button variant="outline" size="sm" onClick={load} className="mt-2">Retry</Button>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4">
      <p className="text-sm text-muted-foreground">
        Configure external service connections. Changes are saved to the .env file.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {Object.entries(integrations).map(([key, def]) => (
        <IntegrationCard
          key={key}
          integration={def}
          onSaved={load}
        />
      ))}
    </div>
  )
}

// ── Integration Card ──────────────────────────────────

function IntegrationCard({ integration, onSaved }: {
  integration: IntegrationDef
  onSaved: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const [key, v] of Object.entries(integration.vars)) {
      init[key] = v.value
    }
    return init
  })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset local values when integration data changes (e.g., after save + reload)
  useEffect(() => {
    const init: Record<string, string> = {}
    for (const [key, v] of Object.entries(integration.vars)) {
      init[key] = v.value
    }
    setValues(init)
  }, [integration])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaveMsg(null)
    setTestResult(null)
    try {
      await apiFetch(`/config/integrations/${integration.name}`, {
        method: 'POST',
        body: JSON.stringify(values),
      })
      setSaveMsg('Saved successfully')
      setTimeout(() => setSaveMsg(null), 3000)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await apiFetch<{ ok: boolean; detail: string }>(
        `/config/integrations/${integration.name}/test`,
        { method: 'POST' }
      )
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : 'Test failed' })
    }
    setTesting(false)
  }

  const updateValue = (key: string, val: string) => {
    setValues(prev => ({ ...prev, [key]: val }))
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">{integration.label}</CardTitle>
            <span className={cn(
              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
              integration.configured
                ? "bg-green-500/10 text-green-400 border border-green-500/30"
                : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/30"
            )}>
              <span className={cn(
                "w-1.5 h-1.5 rounded-full",
                integration.configured ? "bg-green-400" : "bg-yellow-400"
              )} />
              {integration.configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Fields */}
        <div className="space-y-3">
          {Object.entries(integration.vars).map(([key, varDef]) => (
            <div key={key} className="flex items-center gap-3">
              <label className="text-sm text-muted-foreground w-40 shrink-0">
                {varDef.label}
              </label>
              {varDef.type === 'boolean' ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={values[key] === 'true'}
                    onChange={e => updateValue(key, e.target.checked ? 'true' : 'false')}
                    className="h-4 w-4 rounded border-input bg-background"
                  />
                  <span className="text-sm">{values[key] === 'true' ? 'Enabled' : 'Disabled'}</span>
                </label>
              ) : (
                <Input
                  type={varDef.secret ? 'password' : 'text'}
                  value={values[key] || ''}
                  onChange={e => updateValue(key, e.target.value)}
                  placeholder={varDef.secret ? 'Enter value...' : `Enter ${varDef.label.toLowerCase()}...`}
                  className="h-8 text-sm flex-1 max-w-md font-mono"
                />
              )}
              {varDef.hasValue && (
                <span className="text-xs text-muted-foreground font-mono" title="Last 3 chars of stored value">
                  {varDef.secret && varDef.value ? varDef.value : 'set'}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Messages */}
        {saveMsg && <p className="text-xs text-green-400">{saveMsg}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {testResult && (
          <div className={cn(
            "rounded-md border px-3 py-2 text-sm",
            testResult.ok
              ? "border-green-500/30 bg-green-500/5 text-green-400"
              : "border-destructive/30 bg-destructive/5 text-destructive"
          )}>
            {testResult.ok ? 'OK' : 'Failed'}: {testResult.detail}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing...' : 'Test Connection'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
