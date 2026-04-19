const { EventEmitter } = require('events');
const { getDb } = require('./db');

// Status group mappings — mirrors client/src/lib/status-colors.ts
const STATUS_GROUPS = {
  'in-dev': [
    'Development In Progress', 'In Progress', 'In Review', 'Development',
    'Waiting for Cherry Pick', 'Design In Progress', 'Design In Review', 'Design Review',
    'Implementing', 'Remediation in Progress', 'Defect Remediation in Progress',
    'Pending Dev Investigation', 'Pending Defect Remediation', 'Pending Configuration',
    'Pending Prioritization', 'Investigating Issue', 'Escalated',
    'Open', 'To Do', 'Backlog', 'Planning', 'Requirements', 'Needs Requirements',
    'Ready to Develop', 'Ready For Estimation', 'Reopened', 'Pending',
    'On Hold', 'Deprioritized', 'Future Development', 'Future Remediation',
  ],
  'blocked': ['Blocked', 'Testing Failed', 'Test Failed', 'Pending Bug Fix'],
  'ready-for-qa': ['Ready For Testing', 'Cherry Picked', 'Cherrypick is Building', 'Retest After Cherrypick', 'DQA Required'],
  'in-qa': ['In Testing', 'Testing in Branch', 'Testing', 'Re-verify Bug', 'Validating', 'Pending Customer QA/UAT'],
  'done': [
    'QA Certified', 'NO QA - Certified', 'Done', 'Closed', 'Resolved', 'Resolved Without Code',
    'Completed', 'Released', 'Rollout', 'Approved', 'DQA Approved',
    'Test Passed', 'TEST DEFERRED', 'Design Complete', 'Integration Complete',
    'Release Night Activity', 'Canceled', 'Declined', 'Rejected',
  ],
};
const DONE_STATUSES = new Set(STATUS_GROUPS['done']);
const NOT_DONE_STATUSES = new Set([...STATUS_GROUPS['in-dev'], ...STATUS_GROUPS['blocked'], ...STATUS_GROUPS['ready-for-qa'], ...STATUS_GROUPS['in-qa']]);

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
        module, product, projects,
        priority, riskLevel, customerPriority,
        fixVersions, targetFixVersions, customerTags,
        deployedEnvironments, labels, zohoRef,
        submitterName, submitterEmail,
        created, updatedInJira, syncedAt
      ) VALUES (
        @key, @summary, @status, @statusCategory, @state, @type,
        @assignee, @reporter, @qaAssignee, @productAssignee, @component,
        @module, @product, @projects,
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
        module = excluded.module,
        product = excluded.product,
        projects = excluded.projects,
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
    if (opts.module) {
      conditions.push('module = ?');
      params.push(opts.module);
    }
    if (opts.component) {
      conditions.push('component = ?');
      params.push(opts.component);
    }
    if (opts.customer) {
      // Include tickets for this customer + tickets with no customer set
      conditions.push(`(customerTags LIKE ? OR customerTags = '[]')`);
      params.push(`%"${opts.customer}"%`);
    }
    if (opts.project) {
      conditions.push('projects LIKE ?');
      params.push(`%"${opts.project}"%`);
    }
    if (opts.person) {
      conditions.push('(assignee = ? OR qaAssignee = ?)');
      params.push(opts.person, opts.person);
    }
    if (opts.product) {
      conditions.push('product LIKE ?');
      params.push(`%"${opts.product}"%`);
    }
    if (opts.excludeStatuses && opts.excludeStatuses.length > 0) {
      const placeholders = opts.excludeStatuses.map(() => '?').join(',');
      conditions.push(`status NOT IN (${placeholders})`);
      params.push(...opts.excludeStatuses);
    }
    if (opts.excludeStatusCategory) {
      conditions.push('statusCategory != ?');
      params.push(opts.excludeStatusCategory);
    }
    if (opts.statusGroup) {
      if (opts.statusGroup === 'not-done') {
        conditions.push("statusCategory != 'Done'");
      } else if (STATUS_GROUPS[opts.statusGroup]) {
        const statuses = STATUS_GROUPS[opts.statusGroup];
        const placeholders = statuses.map(() => '?').join(',');
        conditions.push(`status IN (${placeholders})`);
        params.push(...statuses);
      }
    }

    const where = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    // Sortable columns (whitelist to prevent injection)
    const SORT_COLS = { key: 'key', summary: 'summary', status: 'status', assignee: 'assignee', module: 'module', component: 'component', created: 'created', priority: 'priority', type: 'type' };
    const sortCol = SORT_COLS[opts.sort] || 'created';
    const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';

    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(ticketFromRow);

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM jira_tickets ${where}`
    ).get(...params).n;

    return { tickets, total, hasMore, offset, limit };
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

  // ── Cut Scope (merged to main, no fixVersion) ────

  /**
   * Tickets with a PR merged to main/master but no fixVersion assigned.
   * This is what would be included if you cut a release branch from main today.
   */
  getCutScope(opts = {}) {
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const SORT_COLS = { key: 'jt.key', summary: 'jt.summary', status: 'jt.status', assignee: 'jt.assignee', module: 'jt.module', component: 'jt.component', created: 'jt.created', priority: 'jt.priority', type: 'jt.type' };
    const sortCol = SORT_COLS[opts.sort] || 'jt.created';
    const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';

    const conditions = [
      "gp.status = 'merged'",
      "gp.baseBranch IN ('main', 'master')",
      "jt.fixVersions = '[]'",
    ];
    const params = [];

    if (opts.module) {
      conditions.push('jt.module = ?');
      params.push(opts.module);
    }
    if (opts.search) {
      conditions.push('(jt.key LIKE ? OR jt.summary LIKE ? OR jt.assignee LIKE ?)');
      const p = `%${opts.search}%`;
      params.push(p, p, p);
    }
    if (opts.statusGroup) {
      if (opts.statusGroup === 'not-done') {
        conditions.push("jt.statusCategory != 'Done'");
      } else if (STATUS_GROUPS[opts.statusGroup]) {
        const statuses = STATUS_GROUPS[opts.statusGroup];
        const placeholders = statuses.map(() => '?').join(',');
        conditions.push(`jt.status IN (${placeholders})`);
        params.push(...statuses);
      }
    }
    if (opts.person) {
      conditions.push('(jt.assignee = ? OR jt.qaAssignee = ?)');
      params.push(opts.person, opts.person);
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const rows = this.db.prepare(`
      SELECT DISTINCT jt.* FROM jira_tickets jt
      JOIN pr_jira_keys pjk ON pjk.jiraKey = jt.key
      JOIN github_prs gp ON gp.repo = pjk.repo AND gp.prNumber = pjk.prNumber
      ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(ticketFromRow);

    const total = this.db.prepare(`
      SELECT COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      JOIN pr_jira_keys pjk ON pjk.jiraKey = jt.key
      JOIN github_prs gp ON gp.repo = pjk.repo AND gp.prNumber = pjk.prNumber
      ${where}
    `).get(...params).n;

    // Status group breakdown across ALL matching tickets (not just this page)
    const statusBreakdown = {};
    const statusRows = this.db.prepare(`
      SELECT jt.status, COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      JOIN pr_jira_keys pjk ON pjk.jiraKey = jt.key
      JOIN github_prs gp ON gp.repo = pjk.repo AND gp.prNumber = pjk.prNumber
      ${where}
      GROUP BY jt.status ORDER BY n DESC
    `).all(...params);
    for (const r of statusRows) {
      statusBreakdown[r.status || 'Unknown'] = r.n;
    }

    // Group into status categories
    const byGroup = { done: 0, blocked: 0, 'ready-for-qa': 0, 'in-qa': 0, 'in-dev': 0 };
    const DONE_SET = new Set(STATUS_GROUPS['done']);
    const BLOCKED_SET = new Set(STATUS_GROUPS['blocked']);
    const QA_READY_SET = new Set(STATUS_GROUPS['ready-for-qa']);
    const IN_QA_SET = new Set(STATUS_GROUPS['in-qa']);
    for (const [status, count] of Object.entries(statusBreakdown)) {
      if (DONE_SET.has(status)) byGroup.done += count;
      else if (BLOCKED_SET.has(status)) byGroup.blocked += count;
      else if (QA_READY_SET.has(status)) byGroup['ready-for-qa'] += count;
      else if (IN_QA_SET.has(status)) byGroup['in-qa'] += count;
      else byGroup['in-dev'] += count;
    }

    // Type breakdown
    const typeBreakdown = {};
    const typeRows = this.db.prepare(`
      SELECT jt.type, COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      JOIN pr_jira_keys pjk ON pjk.jiraKey = jt.key
      JOIN github_prs gp ON gp.repo = pjk.repo AND gp.prNumber = pjk.prNumber
      ${where}
      GROUP BY jt.type ORDER BY n DESC
    `).all(...params);
    for (const r of typeRows) {
      typeBreakdown[r.type || 'Unknown'] = r.n;
    }

    return { tickets, total, hasMore, offset, limit, scopeStats: { byGroup, byType: typeBreakdown, byStatus: statusBreakdown } };
  }

  // ── Module/Component grouping (roadmap) ───────────

  /**
   * Get all distinct modules with ticket counts.
   */
  getModules() {
    return this.db.prepare(`
      SELECT module, COUNT(*) AS count
      FROM jira_tickets
      WHERE module IS NOT NULL
      GROUP BY module
      ORDER BY count DESC
    `).all();
  }

  /**
   * Get components within a module with ticket counts.
   */
  getComponentsForModule(module) {
    return this.db.prepare(`
      SELECT component, COUNT(*) AS count
      FROM jira_tickets
      WHERE module = ? AND component IS NOT NULL
      GROUP BY component
      ORDER BY count DESC
    `).all(module);
  }

  /**
   * Get tickets grouped by module for releases in a time range.
   * Optionally filter by customer (includes tickets with no customer set).
   * Optionally filter by project.
   */
  getByModuleForVersions(versions, opts = {}) {
    if (!versions.length) return {};

    const placeholders = versions.map(() => '?').join(',');
    const likeConditions = versions.map(v => `fixVersions LIKE '%"${v}"%' OR targetFixVersions LIKE '%"${v}"%'`).join(' OR ');

    let where = `WHERE (${likeConditions})`;
    const params = [];

    if (opts.customer) {
      // Include tickets for this customer + tickets with no customer set
      where += ` AND (customerTags LIKE ? OR customerTags = '[]')`;
      params.push(`%"${opts.customer}"%`);
    }

    if (opts.project) {
      where += ` AND projects LIKE ?`;
      params.push(`%"${opts.project}"%`);
    }

    if (opts.product) {
      where += ` AND product LIKE ?`;
      params.push(`%"${opts.product}"%`);
    }

    const rows = this.db.prepare(`
      SELECT * FROM jira_tickets ${where}
      ORDER BY module ASC, component ASC, key ASC
    `).all(...params);

    // Group by module
    const byModule = {};
    for (const row of rows) {
      const ticket = ticketFromRow(row);
      const mod = ticket.module || 'Uncategorized';
      if (!byModule[mod]) byModule[mod] = [];
      byModule[mod].push(ticket);
    }

    return byModule;
  }

  /**
   * Get all distinct values for filter dropdowns.
   */
  getFilterOptions() {
    const modules = this.db.prepare(`
      SELECT DISTINCT module FROM jira_tickets WHERE module IS NOT NULL ORDER BY module
    `).all().map(r => r.module);

    const components = this.db.prepare(`
      SELECT DISTINCT component FROM jira_tickets WHERE component IS NOT NULL ORDER BY component
    `).all().map(r => r.component);

    const customers = this.db.prepare(`
      SELECT DISTINCT value FROM (
        SELECT json_each.value AS value
        FROM jira_tickets, json_each(customerTags)
        WHERE customerTags != '[]'
      ) ORDER BY value
    `).all().map(r => r.value);

    const projects = this.db.prepare(`
      SELECT DISTINCT value FROM (
        SELECT json_each.value AS value
        FROM jira_tickets, json_each(projects)
        WHERE projects != '[]'
      ) ORDER BY value
    `).all().map(r => r.value);

    const products = this.db.prepare(`
      SELECT DISTINCT value FROM (
        SELECT json_each.value AS value
        FROM jira_tickets, json_each(product)
        WHERE product != '[]'
      ) ORDER BY value
    `).all().map(r => r.value);

    // People: union of assignees and QA assignees
    const people = this.db.prepare(`
      SELECT DISTINCT name FROM (
        SELECT assignee AS name FROM jira_tickets WHERE assignee IS NOT NULL
        UNION
        SELECT qaAssignee AS name FROM jira_tickets WHERE qaAssignee IS NOT NULL
      ) ORDER BY name
    `).all().map(r => r.name);

    return { modules, components, customers, projects, products, people };
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

    const byModule = {};
    const modRows = this.db.prepare(
      'SELECT module, COUNT(*) AS n FROM jira_tickets WHERE module IS NOT NULL GROUP BY module'
    ).all();
    for (const r of modRows) {
      byModule[r.module] = r.n;
    }

    return {
      total: this.count(),
      byStatusCategory,
      byType,
      byModule,
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
    module: t.module || null,
    product: JSON.stringify(t.product || []),
    projects: JSON.stringify(t.projects || []),
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
    module: row.module,
    product: JSON.parse(row.product || '[]'),
    projects: JSON.parse(row.projects || '[]'),
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
