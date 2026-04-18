const { EventEmitter } = require('events');
const { getDb } = require('./db');

/**
 * Normalized JIRA ticket database.
 *
 * Unlike other stores, TicketStore does NOT load all rows into memory.
 * With ~20K tickets, we query SQLite directly and rely on indexes.
 *
 * Events:
 *   tickets:synced ({ total, upserted, durationMs })
 */
class TicketStore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || getDb();
    this._prepareStatements();
  }

  _prepareStatements() {
    this._upsertStmt = this.db.prepare(`
      INSERT INTO jira_tickets (
        key, summary, status, statusCategory, state, type,
        assignee, reporter, qaAssignee, productAssignee, component,
        priority, riskLevel, customerPriority,
        fixVersions, targetFixVersions, customerTags,
        deployedEnvironments, labels, zohoRef,
        submitterName, submitterEmail,
        created, updatedInJira, syncedAt
      ) VALUES (
        @key, @summary, @status, @statusCategory, @state, @type,
        @assignee, @reporter, @qaAssignee, @productAssignee, @component,
        @priority, @riskLevel, @customerPriority,
        @fixVersions, @targetFixVersions, @customerTags,
        @deployedEnvironments, @labels, @zohoRef,
        @submitterName, @submitterEmail,
        @created, @updatedInJira, @syncedAt
      )
      ON CONFLICT(key) DO UPDATE SET
        summary = excluded.summary,
        status = excluded.status,
        statusCategory = excluded.statusCategory,
        state = excluded.state,
        type = excluded.type,
        assignee = excluded.assignee,
        reporter = excluded.reporter,
        qaAssignee = excluded.qaAssignee,
        productAssignee = excluded.productAssignee,
        component = excluded.component,
        priority = excluded.priority,
        riskLevel = excluded.riskLevel,
        customerPriority = excluded.customerPriority,
        fixVersions = excluded.fixVersions,
        targetFixVersions = excluded.targetFixVersions,
        customerTags = excluded.customerTags,
        deployedEnvironments = excluded.deployedEnvironments,
        labels = excluded.labels,
        zohoRef = excluded.zohoRef,
        submitterName = excluded.submitterName,
        submitterEmail = excluded.submitterEmail,
        created = excluded.created,
        updatedInJira = excluded.updatedInJira,
        syncedAt = excluded.syncedAt
    `);

    this._getStmt = this.db.prepare('SELECT * FROM jira_tickets WHERE key = ?');
    this._countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM jira_tickets');
  }

  // ── Core CRUD ─────────────────────────────────────

  upsert(ticket) {
    this._upsertStmt.run(ticketToRow(ticket));
  }

  upsertBatch(tickets) {
    const run = this.db.transaction((rows) => {
      for (const row of rows) {
        this._upsertStmt.run(row);
      }
    });
    run(tickets.map(ticketToRow));
  }

  get(key) {
    const row = this._getStmt.get(key);
    return row ? ticketFromRow(row) : null;
  }

  count() {
    return this._countStmt.get().n;
  }

  // ── Release-scoped queries ────────────────────────

  /**
   * Get all tickets for a release version.
   * Matches tickets where fixVersions or targetFixVersions contains the version.
   * Returns tickets with release membership info (source: 'both'|'target'|'fixVersion').
   */
  getForVersion(version) {
    const pattern = `%"${version}"%`;
    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets
      WHERE fixVersions LIKE ? OR targetFixVersions LIKE ?
      ORDER BY key ASC
    `).all(pattern, pattern);

    return rows.map(row => {
      const ticket = ticketFromRow(row);
      const inFix = ticket.fixVersions.includes(version);
      const inTarget = ticket.targetFixVersions.includes(version);
      ticket._releaseSource = inFix && inTarget ? 'both' : inTarget ? 'target' : 'fixVersion';
      return ticket;
    });
  }

  /**
   * Get tickets for multiple versions at once.
   * Returns Map<version, ticket[]> with source info.
   */
  getForVersions(versions) {
    const result = new Map();
    for (const v of versions) {
      result.set(v, this.getForVersion(v));
    }
    return result;
  }

  /**
   * Get ticket keys for a version (lightweight — no full ticket data).
   */
  getKeysForVersion(version) {
    const pattern = `%"${version}"%`;
    return this.db.prepare(`
      SELECT key FROM jira_tickets
      WHERE fixVersions LIKE ? OR targetFixVersions LIKE ?
      ORDER BY key ASC
    `).all(pattern, pattern).map(r => r.key);
  }

  // ── Search ────────────────────────────────────────

  search(query, opts = {}) {
    const limit = opts.limit || 50;
    const offset = opts.offset || 0;
    const pattern = `%${query}%`;

    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets
      WHERE key LIKE ? OR summary LIKE ? OR assignee LIKE ?
      ORDER BY created DESC
      LIMIT ? OFFSET ?
    `).all(pattern, pattern, pattern, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(ticketFromRow);

    const total = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets
      WHERE key LIKE ? OR summary LIKE ? OR assignee LIKE ?
    `).get(pattern, pattern, pattern).n;

    return { tickets, total, hasMore };
  }

  // ── Filtered queries ──────────────────────────────

  getByFilter(opts = {}) {
    const conditions = [];
    const params = [];

    if (opts.statusCategory) {
      conditions.push('statusCategory = ?');
      params.push(opts.statusCategory);
    }
    if (opts.assignee) {
      conditions.push('assignee = ?');
      params.push(opts.assignee);
    }
    if (opts.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }
    if (opts.createdSince) {
      conditions.push('created >= ?');
      params.push(opts.createdSince);
    }
    if (opts.hasFixVersion === true) {
      conditions.push("fixVersions != '[]'");
    } else if (opts.hasFixVersion === false) {
      conditions.push("fixVersions = '[]'");
    }

    const where = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets ${where}
      ORDER BY created DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(ticketFromRow);

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM jira_tickets ${where}`
    ).get(...params).n;

    return { tickets, total, hasMore };
  }

  // ── Analytical views ──────────────────────────────

  getQAScope(opts = {}) {
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const where = `
      WHERE statusCategory = 'Done'
        AND fixVersions = '[]'
        AND status NOT IN ('Resolved Without Code', 'Archived')
    `;

    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets ${where}
      ORDER BY created DESC
      LIMIT ? OFFSET ?
    `).all(limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(ticketFromRow);

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM jira_tickets ${where}`
    ).get().n;

    return { tickets, total, hasMore };
  }

  getTriage(opts = {}) {
    const since = opts.since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const where = `WHERE statusCategory = 'To Do' AND created >= ?`;

    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets ${where}
      ORDER BY created DESC
      LIMIT ? OFFSET ?
    `).all(since, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(ticketFromRow);

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM jira_tickets ${where}`
    ).get(since).n;

    return { tickets, total, hasMore, since };
  }

  getStats() {
    const byStatusCategory = {};
    const catRows = this.db.prepare(
      'SELECT statusCategory, COUNT(*) AS n FROM jira_tickets GROUP BY statusCategory'
    ).all();
    for (const r of catRows) {
      byStatusCategory[r.statusCategory || 'Unknown'] = r.n;
    }

    const byType = {};
    const typeRows = this.db.prepare(
      'SELECT type, COUNT(*) AS n FROM jira_tickets GROUP BY type'
    ).all();
    for (const r of typeRows) {
      byType[r.type || 'Unknown'] = r.n;
    }

    return {
      total: this.count(),
      byStatusCategory,
      byType,
    };
  }

  // ── Sync metadata ─────────────────────────────────

  getSyncMeta() {
    const row = this.db.prepare('SELECT * FROM jira_sync_meta WHERE id = 1').get();
    if (!row) {
      return { lastTicketSyncTime: null, totalTicketsSynced: 0, lastSyncDurationMs: null, lastSyncError: null };
    }
    return {
      lastTicketSyncTime: row.lastTicketSyncTime || null,
      totalTicketsSynced: row.totalTicketsSynced || 0,
      lastSyncDurationMs: row.lastSyncDurationMs || null,
      lastSyncError: row.lastSyncError || null,
    };
  }

  updateSyncMeta(data) {
    const meta = this.getSyncMeta();
    const merged = { ...meta, ...data, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO jira_sync_meta (id, lastTicketSyncTime, totalTicketsSynced, lastSyncDurationMs, lastSyncError, updatedAt)
      VALUES (1, @lastTicketSyncTime, @totalTicketsSynced, @lastSyncDurationMs, @lastSyncError, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        lastTicketSyncTime = excluded.lastTicketSyncTime,
        totalTicketsSynced = excluded.totalTicketsSynced,
        lastSyncDurationMs = excluded.lastSyncDurationMs,
        lastSyncError = excluded.lastSyncError,
        updatedAt = excluded.updatedAt
    `).run(merged);
  }

  flush() { /* no-op — writes are synchronous */ }
}

// ── Row mapping ─────────────────────────────────────

function ticketToRow(t) {
  return {
    key: t.key,
    summary: t.summary || '',
    status: t.status || null,
    statusCategory: t.statusCategory || null,
    state: t.state || null,
    type: t.type || null,
    assignee: t.assignee || null,
    reporter: t.reporter || null,
    qaAssignee: t.qaAssignee || null,
    productAssignee: t.productAssignee || null,
    component: t.component || null,
    priority: t.priority || null,
    riskLevel: t.riskLevel || null,
    customerPriority: t.customerPriority || null,
    fixVersions: JSON.stringify(t.fixVersions || []),
    targetFixVersions: JSON.stringify(t.targetFixVersions || []),
    customerTags: JSON.stringify(t.customerTags || []),
    deployedEnvironments: JSON.stringify(t.deployedEnvironments || []),
    labels: JSON.stringify(t.labels || []),
    zohoRef: t.zohoRef ? JSON.stringify(t.zohoRef) : null,
    submitterName: t.submitterName || null,
    submitterEmail: t.submitterEmail || null,
    created: t.created || null,
    updatedInJira: t.updatedInJira || null,
    syncedAt: t.syncedAt || new Date().toISOString(),
  };
}

function ticketFromRow(row) {
  return {
    key: row.key,
    summary: row.summary,
    status: row.status,
    statusCategory: row.statusCategory,
    state: row.state,
    type: row.type,
    assignee: row.assignee,
    reporter: row.reporter,
    qaAssignee: row.qaAssignee,
    productAssignee: row.productAssignee,
    component: row.component,
    priority: row.priority,
    riskLevel: row.riskLevel,
    customerPriority: row.customerPriority,
    fixVersions: JSON.parse(row.fixVersions || '[]'),
    targetFixVersions: JSON.parse(row.targetFixVersions || '[]'),
    customerTags: JSON.parse(row.customerTags || '[]'),
    deployedEnvironments: JSON.parse(row.deployedEnvironments || '[]'),
    labels: JSON.parse(row.labels || '[]'),
    zohoRef: row.zohoRef ? JSON.parse(row.zohoRef) : null,
    submitterName: row.submitterName,
    submitterEmail: row.submitterEmail,
    created: row.created,
    updatedInJira: row.updatedInJira,
    syncedAt: row.syncedAt,
  };
}

module.exports = TicketStore;
