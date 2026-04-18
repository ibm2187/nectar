const { EventEmitter } = require('events');
const log = require('./log');

const JIRA_KEY_REGEX = /\b(DEV|MAV)-\d+\b/g;

/**
 * GitHub PR sync — fetches PRs across tracked repos and persists them
 * to PrStore (SQLite).
 *
 * Strategy:
 *   1. List open PRs + recently updated PRs across all tracked repos
 *   2. Extract JIRA keys from PR title + body
 *   3. Persist to PrStore with JIRA key associations
 *
 * Incremental:
 *   - First run: all open + last 2000 closed PRs
 *   - Subsequent runs: open + closed PRs updated since last sync
 *
 * Events:
 *   sync:started
 *   sync:completed ({ prsFetched, jiraKeysFound, durationMs, incremental })
 */
class PrSync extends EventEmitter {
  constructor(releases, github, config) {
    super();
    this.releases = releases;
    this.github = github;
    this.config = config;
    this._prStore = null;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;
    this._lastSyncTime = null;
  }

  /**
   * Set the PrStore for SQLite persistence.
   */
  setPrStore(prStore) {
    this._prStore = prStore || null;
  }

  start() {
    if (!this.github.isConfigured()) {
      log.warn('PR sync disabled (GitHub not configured)');
      return;
    }

    const interval = (this.config.polling && this.config.polling.prSync) || 2 * 60 * 1000; // 2 min
    log.info(`PR sync started (polling every ${interval / 60000}m)`);

    // Initial sync after short delay
    setTimeout(() => {
      this.run().catch(err => log.error('PR sync error:', err.message));
    }, 30000);

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('PR sync error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async run() {
    if (this._running) {
      log.warn('PR sync already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    const isIncremental = this._lastSyncTime !== null;
    this.emit('sync:started');

    const results = {
      incremental: isIncremental,
      prsFetched: 0,
      jiraKeysFound: 0,
      errors: 0,
    };

    const syncedAt = new Date().toISOString();
    // Collect all PRs with their JIRA keys for batch persist
    const batch = [];

    try {
      const repos = (this.config.repos || []).filter(r => r.github);
      for (const repo of repos) {
        try {
          const prs = await this._fetchRepoPRs(repo.github, isIncremental);
          results.prsFetched += prs.length;

          for (const pr of prs) {
            const normalized = {
              prNumber: pr.number,
              prTitle: pr.title,
              prAuthor: pr.user?.login || null,
              prUrl: pr.html_url,
              prCreatedAt: pr.created_at,
              prUpdatedAt: pr.updated_at,
              status: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
              repo: repo.github,
              baseBranch: pr.base?.ref || null,
              headBranch: pr.head?.ref || null,
              syncedAt,
            };

            const jiraKeys = this._extractJiraKeys(pr);
            batch.push({ pr: normalized, jiraKeys });
            if (jiraKeys.length > 0) results.jiraKeysFound++;
          }
        } catch (err) {
          results.errors++;
          log.error(`PR sync: failed for ${repo.github}: ${err.message}`);
        }
      }

      // Persist to PrStore
      if (this._prStore && batch.length > 0) {
        this._prStore.upsertBatch(batch);
        this._prStore.updateSyncMeta({
          lastSyncTime: syncedAt,
          totalPrsSynced: this._prStore.count(),
        });
      }

    } catch (err) {
      results.errors++;
      log.error('PR sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this._lastSyncTime = syncedAt;
    this.lastRun = this._lastSyncTime;
    this.lastResults = results;
    this._running = false;

    const mode = isIncremental ? 'incremental' : 'full';
    log.info(`PR sync complete (${mode}): ${results.prsFetched} PRs, ${results.jiraKeysFound} with JIRA keys in ${results.durationMs}ms`);
    this.emit('sync:completed', results);

    return results;
  }

  /**
   * Fetch PRs from a repo.
   *
   * Every run: all open PRs (always fresh, ~20-50 per repo).
   * First run: one-time backfill of last 2000 closed PRs to seed associations.
   * Incremental: closed/merged PRs updated since last sync.
   */
  async _fetchRepoPRs(repoPath, incremental) {
    const allPrs = [];
    const seen = new Set();
    const addPr = (pr) => { if (!seen.has(pr.number)) { seen.add(pr.number); allPrs.push(pr); } };

    // Always fetch ALL open PRs — source of truth for active work
    const openPrs = await this.github._paginate(
      `/repos/${repoPath}/pulls?state=open&per_page=100&sort=updated&direction=desc`, 5
    );
    for (const pr of openPrs) addPr(pr);

    if (incremental) {
      // Closed/merged PRs updated since last sync — catches merges
      const closedPrs = await this.github._paginate(
        `/repos/${repoPath}/pulls?state=closed&per_page=100&sort=updated&direction=desc`, 2
      );
      const sinceTime = new Date(this._lastSyncTime).getTime();
      for (const pr of closedPrs) {
        if (new Date(pr.updated_at).getTime() >= sinceTime) addPr(pr);
      }
    } else {
      // First run: backfill last 2000 closed PRs (20 pages x 100)
      log.info(`PR sync: backfilling closed PRs for ${repoPath} (up to 2000)`);
      const closedPrs = await this.github._paginate(
        `/repos/${repoPath}/pulls?state=closed&per_page=100&sort=updated&direction=desc`, 20
      );
      for (const pr of closedPrs) addPr(pr);
      log.info(`PR sync: backfilled ${closedPrs.length} closed PRs from ${repoPath}`);
    }

    return allPrs;
  }

  /**
   * Extract JIRA keys from PR title + body.
   */
  _extractJiraKeys(pr) {
    const text = `${pr.title || ''} ${(pr.body || '').slice(0, 1000)}`;
    const matches = text.match(JIRA_KEY_REGEX);
    return matches ? [...new Set(matches)] : [];
  }

  /**
   * Find the best PR for a branch. Delegates to PrStore if available.
   */
  findPRByBranch(branch) {
    if (!branch) return null;
    if (this._prStore) return this._prStore.findByBranch(branch);
    return null;
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.github.isConfigured(),
      prStore: this._prStore ? {
        totalPrs: this._prStore.count(),
        ...this._prStore.getSyncMeta(),
      } : null,
    };
  }
}

module.exports = PrSync;
