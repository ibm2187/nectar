const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-customers.json');

/**
 * CustomerStore — manages customers, environments, deployments, and mobile releases.
 * Persists to its own state file (.nectar-customers.json) separate from release state.
 *
 * Events:
 *   customer:updated       (customer)
 *   environment:updated    (environment)
 *   environment:version    (environment, { old, new })
 *   deployment:recorded    (deployment)
 *   scan:completed         (results)
 */
class CustomerStore extends EventEmitter {
  constructor() {
    super();
    this.customers = new Map();         // id → customer
    this.environments = new Map();      // id → environment
    this.deployments = [];               // chronological
    this.mobile = new Map();             // id → mobile release record
    this._saveTimer = null;
    this._loadState();
  }

  // ── Customer CRUD ───────────────────────────────────

  listCustomers(filter = {}) {
    let list = [...this.customers.values()];
    if (filter.active !== undefined) list = list.filter(c => c.active === filter.active);
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  getCustomer(id) {
    return this.customers.get(id) || null;
  }

  upsertCustomer(customer) {
    const existing = this.customers.get(customer.id);
    if (existing) {
      // Preserve manual fields; update synced fields only
      const merged = {
        ...existing,
        ...customer,
        // Never override manual overrides
        notes: existing.notes ?? customer.notes,
        updatedAt: new Date().toISOString(),
      };
      this.customers.set(customer.id, merged);
      this.emit('customer:updated', merged);
      this._debounceSave();
      return merged;
    }
    const created = {
      ...customer,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.customers.set(customer.id, created);
    this.emit('customer:updated', created);
    this._debounceSave();
    return created;
  }

  // ── Environment CRUD ────────────────────────────────

  listEnvironments(filter = {}) {
    let list = [...this.environments.values()];
    if (filter.customerId) list = list.filter(e => e.customerId === filter.customerId);
    if (filter.tier) list = list.filter(e => e.tier === filter.tier);
    if (filter.franchise !== undefined) list = list.filter(e => e.franchise === filter.franchise);
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  getEnvironment(id) {
    return this.environments.get(id) || null;
  }

  upsertEnvironment(env) {
    const existing = this.environments.get(env.id);
    if (existing) {
      const merged = {
        ...existing,
        ...env,
        // Preserve live state from existing — scanner only updates static fields
        currentVersion: existing.currentVersion,
        currentBranch: existing.currentBranch,
        lastChecked: existing.lastChecked,
        reachable: existing.reachable,
        // Preserve manual overrides
        disabled: existing.disabled,
        notes: existing.notes,
        updatedAt: new Date().toISOString(),
      };
      this.environments.set(env.id, merged);
      this.emit('environment:updated', merged);
      this._debounceSave();
      return merged;
    }
    const created = {
      ...env,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.environments.set(env.id, created);
    this.emit('environment:updated', created);
    this._debounceSave();
    return created;
  }

  /**
   * Update an environment's live state (called by poller).
   *
   * Behavior vs manual override:
   * - Poller SUCCESS (reachable=true, version present) → takes over, clears
   *   any manual flag. The real endpoint is now the source of truth.
   * - Poller FAILURE (unreachable or no version) → leaves manual version
   *   untouched. Only updates lastChecked/reachable.
   */
  updateLiveState(envId, { version, branch, reachable, error }) {
    const env = this.environments.get(envId);
    if (!env) return null;

    const oldVersion = env.currentVersion;

    // Always update the poll metadata
    env.lastChecked = new Date().toISOString();
    env.reachable = reachable;
    env.lastError = error || null;
    env.updatedAt = env.lastChecked;

    // Only replace the version if the poll succeeded with a version
    if (reachable && version) {
      env.currentVersion = version;
      env.currentBranch = branch ?? env.currentBranch;
      // Successful poll clears any manual override
      env.versionSetManually = false;
      env.versionSetBy = null;
      env.versionSetAt = null;
    }
    // If poll failed and we have no manual value, clear currentVersion? No —
    // leave the last-known value so the UI doesn't lose data on transient errors.

    this.emit('environment:updated', env);

    // If version changed, record a deployment
    if (version && reachable && version !== oldVersion) {
      this._recordDeployment(env, oldVersion, 'api-poll');
      this.emit('environment:version', env, { old: oldVersion, new: version });
    }

    this._debounceSave();
    return env;
  }

  /**
   * Update an environment's feature flags data (from poller).
   */
  updateFeatures(envId, features) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.features = features;
    env.lastFeaturesCheckedAt = new Date().toISOString();
    env.updatedAt = env.lastFeaturesCheckedAt;
    this.emit('environment:updated', env);
    this._debounceSave();
    return env;
  }

  /**
   * Update an environment's integrations data (from poller).
   */
  updateIntegrations(envId, integrations) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.integrations = integrations;
    env.lastIntegrationsCheckedAt = new Date().toISOString();
    env.updatedAt = env.lastIntegrationsCheckedAt;
    this.emit('environment:updated', env);
    this._debounceSave();
    return env;
  }

  /**
   * Update an environment's upgrades data (from poller).
   */
  updateUpgrades(envId, upgrades) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.upgrades = upgrades;
    env.lastUpgradesCheckedAt = new Date().toISOString();
    env.updatedAt = env.lastUpgradesCheckedAt;
    this.emit('environment:updated', env);
    this._debounceSave();
    return env;
  }

  /**
   * Manually set the version for an environment (from UI).
   * Bypasses the poller — records a deployment with source='manual'.
   */
  setManualVersion(envId, { version, branch, setBy }) {
    const env = this.environments.get(envId);
    if (!env) return null;

    const oldVersion = env.currentVersion;
    env.currentVersion = version || null;
    env.currentBranch = branch || (version ? `releases/${version}` : null);
    env.versionSetManually = true;
    env.versionSetBy = setBy || null;
    env.versionSetAt = new Date().toISOString();
    env.updatedAt = env.versionSetAt;

    this.emit('environment:updated', env);

    if (version && version !== oldVersion) {
      this._recordDeployment(env, oldVersion, 'manual');
      this.emit('environment:version', env, { old: oldVersion, new: version });
    }

    this._debounceSave();
    return env;
  }

  /**
   * Bulk set the same version across multiple environments.
   * Useful for CK where all franchises get deployed together.
   */
  setManualVersionBulk(envIds, { version, branch, setBy }) {
    const updated = [];
    for (const id of envIds) {
      const env = this.setManualVersion(id, { version, branch, setBy });
      if (env) updated.push(env);
    }
    return updated;
  }

  // ── Deployments ─────────────────────────────────────

  _recordDeployment(env, previousVersion, source = 'api-poll') {
    // Mark previous active deployment as ended
    const active = this.deployments.find(d => d.environmentId === env.id && !d.endedAt);
    const now = new Date().toISOString();
    if (active) active.endedAt = now;

    const deployment = {
      id: `dep-${env.id}-${Date.now()}`,
      environmentId: env.id,
      customerId: env.customerId,
      version: env.currentVersion,
      branch: env.currentBranch,
      previousVersion: previousVersion || null,
      detectedAt: now,
      endedAt: null,
      source,
    };
    this.deployments.push(deployment);

    // Cap deployment history to keep file size reasonable
    if (this.deployments.length > 10000) {
      this.deployments = this.deployments.slice(-5000);
    }

    this.emit('deployment:recorded', deployment);
    return deployment;
  }

  listDeployments(filter = {}) {
    let list = [...this.deployments];
    if (filter.environmentId) list = list.filter(d => d.environmentId === filter.environmentId);
    if (filter.customerId) list = list.filter(d => d.customerId === filter.customerId);
    if (filter.version) list = list.filter(d => d.version === filter.version);
    if (filter.active) list = list.filter(d => !d.endedAt);
    return list.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  // ── Mobile releases ─────────────────────────────────

  listMobile() {
    return [...this.mobile.values()];
  }

  upsertMobile(record) {
    this.mobile.set(record.id, {
      ...record,
      updatedAt: new Date().toISOString(),
    });
    this._debounceSave();
    return this.mobile.get(record.id);
  }

  // ── Scan integration ────────────────────────────────

  applyScanResults({ customers, environments }) {
    const results = {
      customersCreated: 0,
      customersUpdated: 0,
      environmentsCreated: 0,
      environmentsUpdated: 0,
    };

    for (const customer of customers) {
      const existed = this.customers.has(customer.id);
      this.upsertCustomer(customer);
      if (existed) results.customersUpdated++;
      else results.customersCreated++;
    }

    for (const env of environments) {
      const existed = this.environments.has(env.id);
      this.upsertEnvironment(env);
      if (existed) results.environmentsUpdated++;
      else results.environmentsCreated++;
    }

    this.emit('scan:completed', results);
    log.info(`Scan applied: +${results.customersCreated} customers, +${results.environmentsCreated} envs, ~${results.environmentsUpdated} updated`);
    return results;
  }

  // ── Persistence ─────────────────────────────────────

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(data.customers)) {
        for (const c of data.customers) this.customers.set(c.id, c);
      }
      if (Array.isArray(data.environments)) {
        for (const e of data.environments) this.environments.set(e.id, e);
      }
      if (Array.isArray(data.deployments)) {
        this.deployments = data.deployments;
      }
      if (Array.isArray(data.mobile)) {
        for (const m of data.mobile) this.mobile.set(m.id, m);
      }
      log.info(`Customer state loaded: ${this.customers.size} customers, ${this.environments.size} environments, ${this.deployments.length} deployments`);
    } catch {
      // No state yet — fine
    }
  }

  _saveState() {
    const data = {
      customers: [...this.customers.values()],
      environments: [...this.environments.values()],
      deployments: this.deployments,
      mobile: [...this.mobile.values()],
      savedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error('Failed to save customer state:', err.message);
    }
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveState();
    }, 5000);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveState();
  }
}

module.exports = CustomerStore;
