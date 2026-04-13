const log = require('./log');

/**
 * Datadog monitor poller.
 *
 * Lightweight poller that fetches all Datadog monitors with status every 2 minutes.
 * Stores monitor states globally (not per-env) — available via API.
 */
class DatadogPoller {
  constructor(datadogClient) {
    this.datadog = datadogClient;
    this._timer = null;
    this._running = false;
    this.monitors = [];
    this.alerts = [];
    this.lastRun = null;
    this.lastError = null;
  }

  start() {
    if (!this.datadog || !this.datadog.isConfigured()) {
      log.info('Datadog poller skipped (not configured)');
      return;
    }

    const interval = 2 * 60 * 1000; // 2 minutes
    log.info('Datadog poller started (every 2m)');

    // Initial poll after brief delay
    setTimeout(() => {
      this.run().catch(err => log.error('Datadog poll error:', err.message));
    }, 3000);

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('Datadog poll error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async run() {
    if (this._running) return;
    if (!this.datadog || !this.datadog.isConfigured()) return;

    this._running = true;
    try {
      const monitors = await this.datadog.getMonitors();
      this.monitors = Array.isArray(monitors) ? monitors : [];
      this.lastRun = new Date().toISOString();
      this.lastError = null;
      log.info(`Datadog poll: ${this.monitors.length} monitors fetched`);
    } catch (err) {
      this.lastError = err.message;
      log.warn(`Datadog poll failed: ${err.message}`);
    } finally {
      this._running = false;
    }
  }

  /**
   * Get all monitors grouped by state.
   */
  getMonitorsGrouped() {
    const grouped = {
      ok: [],
      alert: [],
      warn: [],
      'no data': [],
      other: [],
    };

    for (const monitor of this.monitors) {
      const state = (monitor.overall_state || '').toLowerCase();
      if (grouped[state]) {
        grouped[state].push(monitor);
      } else {
        grouped.other.push(monitor);
      }
    }

    return {
      monitors: grouped,
      total: this.monitors.length,
      lastRun: this.lastRun,
      lastError: this.lastError,
    };
  }

  /**
   * Get monitors for a specific environment tag.
   */
  getMonitorsForEnv(envTag) {
    const tag = envTag.toLowerCase();
    return this.monitors.filter(m => {
      const tags = (m.tags || []).map(t => t.toLowerCase());
      return tags.some(t => t === tag || t.startsWith(`env:${tag}`) || t === `env:${tag}`);
    });
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastError: this.lastError,
      monitorCount: this.monitors.length,
    };
  }
}

module.exports = DatadogPoller;
