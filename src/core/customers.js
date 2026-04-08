const { EventEmitter } = require('events');
const log = require('./log');

/**
 * Customer version poller.
 * Polls each customer environment for their running version.
 *
 * Events:
 *   customer:updated     ({ name, env, version, previous })
 *   customer:unreachable ({ name, env, error })
 *   customer:behind      ({ name, env, version, latest, behind })
 */
class CustomerPoller extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.customers = new Map(); // name → { staging: {...}, production: {...} }
    this._timer = null;

    // Initialize from config
    for (const c of config.customers || []) {
      this.customers.set(c.name, {
        name: c.name,
        staging: { url: c.staging, version: null, lastChecked: null, reachable: null },
        production: { url: c.production, version: null, lastChecked: null, reachable: null },
      });
    }
  }

  start() {
    if (this.customers.size === 0) {
      log.warn('Customer poller disabled (no customers configured)');
      return;
    }

    const interval = this.config.polling.customerVersions || 15 * 60 * 1000;
    log.info(`Customer poller started (${this.customers.size} customers, every ${interval / 60000}m)`);

    // Initial poll
    this._pollAll().catch(err => log.error('Customer poll error:', err.message));

    this._timer = setInterval(() => {
      this._pollAll().catch(err => log.error('Customer poll error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _pollAll() {
    const promises = [];
    for (const [name, customer] of this.customers) {
      if (customer.staging.url) {
        promises.push(this._pollOne(name, 'staging', customer.staging.url));
      }
      if (customer.production.url) {
        promises.push(this._pollOne(name, 'production', customer.production.url));
      }
    }
    await Promise.allSettled(promises);
  }

  async _pollOne(name, env, baseUrl) {
    const customer = this.customers.get(name);
    if (!customer) return;

    const envData = customer[env];
    const url = `${baseUrl.replace(/\/$/, '')}/api/status/version`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const previous = envData.version;
      envData.version = data.version || null;
      envData.lastChecked = new Date().toISOString();
      envData.reachable = true;
      envData.customer = data.customer || name;
      envData.environment = data.environment || env;

      if (previous && envData.version !== previous) {
        this.emit('customer:updated', { name, env, version: envData.version, previous });
      }
    } catch (err) {
      envData.lastChecked = new Date().toISOString();
      envData.reachable = false;
      this.emit('customer:unreachable', { name, env, error: err.message });
    }
  }

  // ── Queries ─────────────────────────────────────────────

  /**
   * Get the full customer version map.
   */
  getMap() {
    return Array.from(this.customers.values()).map(c => ({
      name: c.name,
      staging: c.staging.version,
      stagingReachable: c.staging.reachable,
      stagingLastChecked: c.staging.lastChecked,
      production: c.production.version,
      productionReachable: c.production.reachable,
      productionLastChecked: c.production.lastChecked,
    }));
  }

  /**
   * Get a single customer's status.
   */
  getCustomer(name) {
    const c = this.customers.get(name);
    if (!c) return null;
    return {
      name: c.name,
      staging: c.staging,
      production: c.production,
    };
  }

  /**
   * Find customers behind the latest release.
   */
  getBehind(latestVersion) {
    const behind = [];
    for (const c of this.customers.values()) {
      if (c.production.version && c.production.version !== latestVersion) {
        behind.push({
          name: c.name,
          production: c.production.version,
          latest: latestVersion,
        });
      }
    }
    return behind;
  }

  /**
   * Find which customers are running a specific version.
   */
  getCustomersOnVersion(version) {
    const matches = [];
    for (const c of this.customers.values()) {
      const envs = [];
      if (c.production.version === version) envs.push('production');
      if (c.staging.version === version) envs.push('staging');
      if (envs.length > 0) matches.push({ name: c.name, environments: envs });
    }
    return matches;
  }
}

module.exports = CustomerPoller;
