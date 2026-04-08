const log = require('../core/log');

/**
 * Jenkins API client.
 * Basic auth with user:apiToken.
 */
class JenkinsClient {
  constructor(config) {
    this.baseUrl = (process.env.JENKINS_BASE_URL ||
      (config && config.jenkins && config.jenkins.baseUrl) || '').replace(/\/$/, '');
    this.jobPath = (config && config.jenkins && config.jenkins.jobPath) || 'job/webplatform/job';
    this.user = process.env.JENKINS_USER || '';
    this.token = process.env.JENKINS_TOKEN || '';
  }

  isConfigured() {
    return !!(this.baseUrl && this.user && this.token);
  }

  // ── Core requests ───────────────────────────────────────

  async _request(path) {
    const url = `${this.baseUrl}/${path}`;
    const auth = Buffer.from(`${this.user}:${this.token}`).toString('base64');

    const res = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Jenkins GET ${path} → ${res.status}`);
    }

    return res.json();
  }

  // ── Build Status ────────────────────────────────────────

  /**
   * Get the latest build status for a release branch.
   * Jenkins job path: {baseUrl}/{jobPath}/releases%2F{version}
   */
  async getBuildStatus(version) {
    const encodedBranch = encodeURIComponent(`releases/${version}`);
    try {
      const data = await this._request(
        `${this.jobPath}/${encodedBranch}/lastBuild/api/json`
      );
      return {
        status: data.result ? data.result.toLowerCase() : 'building',
        building: data.building,
        number: data.number,
        url: data.url,
        timestamp: data.timestamp,
        duration: data.duration,
      };
    } catch (err) {
      // No builds found for this branch
      if (err.message.includes('404')) {
        return { status: null, building: false, number: null, url: null };
      }
      throw err;
    }
  }

  /**
   * Get test results for a build.
   */
  async getTestResults(version, buildNumber = 'lastBuild') {
    const encodedBranch = encodeURIComponent(`releases/${version}`);
    try {
      const data = await this._request(
        `${this.jobPath}/${encodedBranch}/${buildNumber}/testReport/api/json`
      );
      return {
        total: data.totalCount || 0,
        passed: data.passCount || 0,
        failed: data.failCount || 0,
        skipped: data.skipCount || 0,
        failures: (data.suites || [])
          .flatMap(s => s.cases || [])
          .filter(c => c.status === 'FAILED')
          .map(c => ({ name: c.name, className: c.className, errorDetails: c.errorDetails }))
          .slice(0, 20), // Cap at 20
      };
    } catch {
      return null;
    }
  }

  /**
   * Get build status in a format suitable for release.ci
   */
  async getCIForRelease(version) {
    const build = await this.getBuildStatus(version);
    if (!build.status && !build.building) {
      return { status: null, buildUrl: null, lastRun: null };
    }

    let status = 'unknown';
    if (build.building) status = 'building';
    else if (build.status === 'success') status = 'passing';
    else if (build.status === 'failure') status = 'failing';
    else if (build.status === 'unstable') status = 'unstable';
    else if (build.status === 'aborted') status = 'aborted';

    return {
      status,
      buildUrl: build.url,
      lastRun: build.timestamp ? new Date(build.timestamp).toISOString() : null,
      buildNumber: build.number,
    };
  }
}

module.exports = JenkinsClient;
