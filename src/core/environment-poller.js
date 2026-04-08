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
   * Poll one environment.
   */
  async _pollOne(env) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const res = await fetch(env.versionEndpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const version = data.version || null;
      const previousVersion = env.currentVersion;

      this.customerStore.updateLiveState(env.id, {
        version,
        branch: data.branch || (version ? `releases/${version}` : null),
        reachable: true,
      });

      this.emit('env:reachable', env);

      return {
        versionChanged: previousVersion && version && previousVersion !== version,
      };
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
