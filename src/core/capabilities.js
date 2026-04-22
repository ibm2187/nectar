/**
 * Capability catalog — the single source of truth for all authorization
 * capabilities in nectar. Nothing else hardcodes capability strings.
 *
 * Each capability has:
 *   - id: namespaced string (e.g. 'config.write')
 *   - name: human-readable label
 *   - description: what the capability gates
 *   - namespace: derived from the id prefix
 */

const CAPABILITIES = [
  {
    id: 'config.write',
    name: 'Manage Config',
    description: 'View and edit themes, integrations, notifications, logs, customer metadata, people directory, release templates',
    namespace: 'config',
  },
  {
    id: 'release.write',
    name: 'Manage Releases',
    description: 'Create/update/delete releases, transition state, approve, deploy, manage tickets, cherry-picks, draft notes, refresh, configure release train, complete/skip milestones',
    namespace: 'release',
  },
  {
    id: 'environment.write',
    name: 'Manage Environments',
    description: 'Change environment versions (single + bulk), trigger scans and polling',
    namespace: 'environment',
  },
  {
    id: 'sync.trigger',
    name: 'Trigger Syncs',
    description: 'Trigger JIRA, PR, pipeline, discovery, Zoho syncs',
    namespace: 'sync',
  },
  {
    id: 'task.write',
    name: 'Manage Tasks',
    description: 'Create and cancel tasks (task completion auto-updates releases)',
    namespace: 'task',
  },
  {
    id: 'notify.send',
    name: 'Send Notifications',
    description: 'Send Slack notifications (standup reminders, ticket notifications, release channel posts)',
    namespace: 'notify',
  },
  {
    id: 'user.admin',
    name: 'Manage Users & Roles',
    description: 'User role management, API key management, access control page',
    namespace: 'user',
  },
  {
    id: 'system.admin',
    name: 'System Administration',
    description: 'Restart server, git pull, datadog backfill, availability refresh',
    namespace: 'system',
  },
];

// Pre-compute lookup set for O(1) validation
const CAPABILITY_IDS = new Set(CAPABILITIES.map(c => c.id));

/**
 * Get the full capability catalog.
 * @returns {Array<{id: string, name: string, description: string, namespace: string}>}
 */
function getCapabilities() {
  return CAPABILITIES;
}

/**
 * Check if a capability ID is valid.
 * @param {string} id
 * @returns {boolean}
 */
function isValidCapability(id) {
  return CAPABILITY_IDS.has(id);
}

/**
 * Get all capability IDs as an array.
 * @returns {string[]}
 */
function getAllCapabilityIds() {
  return Array.from(CAPABILITY_IDS);
}

module.exports = { getCapabilities, isValidCapability, getAllCapabilityIds, CAPABILITIES };
