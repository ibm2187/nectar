const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');

/**
 * JIRA-first release sync.
 * Queries JIRA versions as source of truth for releases,
 * then paginates through all tickets per version.
 *
 * Events:
 *   sync:started
 *   sync:version-started  (versionName, { total })
 *   sync:version-progress (versionName, { fetched, total })
 *   sync:version-done     (versionName, { tickets })
 *   sync:completed        ({ versions, tickets, durationMs })
 */
class JiraSync extends EventEmitter {
  constructor(releases, jira, config) {
    super();
    this.releases = releases;
    this.jira = jira;
    this.config = config;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;
    // Track last sync time per version for incremental updates
    this.lastSyncTimes = new Map(); // versionName → ISO timestamp
  }

  start() {
    if (!this.jira.isConfigured()) {
      log.warn('JIRA sync disabled (JIRA not configured)');
      return;
    }

    const interval = this.config.polling.jiraSync || 10 * 60 * 1000; // 10 min default
    log.info(`JIRA sync started (polling every ${interval / 60000}m)`);

    // Initial sync
    this.run().catch(err => log.error('JIRA sync error:', err.message));

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('JIRA sync error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run full JIRA sync.
   */
  async run() {
    if (this._running) {
      log.warn('JIRA sync already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    this.emit('sync:started');

    const results = {
      versions: { total: 0, unreleased: 0, synced: 0 },
      tickets: { total: 0, updated: 0 },
    };

    try {
      // Step 1: Get all versions from JIRA
      const jiraProject = this.config.jira.project || 'DEV';
      const allVersions = await this.jira.getVersionsSummary(jiraProject);
      results.versions.total = allVersions.length;

      // Step 2: Create/update release metadata from all versions (cheap)
      for (const jiraVersion of allVersions) {
        this._syncVersionMeta(jiraVersion);
      }

      // Step 3: Pick versions to sync tickets for
      // Priority order:
      //  1. Unreleased non-archived versions with future/near-past release date
      //  2. Recently released versions (last 14 days)
      const now = Date.now();
      const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
      const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

      const candidates = allVersions.filter(v => {
        if (v.archived) return false;
        // Unreleased with near-future or recent release date
        if (!v.released) {
          if (!v.releaseDate) return true; // No date, include it
          const relDate = new Date(v.releaseDate).getTime();
          return relDate > (now - NINETY_DAYS_MS); // Release date within 90 days past/future
        }
        // Released recently
        if (v.releaseDate) {
          const relDate = new Date(v.releaseDate).getTime();
          return (now - relDate) < FOURTEEN_DAYS_MS;
        }
        return false;
      });

      // Sort by releaseDate desc, but versions WITHOUT a release date come FIRST
      // (they're actively being worked on and most likely to need ticket sync).
      candidates.sort((a, b) => {
        if (!a.releaseDate && !b.releaseDate) return 0;
        if (!a.releaseDate) return -1;  // a has no date → sort first
        if (!b.releaseDate) return 1;   // b has no date → sort first
        return b.releaseDate.localeCompare(a.releaseDate);
      });

      // Limit to top N to avoid rate limits
      const maxSync = (this.config.jira && this.config.jira.maxVersionsPerSync) || 50;
      const toSync = candidates.slice(0, maxSync);

      results.versions.unreleased = candidates.length;
      log.info(`JIRA sync: ${candidates.length} candidate versions, syncing top ${toSync.length}`);

      for (const version of toSync) {
        try {
          const result = await this._syncVersionTickets(version.name);
          if (result) {
            results.tickets.total += result.tickets;
            results.tickets.updated += result.updated;
          }
          results.versions.synced++;
        } catch (err) {
          log.error(`JIRA sync failed for version ${version.name}:`, err.message);
        }
      }

    } catch (err) {
      log.error('JIRA sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`JIRA sync complete: ${results.versions.synced} versions, ${results.tickets.total} tickets in ${results.durationMs}ms`);
    this.emit('sync:completed', results);

    return results;
  }

  /**
   * Sync metadata for a JIRA version — create/update the release object.
   * Intelligently maps JIRA version names to existing git-discovered releases.
   */
  _syncVersionMeta(jiraVersion) {
    const versionName = jiraVersion.name;

    // Detect repo prefix in version name (e.g., "iOS 2026.4.0" → repo=ios, version=2026.4.0)
    const { repo, cleanVersion } = this._parseVersionName(versionName);

    // Try to find existing release — only repo-scoped match to avoid cross-repo bleed
    let release = this.releases.get(cleanVersion, repo);

    if (!release) {
      // Create new release under the correct repo
      try {
        release = this.releases.create({
          repo: repo,
          version: cleanVersion,
          branch: null,
        });
      } catch {
        return;
      }
    }

    // Track JIRA metadata on the release
    release.jiraVersionId = jiraVersion.id;
    release.jiraVersionName = versionName;
    release.jiraReleased = jiraVersion.released;
    release.jiraReleaseDate = jiraVersion.releaseDate;
    release.jiraArchived = jiraVersion.archived;

    // Update release state based on JIRA version status
    if (release) {
      const jiraState = this._mapVersionState(jiraVersion);
      // Only update if it's a meaningful state change
      if (jiraState === 'done' && release.state !== 'done') {
        try {
          // Walk through transitions to reach 'done'
          const path = this._transitionPath(release.state, 'done');
          const key = this.releases._key(release.repo, release.version);
          for (const state of path) {
            this.releases.transition(key, state, 'jira-sync');
          }
        } catch { /* transition not possible */ }
      }
    }
  }

  /**
   * Sync all tickets for a version with pagination + incremental.
   */
  async _syncVersionTickets(versionName) {
    const lastSync = this.lastSyncTimes.get(versionName);
    const isIncremental = !!lastSync;

    this.emit('sync:version-started', versionName, { incremental: isIncremental });

    const opts = {
      onPage: (fetched, total) => {
        this.emit('sync:version-progress', versionName, { fetched, total });
      },
    };

    if (isIncremental) {
      opts.updatedSince = lastSync;
    }

    const issues = await this.jira.getIssuesForVersion(versionName, opts);

    // Find the release — strict repo match
    const { repo, cleanVersion } = this._parseVersionName(versionName);
    const release = this.releases.get(cleanVersion, repo);
    if (!release) {
      log.warn(`JIRA sync: no release found for ${repo}:${cleanVersion} — skipping ${issues.length} issues`);
      return { tickets: 0, updated: 0 };
    }

    const key = this.releases._key(release.repo, release.version);
    let updated = 0;

    for (const issue of issues) {
      const normalized = JiraClient.normalizeIssue(issue);
      const ticketData = {
        key: normalized.key,
        summary: normalized.summary,
        state: JiraClient.mapStatus(normalized.status),
        jiraStatus: normalized.status,
        type: normalized.type,
        assignee: normalized.assignee,
        // Persist both canonical fixVersions and planning target so
        // release-truth can distinguish "on the plan" from "on the branch".
        fixVersions: normalized.fixVersions,
        targetFixVersions: normalized.targetFixVersions,
        zohoRef: normalized.zohoRef,
        source: 'jira',
        jiraSyncedAt: new Date().toISOString(),
      };
      this.releases.addTicket(key, ticketData, 'jira-sync');
      updated++;
    }

    // Log when tickets were added to help trace sync issues
    if (issues.length > 0) {
      log.info(`JIRA sync: ${versionName} — ${updated} tickets synced (${isIncremental ? 'incremental' : 'full'}, release has ${release.tickets.length} total)`);
    }

    this.lastSyncTimes.set(versionName, new Date().toISOString());

    this.emit('sync:version-done', versionName, {
      tickets: issues.length,
      updated,
      incremental: isIncremental,
    });

    return { tickets: issues.length, updated };
  }

  /**
   * Parse a JIRA version name to extract repo prefix and clean version.
   * Examples:
   *   "4.2.1"         → { repo: 'webplatform' (default), cleanVersion: '4.2.1' }
   *   "iOS 2026.4.0"  → { repo: 'ios', cleanVersion: '2026.4.0' }
   *   "Android 3.9.0" → { repo: 'android', cleanVersion: '3.9.0' }
   */
  _parseVersionName(versionName) {
    const lower = versionName.toLowerCase();
    if (lower.startsWith('ios ')) {
      return { repo: 'ios', cleanVersion: versionName.substring(4).trim() };
    }
    if (lower.startsWith('android ')) {
      return { repo: 'android', cleanVersion: versionName.substring(8).trim() };
    }
    // Default: assume webplatform for bare version numbers
    return { repo: 'webplatform', cleanVersion: versionName };
  }

  /**
   * Map JIRA version status to Nectar release state.
   */
  _mapVersionState(jiraVersion) {
    if (jiraVersion.archived) return 'done';
    if (jiraVersion.released) return 'done';
    return 'stabilizing'; // Default for unreleased
  }

  /**
   * Find transition path from current state to target state.
   */
  _transitionPath(from, to) {
    const order = ['planning', 'cutting', 'stabilizing', 'approved', 'deploying', 'done'];
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) return [];
    return order.slice(fromIdx + 1, toIdx + 1);
  }

  /**
   * Get sync status for API.
   */
  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.jira.isConfigured(),
    };
  }
}

module.exports = JiraSync;
