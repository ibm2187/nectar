/**
 * Alert trigger catalog.
 *
 * Every trigger type the alerting system knows about. The AlertRouter
 * looks up triggers here to evaluate filters and generate incident
 * payloads. The UI reads this to render per-trigger filter fields.
 *
 * To add a new trigger: add an entry here, add an evaluator in
 * alert-router.js, and (for UI) add filter rendering in the rule editor.
 */

const FILTER_FIELDS = {
  customerIds: {
    label: 'Customers',
    description: 'Limit to specific customers (leave empty for all)',
    type: 'customer-multi',
  },
  envIds: {
    label: 'Environments',
    description: 'Limit to specific environments (leave empty for all in selected customers)',
    type: 'env-multi',
  },
  envTier: {
    label: 'Environment tier',
    description: 'Limit by environment tier',
    type: 'tier-multi',
    options: ['production', 'staging', 'lower'],
  },
  components: {
    label: 'Components',
    description: 'Limit to specific failing components',
    type: 'component-multi',
    // Must match what environment-poller.js → prettyComponentName produces,
    // otherwise filter matching will silently miss. Keep these in sync.
    options: ['Database', 'Cache', 'File Storage', 'Message Queue', 'Email', 'Messaging'],
  },
  sustainedMinutes: {
    label: 'Sustained minutes',
    description: 'Fire after unhealthy for this many consecutive minutes',
    type: 'number',
    default: 15,
    min: 1,
    max: 1440,
  },
};

const TRIGGERS = {
  'env-unhealthy': {
    label: 'Environment became unhealthy',
    description: 'Fires the first time an environment transitions to an unhealthy state',
    filterFields: ['customerIds', 'envIds', 'envTier', 'components'],
    defaultSeverity: 'critical',
    tier: 1,
  },
  'env-recovered': {
    label: 'Environment recovered',
    description: 'Fires when a previously-unhealthy environment becomes healthy again',
    filterFields: ['customerIds', 'envIds', 'envTier', 'components'],
    defaultSeverity: 'info',
    tier: 1,
  },
  'env-degraded-sustained': {
    label: 'Environment unhealthy for sustained period',
    description: 'Fires once when an environment has been unhealthy for more than N minutes',
    filterFields: ['customerIds', 'envIds', 'envTier', 'components', 'sustainedMinutes'],
    defaultSeverity: 'critical',
    tier: 1,
  },
  'deploy-failed': {
    label: 'Deployment failed',
    description: 'Fires when a CodeBuild or CodeDeploy pipeline reports failure',
    filterFields: ['customerIds', 'envIds', 'envTier'],
    defaultSeverity: 'critical',
    tier: 2,
  },
  'feature-flag-changed': {
    label: 'Feature flag changed',
    description: 'Fires when a feature flag (DB or config) is enabled/disabled on a live environment',
    filterFields: ['customerIds', 'envIds', 'envTier'],
    defaultSeverity: 'warning',
    tier: 2,
  },
  'integration-config-changed': {
    label: 'Integration config changed',
    description: 'Fires when a backend integration (SSO, SSO providers, etc.) is enabled/disabled on a live environment',
    filterFields: ['customerIds', 'envIds', 'envTier'],
    defaultSeverity: 'warning',
    tier: 2,
  },
  'upgrade-failed': {
    label: 'Upgrade / migration failed',
    description: 'Fires when a DB upgrade or migration reports a failed state',
    filterFields: ['customerIds', 'envIds', 'envTier'],
    defaultSeverity: 'critical',
    tier: 2,
  },
};

const SEVERITIES = ['critical', 'warning', 'info'];

function getTrigger(triggerType) {
  return TRIGGERS[triggerType] || null;
}

function isValidTriggerType(triggerType) {
  return Object.prototype.hasOwnProperty.call(TRIGGERS, triggerType);
}

function isValidSeverity(sev) {
  return SEVERITIES.includes(sev);
}

/**
 * Strip unknown / malformed filter keys from an incoming filter object
 * to match the trigger's declared filter schema. Returns a sanitized
 * object (never throws — unknown keys dropped silently).
 */
function sanitizeFilter(triggerType, rawFilter = {}) {
  const trigger = getTrigger(triggerType);
  if (!trigger) return {};
  const allowed = new Set(trigger.filterFields);
  const out = {};
  for (const [key, value] of Object.entries(rawFilter || {})) {
    if (!allowed.has(key)) continue;
    const spec = FILTER_FIELDS[key];
    if (!spec) continue;
    if (spec.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = n;
    } else if (Array.isArray(value)) {
      out[key] = value
        .filter(v => v !== null && v !== undefined && v !== '')
        .map(v => String(v))
        .filter(Boolean);
    } else if (typeof value === 'string' && value) {
      out[key] = [value];
    }
  }
  return out;
}

/**
 * Get a list of all triggers tagged with their metadata — used by the
 * /alerts/triggers endpoint so the UI can render dynamic filter forms.
 */
function listTriggers() {
  return Object.entries(TRIGGERS).map(([key, t]) => ({
    key,
    label: t.label,
    description: t.description,
    defaultSeverity: t.defaultSeverity,
    tier: t.tier,
    filterFields: t.filterFields.map(fk => ({
      key: fk,
      ...FILTER_FIELDS[fk],
    })),
  }));
}

module.exports = {
  TRIGGERS,
  FILTER_FIELDS,
  SEVERITIES,
  getTrigger,
  isValidTriggerType,
  isValidSeverity,
  sanitizeFilter,
  listTriggers,
};
