const { EventEmitter } = require('events');
const log = require('./log');
const { parseLinkedZohoTickets } = require('./zoho-link-parser');

/**
 * JIRA → Zoho link sync.
 *
 * Queries JIRA for every issue that has customfield_11157 "Linked Zoho
 * Tickets" populated, parses the ADF (or wiki markup) to extract the
 * linked Zoho ticket IDs, and upserts rows into jira_zoho_links.
 *
 * Uses ZohoStore.replaceLinksFromSource so a JIRA that used to point at 3
 * Zoho tickets and now points at 2 has the dropped one correctly removed
 * (but only for the 'customfield_11157' source — Zoho-side links are
 * untouched).
 *
 * Runs on its own polling interval (default 10 min — same cadence as
 * jiraSync). Safe to call run() ad-hoc for manual re-sync.
 *
 * Events:
 *   sync:completed ({ issuesScanned, linksUpserted, jiraKeysWithLinks, errors, durationMs })
 */
class JiraZohoLinkSync extends EventEmitter {
  /**
   * @param {object} deps
   *   jira:      JiraClient
   *   zohoStore: ZohoStore
   *   config:    nectar config (reads config.polling.jiraSync as default cadence)
   */
  constructor({ jira, zohoStore, config }) {
    super();
    this.jira = jira;
    this.store = zohoStore;
    this.config = config || {};
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;
  }

  start() {
    if (!this.jira.isConfigured()) {
      log.warn('JIRA→Zoho link sync disabled (JIRA not configured)');
      return;
    }
    const interval = (this.config.polling && this.config.polling.jiraSync) || 10 * 60 * 1000;
    log.info(`JIRA→Zoho link sync started (polling every ${interval / 60000}m)`);

    // First run after a short delay — let JIRA sync populate tickets first
    setTimeout(() => {
      this.run().catch(err => log.error(`JIRA→Zoho link sync error: ${err.message}`));
    }, 45_000);

    this._timer = setInterval(() => {
      this.run().catch(err => log.error(`JIRA→Zoho link sync error: ${err.message}`));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run one link sync pass. On first run we scan all issues with the field;
   * subsequent runs can be narrowed with updatedSince for efficiency.
   *
   * @param {object} opts
   *   updatedSince?: ISO timestamp; only re-scan issues updated after this.
   *                  null = full scan.
   */
  async run(opts = {}) {
    if (this._running) {
      log.info('JIRA→Zoho link sync already running, skipping');
      return this.lastResults;
    }
    this._running = true;
    const start = Date.now();
    const results = {
      issuesScanned: 0,
      jiraKeysWithLinks: 0,
      linksUpserted: 0,
      errors: 0,
      durationMs: 0,
    };

    try {
      const issues = await this.jira.listIssuesWithZohoLinks({
        updatedSince: opts.updatedSince || null,
      });
      results.issuesScanned = issues.length;

      for (const issue of issues) {
        const key = issue.key;
        const raw = issue.fields && issue.fields.customfield_11157;
        let links = [];
        try {
          links = parseLinkedZohoTickets(raw);
        } catch (err) {
          log.warn(`JIRA→Zoho link parse failed for ${key}: ${err.message}`);
          results.errors++;
          continue;
        }

        // Even when links is empty (junk placeholder like "."), we still
        // call replaceLinksFromSource so previously-recorded links for
        // this key are cleared out.
        const zohoIds = links.map(l => l.zohoTicketId);
        try {
          this.store.replaceLinksFromSource(key, 'customfield_11157', zohoIds);
          if (zohoIds.length > 0) {
            results.jiraKeysWithLinks++;
            results.linksUpserted += zohoIds.length;
          }
        } catch (err) {
          log.warn(`JIRA→Zoho link upsert failed for ${key}: ${err.message}`);
          results.errors++;
        }
      }
    } catch (err) {
      log.error(`JIRA→Zoho link sync: ${err.message}`);
      results.errors++;
    }

    results.durationMs = Date.now() - start;
    this._running = false;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    log.info(
      `JIRA→Zoho link sync: ${results.issuesScanned} issues scanned, ` +
      `${results.jiraKeysWithLinks} with links, ${results.linksUpserted} links upserted, ` +
      `${results.errors} errors, ${results.durationMs}ms`
    );
    this.emit('sync:completed', results);
    return results;
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.jira.isConfigured(),
    };
  }
}

module.exports = JiraZohoLinkSync;
