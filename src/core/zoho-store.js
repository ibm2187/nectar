const { EventEmitter } = require('events');
const { getDb } = require('./db');

/**
 * ZohoStore — SQLite access layer for the Zoho Desk mirror.
 *
 * Owns all reads/writes for:
 *   zoho_tickets, zoho_accounts, zoho_contacts, zoho_ticket_history,
 *   jira_zoho_links, zoho_sync_meta.
 *
 * Sync workers call the upsert methods; API routes call the list/get methods.
 * No in-memory cache — SQLite indexes make this sub-ms.
 *
 * Events:
 *   ticket:upserted   (zohoTicket)
 *   ticket:removed    (zohoTicketId)
 *   link:upserted     ({ jiraKey, zohoTicketId, source })
 */
class ZohoStore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || getDb();
    this._prepareStatements();
  }

  _prepareStatements() {
    // ── Tickets ─────────────────────────────────────────────
    this._upsertTicket = this.db.prepare(`
      INSERT INTO zoho_tickets (
        id, ticketNumber, deptPrefix, departmentId, accountId, contactId,
        assigneeEmail, assigneeZohoAgentId,
        subject, status, statusType, priority, category, subCategory, channel, sentiment,
        commentCount, threadCount,
        createdAt, modifiedAt, closedAt, onHoldAt, customerResponseAt,
        webUrl, rawPayload, lastSyncedAt
      ) VALUES (
        @id, @ticketNumber, @deptPrefix, @departmentId, @accountId, @contactId,
        @assigneeEmail, @assigneeZohoAgentId,
        @subject, @status, @statusType, @priority, @category, @subCategory, @channel, @sentiment,
        @commentCount, @threadCount,
        @createdAt, @modifiedAt, @closedAt, @onHoldAt, @customerResponseAt,
        @webUrl, @rawPayload, @lastSyncedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        ticketNumber        = excluded.ticketNumber,
        deptPrefix          = excluded.deptPrefix,
        departmentId        = excluded.departmentId,
        accountId           = excluded.accountId,
        contactId           = excluded.contactId,
        assigneeEmail       = excluded.assigneeEmail,
        assigneeZohoAgentId = excluded.assigneeZohoAgentId,
        subject             = excluded.subject,
        status              = excluded.status,
        statusType          = excluded.statusType,
        priority            = excluded.priority,
        category            = excluded.category,
        subCategory         = excluded.subCategory,
        channel             = excluded.channel,
        sentiment           = excluded.sentiment,
        commentCount        = excluded.commentCount,
        threadCount         = excluded.threadCount,
        createdAt           = excluded.createdAt,
        modifiedAt          = excluded.modifiedAt,
        closedAt            = excluded.closedAt,
        onHoldAt            = excluded.onHoldAt,
        customerResponseAt  = excluded.customerResponseAt,
        webUrl              = excluded.webUrl,
        rawPayload          = excluded.rawPayload,
        lastSyncedAt        = excluded.lastSyncedAt
    `);
    this._getTicketById = this.db.prepare('SELECT * FROM zoho_tickets WHERE id = ?');
    this._getTicketByNumber = this.db.prepare('SELECT * FROM zoho_tickets WHERE ticketNumber = ?');
    this._countTickets = this.db.prepare('SELECT COUNT(*) AS n FROM zoho_tickets');
    this._countOpenTickets = this.db.prepare("SELECT COUNT(*) AS n FROM zoho_tickets WHERE statusType != 'Closed' OR statusType IS NULL");
    this._deleteTicket = this.db.prepare('DELETE FROM zoho_tickets WHERE id = ?');
    this._maxModifiedAt = this.db.prepare('SELECT MAX(modifiedAt) AS m FROM zoho_tickets');

    // ── Accounts ────────────────────────────────────────────
    this._upsertAccount = this.db.prepare(`
      INSERT INTO zoho_accounts (id, name, departmentId, rawPayload, lastSyncedAt)
      VALUES (@id, @name, @departmentId, @rawPayload, @lastSyncedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        departmentId = excluded.departmentId,
        rawPayload = excluded.rawPayload,
        lastSyncedAt = excluded.lastSyncedAt
    `);
    this._getAccount = this.db.prepare('SELECT * FROM zoho_accounts WHERE id = ?');
    this._listAccounts = this.db.prepare('SELECT * FROM zoho_accounts ORDER BY name');
    this._listDeptPrefixes = this.db.prepare(`
      SELECT deptPrefix, COUNT(*) AS count
      FROM zoho_tickets
      WHERE deptPrefix IS NOT NULL AND deptPrefix != ''
      GROUP BY deptPrefix
      ORDER BY deptPrefix
    `);

    // ── Contacts ────────────────────────────────────────────
    this._upsertContact = this.db.prepare(`
      INSERT INTO zoho_contacts (id, accountId, email, name, phone, rawPayload, lastSyncedAt)
      VALUES (@id, @accountId, @email, @name, @phone, @rawPayload, @lastSyncedAt)
      ON CONFLICT(id) DO UPDATE SET
        accountId = excluded.accountId,
        email = excluded.email,
        name = excluded.name,
        phone = excluded.phone,
        rawPayload = excluded.rawPayload,
        lastSyncedAt = excluded.lastSyncedAt
    `);
    this._getContact = this.db.prepare('SELECT * FROM zoho_contacts WHERE id = ?');

    // ── History ─────────────────────────────────────────────
    this._upsertHistory = this.db.prepare(`
      INSERT OR REPLACE INTO zoho_ticket_history (
        id, ticketId, changedAt, changedByEmail, fieldName, fromValue, toValue, rawPayload
      ) VALUES (
        @id, @ticketId, @changedAt, @changedByEmail, @fieldName, @fromValue, @toValue, @rawPayload
      )
    `);
    this._listHistory = this.db.prepare(
      'SELECT * FROM zoho_ticket_history WHERE ticketId = ? ORDER BY changedAt DESC'
    );
    this._lastStatusEntry = this.db.prepare(`
      SELECT * FROM zoho_ticket_history
      WHERE ticketId = ? AND fieldName = 'status'
      ORDER BY changedAt DESC LIMIT 1
    `);

    // ── Links ───────────────────────────────────────────────
    this._upsertLink = this.db.prepare(`
      INSERT INTO jira_zoho_links (jiraKey, zohoTicketId, source, firstSeenAt, lastSeenAt)
      VALUES (@jiraKey, @zohoTicketId, @source, @firstSeenAt, @lastSeenAt)
      ON CONFLICT(jiraKey, zohoTicketId) DO UPDATE SET
        source = excluded.source,
        lastSeenAt = excluded.lastSeenAt
    `);
    this._deleteLinksByJira = this.db.prepare('DELETE FROM jira_zoho_links WHERE jiraKey = ? AND source = ?');
    this._listLinksByJira = this.db.prepare('SELECT * FROM jira_zoho_links WHERE jiraKey = ?');
    this._listLinksByZoho = this.db.prepare('SELECT * FROM jira_zoho_links WHERE zohoTicketId = ?');

    // ── Sync meta (singleton) ───────────────────────────────
    this._getSyncMeta = this.db.prepare('SELECT * FROM zoho_sync_meta WHERE id = 1');
    this._upsertSyncMetaInit = this.db.prepare(
      "INSERT OR IGNORE INTO zoho_sync_meta (id, backfillStatus, backfillProgress, backfillTotal) VALUES (1, 'pending', 0, 0)"
    );
  }

  // ─────────────────────────────────────────────────────────
  // Tickets
  // ─────────────────────────────────────────────────────────

  upsertTicket(ticket) {
    const row = ticketToRow(ticket);
    this._upsertTicket.run(row);
    this.emit('ticket:upserted', ticket);
  }

  upsertTicketBatch(tickets) {
    const run = this.db.transaction((items) => {
      for (const t of items) this._upsertTicket.run(ticketToRow(t));
    });
    run(tickets);
  }

  getTicketById(zohoTicketId) {
    const row = this._getTicketById.get(zohoTicketId);
    return row ? ticketFromRow(row) : null;
  }

  getTicketByNumber(ticketNumber) {
    const row = this._getTicketByNumber.get(ticketNumber);
    return row ? ticketFromRow(row) : null;
  }

  count() {
    return this._countTickets.get().n;
  }

  countOpen() {
    return this._countOpenTickets.get().n;
  }

  deleteTicket(zohoTicketId) {
    const res = this._deleteTicket.run(zohoTicketId);
    if (res.changes > 0) this.emit('ticket:removed', zohoTicketId);
    return res.changes;
  }

  /** Max modifiedAt seen in the mirror — source-of-truth cursor fallback. */
  maxModifiedAt() {
    const row = this._maxModifiedAt.get();
    return row ? row.m : null;
  }

  /**
   * List tickets with optional filters.
   *
   * @param {object} opts
   *   assigneeEmail?: string           normalized lowercase
   *   statuses?: string[]              e.g. ['Investigating', 'Waiting for Viv Response']
   *   statusTypes?: string[]           e.g. ['Open', 'On Hold']
   *   priorities?: string[]            e.g. ['Urgent', 'High']
   *   deptPrefixes?: string[]          e.g. ['VHC', 'BYD']
   *   accountIds?: string[]
   *   openOnly?: boolean               shortcut for statusType != 'Closed'
   *   closedOnly?: boolean
   *   minAgeDays?: number              ticket age floor (now - createdAt)
   *   maxAgeDays?: number              ticket age ceiling — pairs with minAgeDays for windowed buckets
   *   fixVersions?: string[]           filter to tickets whose linked JIRA(s) ship in any of these versions
   *   search?: string                  LIKE match on subject or ticketNumber
   *   limit?: number                   default 500
   *   orderBy?: 'modified'|'created'|'age'|'status'  default 'modified'
   *   orderDir?: 'asc'|'desc'          default 'desc'
   */
  listTickets(opts = {}) {
    const where = [];
    const params = [];

    if (opts.assigneeEmail) {
      where.push('assigneeEmail = ?');
      params.push(opts.assigneeEmail.toLowerCase());
    }
    if (opts.statuses && opts.statuses.length > 0) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    if (opts.statusTypes && opts.statusTypes.length > 0) {
      where.push(`statusType IN (${opts.statusTypes.map(() => '?').join(',')})`);
      params.push(...opts.statusTypes);
    }
    if (opts.priorities && opts.priorities.length > 0) {
      where.push(`priority IN (${opts.priorities.map(() => '?').join(',')})`);
      params.push(...opts.priorities);
    }
    if (opts.deptPrefixes && opts.deptPrefixes.length > 0) {
      where.push(`deptPrefix IN (${opts.deptPrefixes.map(() => '?').join(',')})`);
      params.push(...opts.deptPrefixes);
    }
    if (opts.accountIds && opts.accountIds.length > 0) {
      where.push(`accountId IN (${opts.accountIds.map(() => '?').join(',')})`);
      params.push(...opts.accountIds);
    }
    if (opts.openOnly) {
      where.push("(statusType != 'Closed' OR statusType IS NULL)");
    }
    if (opts.closedOnly) {
      where.push("statusType = 'Closed'");
    }
    if (opts.minAgeDays && opts.minAgeDays > 0) {
      const cutoff = new Date(Date.now() - opts.minAgeDays * 24 * 60 * 60 * 1000).toISOString();
      where.push('createdAt <= ?');
      params.push(cutoff);
    }
    if (opts.maxAgeDays != null && opts.maxAgeDays >= 0) {
      // createdAt must be >= (now - maxAgeDays) — newer than the floor
      const cutoff = new Date(Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      where.push('createdAt >= ?');
      params.push(cutoff);
    }
    if (opts.search) {
      const pat = `%${opts.search}%`;
      where.push('(subject LIKE ? OR ticketNumber LIKE ?)');
      params.push(pat, pat);
    }
    if (opts.hasJiraLinks) {
      where.push('id IN (SELECT DISTINCT zohoTicketId FROM jira_zoho_links)');
    }
    if (opts.fixVersions && opts.fixVersions.length > 0) {
      // jira_tickets.fixVersions is a JSON array of strings; match each version
      // by LIKE on the JSON encoding. Implies hasJiraLinks (must have a linked
      // JIRA to be in any release).
      const conds = opts.fixVersions.map(() => 'j.fixVersions LIKE ?').join(' OR ');
      where.push(`id IN (
        SELECT DISTINCT l.zohoTicketId
        FROM jira_zoho_links l
        JOIN jira_tickets j ON j.key = l.jiraKey
        WHERE ${conds}
      )`);
      for (const v of opts.fixVersions) {
        params.push(`%"${v}"%`);
      }
    }

    const orderCol = {
      modified: 'modifiedAt',
      created: 'createdAt',
      status: 'status',
    }[opts.orderBy || 'modified'] || 'modifiedAt';
    const orderDir = (opts.orderDir || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const limit = Math.min(opts.limit || 500, 5000);

    const sql = `
      SELECT * FROM zoho_tickets
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(ticketFromRow);
  }

  /**
   * Group counts by assignee for summary strip. Optionally filtered to open.
   * @returns [{ assigneeEmail, total, openCount }]
   */
  assigneeStats({ openOnly = false } = {}) {
    const where = openOnly ? "WHERE (statusType != 'Closed' OR statusType IS NULL)" : '';
    return this.db.prepare(`
      SELECT
        assigneeEmail,
        COUNT(*) AS total,
        SUM(CASE WHEN statusType != 'Closed' OR statusType IS NULL THEN 1 ELSE 0 END) AS openCount
      FROM zoho_tickets
      ${where}
      GROUP BY assigneeEmail
      ORDER BY total DESC
    `).all();
  }

  /**
   * Return a Map of zohoTicketId → number of jira_zoho_links for each.
   * Used by the /api/support/tickets list to decorate rows with
   * "N linked JIRAs" without N+1 queries.
   */
  linkCountsByTicketId(ids) {
    if (!ids || ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT zohoTicketId, COUNT(*) AS n FROM jira_zoho_links WHERE zohoTicketId IN (${placeholders}) GROUP BY zohoTicketId`
    ).all(...ids);
    const map = new Map();
    for (const r of rows) map.set(r.zohoTicketId, r.n);
    return map;
  }

  /**
   * Map of zohoTicketId → array of linked JIRA summaries, joined with
   * jira_tickets for status/state/assignee. Used by /api/support/tickets
   * to decorate list rows with "what JIRA is working on this?"
   *
   * Caps at 3 entries per Zoho ticket to keep the response small.
   */
  linkedJirasByTicketId(ids) {
    if (!ids || ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const linkRows = this.db.prepare(`
      SELECT l.zohoTicketId, l.jiraKey,
             j.summary, j.status, j.statusCategory, j.assignee, j.priority, j.fixVersions
      FROM jira_zoho_links l
      LEFT JOIN jira_tickets j ON j.key = l.jiraKey
      WHERE l.zohoTicketId IN (${placeholders})
      ORDER BY l.zohoTicketId, l.jiraKey
    `).all(...ids);

    // Collect unique JIRA keys we need per-release truth for.
    const jiraKeys = [...new Set(linkRows.map(r => r.jiraKey))];
    const truthByKey = new Map();
    if (jiraKeys.length > 0) {
      const jqMarks = jiraKeys.map(() => '?').join(',');
      const truthRows = this.db.prepare(`
        SELECT jiraKey, repo, version, healthCategory, healthMessage, stage,
               prNumber, prUrl, onBranch, inFixVersion
        FROM ticket_truth
        WHERE jiraKey IN (${jqMarks})
        ORDER BY jiraKey, version
      `).all(...jiraKeys);
      for (const t of truthRows) {
        if (!truthByKey.has(t.jiraKey)) truthByKey.set(t.jiraKey, []);
        truthByKey.get(t.jiraKey).push({
          version: t.version,
          repo: t.repo,
          healthCategory: t.healthCategory || null,
          healthMessage: t.healthMessage || null,
          stage: t.stage || null,
          prNumber: t.prNumber || null,
          prUrl: t.prUrl || null,
          onBranch: !!t.onBranch,
          inFixVersion: !!t.inFixVersion,
        });
      }
    }

    const map = new Map();
    for (const r of linkRows) {
      if (!map.has(r.zohoTicketId)) map.set(r.zohoTicketId, []);
      const list = map.get(r.zohoTicketId);
      if (list.length >= 3) continue;
      list.push({
        jiraKey: r.jiraKey,
        summary: r.summary || null,
        status: r.status || null,
        statusCategory: r.statusCategory || null,
        assignee: r.assignee || null,
        priority: r.priority || null,
        fixVersions: r.fixVersions ? (() => { try { return JSON.parse(r.fixVersions); } catch { return []; } })() : [],
        truth: truthByKey.get(r.jiraKey) || [],
      });
    }
    return map;
  }

  /**
   * Batch fetch linked Zoho tickets for a list of JIRA keys. Keyed by jiraKey.
   * Used by the standup "Customer Resolutions" section so a card with 5
   * JIRAs doesn't fan out to 5 endpoints.
   *
   * @param {string[]} jiraKeys
   * @returns {Map<string, Array<{jiraKey, zohoTicketId, zohoTicket}>>}
   */
  linkedZohoByJiraKeys(jiraKeys) {
    const result = new Map();
    if (!jiraKeys || jiraKeys.length === 0) return result;
    const placeholders = jiraKeys.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT l.jiraKey, l.zohoTicketId, t.ticketNumber, t.subject, t.status, t.statusType,
             t.priority, t.deptPrefix, t.accountId, t.assigneeEmail, t.createdAt, t.modifiedAt,
             t.webUrl,
             a.name AS accountName
      FROM jira_zoho_links l
      LEFT JOIN zoho_tickets t  ON t.id = l.zohoTicketId
      LEFT JOIN zoho_accounts a ON a.id = t.accountId
      WHERE l.jiraKey IN (${placeholders})
    `).all(...jiraKeys);
    for (const r of rows) {
      if (!result.has(r.jiraKey)) result.set(r.jiraKey, []);
      result.get(r.jiraKey).push(r);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────
  // Accounts + Contacts
  // ─────────────────────────────────────────────────────────

  upsertAccount(account) {
    this._upsertAccount.run({
      id: account.id,
      name: account.name ?? null,
      departmentId: account.departmentId ?? null,
      rawPayload: account.rawPayload ?? null,
      lastSyncedAt: account.lastSyncedAt ?? new Date().toISOString(),
    });
  }
  getAccount(id) { return this._getAccount.get(id) || null; }
  listAccounts() { return this._listAccounts.all(); }
  /** Returns [{ deptPrefix: 'VHC', count: 1234 }, ...] for ticket-prefix filtering. */
  listDeptPrefixes() { return this._listDeptPrefixes.all(); }

  upsertContact(contact) {
    this._upsertContact.run({
      id: contact.id,
      accountId: contact.accountId ?? null,
      email: contact.email ? contact.email.toLowerCase() : null,
      name: contact.name ?? null,
      phone: contact.phone ?? null,
      rawPayload: contact.rawPayload ?? null,
      lastSyncedAt: contact.lastSyncedAt ?? new Date().toISOString(),
    });
  }
  getContact(id) { return this._getContact.get(id) || null; }

  // ─────────────────────────────────────────────────────────
  // Status history
  // ─────────────────────────────────────────────────────────

  upsertHistoryEntry(entry) {
    this._upsertHistory.run({
      id: entry.id || `${entry.ticketId}:${entry.changedAt}:${entry.fieldName}`,
      ticketId: entry.ticketId,
      changedAt: entry.changedAt,
      changedByEmail: entry.changedByEmail ?? null,
      fieldName: entry.fieldName,
      fromValue: entry.fromValue ?? null,
      toValue: entry.toValue ?? null,
      rawPayload: entry.rawPayload ?? null,
    });
  }

  listHistory(ticketId) {
    return this._listHistory.all(ticketId);
  }

  /**
   * Days since the ticket last entered its current status. Returns null if
   * we have no history for it (e.g. pre-mirror ticket). Powers the
   * "Days on Dashboard" column in the standup view.
   */
  daysInCurrentStatus(ticketId) {
    const last = this._lastStatusEntry.get(ticketId);
    if (!last || !last.changedAt) return null;
    const ms = Date.now() - new Date(last.changedAt).getTime();
    return Math.floor(ms / (1000 * 60 * 60 * 24));
  }

  // ─────────────────────────────────────────────────────────
  // Links
  // ─────────────────────────────────────────────────────────

  upsertLink({ jiraKey, zohoTicketId, source }) {
    const now = new Date().toISOString();
    this._upsertLink.run({
      jiraKey,
      zohoTicketId,
      source,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    this.emit('link:upserted', { jiraKey, zohoTicketId, source });
  }

  /**
   * Replace all links for a JIRA key from a single source.
   * Used by the customfield_11157 sync: if a JIRA used to point at 3 Zoho
   * tickets and now points at 2, the removed one should disappear.
   */
  replaceLinksFromSource(jiraKey, source, newZohoTicketIds) {
    this.db.transaction(() => {
      this._deleteLinksByJira.run(jiraKey, source);
      const now = new Date().toISOString();
      for (const zohoId of newZohoTicketIds) {
        this._upsertLink.run({ jiraKey, zohoTicketId: zohoId, source, firstSeenAt: now, lastSeenAt: now });
      }
    })();
  }

  listLinksByJira(jiraKey) {
    return this._listLinksByJira.all(jiraKey);
  }
  listLinksByZoho(zohoTicketId) {
    return this._listLinksByZoho.all(zohoTicketId);
  }

  // ─────────────────────────────────────────────────────────
  // Sync meta + worker lock
  // ─────────────────────────────────────────────────────────

  getSyncMeta() {
    this._upsertSyncMetaInit.run(); // idempotent; fresh DBs may not have the row yet
    return this._getSyncMeta.get();
  }

  /**
   * Partial update of the singleton sync meta row.
   * @param {object} updates - any subset of meta columns
   */
  updateSyncMeta(updates) {
    this._upsertSyncMetaInit.run();
    const cols = Object.keys(updates);
    if (cols.length === 0) return;
    const setClause = cols.map(c => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE zoho_sync_meta SET ${setClause}, updatedAt = @updatedAt WHERE id = 1`
    ).run({ ...updates, updatedAt: new Date().toISOString() });
  }

  /**
   * Acquire the singleton worker lock with TTL. Returns true if acquired,
   * false if another worker holds it. Reads + writes inside a transaction
   * to avoid races between concurrent runs.
   */
  acquireLock(ttlMs) {
    return this.db.transaction(() => {
      this._upsertSyncMetaInit.run();
      const meta = this._getSyncMeta.get();
      const now = Date.now();
      if (meta.workerLockUntil && new Date(meta.workerLockUntil).getTime() > now) {
        return false;
      }
      const until = new Date(now + ttlMs).toISOString();
      this.db.prepare(
        'UPDATE zoho_sync_meta SET workerLockUntil = ?, updatedAt = ? WHERE id = 1'
      ).run(until, new Date().toISOString());
      return true;
    })();
  }

  releaseLock() {
    this.db.prepare(
      'UPDATE zoho_sync_meta SET workerLockUntil = NULL, updatedAt = ? WHERE id = 1'
    ).run(new Date().toISOString());
  }
}

// ─────────────────────────────────────────────────────────
// Row ↔ object mapping
// ─────────────────────────────────────────────────────────

function ticketToRow(t) {
  const now = new Date().toISOString();
  return {
    id: t.id,
    ticketNumber: t.ticketNumber ?? null,
    deptPrefix: t.deptPrefix ?? _deptPrefixOf(t.ticketNumber),
    departmentId: t.departmentId ?? null,
    accountId: t.accountId ?? null,
    contactId: t.contactId ?? null,
    assigneeEmail: t.assigneeEmail ? t.assigneeEmail.toLowerCase() : null,
    assigneeZohoAgentId: t.assigneeZohoAgentId ?? null,
    subject: t.subject ?? null,
    status: t.status ?? null,
    statusType: t.statusType ?? null,
    priority: t.priority ?? null,
    category: t.category ?? null,
    subCategory: t.subCategory ?? null,
    channel: t.channel ?? null,
    sentiment: t.sentiment ?? null,
    commentCount: t.commentCount != null ? Number(t.commentCount) : 0,
    threadCount: t.threadCount != null ? Number(t.threadCount) : 0,
    createdAt: t.createdAt ?? null,
    modifiedAt: t.modifiedAt ?? null,
    closedAt: t.closedAt ?? null,
    onHoldAt: t.onHoldAt ?? null,
    customerResponseAt: t.customerResponseAt ?? null,
    webUrl: t.webUrl ?? null,
    rawPayload: t.rawPayload ?? null,
    lastSyncedAt: t.lastSyncedAt ?? now,
  };
}

function ticketFromRow(row) {
  return { ...row };
}

function _deptPrefixOf(ticketNumber) {
  if (!ticketNumber) return null;
  const m = String(ticketNumber).match(/^([A-Z]+)-\d+$/);
  return m ? m[1] : null;
}

module.exports = ZohoStore;
