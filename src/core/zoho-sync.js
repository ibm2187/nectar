const { EventEmitter } = require('events');
const log = require('./log');
const ZohoClient = require('../integrations/zoho');

const JIRA_KEY_REGEX = /\b(DEV|MAV)-\d+\b/g;

/**
 * Zoho Desk sync — pulls Zoho tickets and matches them to JIRA issues in releases.
 *
 * Strategy (Zoho → JIRA direction):
 *   1. Pull Zoho tickets (full on first run, incremental on subsequent runs)
 *   2. For each ticket, read the "Associated Jira Issues" custom field
 *   3. Extract JIRA keys and match them to tickets in active releases
 *   4. Store the associations on each release as `zohoTickets[]`
 *
 * Incremental sync:
 *   - First run: fetches all open tickets, builds full cache
 *   - Subsequent runs: only fetches tickets modified since last sync
 *   - Only fetches individual ticket details for new/changed tickets
 *   - Rebuilds release associations from the full cache
 *
 * Events:
 *   sync:started
 *   sync:completed ({ zohoFetched, matched, releases, durationMs, incremental })
 */
class ZohoSync extends EventEmitter {
  constructor(releases, zoho, config) {
    super();
    this.releases = releases;
    this.zoho = zoho;
    this.config = config;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;
    this._lastSyncTime = null; // ISO timestamp of last successful sync
    // Cache: zoho ticket id → normalized ticket (persists across syncs)
    this._ticketCache = new Map();
  }

  start() {
    if (!this.zoho.isConfigured()) {
      log.warn('Zoho sync disabled (Zoho not configured)');
      return;
    }

    const interval = (this.config.polling && this.config.polling.zohoSync) || 15 * 60 * 1000;
    log.info(`Zoho sync started (polling every ${interval / 60000}m)`);

    // Initial sync after a short delay (let JIRA sync populate tickets first)
    setTimeout(() => {
      this.run().catch(err => log.error('Zoho sync error:', err.message));
    }, 60000);

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('Zoho sync error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run Zoho sync — full on first run, incremental on subsequent runs.
   */
  async run() {
    if (this._running) {
      log.warn('Zoho sync already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    const isIncremental = this._lastSyncTime !== null;
    this.emit('sync:started');

    const results = {
      incremental: isIncremental,
      zohoFetched: 0,
      detailsFetched: 0,
      withJiraLinks: 0,
      matched: 0,
      releasesUpdated: 0,
      errors: 0,
    };

    try {
      // Step 1: Fetch tickets (full or incremental)
      if (isIncremental) {
        await this._fetchIncremental(results);
      } else {
        await this._fetchFull(results);
      }

      // Step 2: Build JIRA key index from active releases
      const jiraKeyIndex = this._buildJiraKeyIndex();

      // Step 3: Match cached tickets to releases
      this._matchAndStore(jiraKeyIndex, results);

    } catch (err) {
      results.errors++;
      log.error('Zoho sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this._lastSyncTime = new Date().toISOString();
    this.lastRun = this._lastSyncTime;
    this.lastResults = results;
    this._running = false;

    const mode = isIncremental ? 'incremental' : 'full';
    log.info(`Zoho sync complete (${mode}): ${results.zohoFetched} listed, ${results.detailsFetched} details fetched, ${results.withJiraLinks} with JIRA links, ${results.matched} matched, ${results.releasesUpdated} releases updated in ${results.durationMs}ms (cache: ${this._ticketCache.size})`);
    this.emit('sync:completed', results);

    return results;
  }

  /**
   * Full sync — fetch all open tickets and populate cache.
   */
  async _fetchFull(results) {
    log.info('Zoho sync: running full sync (first run)');
    const stubs = await this._listTickets();
    results.zohoFetched = stubs.length;

    // Filter out closed
    const open = stubs.filter(t => t.statusType !== 'Closed');

    // Fetch details for each open ticket
    for (const stub of open) {
      try {
        const full = await this.zoho.getTicket(stub.id);
        const normalized = ZohoClient.normalizeTicket(full);
        this._ticketCache.set(normalized.id, normalized);
        results.detailsFetched++;
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        log.warn(`Zoho sync: failed fetching ${stub.ticketNumber || stub.id}: ${err.message}`);
      }
    }

    // Remove closed tickets from cache
    for (const stub of stubs.filter(t => t.statusType === 'Closed')) {
      this._ticketCache.delete(stub.id);
    }
  }

  /**
   * Incremental sync — only fetch tickets modified since last sync.
   */
  async _fetchIncremental(results) {
    const since = this._lastSyncTime;
    log.info(`Zoho sync: running incremental since ${since}`);

    const stubs = await this._listTickets(since);
    results.zohoFetched = stubs.length;

    if (stubs.length === 0) {
      log.info('Zoho sync: no changes since last sync');
      return;
    }

    // Fetch details only for modified tickets
    for (const stub of stubs) {
      if (stub.statusType === 'Closed') {
        // Remove from cache if it was closed
        this._ticketCache.delete(stub.id);
        continue;
      }

      try {
        const full = await this.zoho.getTicket(stub.id);
        const normalized = ZohoClient.normalizeTicket(full);
        this._ticketCache.set(normalized.id, normalized);
        results.detailsFetched++;
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        log.warn(`Zoho sync: failed fetching ${stub.ticketNumber || stub.id}: ${err.message}`);
      }
    }
  }

  /**
   * List tickets from Zoho, optionally filtered by modifiedTime.
   * Returns lightweight stubs (no custom fields).
   */
  async _listTickets(since = null) {
    const allStubs = [];
    const pageSize = 50;
    const maxPages = 20;
    let from = 0;

    for (let page = 0; page < maxPages; page++) {
      try {
        const params = new URLSearchParams();
        params.set('limit', String(pageSize));
        params.set('from', String(from));
        params.set('sortBy', 'modifiedTime');

        const raw = await this.zoho._request('GET', `/tickets?${params}`);
        const tickets = raw?.data || [];
        if (tickets.length === 0) break;

        if (since) {
          // For incremental: only keep tickets modified after our cutoff
          const sinceTime = new Date(since).getTime();
          const recent = tickets.filter(t => {
            const mod = new Date(t.modifiedTime || t.createdTime).getTime();
            return mod >= sinceTime;
          });
          allStubs.push(...recent);

          // If all tickets on this page are older than our cutoff, stop paginating
          if (recent.length < tickets.length) break;
        } else {
          allStubs.push(...tickets);
        }

        if (tickets.length < pageSize) break;
        from += pageSize;
      } catch (err) {
        log.error(`Zoho sync: failed fetching page ${page}:`, err.message);
        break;
      }
    }

    return allStubs;
  }

  /**
   * Match all cached tickets to active releases and store associations.
   */
  _matchAndStore(jiraKeyIndex, results) {
    const releaseZohoMap = new Map();

    for (const zt of this._ticketCache.values()) {
      const jiraKeys = this._extractJiraKeys(zt);
      if (jiraKeys.length === 0) continue;
      results.withJiraLinks++;

      for (const jiraKey of jiraKeys) {
        const entries = jiraKeyIndex.get(jiraKey);
        if (!entries) continue;
        results.matched++;

        for (const { releaseKey } of entries) {
          if (!releaseZohoMap.has(releaseKey)) {
            releaseZohoMap.set(releaseKey, { zohoTickets: new Map(), zohoByJiraKey: {} });
          }
          const data = releaseZohoMap.get(releaseKey);

          if (!data.zohoTickets.has(zt.id)) {
            data.zohoTickets.set(zt.id, zt);
          }
          if (!data.zohoByJiraKey[jiraKey]) data.zohoByJiraKey[jiraKey] = [];
          if (!data.zohoByJiraKey[jiraKey].some(t => t.id === zt.id)) {
            data.zohoByJiraKey[jiraKey].push(zt);
          }
        }
      }
    }

    // Store on releases
    for (const [releaseKey, data] of releaseZohoMap) {
      const release = this.releases.releases.get(releaseKey);
      if (!release) continue;

      release.zohoTickets = Array.from(data.zohoTickets.values());
      release.zohoByJiraKey = data.zohoByJiraKey;
      release.zohoSyncedAt = new Date().toISOString();
      this.releases.persist(release);
      results.releasesUpdated++;
    }

    // Clear stale zoho data from releases that no longer match
    for (const release of this.releases.list()) {
      const key = this.releases._key(release.repo, release.version);
      if (!releaseZohoMap.has(key) && release.zohoTickets && release.zohoTickets.length > 0) {
        release.zohoTickets = [];
        release.zohoByJiraKey = {};
        release.zohoSyncedAt = new Date().toISOString();
        this.releases.persist(release);
      }
    }
  }

  /**
   * Build an index of JIRA keys → release entries across all active releases.
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
   * Extract JIRA keys from a normalized Zoho ticket.
   */
  _extractJiraKeys(zohoTicket) {
    const raw = zohoTicket.associatedJiraIssues;
    if (!raw) return [];
    const matches = raw.match(JIRA_KEY_REGEX);
    return matches ? [...new Set(matches)] : [];
  }

  /**
   * Get sync status for API.
   */
  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.zoho.isConfigured(),
      cacheSize: this._ticketCache.size,
    };
  }
}

module.exports = ZohoSync;
