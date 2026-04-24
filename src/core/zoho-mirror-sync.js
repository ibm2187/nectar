const { EventEmitter } = require('events');
const log = require('./log');

/**
 * Zoho Desk → Nectar mirror.
 *
 * Two flows share the same write path:
 *   1. backfill()       — one-time, sortBy createdTime asc, walks every page
 *                         within the configured window (dev=30d, prod=all-time).
 *                         Resumable via zoho_sync_meta.backfillProgress.
 *   2. runIncremental() — polled every 5 min, sortBy=-modifiedTime desc,
 *                         early-exit on cursor. Typical page finds 0–50 new
 *                         tickets.
 *
 * Accounts + contacts are fetched lazily the first time a ticket references
 * one we haven't seen, not enumerated up-front. Keeps the backfill path
 * simple + avoids paying for accounts we'll never display.
 *
 * Singleton worker lock (zoho_sync_meta.workerLockUntil) prevents concurrent
 * runs from doubling up on Zoho's credit budget.
 *
 * Events:
 *   backfill:started / backfill:progress / backfill:done
 *   incremental:completed
 */
class ZohoMirrorSync extends EventEmitter {
  /**
   * @param {object} deps
   *   zoho:        ZohoClient
   *   zohoStore:   ZohoStore
   *   userStore:   UserStore
   *   config:      nectar config (reads config.polling.zohoMirror, config.zohoMirror)
   */
  constructor({ zoho, zohoStore, userStore, config }) {
    super();
    this.zoho = zoho;
    this.store = zohoStore;
    this.userStore = userStore;
    this.config = config || {};
    this._timer = null;
    this._running = false;

    const mc = (config && config.zohoMirror) || {};
    this.pageSize = mc.pageSize || 100;
    this.throttleMs = mc.throttleMs != null ? mc.throttleMs : 2000;
    this.lockTtlMs = mc.workerLockTtlMs || 10 * 60 * 1000;
    this.backfillSinceDays = mc.backfillSinceDays;
  }

  // ─────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────

  start() {
    if (!this.zoho.isConfigured()) {
      log.warn('Zoho mirror sync disabled (Zoho not configured)');
      return;
    }
    const interval = (this.config.polling && this.config.polling.zohoMirror) || 5 * 60 * 1000;
    log.info(`Zoho mirror sync started (polling every ${interval / 60000}m)`);

    // Kick off backfill if it hasn't run yet (async, non-blocking).
    // runIncremental below will skip until backfill is done.
    const meta = this.store.getSyncMeta();
    if (meta.backfillStatus !== 'done') {
      setTimeout(() => {
        this.backfill().catch(err =>
          log.error(`Zoho mirror backfill failed: ${err.message}`)
        );
      }, 30_000); // let other startup work finish first
    }

    this._timer = setInterval(() => {
      this.runIncremental().catch(err =>
        log.error(`Zoho mirror incremental sync failed: ${err.message}`)
      );
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Backfill
  // ─────────────────────────────────────────────────────────

  /**
   * One-time mirror seed. Paginates tickets oldest-first and upserts each.
   * Can be called again to resume if it was interrupted — the cursor lives
   * on zoho_sync_meta.backfillProgress (as a page offset).
   */
  async backfill() {
    if (!this.store.acquireLock(this.lockTtlMs)) {
      log.info('Zoho mirror backfill: another worker holds the lock, skipping');
      return null;
    }
    this._running = true;
    const start = Date.now();

    const floor = this._backfillFloorIso(); // null = all-time
    const results = {
      floor,
      pagesFetched: 0,
      ticketsSeen: 0,
      ticketsUpserted: 0,
      accountsCached: 0,
      contactsCached: 0,
      errors: 0,
      durationMs: 0,
    };

    this.store.updateSyncMeta({
      backfillStatus: 'in_progress',
      lastSyncError: null,
    });
    this.emit('backfill:started', { floor });
    log.info(`Zoho mirror backfill: starting (floor=${floor || 'all-time'}, pageSize=${this.pageSize})`);

    const seenAccounts = new Set();
    const seenContacts = new Set();
    let maxModifiedSeen = null;

    try {
      const startMeta = this.store.getSyncMeta();
      let from = startMeta.backfillProgress || 0;
      // Max pages as safety — at 100/page and max ~20K tickets, 250 pages is plenty.
      const maxPages = 500;

      // When a window is set we paginate newest-first so we can stop as
      // soon as we start seeing tickets older than the floor. Unbounded
      // backfill paginates oldest-first and walks every page.
      const sortBy = floor ? '-createdTime' : 'createdTime';

      for (let i = 0; i < maxPages; i++) {
        const page = await this.zoho.listTicketsPage({
          sortBy,
          pageSize: this.pageSize,
          from,
        });
        results.pagesFetched++;
        const tickets = page.data || [];
        if (tickets.length === 0) break;

        // Filter: drop tickets older than the floor (when a window is set).
        const inWindow = floor
          ? tickets.filter(t => (t.createdTime || '') >= floor)
          : tickets;

        for (const t of inWindow) {
          results.ticketsSeen++;
          try {
            await this._upsertTicketWithRefs(t, { seenAccounts, seenContacts, results });
            results.ticketsUpserted++;
            if (t.modifiedTime && (!maxModifiedSeen || t.modifiedTime > maxModifiedSeen)) {
              maxModifiedSeen = t.modifiedTime;
            }
          } catch (err) {
            results.errors++;
            log.warn(`Zoho mirror backfill: upsert ${t.ticketNumber || t.id} failed: ${err.message}`);
          }
        }

        from += this.pageSize;

        // Persist progress so a resume picks up where we left off. Note:
        // `from` is an offset into Zoho's paginated response, not a stable
        // cursor. If tickets are inserted at the head between runs, resume
        // may skip a few boundary rows — incremental sync sweeps them up
        // on the next cycle via the modifiedTime cursor.
        this.store.updateSyncMeta({
          backfillProgress: from,
          backfillTotal: results.ticketsSeen,
        });

        if (tickets.length < this.pageSize) break;
        // Windowed + newest-first: once we see a page with any ticket older
        // than the floor, everything after is older too — stop.
        if (floor && inWindow.length < tickets.length) {
          log.info('Zoho mirror backfill: reached window floor, stopping');
          break;
        }

        await _sleep(this.throttleMs);

        this.emit('backfill:progress', { ticketsUpserted: results.ticketsUpserted, pagesFetched: results.pagesFetched });
      }

      // Seed the incremental cursor from the max modified timestamp we saw,
      // or from now if we saw nothing. Future incremental runs paginate
      // newest-first and early-exit once they reach this mark.
      const cursor = maxModifiedSeen || new Date().toISOString();
      this.store.updateSyncMeta({
        backfillStatus: 'done',
        lastBackfillAt: new Date().toISOString(),
        lastModifiedCursor: cursor,
        backfillProgress: results.ticketsSeen,
        backfillTotal: results.ticketsSeen,
      });
    } catch (err) {
      log.error(`Zoho mirror backfill error: ${err.message}`);
      this.store.updateSyncMeta({
        backfillStatus: 'failed',
        lastSyncError: err.message,
      });
      results.errors++;
    } finally {
      results.durationMs = Date.now() - start;
      this.store.releaseLock();
      this._running = false;
      log.info(
        `Zoho mirror backfill: done — ${results.ticketsUpserted} upserted ` +
        `(${results.ticketsSeen} seen, ${results.pagesFetched} pages, ` +
        `${results.accountsCached} accounts, ${results.contactsCached} contacts, ` +
        `${results.errors} errors) in ${results.durationMs}ms`
      );
      this.emit('backfill:done', results);
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────
  // Incremental
  // ─────────────────────────────────────────────────────────

  async runIncremental() {
    const meta = this.store.getSyncMeta();
    if (meta.backfillStatus === 'failed') {
      // Transient failure (Zoho 429, auth blip, network). Re-run backfill
      // on the next tick instead of stalling until process restart.
      log.info('Zoho mirror: previous backfill failed — retrying on this tick');
      return this.backfill();
    }
    if (meta.backfillStatus !== 'done') {
      // Backfill hasn't completed — skip this tick. Initial backfill fires
      // on start(), and it'll set backfillStatus='done' when it finishes.
      return null;
    }
    if (!this.store.acquireLock(this.lockTtlMs)) {
      return null; // lock held by another worker — quiet skip
    }
    this._running = true;
    const start = Date.now();
    const cursor = meta.lastModifiedCursor;

    const results = {
      cursor,
      pagesFetched: 0,
      ticketsChecked: 0,
      ticketsUpserted: 0,
      accountsCached: 0,
      contactsCached: 0,
      errors: 0,
      durationMs: 0,
      newCursor: cursor,
    };

    const seenAccounts = new Set();
    const seenContacts = new Set();
    let maxModifiedSeen = cursor;

    try {
      let from = 0;
      // Incremental is almost always <1 page; cap at 50 as a pathological-case brake.
      const maxPages = 50;

      for (let i = 0; i < maxPages; i++) {
        const page = await this.zoho.listTicketsPage({
          sortBy: '-modifiedTime',
          pageSize: this.pageSize,
          from,
        });
        results.pagesFetched++;
        const tickets = page.data || [];
        if (tickets.length === 0) break;

        let stoppedEarly = false;
        for (const t of tickets) {
          results.ticketsChecked++;
          const mod = t.modifiedTime || t.createdTime || null;
          if (cursor && mod && mod <= cursor) {
            stoppedEarly = true;
            break; // older than our cursor — stop this page
          }
          try {
            await this._upsertTicketWithRefs(t, { seenAccounts, seenContacts, results });
            results.ticketsUpserted++;
            if (mod && (!maxModifiedSeen || mod > maxModifiedSeen)) {
              maxModifiedSeen = mod;
            }
          } catch (err) {
            results.errors++;
            log.warn(`Zoho mirror incremental: upsert ${t.ticketNumber || t.id} failed: ${err.message}`);
          }
        }

        if (stoppedEarly) break;
        if (tickets.length < this.pageSize) break;
        from += this.pageSize;
        await _sleep(this.throttleMs);
      }

      results.newCursor = maxModifiedSeen;
      this.store.updateSyncMeta({
        lastModifiedCursor: maxModifiedSeen,
        lastRunAt: new Date().toISOString(),
        lastSyncError: null,
      });
    } catch (err) {
      log.error(`Zoho mirror incremental error: ${err.message}`);
      this.store.updateSyncMeta({
        lastSyncError: err.message,
        lastRunAt: new Date().toISOString(),
      });
      results.errors++;
    } finally {
      results.durationMs = Date.now() - start;
      this.store.updateSyncMeta({ lastSyncDurationMs: results.durationMs });
      this.store.releaseLock();
      this._running = false;
      if (results.ticketsUpserted > 0 || results.errors > 0) {
        log.info(
          `Zoho mirror incremental: ${results.ticketsUpserted} upserted, ` +
          `${results.ticketsChecked} checked, ${results.errors} errors, ` +
          `${results.durationMs}ms`
        );
      }
      this.emit('incremental:completed', results);
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────
  // Single-ticket refresh (manual "refresh" button)
  // ─────────────────────────────────────────────────────────

  /**
   * Force-refresh one ticket from Zoho. Used by /api/support/tickets/:n/refresh.
   */
  async refreshTicket(zohoTicketId) {
    if (!this.zoho.isConfigured()) throw new Error('Zoho not configured');
    const raw = await this.zoho.getTicket(zohoTicketId);
    if (!raw) return null;
    const seenAccounts = new Set();
    const seenContacts = new Set();
    const results = { accountsCached: 0, contactsCached: 0 };
    await this._upsertTicketWithRefs(raw, { seenAccounts, seenContacts, results });
    return this.store.getTicketById(zohoTicketId);
  }

  // ─────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────

  /**
   * Upsert a Zoho ticket row + lazily cache any referenced account/contact.
   * Caller passes seenAccounts/seenContacts Sets so we don't re-fetch the
   * same one N times per page.
   */
  async _upsertTicketWithRefs(raw, { seenAccounts, seenContacts, results }) {
    const normalized = normalizeTicket(raw, { userStore: this.userStore });

    // Lazy account
    if (raw.accountId && !seenAccounts.has(raw.accountId)) {
      seenAccounts.add(raw.accountId);
      if (!this.store.getAccount(raw.accountId)) {
        try {
          const accRaw = await this.zoho.getAccount(raw.accountId);
          if (accRaw) {
            this.store.upsertAccount({
              id: accRaw.id,
              name: accRaw.accountName || accRaw.name || null,
              departmentId: raw.departmentId || null,
              rawPayload: JSON.stringify(accRaw),
            });
            results.accountsCached++;
          }
        } catch (err) {
          log.warn(`Zoho mirror: account ${raw.accountId} fetch failed: ${err.message}`);
        }
      }
    }

    // Lazy contact
    if (raw.contactId && !seenContacts.has(raw.contactId)) {
      seenContacts.add(raw.contactId);
      if (!this.store.getContact(raw.contactId)) {
        try {
          const contactRaw = await this.zoho.getContact(raw.contactId);
          if (contactRaw) {
            this.store.upsertContact({
              id: contactRaw.id,
              accountId: contactRaw.accountId || null,
              email: contactRaw.email || null,
              name: [contactRaw.firstName, contactRaw.lastName].filter(Boolean).join(' ') || null,
              phone: contactRaw.phone || null,
              rawPayload: JSON.stringify(contactRaw),
            });
            results.contactsCached++;
          }
        } catch (err) {
          log.warn(`Zoho mirror: contact ${raw.contactId} fetch failed: ${err.message}`);
        }
      }
    }

    this.store.upsertTicket(normalized);
  }

  /** Compute the backfill ISO floor, or null for unbounded. */
  _backfillFloorIso() {
    if (!this.backfillSinceDays || this.backfillSinceDays <= 0) return null;
    const ms = Date.now() - this.backfillSinceDays * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }
}

// ─────────────────────────────────────────────────────────
// Normalization — Zoho ticket → Nectar row shape
// ─────────────────────────────────────────────────────────

function normalizeTicket(raw, { userStore } = {}) {
  // Resolve assigneeZohoAgentId → email via users table (needs reconciler first run)
  let assigneeEmail = null;
  if (raw.assigneeId && userStore && typeof userStore.findByZohoAgentId === 'function') {
    const user = userStore.findByZohoAgentId(raw.assigneeId);
    if (user) assigneeEmail = user.email;
  }

  return {
    id: String(raw.id),
    ticketNumber: raw.ticketNumber || null,
    deptPrefix: _deptPrefixOf(raw.ticketNumber),
    departmentId: raw.departmentId || null,
    accountId: raw.accountId || null,
    contactId: raw.contactId || null,
    assigneeEmail,
    assigneeZohoAgentId: raw.assigneeId || null,
    subject: raw.subject || '',
    status: raw.status || null,
    statusType: raw.statusType || null,
    priority: raw.priority || null,
    category: raw.category || null,
    subCategory: raw.subCategory || null,
    channel: raw.channel || null,
    sentiment: raw.sentiment || null,
    commentCount: Number(raw.commentCount || 0),
    threadCount: Number(raw.threadCount || 0),
    createdAt: raw.createdTime || null,
    modifiedAt: raw.modifiedTime || null,
    closedAt: raw.closedTime || null,
    onHoldAt: raw.onholdTime || null,
    customerResponseAt: raw.customerResponseTime || null,
    webUrl: raw.webUrl || null,
    rawPayload: JSON.stringify(raw),
    lastSyncedAt: new Date().toISOString(),
  };
}

function _deptPrefixOf(ticketNumber) {
  if (!ticketNumber) return null;
  const m = String(ticketNumber).match(/^([A-Z]+)-\d+$/);
  return m ? m[1] : null;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = ZohoMirrorSync;
module.exports.normalizeTicket = normalizeTicket;
