const crypto = require('crypto');
const { EventEmitter } = require('events');
const log = require('./log');
const { getDb } = require('./db');

// ── Column contracts ────────────────────────────────────────────────────────

const CUSTOMER_COLUMNS = [
  'id','name','shortName','color','hidden','sortOrder',
  'domain','domainPrefix','integrations','hasFranchises','active',
  'syncedFrom','lastSyncedAt','notes','createdAt','updatedAt',
];

const ENVIRONMENT_COLUMNS = [
  'id','customerId','name','tier','franchise','currentVersion','currentBranch','reachable',
  'lastChecked','lastError','health','features','integrations','upgrades',
  'lastHealthCheckedAt','lastFeaturesCheckedAt','lastIntegrationsCheckedAt','lastUpgradesCheckedAt',
  'disabled','notes','versionSetManually','versionSetBy','versionSetAt','createdAt','updatedAt',
];

const ENV_JSON_FIELDS = ['health','features','integrations','upgrades'];
const ENV_BOOL_FIELDS = ['franchise','reachable','disabled','versionSetManually'];
const CUST_BOOL_FIELDS = ['hasFranchises','active','hidden'];

// Fields that users can edit via the Config UI — scanner must not overwrite these.
const USER_EDITABLE_FIELDS = new Set(['shortName', 'color', 'hidden', 'sortOrder', 'notes']);

/**
 * CustomerStore — manages customers, environments, deployments, and mobile releases.
 * Persists to the SQLite tables: customers, environments, deployments, mobile.
 *
 * Deployments are NOT mirrored in memory — they're queried on demand.
 * This is the key win: we can have 100k+ deployment rows without loading
 * them all at startup.
 *
 * Events:
 *   customer:updated       (customer)
 *   environment:updated    (environment)
 *   environment:version    (environment, { old, new })
 *   deployment:recorded    (deployment)
 *   scan:completed         (results)
 */
class CustomerStore extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db]
   */
  constructor(opts = {}) {
    super();
    this.db = opts.db || getDb();
    this.customers = new Map();    // id → customer
    this.environments = new Map(); // id → environment
    this.mobile = new Map();       // id → mobile release record
    // Legacy: some callers (tests, older code) expect this to be an array.
    // We expose it as a computed list, but also let tests reset it with [].
    // Since deployments are queried on demand, this stays empty by default.
    this.deployments = [];
    this._loadState();
  }

  // ── Customer CRUD ───────────────────────────────────

  listCustomers(filter = {}) {
    let list = [...this.customers.values()];
    if (filter.active !== undefined) list = list.filter(c => c.active === filter.active);
    if (filter.hidden !== undefined) list = list.filter(c => !!c.hidden === filter.hidden);
    return list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id.localeCompare(b.id));
  }

  /** List only visible (non-hidden) customers, sorted by sortOrder. */
  listVisibleCustomers() {
    return this.listCustomers({ hidden: false });
  }

  getCustomer(id) {
    return this.customers.get(id) || null;
  }

  upsertCustomer(customer) {
    const existing = this.customers.get(customer.id);
    if (existing) {
      const merged = { ...existing, updatedAt: new Date().toISOString() };
      // Apply incoming fields, but preserve user-editable fields if already set
      for (const [key, value] of Object.entries(customer)) {
        if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue;
        if (USER_EDITABLE_FIELDS.has(key) && existing[key] != null) continue;
        merged[key] = value;
      }
      this.customers.set(customer.id, merged);
      this._upsertCustomerRow(merged);
      this.emit('customer:updated', merged);
      return merged;
    }
    const created = {
      ...customer,
      hidden: customer.hidden ?? false,
      sortOrder: customer.sortOrder ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.customers.set(customer.id, created);
    this._upsertCustomerRow(created);
    this.emit('customer:updated', created);
    return created;
  }

  /**
   * Update user-editable customer fields (from Config UI).
   * Only touches the fields provided — does not reset others.
   */
  updateCustomer(id, changes) {
    const existing = this.customers.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, id, updatedAt: new Date().toISOString() };
    this.customers.set(id, merged);
    this._upsertCustomerRow(merged);
    this.emit('customer:updated', merged);
    return merged;
  }

  /**
   * Seed display defaults (shortName, color, sortOrder, hidden) for customers
   * that don't have them yet. Called after the initial webplatform scan to
   * populate newly discovered customers with sensible defaults.
   */
  seedDisplayDefaults() {
    const defaults = {
      bayada:      { shortName: 'Bayada',       color: '#E31A38', sortOrder: 1 },
      ck:          { shortName: 'CK',           color: '#0054A6', sortOrder: 2 },
      tribute:     { shortName: 'Tribute',      color: '#FF671F', sortOrder: 3 },
      lumen:       { shortName: 'Lumen',        color: '#6D1D68', sortOrder: 4 },
      qualitycare: { shortName: 'Quality Care', color: '#8B2323', sortOrder: 5 },
      viv:         { shortName: 'Viv',          color: '#22c55e', sortOrder: 6, name: 'Viv (Internal)' },
      haven:       { shortName: 'Haven',        color: '#64748b', sortOrder: 7, hidden: true },
    };
    let seeded = 0;
    for (const c of this.customers.values()) {
      if (c.shortName) continue; // already has display config
      const d = defaults[c.id] || { shortName: c.name || c.id, color: '#64748b', sortOrder: 99 };
      const updated = {
        ...c,
        shortName: d.shortName,
        color: d.color,
        sortOrder: d.sortOrder,
        hidden: d.hidden || false,
        updatedAt: new Date().toISOString(),
      };
      this.customers.set(c.id, updated);
      this._upsertCustomerRow(updated);
      seeded++;
    }
    if (seeded > 0) log.info(`Seeded display defaults for ${seeded} customers`);
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
      this._upsertEnvRow(merged);
      this.emit('environment:updated', merged);
      return merged;
    }
    const created = {
      ...env,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.environments.set(env.id, created);
    this._upsertEnvRow(created);
    this.emit('environment:updated', created);
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

    this._upsertEnvRow(env);
    this.emit('environment:updated', env);

    // If version changed, record a deployment
    if (version && reachable && version !== oldVersion) {
      this._recordDeployment(env, oldVersion, 'api-poll');
      this.emit('environment:version', env, { old: oldVersion, new: version });
    }

    return env;
  }

  /**
   * Update an environment's health check data (from poller).
   */
  updateHealth(envId, healthData) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.health = {
      status: healthData.status,
      checks: healthData.checks || {},
      summary: healthData.summary || {},
      responseTimeMs: healthData.responseTimeMs || null,
      checkedAt: healthData.checkedAt || new Date().toISOString(),
    };
    env.lastHealthCheckedAt = env.health.checkedAt;
    env.updatedAt = env.health.checkedAt;
    this._upsertEnvRow(env);
    this.emit('environment:updated', env);
    return env;
  }

  updateFeatures(envId, features) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.features = features;
    env.lastFeaturesCheckedAt = new Date().toISOString();
    env.updatedAt = env.lastFeaturesCheckedAt;
    this._upsertEnvRow(env);
    this.emit('environment:updated', env);
    return env;
  }

  updateIntegrations(envId, integrations) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.integrations = integrations;
    env.lastIntegrationsCheckedAt = new Date().toISOString();
    env.updatedAt = env.lastIntegrationsCheckedAt;
    this._upsertEnvRow(env);
    this.emit('environment:updated', env);
    return env;
  }

  updateUpgrades(envId, upgrades) {
    const env = this.environments.get(envId);
    if (!env) return null;
    env.upgrades = upgrades;
    env.lastUpgradesCheckedAt = new Date().toISOString();
    env.updatedAt = env.lastUpgradesCheckedAt;
    this._upsertEnvRow(env);
    this.emit('environment:updated', env);
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

    this._upsertEnvRow(env);
    this.emit('environment:updated', env);

    if (version && version !== oldVersion) {
      this._recordDeployment(env, oldVersion, 'manual');
      this.emit('environment:version', env, { old: oldVersion, new: version });
    }
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

  /**
   * Set the DatadogClient instance so deployment impact can be captured
   * automatically when version changes are detected.
   */
  setDatadogClient(datadogClient) {
    this._datadogClient = datadogClient || null;
  }

  // ── Deployments ─────────────────────────────────────

  _recordDeployment(env, previousVersion, source = 'api-poll') {
    const now = new Date().toISOString();

    // Mark previous active deployment as ended
    this.db.prepare(
      'UPDATE deployments SET endedAt = ? WHERE environmentId = ? AND endedAt IS NULL'
    ).run(now, env.id);

    const deployment = {
      // Include a random suffix so multiple deployments within the same
      // millisecond (common in tests and bulk operations) don't collide.
      id: `dep-${env.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      environmentId: env.id,
      customerId: env.customerId,
      version: env.currentVersion,
      branch: env.currentBranch,
      previousVersion: previousVersion || null,
      detectedAt: now,
      endedAt: null,
      source,
    };

    this.db.prepare(`
      INSERT INTO deployments (id, environmentId, customerId, version, branch, previousVersion,
                               detectedAt, endedAt, source, datadogImpact)
      VALUES (@id, @environmentId, @customerId, @version, @branch, @previousVersion,
              @detectedAt, @endedAt, @source, NULL)
    `).run(deployment);

    // Asynchronously capture Datadog deployment impact if configured.
    // Fire-and-forget: failures are logged but do not block deployment recording.
    if (this._datadogClient && this._datadogClient.isConfigured()) {
      const envTag = `env:${env.customerId}`;
      this._datadogClient.getDeploymentImpact(envTag, now)
        .then(impact => {
          const impactRecord = {
            capturedAt: new Date().toISOString(),
            window: impact.window,
            errorRate: impact.errorRate,
            latencyP90: impact.latencyP90,
            throughput: impact.throughput,
            alertsTriggered: impact.alertsTriggered,
          };
          deployment.datadogImpact = impactRecord;
          this.db.prepare('UPDATE deployments SET datadogImpact = ? WHERE id = ?')
            .run(JSON.stringify(impactRecord), deployment.id);
        })
        .catch(err => {
          log.warn(`Datadog impact capture failed for ${deployment.id}: ${err.message}`);
        });
    }

    this.emit('deployment:recorded', deployment);
    return deployment;
  }

  /**
   * Query deployments from the DB. Unlike the old version this does NOT
   * scan an in-memory array — the DB does the filtering, sorting, and
   * (optional) paging.
   *
   * @param {object} filter
   * @param {string} [filter.environmentId]
   * @param {string} [filter.customerId]
   * @param {string} [filter.version]
   * @param {boolean} [filter.active]     — endedAt IS NULL
   * @param {number}  [filter.limit]
   * @param {number}  [filter.offset]
   * @returns {Array<object>}
   */
  listDeployments(filter = {}) {
    const clauses = [];
    const params = {};
    if (filter.environmentId) { clauses.push('environmentId = @environmentId'); params.environmentId = filter.environmentId; }
    if (filter.customerId)    { clauses.push('customerId = @customerId');       params.customerId = filter.customerId; }
    if (filter.version)       { clauses.push('version = @version');             params.version = filter.version; }
    if (filter.active)        { clauses.push('endedAt IS NULL'); }

    let sql = 'SELECT * FROM deployments';
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY detectedAt DESC';
    if (filter.limit)  { sql += ' LIMIT @limit';  params.limit = filter.limit; }
    if (filter.offset) { sql += ' OFFSET @offset'; params.offset = filter.offset; }

    const rows = Object.keys(params).length
      ? this.db.prepare(sql).all(params)
      : this.db.prepare(sql).all();
    return rows.map(deploymentFromRow);
  }

  /**
   * Count deployments matching a filter. Handy for pagination.
   */
  countDeployments(filter = {}) {
    const clauses = [];
    const params = {};
    if (filter.environmentId) { clauses.push('environmentId = @environmentId'); params.environmentId = filter.environmentId; }
    if (filter.customerId)    { clauses.push('customerId = @customerId');       params.customerId = filter.customerId; }
    if (filter.version)       { clauses.push('version = @version');             params.version = filter.version; }
    if (filter.active)        { clauses.push('endedAt IS NULL'); }

    let sql = 'SELECT COUNT(*) AS n FROM deployments';
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    return (Object.keys(params).length ? this.db.prepare(sql).get(params) : this.db.prepare(sql).get()).n;
  }

  // ── Mobile releases ─────────────────────────────────

  listMobile() {
    return [...this.mobile.values()];
  }

  upsertMobile(record) {
    const updated = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    this.mobile.set(record.id, updated);
    this.db.prepare(`
      INSERT INTO mobile (id, data, updatedAt)
      VALUES (@id, @data, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
    `).run({
      id: updated.id,
      data: JSON.stringify(updated),
      updatedAt: updated.updatedAt,
    });
    return updated;
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

  /**
   * Backwards-compat no-op — writes are synchronous with SQLite.
   */
  flush() { /* no-op */ }

  // ── Internal ────────────────────────────────────────

  _upsertCustomerRow(c) {
    this.db.prepare(`
      INSERT INTO customers (id, name, shortName, color, hidden, sortOrder,
                             domain, domainPrefix, integrations, hasFranchises, active,
                             syncedFrom, lastSyncedAt, notes, extra, createdAt, updatedAt)
      VALUES (@id, @name, @shortName, @color, @hidden, @sortOrder,
              @domain, @domainPrefix, @integrations, @hasFranchises, @active,
              @syncedFrom, @lastSyncedAt, @notes, @extra, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name          = excluded.name,
        shortName     = excluded.shortName,
        color         = excluded.color,
        hidden        = excluded.hidden,
        sortOrder     = excluded.sortOrder,
        domain        = excluded.domain,
        domainPrefix  = excluded.domainPrefix,
        integrations  = excluded.integrations,
        hasFranchises = excluded.hasFranchises,
        active        = excluded.active,
        syncedFrom    = excluded.syncedFrom,
        lastSyncedAt  = excluded.lastSyncedAt,
        notes         = excluded.notes,
        extra         = excluded.extra,
        updatedAt     = excluded.updatedAt
    `).run(customerToRow(c));
  }

  _upsertEnvRow(e) {
    this.db.prepare(`
      INSERT INTO environments (
        id, customerId, name, tier, franchise, currentVersion, currentBranch, reachable,
        lastChecked, lastError, health, features, integrations, upgrades,
        lastHealthCheckedAt, lastFeaturesCheckedAt, lastIntegrationsCheckedAt, lastUpgradesCheckedAt,
        disabled, notes, versionSetManually, versionSetBy, versionSetAt,
        extra, createdAt, updatedAt
      ) VALUES (
        @id, @customerId, @name, @tier, @franchise, @currentVersion, @currentBranch, @reachable,
        @lastChecked, @lastError, @health, @features, @integrations, @upgrades,
        @lastHealthCheckedAt, @lastFeaturesCheckedAt, @lastIntegrationsCheckedAt, @lastUpgradesCheckedAt,
        @disabled, @notes, @versionSetManually, @versionSetBy, @versionSetAt,
        @extra, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        customerId                = excluded.customerId,
        name                      = excluded.name,
        tier                      = excluded.tier,
        franchise                 = excluded.franchise,
        currentVersion            = excluded.currentVersion,
        currentBranch             = excluded.currentBranch,
        reachable                 = excluded.reachable,
        lastChecked               = excluded.lastChecked,
        lastError                 = excluded.lastError,
        health                    = excluded.health,
        features                  = excluded.features,
        integrations              = excluded.integrations,
        upgrades                  = excluded.upgrades,
        lastHealthCheckedAt       = excluded.lastHealthCheckedAt,
        lastFeaturesCheckedAt     = excluded.lastFeaturesCheckedAt,
        lastIntegrationsCheckedAt = excluded.lastIntegrationsCheckedAt,
        lastUpgradesCheckedAt     = excluded.lastUpgradesCheckedAt,
        disabled                  = excluded.disabled,
        notes                     = excluded.notes,
        versionSetManually        = excluded.versionSetManually,
        versionSetBy              = excluded.versionSetBy,
        versionSetAt              = excluded.versionSetAt,
        extra                     = excluded.extra,
        updatedAt                 = excluded.updatedAt
    `).run(envToRow(e));
  }

  _loadState() {
    try {
      const customers = this.db.prepare('SELECT * FROM customers').all();
      for (const row of customers) {
        this.customers.set(row.id, customerFromRow(row));
      }

      const envs = this.db.prepare('SELECT * FROM environments').all();
      for (const row of envs) {
        this.environments.set(row.id, envFromRow(row));
      }

      const mobiles = this.db.prepare('SELECT * FROM mobile').all();
      for (const row of mobiles) {
        try {
          this.mobile.set(row.id, JSON.parse(row.data));
        } catch { /* skip malformed */ }
      }

      const depCount = this.db.prepare('SELECT COUNT(*) AS n FROM deployments').get().n;
      log.info(`Customer state loaded: ${this.customers.size} customers, ${this.environments.size} environments, ${depCount} deployments`);
    } catch (err) {
      log.warn(`Failed to load customer state: ${err.message}`);
    }
  }
}

// ── Row ↔ object mapping ────────────────────────────────────────────────────

function customerToRow(c) {
  const extra = {};
  for (const k of Object.keys(c)) {
    if (!CUSTOMER_COLUMNS.includes(k)) extra[k] = c[k];
  }
  return {
    id: c.id,
    name: c.name ?? null,
    shortName: c.shortName ?? null,
    color: c.color ?? null,
    hidden: boolOrNull(c.hidden),
    sortOrder: c.sortOrder ?? 0,
    domain: c.domain ?? null,
    domainPrefix: c.domainPrefix ?? null,
    integrations: c.integrations == null ? null : JSON.stringify(c.integrations),
    hasFranchises: boolOrNull(c.hasFranchises),
    active: boolOrNull(c.active),
    syncedFrom: c.syncedFrom ?? null,
    lastSyncedAt: c.lastSyncedAt ?? null,
    notes: c.notes ?? null,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function customerFromRow(row) {
  const customer = {
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    color: row.color,
    sortOrder: row.sortOrder ?? 0,
    domain: row.domain,
    domainPrefix: row.domainPrefix,
    integrations: row.integrations == null ? null : safeParse(row.integrations, null),
    syncedFrom: row.syncedFrom,
    lastSyncedAt: row.lastSyncedAt,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  for (const f of CUST_BOOL_FIELDS) customer[f] = row[f] == null ? null : !!row[f];
  if (row.extra) {
    try {
      const extra = JSON.parse(row.extra);
      if (extra && typeof extra === 'object') Object.assign(customer, extra);
    } catch { /* ignore */ }
  }
  return customer;
}

function envToRow(e) {
  const extra = {};
  for (const k of Object.keys(e)) {
    if (!ENVIRONMENT_COLUMNS.includes(k)) extra[k] = e[k];
  }
  const row = {
    id: e.id,
    customerId: e.customerId ?? null,
    name: e.name ?? null,
    tier: e.tier ?? null,
    franchise: boolOrNull(e.franchise),
    currentVersion: e.currentVersion ?? null,
    currentBranch: e.currentBranch ?? null,
    reachable: boolOrNull(e.reachable),
    lastChecked: e.lastChecked ?? null,
    lastError: e.lastError ?? null,
    lastHealthCheckedAt: e.lastHealthCheckedAt ?? null,
    lastFeaturesCheckedAt: e.lastFeaturesCheckedAt ?? null,
    lastIntegrationsCheckedAt: e.lastIntegrationsCheckedAt ?? null,
    lastUpgradesCheckedAt: e.lastUpgradesCheckedAt ?? null,
    disabled: boolOrNull(e.disabled),
    notes: e.notes ?? null,
    versionSetManually: boolOrNull(e.versionSetManually),
    versionSetBy: e.versionSetBy ?? null,
    versionSetAt: e.versionSetAt ?? null,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
  for (const f of ENV_JSON_FIELDS) {
    row[f] = e[f] == null ? null : JSON.stringify(e[f]);
  }
  return row;
}

function envFromRow(row) {
  const env = {
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    tier: row.tier,
    currentVersion: row.currentVersion,
    currentBranch: row.currentBranch,
    lastChecked: row.lastChecked,
    lastError: row.lastError,
    lastHealthCheckedAt: row.lastHealthCheckedAt,
    lastFeaturesCheckedAt: row.lastFeaturesCheckedAt,
    lastIntegrationsCheckedAt: row.lastIntegrationsCheckedAt,
    lastUpgradesCheckedAt: row.lastUpgradesCheckedAt,
    notes: row.notes,
    versionSetBy: row.versionSetBy,
    versionSetAt: row.versionSetAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  for (const f of ENV_BOOL_FIELDS) env[f] = row[f] == null ? null : !!row[f];
  for (const f of ENV_JSON_FIELDS) {
    env[f] = row[f] == null ? null : safeParse(row[f], null);
  }
  if (row.extra) {
    try {
      const extra = JSON.parse(row.extra);
      if (extra && typeof extra === 'object') Object.assign(env, extra);
    } catch { /* ignore */ }
  }
  return env;
}

function deploymentFromRow(row) {
  return {
    id: row.id,
    environmentId: row.environmentId,
    customerId: row.customerId,
    version: row.version,
    branch: row.branch,
    previousVersion: row.previousVersion,
    detectedAt: row.detectedAt,
    endedAt: row.endedAt,
    source: row.source,
    datadogImpact: row.datadogImpact == null ? null : safeParse(row.datadogImpact, null),
  };
}

function boolOrNull(v) {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = CustomerStore;
