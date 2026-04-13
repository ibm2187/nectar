const { EventEmitter } = require('events');
const log = require('./log');
const ZohoClient = require('../integrations/zoho');

const JIRA_KEY_REGEX = /\b(DEV|MAV)-\d+\b/g;

/**
 * Zoho Desk sync — pulls Zoho tickets and matches them to JIRA issues in releases.
 *
 * Strategy (Zoho → JIRA direction):
 *   1. Pull all open/recent Zoho tickets across departments
 *   2. For each ticket, read the "Associated Jira Issues" custom field
 *   3. Extract JIRA keys and match them to tickets in active releases
 *   4. Store the associations on each release as `zohoTickets[]`
 *
 * This is the correct direction: Zoho tracks which JIRA issues it's linked to,
 * not the other way around (JIRA's customfield_10691 is 99% empty).
 *
 * Events:
 *   sync:started
 *   sync:completed ({ zohoFetched, matched, releases, durationMs })
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
   * Run full Zoho sync.
   */
  async run() {
    if (this._running) {
      log.warn('Zoho sync already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    this.emit('sync:started');

    const results = {
      zohoFetched: 0,
      withJiraLinks: 0,
      matched: 0,
      releasesUpdated: 0,
      errors: 0,
    };

    try {
      // Step 1: Build a lookup of all JIRA keys across active releases
      // key → [{ release, ticket }]
      const jiraKeyIndex = this._buildJiraKeyIndex();
      log.info(`Zoho sync: ${jiraKeyIndex.size} unique JIRA keys across active releases`);
      // Debug: check if DEV-44698 is in the index
      if (jiraKeyIndex.has('DEV-44698')) {
        const entries = jiraKeyIndex.get('DEV-44698');
        log.info(`Zoho sync: DEV-44698 found in index → ${entries.map(e => e.releaseKey).join(', ')}`);
      } else {
        log.info('Zoho sync: DEV-44698 NOT in index');
      }

      // Step 2: Pull Zoho tickets and find JIRA associations
      const zohoTickets = await this._fetchAllZohoTickets();
      results.zohoFetched = zohoTickets.length;
      log.info(`Zoho sync: fetched ${zohoTickets.length} Zoho tickets`);

      // Step 3: For each Zoho ticket, extract JIRA keys and match
      // Build: releaseKey → { zohoTickets[], zohoByJiraKey }
      const releaseZohoMap = new Map();

      for (const zt of zohoTickets) {
        const jiraKeys = this._extractJiraKeys(zt);
        if (jiraKeys.length === 0) continue;
        results.withJiraLinks++;
        const matchedAny = jiraKeys.some(k => jiraKeyIndex.has(k));
        log.info(`Zoho sync: ${zt.ticketNumber} has JIRA keys [${jiraKeys.join(', ')}] → ${matchedAny ? 'MATCHED' : 'no match in active releases'}`);

        for (const jiraKey of jiraKeys) {
          const entries = jiraKeyIndex.get(jiraKey);
          if (!entries) continue; // JIRA key not in any active release
          results.matched++;

          for (const { releaseKey } of entries) {
            if (!releaseZohoMap.has(releaseKey)) {
              releaseZohoMap.set(releaseKey, { zohoTickets: new Map(), zohoByJiraKey: {} });
            }
            const data = releaseZohoMap.get(releaseKey);

            // Deduplicate by Zoho ticket ID
            if (!data.zohoTickets.has(zt.id)) {
              data.zohoTickets.set(zt.id, zt);
            }
            // Track which JIRA key this Zoho ticket is linked to
            if (!data.zohoByJiraKey[jiraKey]) data.zohoByJiraKey[jiraKey] = [];
            if (!data.zohoByJiraKey[jiraKey].some(t => t.id === zt.id)) {
              data.zohoByJiraKey[jiraKey].push(zt);
            }
          }
        }
      }

      // Step 4: Store associations on releases
      for (const [releaseKey, data] of releaseZohoMap) {
        const release = this.releases.releases.get(releaseKey);
        if (!release) continue;

        release.zohoTickets = Array.from(data.zohoTickets.values());
        release.zohoByJiraKey = data.zohoByJiraKey;
        release.zohoSyncedAt = new Date().toISOString();
        results.releasesUpdated++;
      }

      // Clear zoho data from releases that had matches before but don't anymore
      for (const release of this.releases.list()) {
        const key = this.releases._key(release.repo, release.version);
        if (!releaseZohoMap.has(key) && release.zohoTickets && release.zohoTickets.length > 0) {
          release.zohoTickets = [];
          release.zohoByJiraKey = {};
          release.zohoSyncedAt = new Date().toISOString();
        }
      }

      if (results.releasesUpdated > 0) {
        this.releases._debounceSave();
      }

    } catch (err) {
      results.errors++;
      log.error('Zoho sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`Zoho sync complete: ${results.zohoFetched} tickets fetched, ${results.withJiraLinks} with JIRA links, ${results.matched} matched to releases, ${results.releasesUpdated} releases updated in ${results.durationMs}ms`);
    this.emit('sync:completed', results);

    return results;
  }

  /**
   * Build an index of JIRA keys → release entries across all active releases.
   */
  _buildJiraKeyIndex() {
    const index = new Map(); // jiraKey → [{ releaseKey, ticket }]
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
   * Fetch all open/recent Zoho tickets with their custom fields.
   *
   * The list endpoint doesn't return custom fields (where JIRA links live),
   * so we: list tickets → fetch each one's details → normalize.
   */
  async _fetchAllZohoTickets() {
    const allTickets = [];
    const pageSize = 50; // Zoho max per page
    const maxPages = 20; // Safety limit (1000 tickets max)
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

        // Filter out closed before fetching details (save API calls)
        const open = tickets.filter(t => t.statusType !== 'Closed');

        // Fetch full details for each open ticket to get custom fields
        for (const stub of open) {
          try {
            const full = await this.zoho.getTicket(stub.id);
            allTickets.push(ZohoClient.normalizeTicket(full));
            // Rate limit between detail fetches
            await new Promise(r => setTimeout(r, 100));
          } catch (err) {
            log.warn(`Zoho sync: failed fetching details for ${stub.ticketNumber || stub.id}: ${err.message}`);
          }
        }

        if (tickets.length < pageSize) break; // last page
        from += pageSize;
      } catch (err) {
        log.error(`Zoho sync: failed fetching page ${page}:`, err.message);
        break;
      }
    }

    return allTickets;
  }

  /**
   * Extract JIRA keys from a normalized Zoho ticket.
   * Checks the "Associated Jira Issues" custom field.
   */
  _extractJiraKeys(zohoTicket) {
    const raw = zohoTicket.associatedJiraIssues;
    if (!raw) return [];

    // Extract all JIRA keys (DEV-XXXXX, MAV-XXXXX) from the field
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
    };
  }
}

module.exports = ZohoSync;
