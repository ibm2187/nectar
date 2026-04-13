const { EventEmitter } = require('events');
const log = require('./log');

const JIRA_KEY_REGEX = /\b(DEV|MAV)-\d+\b/g;

/**
 * GitHub PR sync — fetches PRs across tracked repos and matches them
 * to JIRA tickets in active releases.
 *
 * Strategy:
 *   1. List open PRs + recently updated PRs across all tracked repos
 *   2. Extract JIRA keys from PR title + body
 *   3. Build a cache: JIRA key → [PR info]
 *   4. Store associations on releases as prsByJiraKey
 *
 * Incremental:
 *   - First run: all open + recently merged (last 14 days)
 *   - Subsequent runs: only PRs updated since last sync
 *
 * Events:
 *   sync:started
 *   sync:completed ({ prsFetched, matched, releasesUpdated, durationMs, incremental })
 */
class PrSync extends EventEmitter {
  constructor(releases, github, config) {
    super();
    this.releases = releases;
    this.github = github;
    this.config = config;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;
    this._lastSyncTime = null;
    // Cache: JIRA key → [normalized PR]
    this._prCache = new Map();
  }

  start() {
    if (!this.github.isConfigured()) {
      log.warn('PR sync disabled (GitHub not configured)');
      return;
    }

    const interval = (this.config.polling && this.config.polling.prSync) || 5 * 60 * 1000; // 5 min
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
      matched: 0,
      releasesUpdated: 0,
      errors: 0,
    };

    try {
      // Fetch PRs from all tracked repos
      const repos = (this.config.repos || []).filter(r => r.github);
      for (const repo of repos) {
        try {
          const prs = await this._fetchRepoPRs(repo.github, isIncremental);
          results.prsFetched += prs.length;

          // Extract JIRA keys and add/update cache
          for (const pr of prs) {
            const jiraKeys = this._extractJiraKeys(pr);
            if (jiraKeys.length === 0) continue;

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
            };

            for (const key of jiraKeys) {
              if (!this._prCache.has(key)) this._prCache.set(key, new Map());
              // Always overwrite — ensures state updates (open→merged) are captured
              this._prCache.get(key).set(pr.number, normalized);
            }
          }
        } catch (err) {
          results.errors++;
          log.error(`PR sync: failed for ${repo.github}: ${err.message}`);
        }
      }

      // Step 2: Count unique JIRA keys
      results.jiraKeysFound = this._prCache.size;

      // Step 3: Match to active releases
      const jiraKeyIndex = this._buildJiraKeyIndex();
      this._matchAndStore(jiraKeyIndex, results);

    } catch (err) {
      results.errors++;
      log.error('PR sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this._lastSyncTime = new Date().toISOString();
    this.lastRun = this._lastSyncTime;
    this.lastResults = results;
    this._running = false;

    const mode = isIncremental ? 'incremental' : 'full';
    log.info(`PR sync complete (${mode}): ${results.prsFetched} PRs fetched, ${results.jiraKeysFound} JIRA keys, ${results.matched} matched, ${results.releasesUpdated} releases updated in ${results.durationMs}ms`);
    this.emit('sync:completed', results);

    return results;
  }

  /**
   * Fetch PRs from a repo.
   *
   * Every run:
   *   - All open PRs (always fresh — typically ~20-50 per repo)
   *   - Closed/merged PRs updated since last sync (catches merges + closes)
   *   - On first run, also grabs closed PRs from last 14 days to seed the cache
   */
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
      // First run: backfill last 2000 closed PRs (20 pages × 100)
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
   * Build JIRA key → release index from active releases.
   */
  _buildJiraKeyIndex() {
    const index = new Map();
    const activeReleases = this.releases.list().filter(r =>
      r.state !== 'done' && !r.jiraArchived
    );

    for (const release of activeReleases) {
      const releaseKey = this.releases._key(release.repo, release.version);
      for (const ticket of (release.tickets || [])) {
        if (!ticket.key) continue;
        if (!index.has(ticket.key)) index.set(ticket.key, []);
        index.get(ticket.key).push({ releaseKey, ticket });
      }
    }

    return index;
  }

  /**
   * Match cached PRs to releases and store.
   */
  _matchAndStore(jiraKeyIndex, results) {
    // Build releaseKey → { prsByJiraKey }
    const releaseMap = new Map();

    for (const [jiraKey, prMap] of this._prCache) {
      const entries = jiraKeyIndex.get(jiraKey);
      if (!entries) continue;
      results.matched++;

      const prs = Array.from(prMap.values());
      for (const { releaseKey } of entries) {
        if (!releaseMap.has(releaseKey)) releaseMap.set(releaseKey, {});
        const data = releaseMap.get(releaseKey);
        if (!data[jiraKey]) data[jiraKey] = [];
        // Deduplicate by PR number
        for (const pr of prs) {
          if (!data[jiraKey].some(p => p.prNumber === pr.prNumber)) {
            data[jiraKey].push(pr);
          }
        }
      }
    }

    // Store on releases
    for (const [releaseKey, prsByJiraKey] of releaseMap) {
      const release = this.releases.releases.get(releaseKey);
      if (!release) continue;

      release.prsByJiraKey = prsByJiraKey;
      release.prSyncedAt = new Date().toISOString();
      results.releasesUpdated++;
    }

    // Clear stale PR data
    for (const release of this.releases.list()) {
      const key = this.releases._key(release.repo, release.version);
      if (!releaseMap.has(key) && release.prsByJiraKey && Object.keys(release.prsByJiraKey).length > 0) {
        release.prsByJiraKey = {};
        release.prSyncedAt = new Date().toISOString();
      }
    }

    if (results.releasesUpdated > 0) {
      this.releases._debounceSave();
    }
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.github.isConfigured(),
      cacheSize: this._prCache.size,
    };
  }
}

module.exports = PrSync;
