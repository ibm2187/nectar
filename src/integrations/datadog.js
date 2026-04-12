const log = require('../core/log');

/**
 * Datadog API client.
 * Uses DD-API-KEY and DD-APPLICATION-KEY headers for authentication.
 * Docs: https://docs.datadoghq.com/api/
 */
class DatadogClient {
  constructor() {
    this.apiKey = process.env.DATADOG_API_KEY || '';
    this.appKey = process.env.DATADOG_APP_KEY || '';
    this.baseUrl = 'https://api.datadoghq.com';
  }

  isConfigured() {
    return !!(this.apiKey && this.appKey);
  }

  // ── Core requests ───────────────────────────────────────

  async _request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'DD-API-KEY': this.apiKey,
      'DD-APPLICATION-KEY': this.appKey,
      'Accept': 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Datadog ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  // ── Monitors ────────────────────────────────────────────

  /**
   * Get all monitors with status.
   * Returns the full monitor list from Datadog.
   */
  async getMonitors() {
    return this._request('GET', '/api/v1/monitor');
  }

  /**
   * Get monitors filtered by environment tag (e.g., 'env:bayada').
   * Uses the Datadog monitor search API with tag filtering.
   */
  async getMonitorsForEnv(envTag) {
    const monitors = await this.getMonitors();
    return monitors.filter(m => {
      const tags = m.tags || [];
      return tags.some(t => t.toLowerCase() === envTag.toLowerCase());
    });
  }

  // ── Events / Alerts ─────────────────────────────────────

  /**
   * Get recent alert events (default last 24h).
   * @param {number} [fromSeconds] - Start of window (epoch seconds)
   * @param {number} [toSeconds] - End of window (epoch seconds)
   */
  async getAlertEvents(fromSeconds, toSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const from = fromSeconds || (now - 86400); // 24h ago
    const to = toSeconds || now;
    return this._request('GET', `/api/v1/events?start=${from}&end=${to}&sources=alert`);
  }

  // ── Metrics ─────────────────────────────────────────────

  /**
   * Query metrics for a time window.
   * Returns { avg, max, min, values } for the given query.
   * @param {string} query - Datadog metric query string
   * @param {number} fromSeconds - Start of window (epoch seconds)
   * @param {number} toSeconds - End of window (epoch seconds)
   */
  async queryMetrics(query, fromSeconds, toSeconds) {
    const data = await this._request(
      'GET',
      `/api/v1/query?from=${fromSeconds}&to=${toSeconds}&query=${encodeURIComponent(query)}`
    );

    // Parse series data into summary stats
    const series = (data.series || [])[0];
    if (!series || !series.pointlist || series.pointlist.length === 0) {
      return { avg: null, max: null, min: null, values: [] };
    }

    const values = series.pointlist.map(p => p[1]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) {
      return { avg: null, max: null, min: null, values: [] };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    return {
      avg: sum / values.length,
      max: Math.max(...values),
      min: Math.min(...values),
      values,
    };
  }

  // ── Deployment Impact ───────────────────────────────────

  /**
   * Get deployment impact metrics for a specific deployment.
   * Queries error rate, latency p90, throughput for 30min before -> 2h after.
   *
   * @param {string} envTag - Datadog environment tag (e.g., 'env:bayada')
   * @param {string} deployedAtISO - ISO timestamp of deployment
   * @returns {{ errorRate, latencyP90, throughput, alertsTriggered }}
   */
  async getDeploymentImpact(envTag, deployedAtISO) {
    const deployedAt = Math.floor(new Date(deployedAtISO).getTime() / 1000);
    const beforeStart = deployedAt - (30 * 60);  // 30 min before
    const afterEnd = deployedAt + (2 * 60 * 60); // 2h after

    // Metric queries scoped to environment tag
    const errorQuery = `sum:trace.web.request.errors{${envTag}}.as_rate()`;
    const latencyQuery = `p90:trace.web.request.duration{${envTag}}`;
    const throughputQuery = `sum:trace.web.request.hits{${envTag}}.as_rate()`;

    // Query before and after windows in parallel
    const [
      errorBefore, errorAfter,
      latencyBefore, latencyAfter,
      throughputBefore, throughputAfter,
      alertEvents,
    ] = await Promise.all([
      this.queryMetrics(errorQuery, beforeStart, deployedAt),
      this.queryMetrics(errorQuery, deployedAt, afterEnd),
      this.queryMetrics(latencyQuery, beforeStart, deployedAt),
      this.queryMetrics(latencyQuery, deployedAt, afterEnd),
      this.queryMetrics(throughputQuery, beforeStart, deployedAt),
      this.queryMetrics(throughputQuery, deployedAt, afterEnd),
      this.getAlertEvents(beforeStart, afterEnd),
    ]);

    // Calculate delta percentages (positive = increase, negative = decrease)
    const deltaPercent = (before, after) => {
      if (before === null || before === 0) return after === null ? 0 : 100;
      if (after === null) return -100;
      return ((after - before) / Math.abs(before)) * 100;
    };

    // Count alerts that triggered in the window
    const events = alertEvents.events || [];
    const alertsTriggered = events.filter(e =>
      e.alert_type === 'error' || e.alert_type === 'warning'
    ).length;

    return {
      errorRate: {
        before: errorBefore.avg,
        after: errorAfter.avg,
        deltaPercent: deltaPercent(errorBefore.avg, errorAfter.avg),
      },
      latencyP90: {
        before: latencyBefore.avg,
        after: latencyAfter.avg,
        deltaPercent: deltaPercent(latencyBefore.avg, latencyAfter.avg),
      },
      throughput: {
        before: throughputBefore.avg,
        after: throughputAfter.avg,
        deltaPercent: deltaPercent(throughputBefore.avg, throughputAfter.avg),
      },
      alertsTriggered,
      window: {
        beforeStart: new Date(beforeStart * 1000).toISOString(),
        deployedAt: deployedAtISO,
        afterEnd: new Date(afterEnd * 1000).toISOString(),
      },
    };
  }

  // ── Hosts ───────────────────────────────────────────────

  /**
   * Get host metrics (CPU, memory, disk) for infrastructure view.
   * @param {string} [filter] - Optional host filter string
   */
  async getHosts(filter) {
    let path = '/api/v1/hosts';
    if (filter) path += `?filter=${encodeURIComponent(filter)}`;
    return this._request('GET', path);
  }

  // ── Connection test ─────────────────────────────────────

  /**
   * Test connection to Datadog API.
   * Uses the validate endpoint which is lightweight.
   */
  async testConnection() {
    const data = await this._request('GET', '/api/v1/validate');
    return { ok: data.valid === true, detail: data.valid ? 'API key is valid' : 'API key is invalid' };
  }
}

module.exports = DatadogClient;
