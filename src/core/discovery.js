const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');
const { readVersion } = require('./version-reader');

// Matches semver-like versions: 4.2.1, 2026.4.0, 3.48.1-ck, etc.
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * Multi-repo discovery engine.
 * Scans configured repos for release branches, creates/syncs releases.
 *
 * Events:
 *   discovery:started
 *   discovery:repo-started   (repoName)
 *   discovery:repo-synced    (repoName, { discovered, synced })
 *   discovery:completed      ({ repos, totalDiscovered, totalSynced, durationMs })
 */
class Discovery extends EventEmitter {
  constructor(releases, repoManager, config) {
    super();
    this.releases = releases;
    this.repoManager = repoManager;
    this.config = config;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;
  }

  start() {
    const interval = this.config.polling.discovery || 5 * 60 * 1000;
    log.info(`Discovery engine started (polling every ${interval / 60000}m)`);

    // Initial discovery
    this.run().catch(err => log.error('Discovery error:', err.message));

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('Discovery error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run discovery across all repos.
   */
  async run() {
    if (this._running) {
      log.warn('Discovery already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    this.emit('discovery:started');

    const results = { repos: {}, totalDiscovered: 0, totalSynced: 0 };

    for (const repoConfig of this.config.repos || []) {
      this.emit('discovery:repo-started', repoConfig.name);
      try {
        const repoResult = await this._discoverRepo(repoConfig);
        results.repos[repoConfig.name] = repoResult;
        results.totalDiscovered += repoResult.discovered;
        results.totalSynced += repoResult.synced;
      } catch (err) {
        log.error(`Discovery failed for ${repoConfig.name}:`, err.message);
        results.repos[repoConfig.name] = { error: err.message, discovered: 0, synced: 0 };
      }
      this.emit('discovery:repo-synced', repoConfig.name, results.repos[repoConfig.name]);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`Discovery complete: ${results.totalDiscovered} new, ${results.totalSynced} synced in ${results.durationMs}ms`);
    this.emit('discovery:completed', results);

    return results;
  }

  async _discoverRepo(repoConfig) {
    const { name, releaseBranchPrefix } = repoConfig;
    const disc = this.config.discovery || {};
    const maxAge = disc.maxAgeDays ?? 90;
    const maxPerRepo = disc.maxPerRepo ?? 20;

    // Fetch latest
    try {
      await this.repoManager.fetch(name);
    } catch (err) {
      log.warn(`Fetch failed for ${name}: ${err.message}`);
    }

    // List release branches
    const branches = await this.repoManager.listBranches(name, releaseBranchPrefix);

    // Filter to semver-like branches and extract version
    const candidates = [];
    for (const branch of branches) {
      const version = branch.slice(releaseBranchPrefix.length);
      if (!SEMVER_PATTERN.test(version)) continue;
      candidates.push({ branch, version });
    }

    // Sort by version (newest first) and optionally limit
    candidates.sort((a, b) => this._compareVersions(b.version, a.version));
    const tracked = maxPerRepo > 0 ? candidates.slice(0, maxPerRepo) : candidates;

    let discovered = 0;
    let synced = 0;

    for (const { branch, version } of tracked) {
      const existing = this.releases.get(version, name);

      if (!existing) {
        // Releases are only created by JIRA sync. Discovery only enriches
        // existing releases with branch data. Skip unknown branches.
        continue;
      } else if (!existing.branch) {
        // Existing release (likely created by JIRA sync) without a branch.
        // Discovery just confirmed the branch exists — fill it in.
        let cutFrom = null;
        try {
          cutFrom = await this.repoManager.getBranchHead(name, branch);
        } catch { /* ok */ }
        existing.branch = branch;
        if (cutFrom) existing.cutFrom = cutFrom;
        existing.updatedAt = new Date().toISOString();
        this.releases._debounceSave();
      }

      // Only sync the most recent 20 releases (git log is expensive)
      if (synced < 20) {
        const release = this.releases.get(version, name);
        if (release && release.state !== 'done') {
          await this._syncRelease(repoConfig, release);
          synced++;
        }
      }
    }

    return { discovered, synced, branches: tracked.length, totalBranches: branches.length };
  }

  async _syncRelease(repoConfig, release) {
    // Read version from repo source (if configured)
    if (repoConfig.versionSource) {
      try {
        const ver = await readVersion(
          this.repoManager, repoConfig.name,
          release.branch, repoConfig.versionSource
        );
        if (ver && ver !== release.version) {
          release.repoVersion = ver;
        }
      } catch { /* ok */ }
    }

    // NOTE: We no longer extract tickets from git commit messages.
    // JIRA sync is the source of truth for what tickets exist in a release.
    // The release-truth engine cross-references git commits against JIRA tickets
    // on demand, so commit-based ticket discovery is unnecessary here.
  }

  /**
   * Compare semver-like versions. Returns positive if a > b.
   */
  _compareVersions(a, b) {
    const pa = a.match(SEMVER_PATTERN);
    const pb = b.match(SEMVER_PATTERN);
    if (!pa || !pb) return a.localeCompare(b);

    for (let i = 1; i <= 3; i++) {
      const diff = parseInt(pa[i]) - parseInt(pb[i]);
      if (diff !== 0) return diff;
    }
    return a.localeCompare(b); // Compare suffixes lexically
  }

  /**
   * Get discovery status for API.
   */
  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      repos: this.repoManager.getStatus(),
    };
  }
}

module.exports = Discovery;
