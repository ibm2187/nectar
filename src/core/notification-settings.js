const log = require('./log');
const { getDb } = require('./db');

// Evaluated at construction time, not module load — see constructor.

/**
 * GROUP_SCHEMA — defines the grouped notification model.
 *
 * Three groups, nine notification types total.
 * Used by the frontend to render grouped toggles and by get() for lookups.
 */
const GROUP_SCHEMA = {
  releaseChannel: {
    label: 'Release Channel',
    description: 'Notifications posted to per-release Slack channels (e.g. #releases-4-2-0)',
    notifications: {
      transitions: { label: 'State Transitions', description: 'Release cut, state changes, and approvals' },
      deploys: { label: 'Deployments', description: 'Deployment success and failure alerts' },
      dateChanges: { label: 'Date Changes', description: 'Release date changed in JIRA' },
      envDeployments: { label: 'Environment Deployments', description: 'Version detected on a live environment' },
    },
  },
  scheduledReports: {
    label: 'Scheduled Reports',
    description: 'Periodic digests posted to release channels on a schedule',
    notifications: {
      releaseStatus: { label: 'Release Status', description: '9 AM + 2 PM status digests for due releases' },
      ticketChanges: { label: 'Ticket Changes', description: 'Tickets added/removed since last digest' },
    },
  },
  developerAlerts: {
    label: 'Developer Alerts',
    description: 'DMs and alerts sent directly to individual developers',
    notifications: {
      dailyDigest: { label: 'Daily Digest', description: 'Morning DM with undone tickets across upcoming releases' },
      buildFailures: { label: 'Build Failure Alerts', description: 'DMs when a build fails or recovers' },
      cherryPickConflicts: { label: 'Cherry-Pick Conflicts', description: 'DMs when a cherry-pick has a merge conflict' },
    },
  },
  environmentAlerts: {
    label: 'Environment Alerts',
    description: 'Slack posts when an environment becomes unhealthy, recovers, or stays degraded. Routing is controlled by rules configured on this page.',
    notifications: {
      envUnhealthy: { label: 'Unhealthy Transitions', description: 'Fires when an environment transitions from healthy to unhealthy' },
      envRecovered: { label: 'Recovery', description: 'Fires when a previously-unhealthy environment becomes healthy again' },
      envSustained: { label: 'Sustained Degradation', description: 'Escalation fired when an environment stays unhealthy for N minutes' },
    },
  },
};

// Reverse lookup: notification key → group key
const NOTIFICATION_TO_GROUP = {};
for (const [groupKey, group] of Object.entries(GROUP_SCHEMA)) {
  for (const notifKey of Object.keys(group.notifications)) {
    NOTIFICATION_TO_GROUP[notifKey] = groupKey;
  }
}

// Schema is immutable — deep-freeze to prevent accidental mutation
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) deepFreeze(val);
  }
  return obj;
}
const FROZEN_SCHEMA = deepFreeze(structuredClone(GROUP_SCHEMA));

/**
 * Build default group state. In production all toggles are on;
 * in non-production all toggles are off.
 */
function buildDefaults(enabled) {
  const groups = {};
  for (const [groupKey, group] of Object.entries(GROUP_SCHEMA)) {
    const notifications = {};
    for (const notifKey of Object.keys(group.notifications)) {
      notifications[notifKey] = enabled;
    }
    groups[groupKey] = { enabled, notifications };
  }
  return groups;
}

/**
 * NotificationSettings — persists grouped notification toggles in SQLite.
 *
 * Three-level model: master → group → child.
 * `get(key)` checks master, then group enabled, then child boolean.
 *
 * Replaces the old flat JSON-file model.
 */
class NotificationSettings {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db] — inject a DB (tests)
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    this.enabled = true;
    this.redirectChannel = null;
    this.redirectDM = null;
    const isProduction = process.env.NODE_ENV === 'production';
    this.groups = buildDefaults(isProduction);
    this._saveStmt = null;
    this._load();
  }

  /**
   * Check if a notification type is enabled.
   * Three-level: master → group → child.
   * Unknown keys return false (fail-closed).
   */
  get(key) {
    if (!this.enabled) return false;
    const groupKey = NOTIFICATION_TO_GROUP[key];
    if (!groupKey) {
      log.warn(`NotificationSettings: unknown key "${key}" — returning false`);
      return false;
    }
    const group = this.groups[groupKey];
    if (!group || !group.enabled) return false;
    return !!group.notifications[key];
  }

  /**
   * Toggle an individual notification.
   */
  set(key, enabled) {
    const groupKey = NOTIFICATION_TO_GROUP[key];
    if (!groupKey) return;
    const value = !!enabled;
    if (this.groups[groupKey].notifications[key] === value) return;
    this.groups[groupKey].notifications[key] = value;
    this._save();
    log.info(`Notification settings: ${key} = ${value}`);
  }

  /**
   * Toggle a group's enabled flag.
   * Does NOT touch child values — they are preserved for re-enable.
   */
  setGroup(groupKey, enabled) {
    if (!this.groups[groupKey]) return;
    const value = !!enabled;
    if (this.groups[groupKey].enabled === value) return;
    this.groups[groupKey].enabled = value;
    this._save();
    log.info(`Notification settings: group ${groupKey} = ${value}`);
  }

  /**
   * Get all settings as a deep copy.
   */
  getAll() {
    return structuredClone({
      enabled: this.enabled,
      redirectChannel: this.redirectChannel,
      redirectDM: this.redirectDM,
      groups: this.groups,
    });
  }

  /**
   * Get the GROUP_SCHEMA (for API/frontend).
   */
  getSchema() {
    return FROZEN_SCHEMA;
  }

  /**
   * Bulk update from API.
   */
  update(settings) {
    if (typeof settings.enabled === 'boolean') {
      this.enabled = settings.enabled;
      log.info(`Notification settings: master toggle = ${this.enabled}`);
    }

    // Redirect fields — coerce empty string to null
    if ('redirectChannel' in settings) {
      this.redirectChannel = settings.redirectChannel || null;
    }
    if ('redirectDM' in settings) {
      this.redirectDM = settings.redirectDM || null;
    }

    // Groups
    if (settings.groups && typeof settings.groups === 'object') {
      for (const [groupKey, groupPatch] of Object.entries(settings.groups)) {
        const group = this.groups[groupKey];
        if (!group) continue;
        if (typeof groupPatch.enabled === 'boolean') {
          group.enabled = groupPatch.enabled;
        }
        if (groupPatch.notifications && typeof groupPatch.notifications === 'object') {
          for (const [notifKey, value] of Object.entries(groupPatch.notifications)) {
            if (notifKey in group.notifications && typeof value === 'boolean') {
              group.notifications[notifKey] = value;
            }
          }
        }
      }
    }

    this._save();
  }

  flush() {
    this._save();
  }

  /**
   * Re-read settings from DB. Used by the sync-worker to pick up
   * changes made by the web-server process without a restart.
   */
  reload() {
    this._load();
  }

  // ── Internal ────────────────────────────────────────────

  _load() {
    try {
      const row = this.db.prepare('SELECT * FROM notification_settings WHERE id = 1').get();
      if (!row) return;

      if (typeof row.enabled === 'number') this.enabled = !!row.enabled;
      this.redirectChannel = row.redirectChannel || null;
      this.redirectDM = row.redirectDM || null;

      if (row.groups) {
        const saved = JSON.parse(row.groups);
        for (const [groupKey, savedGroup] of Object.entries(saved)) {
          const group = this.groups[groupKey];
          if (!group) continue;
          if (typeof savedGroup.enabled === 'boolean') {
            group.enabled = savedGroup.enabled;
          }
          if (savedGroup.notifications) {
            for (const [notifKey, value] of Object.entries(savedGroup.notifications)) {
              if (notifKey in group.notifications && typeof value === 'boolean') {
                group.notifications[notifKey] = value;
              }
            }
          }
        }
      }

      log.info(`Notification settings loaded from DB (enabled: ${this.enabled})`);
    } catch (err) {
      log.error(`Failed to load notification settings: ${err.message}`);
    }
  }

  _save() {
    try {
      if (!this._saveStmt) {
        this._saveStmt = this.db.prepare(`
          INSERT INTO notification_settings (id, enabled, redirectChannel, redirectDM, groups, updatedAt)
          VALUES (1, @enabled, @redirectChannel, @redirectDM, @groups, @updatedAt)
          ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            redirectChannel = excluded.redirectChannel,
            redirectDM = excluded.redirectDM,
            groups = excluded.groups,
            updatedAt = excluded.updatedAt
        `);
      }
      this._saveStmt.run({
        enabled: this.enabled ? 1 : 0,
        redirectChannel: this.redirectChannel,
        redirectDM: this.redirectDM,
        groups: JSON.stringify(this.groups),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.error(`Failed to save notification settings: ${err.message}`);
    }
  }
}

module.exports = NotificationSettings;
