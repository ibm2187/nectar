const { EventEmitter } = require('events');
const log = require('./log');

/**
 * Environment version poller.
 *
 * Iterates over environments in the CustomerStore and polls each one's
 * versionEndpoint (e.g., /api/status/version) to detect version changes.
 *
 * When a version changes, updates the store which automatically records
 * a Deployment history entry.
 *
 * Events:
 *   poll:started
 *   poll:completed ({ total, succeeded, failed, versionChanges })
 *   env:reachable  (environment)
 *   env:unreachable (environment, error)
 */
class EnvironmentPoller extends EventEmitter {
  constructor(customerStore, config) {
    super();
    this.customerStore = customerStore;
    this.config = config;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
  }

  start() {
    const interval = (this.config.polling && this.config.polling.environmentVersions)
      || 10 * 60 * 1000; // 10 min default

    log.info(`Environment poller started (every ${interval / 60000}m)`);

    // Initial poll after a brief delay (let other services start)
    setTimeout(() => {
      this.run().catch(err => log.error('Environment poll error:', err.message));
    }, 5000);

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('Environment poll error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Poll all environments that have a versionEndpoint and aren't disabled.
   */
  async run() {
    if (this._running) {
      log.warn('Environment poll already running, skipping');
      return;
    }

    this._running = true;
    this.emit('poll:started');
    const startTime = Date.now();

    const environments = this.customerStore.listEnvironments().filter(
      e => e.versionEndpoint && !e.disabled
    );

    const results = {
      total: environments.length,
      succeeded: 0,
      failed: 0,
      versionChanges: 0,
      durationMs: 0,
    };

    // Poll in parallel with concurrency limit
    const concurrency = 10;
    for (let i = 0; i < environments.length; i += concurrency) {
      const batch = environments.slice(i, i + concurrency);
      const outcomes = await Promise.allSettled(
        batch.map(env => this._pollOne(env))
      );
      for (const o of outcomes) {
        if (o.status === 'fulfilled') {
          results.succeeded++;
          if (o.value && o.value.versionChanged) results.versionChanges++;
        } else {
          results.failed++;
        }
      }
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this._running = false;

    log.info(`Environment poll: ${results.succeeded}/${results.total} reachable, ${results.versionChanges} version changes in ${results.durationMs}ms`);
    this.emit('poll:completed', results);
    return results;
  }

  /**
   * Fetch a status endpoint from an environment with timeout.
   */
  async _fetchEndpoint(baseUrl, path) {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Walk all pages of /api/status/upgrades and merge the items into a single
   * response shape for the customer store. The endpoint is paginated (default
   * pageSize=100, max=500) — we use pageSize=500 to minimize round-trips and
   * stay under the 5-requests-per-minute rate limit.
   *
   * Returns: { environment, totalInPool, items }
   */
  async _fetchAllUpgrades(baseUrl) {
    const pageSize = 500;
    let page = 1;
    let environment = null;
    let total = 0;
    const items = [];

    // Safety cap — webplatform has ~500 upgrades, so 10 pages at pageSize=500
    // is plenty of headroom. Prevents runaway loops if the server misbehaves.
    const MAX_PAGES = 20;

    while (page <= MAX_PAGES) {
      const res = await this._fetchEndpoint(baseUrl, `/api/status/upgrades?page=${page}&pageSize=${pageSize}`);
      if (page === 1) {
        environment = res.environment || null;
        total = res.pagination ? res.pagination.total : 0;
      }
      if (Array.isArray(res.items)) items.push(...res.items);
      if (!res.pagination || !res.pagination.hasMore) break;
      page += 1;
    }

    return { environment, totalInPool: total, items };
  }

  /**
   * Fetch /api/status and measure the response time. Returns the parsed JSON
   * along with the elapsed milliseconds so we can store responseTimeMs.
   */
  async _fetchHealthEndpoint(baseUrl) {
    const start = Date.now();
    const data = await this._fetchEndpoint(baseUrl, '/api/status');
    const elapsed = Date.now() - start;
    return { data, responseTimeMs: elapsed };
  }

  /**
   * Derive an overall health status string from the /api/status response.
   *
   * Rules:
   *  - 'unhealthy'  — any critical service (mongodb, redis) is down
   *  - 'degraded'   — all critical services up but any response time > 500ms
   *                    or any non-critical service is down
   *  - 'healthy'    — everything passing and fast
   */
  _deriveHealthStatus(data) {
    const checks = data.checks || {};
    const allChecks = [
      ...(checks.criticalFunctionality || []),
      ...(checks.externalServices || []),
      ...(checks.integrations || []),
    ];

    const CRITICAL_SERVICES = ['mongodb', 'redis'];

    // Any critical service down → unhealthy
    for (const check of allChecks) {
      if (CRITICAL_SERVICES.includes(check.name) && check.status === 'fail') {
        return 'unhealthy';
      }
    }

    // Any non-critical failure or any response time > 500ms → degraded
    for (const check of allChecks) {
      if (check.status === 'fail' || check.status === 'degraded') return 'degraded';
      if (check.responseTime && check.responseTime > 500) return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Poll one environment — hits /version, /features, /integrations, /upgrades,
   * and /status (health) in parallel. Each endpoint failure is independent:
   * a /features 404 doesn't prevent /version from being recorded.
   */
  async _pollOne(env) {
    if (!env.url) return { versionChanged: false };
    const previousVersion = env.currentVersion;

    // Kick off all four original endpoints in parallel (unchanged from before health feature).
    const [versionResult, featuresResult, integrationsResult, upgradesResult] = await Promise.allSettled([
      this._fetchEndpoint(env.url, '/api/status/version'),
      this._fetchEndpoint(env.url, '/api/status/features'),
      this._fetchEndpoint(env.url, '/api/status/integrations'),
      this._fetchAllUpgrades(env.url),
    ]);

    // /version → updates currentVersion + reachable + lastChecked
    if (versionResult.status === 'fulfilled') {
      const data = versionResult.value;
      const version = data.version || null;
      this.customerStore.updateLiveState(env.id, {
        version,
        branch: data.branch || (version ? `releases/${version}` : null),
        reachable: true,
      });
      this.emit('env:reachable', env);
    } else {
      this.customerStore.updateLiveState(env.id, {
        reachable: false,
        error: versionResult.reason ? versionResult.reason.message : 'unknown',
      });
      this.emit('env:unreachable', env, versionResult.reason);
    }

    // /features → store as-is from the new API shape
    if (featuresResult.status === 'fulfilled') {
      const d = featuresResult.value;
      this.customerStore.updateFeatures(env.id, {
        dbFeatureFlags: d.dbFeatureFlags || [],
        configFeatures: d.configFeatures || {
          portalFeatureFlag: d.portalFeatureFlag || {},
          mobileFeatureFlag: d.mobileFeatureFlag || {},
          workflow: d.workflow || {},
        },
        toggles: d.toggles || {},
      });
    }

    // /integrations → store as-is from the new API shape
    if (integrationsResult.status === 'fulfilled') {
      const d = integrationsResult.value;
      this.customerStore.updateIntegrations(env.id, {
        disableOutgoingCommunication: !!d.disableOutgoingCommunication,
        dbIntegrations: d.dbIntegrations || {},
        configIntegrations: d.configIntegrations || {},
        dataPublishing: d.dataPublishing || {},
        sqsQueues: d.sqsQueues || {},
      });
    }

    // /upgrades → store merged pages as-is; all classification is done in the UI
    if (upgradesResult.status === 'fulfilled') {
      this.customerStore.updateUpgrades(env.id, upgradesResult.value);
    }

    // /status (health) — separate from main poll, only for production + staging
    if (env.tier === 'production' || env.tier === 'staging') {
      try {
        const { data: healthData, responseTimeMs } = await this._fetchHealthEndpoint(env.url);
        const status = this._deriveHealthStatus(healthData);
        const checks = healthData.checks || {};
        const summary = healthData.summary || {};
        this.customerStore.updateHealth(env.id, {
          status,
          checks: {
            criticalFunctionality: checks.criticalFunctionality || {},
            externalServices: checks.externalServices || {},
            integrations: checks.integrations || {},
          },
          summary: {
            totalChecks: summary.totalChecks || 0,
            passed: summary.passed || 0,
            failed: summary.failed || 0,
            degraded: summary.degraded || 0,
            skipped: summary.skipped || 0,
          },
          responseTimeMs,
          checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        log.warn(`Health poll failed for ${env.id}: ${err.message}`);
      }
    }

    // Track per-env reachability for rollup (consider reachable if at least version succeeded)
    const anySucceeded = [versionResult, featuresResult, integrationsResult, upgradesResult]
      .some(r => r.status === 'fulfilled');
    if (!anySucceeded) {
      throw new Error('All endpoints failed');
    }

    const version = versionResult.status === 'fulfilled' ? versionResult.value.version : null;
    return {
      versionChanged: !!(previousVersion && version && previousVersion !== version),
    };
  }

  /**
   * Legacy single-endpoint version (no longer used, kept for reference).
   * @deprecated
   */
  async _pollOneVersionOnly(env) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(env.versionEndpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.customerStore.updateLiveState(env.id, {
        version: data.version,
        branch: data.branch || (data.version ? `releases/${data.version}` : null),
        reachable: true,
      });
      return { versionChanged: false };
    } catch (err) {
      clearTimeout(timeout);
      this.customerStore.updateLiveState(env.id, {
        reachable: false,
        error: err.message,
      });
      this.emit('env:unreachable', env, err);
      throw err;
    }
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
    };
  }
}

module.exports = EnvironmentPoller;
