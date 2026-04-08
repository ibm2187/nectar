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
   * Poll one environment — hits /version, /features, /integrations, /upgrades
   * in parallel. Each endpoint failure is independent: a /features 404 doesn't
   * prevent /version from being recorded.
   */
  async _pollOne(env) {
    if (!env.url) return { versionChanged: false };
    const previousVersion = env.currentVersion;

    // Kick off all four in parallel
    const [versionResult, featuresResult, integrationsResult, upgradesResult] = await Promise.allSettled([
      this._fetchEndpoint(env.url, '/api/status/version'),
      this._fetchEndpoint(env.url, '/api/status/features'),
      this._fetchEndpoint(env.url, '/api/status/integrations'),
      this._fetchEndpoint(env.url, '/api/status/upgrades'),
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

    // /features → updates feature flags
    if (featuresResult.status === 'fulfilled') {
      this.customerStore.updateFeatures(env.id, {
        portalFeatureFlag: featuresResult.value.portalFeatureFlag || {},
        mobileFeatureFlag: featuresResult.value.mobileFeatureFlag || {},
        workflow: featuresResult.value.workflow || {},
      });
    }

    // /integrations → updates integration toggles
    if (integrationsResult.status === 'fulfilled') {
      const d = integrationsResult.value;
      this.customerStore.updateIntegrations(env.id, {
        ascend: d.ascend || { enabled: false },
        bayadaHub: d.bayadaHub || { enabled: false },
        hah: d.hah || { enabled: false },
        sqsOutbound: d.sqsOutbound || { enabled: false },
        sqsInbound: d.sqsInbound || { enabled: false },
        dataPublishing: d.dataPublishing || {},
        disableOutgoingCommunication: !!d.disableOutgoingCommunication,
        sqsQueues: d.sqsQueues || {},
      });
    }

    // /upgrades → updates upgrade status summary
    if (upgradesResult.status === 'fulfilled') {
      const d = upgradesResult.value;
      this.customerStore.updateUpgrades(env.id, {
        summary: d.summary || {},
        latest: d.latest || null,
        pending: d.pending || [],
        inProgress: d.inProgress || [],
        failedVerification: d.failedVerification || [],
        skipped: d.skipped || [],
      });
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
