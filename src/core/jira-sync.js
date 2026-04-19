const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');
const { resolveTargetCustomers } = require('./customer-resolver');

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
    this._customerStore = null;
    this._ticketStore = null;
    this._timer = null;
    this._running = false;
    this._ticketSyncRunning = false;
    this._ticketSyncTimer = null;
    this.lastRun = null;
    this.lastResults = null;
  }

  /**
   * Set the CustomerStore so target customers can be resolved from known IDs.
   */
  setCustomerStore(customerStore) {
    this._customerStore = customerStore || null;
  }

  /**
   * Set the TicketStore for full-project ticket sync.
   */
  setTicketStore(ticketStore) {
    this._ticketStore = ticketStore || null;
  }

  /**
   * Get known customer IDs from the customer store.
   */
  _getKnownCustomerIds() {
    if (!this._customerStore) return [];
    return this._customerStore.listCustomers().map(c => c.id);
  }

  start() {
    if (!this.jira.isConfigured()) {
      log.warn('JIRA sync disabled (JIRA not configured)');
      return;
    }

    const fullInterval = this.config.polling.jiraSync || 10 * 60 * 1000; // 10 min default
    const hotInterval = this.config.polling.jiraSyncHot || 2 * 60 * 1000; // 2 min for hot releases
    log.info(`JIRA sync started (hot: every ${hotInterval / 60000}m, full: every ${fullInterval / 60000}m)`);

    // Initial full sync
    this.run().catch(err => log.error('JIRA sync error:', err.message));

    // Hot sync — only overdue + next 2 weeks releases (fast, frequent)
    this._hotTimer = setInterval(() => {
      this.runHot().catch(err => log.error('JIRA hot sync error:', err.message));
    }, hotInterval);

    // Full sync — all candidate versions (slower, less frequent)
    this._timer = setInterval(() => {
      this.run().catch(err => log.error('JIRA sync error:', err.message));
    }, fullInterval);

    // Ticket database sync — full project, initial + incremental
    if (this._ticketStore) {
      const ticketInterval = (this.config.polling && this.config.polling.ticketSync) || 15 * 60 * 1000;
      // Defer first run to let version sync complete first
      setTimeout(() => {
        this.runTicketSync().catch(err => log.error('Ticket sync error:', err.message));
      }, 30_000);
      this._ticketSyncTimer = setInterval(() => {
        this.runTicketSync().catch(err => log.error('Ticket sync error:', err.message));
      }, ticketInterval);
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._hotTimer) { clearInterval(this._hotTimer); this._hotTimer = null; }
    if (this._ticketSyncTimer) { clearInterval(this._ticketSyncTimer); this._ticketSyncTimer = null; }
  }

  /**
   * One-time migration: remove jira-synced tickets from repos that previously
   * used sharesVersionsWith but no longer do. These tickets were blindly copied
   * from the primary repo and don't actually belong to the sharing repo.
   */
  _migrateStaleSharedTickets() {
    if (this._migrationDone) return;
    this._migrationDone = true;

    // Find repos that currently have sharesVersionsWith configured
    const activeSharing = new Set();
    for (const repo of (this.config.repos || [])) {
      if (repo.sharesVersionsWith) activeSharing.add(repo.name);
    }

    // Known repos that previously shared — clean them if they're no longer sharing
    const previouslySharing = ['bluesummit'];
    for (const repoName of previouslySharing) {
      if (activeSharing.has(repoName)) continue; // still sharing, skip

      // Remove all releases for this repo entirely
      const toDelete = this.releases.list().filter(r => r.repo === repoName);
      if (toDelete.length > 0) {
        for (const release of toDelete) {
          const key = this.releases._key(release.repo, release.version);
          this.releases.releases.delete(key);
          this.releases.db.prepare('DELETE FROM releases WHERE key = ?').run(key);
        }
        log.info(`Migration: removed ${toDelete.length} bluesummit releases (repo no longer shares versions)`);
      }
    }
  }

  /**
   * Hot sync — only sync versions that are overdue or upcoming within 2 weeks.
   * Runs frequently (every 2 min) for fast feedback on active releases.
   */
  async runHot() {
    if (this._running) return this.lastResults;

    this._running = true;
    const startTime = Date.now();

    const results = { versions: 0, tickets: 0 };

    try {
      const jiraProject = this.config.jira.project || 'DEV';
      const allVersions = await this.jira.getVersionsSummary(jiraProject);

      // Only sync versions that are overdue or within next 2 weeks
      const today = new Date().toISOString().slice(0, 10);
      const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const hotVersions = allVersions.filter(v => {
        if (v.archived || v.released) return false;
        if (!v.releaseDate) return false; // unscheduled — handled by full sync
        return v.releaseDate <= twoWeeksOut; // overdue or upcoming
      });

      for (const version of hotVersions) {
        try {
          const result = await this._syncVersionTickets(version.name);
          if (result) {
            results.tickets += result.tickets;
          }
          results.versions++;
        } catch (err) {
          log.error(`JIRA hot sync failed for ${version.name}:`, err.message);
        }
      }
    } catch (err) {
      log.error('JIRA hot sync error:', err.message);
    }

    const durationMs = Date.now() - startTime;
    this._running = false;

    if (results.versions > 0) {
      log.info(`JIRA hot sync: ${results.versions} versions, ${results.tickets} tickets in ${durationMs}ms`);
      this.emit('sync:completed', { ...this.lastResults, hot: true });
    }

    return results;
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

    // Run one-time migration to clean stale shared tickets
    this._migrateStaleSharedTickets();

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

    // Track JIRA metadata on the release — detect date changes
    const oldDate = release.jiraReleaseDate;
    const newDate = jiraVersion.releaseDate;

    release.jiraVersionId = jiraVersion.id;
    release.jiraVersionName = versionName;
    release.jiraReleased = jiraVersion.released;
    release.jiraReleaseDate = newDate;
    release.jiraArchived = jiraVersion.archived;

    // Resolve target customers from version name suffix + description override
    const knownIds = this._getKnownCustomerIds();
    if (knownIds.length > 0) {
      const { customers, source } = resolveTargetCustomers(
        cleanVersion, jiraVersion.description || null, knownIds
      );
      release.targetCustomers = customers;
      release.targetCustomerSource = source;
    }

    // Emit event if release date changed
    if (oldDate && newDate && oldDate !== newDate && release.state !== 'done') {
      this.emit('release:date-changed', release, { oldDate, newDate });
    }

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

    // Also update JIRA metadata on repos that share version numbers.
    // E.g., bluesummit shares versions with webplatform — if a bluesummit
    // release exists for this version (created by discovery), tag it with
    // the same JIRA metadata.
    for (const sharingRepo of this._getVersionSharingRepos(repo)) {
      const sharingRelease = this.releases.get(cleanVersion, sharingRepo);
      if (sharingRelease) {
        sharingRelease.jiraVersionId = jiraVersion.id;
        sharingRelease.jiraVersionName = versionName;
        sharingRelease.jiraReleased = jiraVersion.released;
        sharingRelease.jiraReleaseDate = jiraVersion.releaseDate;
        sharingRelease.jiraArchived = jiraVersion.archived;
        sharingRelease.updatedAt = new Date().toISOString();
      }
    }
  }

  /**
   * Sync all tickets for a JIRA version.
   *
   * Pulls every ticket that references this version via fixVersion OR
   * Target FixVersion. Writes to TicketStore (jira_tickets table) as
   * the single source of truth.
   */
  async _syncVersionTickets(versionName) {
    this.emit('sync:version-started', versionName, { incremental: false });

    const issues = await this.jira.getIssuesForVersion(versionName, {
      onPage: (fetched, total) => {
        this.emit('sync:version-progress', versionName, { fetched, total });
      },
    });

    // Find the release — strict repo match
    const { repo, cleanVersion } = this._parseVersionName(versionName);
    const release = this.releases.get(cleanVersion, repo);
    if (!release) {
      log.warn(`JIRA sync: no release found for ${repo}:${cleanVersion} — skipping ${issues.length} issues`);
      return { tickets: 0, updated: 0 };
    }

    const syncedAt = new Date().toISOString();

    // Snapshot existing ticket keys BEFORE mutations (for change detection).
    const preExistingKeys = this._ticketStore
      ? new Set(this._ticketStore.getKeysForVersion(cleanVersion))
      : new Set();

    // Normalize all issues
    const normalized = issues.map(issue => ({
      ...JiraClient.normalizeIssue(issue),
      key: issue.key,
      updatedInJira: issue.fields?.updated || null,
      syncedAt,
    }));

    // Write to TicketStore (single source of truth)
    if (this._ticketStore && normalized.length > 0) {
      this._ticketStore.upsertBatch(normalized);
    }

    const freshKeys = new Set(issues.map(i => i.key));

    // Prune: tickets previously in this version but no longer returned by JIRA.
    // Remove the version from their fixVersions/targetFixVersions in TicketStore.
    const removedKeys = [...preExistingKeys].filter(k => !freshKeys.has(k));
    if (this._ticketStore && removedKeys.length > 0) {
      for (const key of removedKeys) {
        const stale = this._ticketStore.get(key);
        if (stale) {
          stale.fixVersions = (stale.fixVersions || []).filter(v => v !== cleanVersion);
          stale.targetFixVersions = (stale.targetFixVersions || []).filter(v => v !== cleanVersion);
          this._ticketStore.upsert(stale);
        }
      }
      log.info(`JIRA sync: ${versionName} — pruned ${removedKeys.length} stale tickets from TicketStore`);
    }

    // Detect added/removed tickets for notification engine
    const removedTicketInfo = removedKeys.map(k => {
      const t = this._ticketStore ? this._ticketStore.get(k) : null;
      return { key: k, summary: t ? t.summary : k };
    });

    const addedKeys = [...freshKeys].filter(k => !preExistingKeys.has(k));
    if (addedKeys.length > 0 || removedTicketInfo.length > 0) {
      this.emit('sync:version-tickets', release.version, {
        repo: release.repo,
        added: addedKeys.map(k => {
          const td = normalized.find(t => t.key === k);
          return { key: k, summary: td ? td.summary : k };
        }),
        removed: removedTicketInfo,
      });
    }

    if (issues.length > 0) {
      log.info(`JIRA sync: ${versionName} — ${normalized.length} tickets synced to TicketStore`);
    }

    this.emit('sync:version-done', versionName, {
      tickets: issues.length,
      updated: normalized.length,
      pruned: removedKeys.length,
    });

    return { tickets: issues.length, updated: normalized.length };
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
   * Find repos that share JIRA version numbers with the primary repo.
   * Used to sync tickets to both the primary and sharing repos.
   */
  _getVersionSharingRepos(primaryRepo) {
    const repos = this.config.repos || [];
    return repos
      .filter(r => r.sharesVersionsWith === primaryRepo)
      .map(r => r.name);
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
   * Full-project ticket sync — populates the jira_tickets table.
   * Initial sync pulls 1 year of history; subsequent syncs are incremental.
   */
  async runTicketSync() {
    if (!this._ticketStore) return null;
    if (this._ticketSyncRunning) return null;
    this._ticketSyncRunning = true;

    const startTime = Date.now();
    const jiraProject = this.config.jira.project || 'DEV';
    const syncMeta = this._ticketStore.getSyncMeta();
    const lastSync = syncMeta.lastTicketSyncTime;

    let jql;
    if (lastSync) {
      const jiraDate = lastSync.replace('T', ' ').slice(0, 16);
      jql = `project = ${jiraProject} AND updated >= "${jiraDate}" ORDER BY key ASC`;
    } else {
      jql = `project = ${jiraProject} AND updated >= -365d ORDER BY key ASC`;
    }

    const results = { total: 0, upserted: 0, error: null };
    const syncStartTime = new Date().toISOString();

    try {
      this.emit('ticket-sync:started', { incremental: !!lastSync });
      log.info(`Ticket sync: ${lastSync ? 'incremental' : 'initial'} — ${jql.slice(0, 80)}...`);

      const issues = await this.jira.searchAllIssues(jql, {
        fields: JiraClient.NECTAR_FIELDS,
        maxResults: 50000,
        onPage: (fetched) => {
          this.emit('ticket-sync:progress', { fetched });
        },
      });

      results.total = issues.length;

      // Batch upsert in chunks of 500
      const CHUNK = 500;
      for (let i = 0; i < issues.length; i += CHUNK) {
        const chunk = issues.slice(i, i + CHUNK);
        const normalized = chunk.map(issue => ({
          key: issue.key,
          ...JiraClient.normalizeIssue(issue),
          updatedInJira: issue.fields?.updated || null,
          syncedAt: syncStartTime,
        }));
        this._ticketStore.upsertBatch(normalized);
        results.upserted += normalized.length;
      }

      this._ticketStore.updateSyncMeta({
        lastTicketSyncTime: syncStartTime,
        totalTicketsSynced: this._ticketStore.count(),
        lastSyncDurationMs: Date.now() - startTime,
        lastSyncError: null,
      });
    } catch (err) {
      results.error = err.message;
      this._ticketStore.updateSyncMeta({ lastSyncError: err.message });
      log.error('Ticket sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this._ticketSyncRunning = false;

    this.emit('ticket-sync:completed', results);
    log.info(`Ticket sync: ${results.upserted} tickets in ${results.durationMs}ms${results.error ? ` (error: ${results.error})` : ''}`);

    return results;
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
      ticketSync: this._ticketStore ? {
        running: this._ticketSyncRunning,
        ...this._ticketStore.getSyncMeta(),
      } : null,
    };
  }
}

module.exports = JiraSync;
