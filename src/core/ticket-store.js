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

  // ── Enrichment SQL (releases + PRs + truth in one query) ──

  /**
   * SQL subquery fragments that add releases, PRs, and truth as JSON columns.
   * Append these to any SELECT from jira_tickets aliased as `jt`.
   */
  static ENRICH_COLUMNS = `,
    (SELECT json_group_array(json_object(
      'version', r.version, 'repo', r.repo, 'state', r.state,
      'jiraReleaseDate', r.jiraReleaseDate, 'jiraReleased', r.jiraReleased
    )) FROM (
      SELECT DISTINCT r2.version, r2.repo, r2.state, r2.jiraReleaseDate, r2.jiraReleased
      FROM json_each(jt.fixVersions) fv JOIN releases r2 ON r2.version = fv.value
      UNION
      SELECT DISTINCT r3.version, r3.repo, r3.state, r3.jiraReleaseDate, r3.jiraReleased
      FROM json_each(jt.targetFixVersions) tv JOIN releases r3 ON r3.version = tv.value
    ) r) AS releases_json,
    (SELECT json_group_array(json_object(
      'prNumber', gp.prNumber, 'repo', gp.repo, 'status', gp.status,
      'baseBranch', gp.baseBranch, 'prUrl', gp.prUrl
    )) FROM pr_jira_keys pjk
      JOIN github_prs gp ON gp.repo = pjk.repo AND gp.prNumber = pjk.prNumber
      WHERE pjk.jiraKey = jt.key
    ) AS prs_json,
    (SELECT json_group_array(json_object(
      'version', tt.version, 'health', tt.health, 'healthCategory', tt.healthCategory,
      'healthMessage', tt.healthMessage, 'onBranch', tt.onBranch
    )) FROM ticket_truth tt WHERE tt.jiraKey = jt.key
    ) AS truth_json`;

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
    // Version names are normalized at write time (prefixes like "iOS " stripped)
    // so a simple exact-element LIKE match works.
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
      SELECT jt.* ${TicketStore.ENRICH_COLUMNS} FROM jira_tickets jt
      WHERE jt.key LIKE ? OR jt.summary LIKE ? OR jt.assignee LIKE ?
      ORDER BY jt.created DESC
      LIMIT ? OFFSET ?
    `).all(pattern, pattern, pattern, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(enrichedTicketFromRow);

    const total = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets jt
      WHERE jt.key LIKE ? OR jt.summary LIKE ? OR jt.assignee LIKE ?
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
    const SORT_COLS = { key: 'key', summary: 'summary', status: 'status', assignee: 'assignee', qaAssignee: 'qaAssignee', module: 'module', component: 'component', created: 'created', priority: 'priority', riskLevel: 'riskLevel', customerPriority: 'customerPriority', type: 'type' };
    const sortCol = SORT_COLS[opts.sort] || 'created';
    const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';

    const enrich = opts.enrich !== false;
    const selectCols = enrich ? `jt.* ${TicketStore.ENRICH_COLUMNS}` : 'jt.*';
    const mapper = enrich ? enrichedTicketFromRow : ticketFromRow;

    const rows = this.db.prepare(`
      SELECT ${selectCols} FROM jira_tickets jt ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(mapper);

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM jira_tickets jt ${where}`
    ).get(...params).n;

    return { tickets, total, hasMore, offset, limit };
  }

  // ── People (distinct names across all tickets) ────

  /**
   * Get all distinct people from tickets in a single SQL query.
   * Returns an array of { name, roles: string[] } objects sorted by name.
   * Replaces the O(N) release loop that ran 1011 individual queries.
   */
  getDistinctPeople() {
    // Union all person columns, tag each with a role
    const rows = this.db.prepare(`
      SELECT name, GROUP_CONCAT(DISTINCT role) AS roles FROM (
        SELECT assignee AS name, 'dev' AS role FROM jira_tickets WHERE assignee IS NOT NULL AND assignee != ''
        UNION ALL
        SELECT reporter AS name, 'reporter' AS role FROM jira_tickets WHERE reporter IS NOT NULL AND reporter != ''
        UNION ALL
        SELECT qaAssignee AS name, 'qa' AS role FROM jira_tickets WHERE qaAssignee IS NOT NULL AND qaAssignee != ''
        UNION ALL
        SELECT productAssignee AS name, 'pm' AS role FROM jira_tickets WHERE productAssignee IS NOT NULL AND productAssignee != ''
      )
      GROUP BY name
      ORDER BY name COLLATE NOCASE ASC
    `).all();

    return rows.map(r => ({
      name: r.name,
      roles: r.roles.split(','),
    }));
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

    const SORT_COLS = { key: 'jt.key', summary: 'jt.summary', status: 'jt.status', assignee: 'jt.assignee', qaAssignee: 'jt.qaAssignee', module: 'jt.module', component: 'jt.component', created: 'jt.created', priority: 'jt.priority', riskLevel: 'jt.riskLevel', customerPriority: 'jt.customerPriority', type: 'jt.type' };
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

    // Use a CTE to get distinct ticket keys first, then enrich
    const rows = this.db.prepare(`
      WITH scope AS (
        SELECT DISTINCT jt2.key FROM jira_tickets jt2
        JOIN pr_jira_keys pjk ON pjk.jiraKey = jt2.key
        JOIN github_prs gp ON gp.repo = pjk.repo AND gp.prNumber = pjk.prNumber
        ${where.replace(/jt\./g, 'jt2.')}
      )
      SELECT jt.* ${TicketStore.ENRICH_COLUMNS} FROM jira_tickets jt
      JOIN scope ON scope.key = jt.key
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset);

    const hasMore = rows.length > limit;
    const tickets = rows.slice(0, limit).map(enrichedTicketFromRow);

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

  // ── Release-scoped queries (Home page) ────────────

  /**
   * Get tickets that belong to immediate releases (overdue, upcoming, unscheduled).
   * Everything done in SQL — no JS iteration over releases.
   *
   * @param {object} opts
   * @param {string} opts.today - ISO date string
   * @param {string} opts.horizon - ISO date string (e.g., 14 days from now)
   * @param {string} [opts.view] - 'dev'|'qa'|'pm' for person filter
   * @param {string} [opts.person] - person name to filter by
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   * @param {string} [opts.sort]
   * @param {string} [opts.sortDir]
   */
  getForImmediateReleases(opts = {}) {
    const today = opts.today || new Date().toISOString().slice(0, 10);
    const horizon = opts.horizon || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    // Build WHERE conditions for ticket-level filters
    const ticketConditions = [];
    const ticketParams = [];

    if (opts.person && opts.view) {
      const pLower = opts.person.toLowerCase();
      if (opts.view === 'dev') {
        ticketConditions.push('LOWER(jt.assignee) = ?');
        ticketParams.push(pLower);
      } else if (opts.view === 'qa') {
        ticketConditions.push('LOWER(jt.qaAssignee) = ?');
        ticketParams.push(pLower);
      } else if (opts.view === 'pm') {
        ticketConditions.push('(LOWER(jt.assignee) = ? OR LOWER(jt.qaAssignee) = ?)');
        ticketParams.push(pLower, pLower);
      }
    }

    const ticketWhere = ticketConditions.length > 0 ? 'AND ' + ticketConditions.join(' AND ') : '';

    const SORT_COLS = { key: 'jt.key', summary: 'jt.summary', status: 'jt.status', assignee: 'jt.assignee', priority: 'jt.priority', created: 'jt.created', type: 'jt.type' };
    const sortCol = SORT_COLS[opts.sort] || 'jt.created';
    const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';

    // CTE: find tickets in immediate releases via json_each join
    const sql = `
      WITH immediate_versions AS (
        SELECT version FROM releases
        WHERE state != 'done' AND (jiraArchived IS NULL OR jiraArchived = 0)
        AND (jiraReleaseDate IS NULL OR jiraReleaseDate < ? OR jiraReleaseDate <= ?)
      ),
      immediate_tickets AS (
        SELECT DISTINCT jt.key FROM jira_tickets jt, json_each(jt.fixVersions) fv
        WHERE fv.value IN (SELECT version FROM immediate_versions)
        UNION
        SELECT DISTINCT jt.key FROM jira_tickets jt, json_each(jt.targetFixVersions) tv
        WHERE tv.value IN (SELECT version FROM immediate_versions)
      )
      SELECT jt.* ${TicketStore.ENRICH_COLUMNS}
      FROM jira_tickets jt
      JOIN immediate_tickets it ON it.key = jt.key
      WHERE 1=1 ${ticketWhere}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(sql).all(today, horizon, ...ticketParams, limit + 1, offset);
    const hasMore = rows.length > limit;

    // Get immediate version set for marking isImmediate on releases
    const immediateVersions = new Set(
      this.db.prepare(`
        SELECT version FROM releases
        WHERE state != 'done' AND (jiraArchived IS NULL OR jiraArchived = 0)
        AND (jiraReleaseDate IS NULL OR jiraReleaseDate < ? OR jiraReleaseDate <= ?)
      `).all(today, horizon).map(r => r.version)
    );

    const tickets = rows.slice(0, limit).map(row => {
      const ticket = enrichedTicketFromRow(row);
      // Mark which releases are "immediate" (in the current horizon)
      for (const r of ticket.releases) {
        r.isImmediate = immediateVersions.has(r.version);
      }
      return ticket;
    });

    // Default sort: most urgent release date first (overdue → upcoming → unscheduled)
    if (!opts.sort) {
      tickets.sort((a, b) => {
        const aNext = (a.releases || []).find(r => !r.isShipped);
        const bNext = (b.releases || []).find(r => !r.isShipped);
        const aDate = aNext?.jiraReleaseDate || 'zzzz';
        const bDate = bNext?.jiraReleaseDate || 'zzzz';
        return aDate.localeCompare(bDate);
      });
    }

    const countSql = `
      WITH immediate_versions AS (
        SELECT version FROM releases
        WHERE state != 'done' AND (jiraArchived IS NULL OR jiraArchived = 0)
        AND (jiraReleaseDate IS NULL OR jiraReleaseDate < ? OR jiraReleaseDate <= ?)
      ),
      immediate_tickets AS (
        SELECT DISTINCT jt.key FROM jira_tickets jt, json_each(jt.fixVersions) fv
        WHERE fv.value IN (SELECT version FROM immediate_versions)
        UNION
        SELECT DISTINCT jt.key FROM jira_tickets jt, json_each(jt.targetFixVersions) tv
        WHERE tv.value IN (SELECT version FROM immediate_versions)
      )
      SELECT COUNT(*) AS n FROM jira_tickets jt
      JOIN immediate_tickets it ON it.key = jt.key
      WHERE 1=1 ${ticketWhere}
    `;
    const total = this.db.prepare(countSql).get(today, horizon, ...ticketParams).n;

    // Release columns for filter chips
    const releaseColumns = this.db.prepare(`
      SELECT repo, version, state, jiraReleaseDate FROM releases
      WHERE state != 'done' AND (jiraArchived IS NULL OR jiraArchived = 0)
      AND (jiraReleaseDate IS NULL OR jiraReleaseDate < ? OR jiraReleaseDate <= ?)
      ORDER BY COALESCE(jiraReleaseDate, 'zzzz') ASC
    `).all(today, horizon);

    return { tickets, total, hasMore, offset, limit, releases: releaseColumns };
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

  // ── Truth persistence (ticket_truth table) ────────

  /**
   * Upsert truth for a ticket in a release.
   * @param {string} jiraKey
   * @param {string} repo
   * @param {string} version
   * @param {object} truthData - { health, healthCategory, healthMessage, onBranch, prNumber, prUrl, stage, inTarget, inFixVersion }
   */
  upsertTruth(jiraKey, repo, version, truthData) {
    this.db.prepare(`
      INSERT INTO ticket_truth (jiraKey, repo, version, health, healthCategory, healthMessage,
                                onBranch, prNumber, prUrl, stage, inTarget, inFixVersion, computedAt)
      VALUES (@jiraKey, @repo, @version, @health, @healthCategory, @healthMessage,
              @onBranch, @prNumber, @prUrl, @stage, @inTarget, @inFixVersion, @computedAt)
      ON CONFLICT(jiraKey, repo, version) DO UPDATE SET
        health         = excluded.health,
        healthCategory = excluded.healthCategory,
        healthMessage  = excluded.healthMessage,
        onBranch       = excluded.onBranch,
        prNumber       = excluded.prNumber,
        prUrl          = excluded.prUrl,
        stage          = excluded.stage,
        inTarget       = excluded.inTarget,
        inFixVersion   = excluded.inFixVersion,
        computedAt     = excluded.computedAt
    `).run({
      jiraKey,
      repo,
      version,
      health: truthData.health,
      healthCategory: truthData.healthCategory,
      healthMessage: truthData.healthMessage || null,
      onBranch: truthData.onBranch ? 1 : 0,
      prNumber: truthData.prNumber || null,
      prUrl: truthData.prUrl || null,
      stage: truthData.stage || null,
      inTarget: truthData.inTarget ? 1 : 0,
      inFixVersion: truthData.inFixVersion ? 1 : 0,
      computedAt: new Date().toISOString(),
    });
  }

  /**
   * Batch upsert truth rows in a transaction.
   * @param {Array<{jiraKey, repo, version, ...truthData}>} rows
   */
  upsertTruthBatch(rows) {
    const stmt = this.db.prepare(`
      INSERT INTO ticket_truth (jiraKey, repo, version, health, healthCategory, healthMessage,
                                onBranch, prNumber, prUrl, stage, inTarget, inFixVersion, computedAt)
      VALUES (@jiraKey, @repo, @version, @health, @healthCategory, @healthMessage,
              @onBranch, @prNumber, @prUrl, @stage, @inTarget, @inFixVersion, @computedAt)
      ON CONFLICT(jiraKey, repo, version) DO UPDATE SET
        health         = excluded.health,
        healthCategory = excluded.healthCategory,
        healthMessage  = excluded.healthMessage,
        onBranch       = excluded.onBranch,
        prNumber       = excluded.prNumber,
        prUrl          = excluded.prUrl,
        stage          = excluded.stage,
        inTarget       = excluded.inTarget,
        inFixVersion   = excluded.inFixVersion,
        computedAt     = excluded.computedAt
    `);

    const run = this.db.transaction((rows) => {
      for (const row of rows) {
        stmt.run({
          jiraKey: row.jiraKey,
          repo: row.repo,
          version: row.version,
          health: row.health,
          healthCategory: row.healthCategory,
          healthMessage: row.healthMessage || null,
          onBranch: row.onBranch ? 1 : 0,
          prNumber: row.prNumber || null,
          prUrl: row.prUrl || null,
          stage: row.stage || null,
          inTarget: row.inTarget ? 1 : 0,
          inFixVersion: row.inFixVersion ? 1 : 0,
          computedAt: row.computedAt || new Date().toISOString(),
        });
      }
    });
    run(rows);
  }

  /**
   * Get truth for multiple tickets at once (batch query).
   * Returns Map<jiraKey, truthRow[]> — avoids N+1 queries when enriching ticket lists.
   * @param {string[]} jiraKeys
   * @returns {Map<string, Array<object>>}
   */
  getTruthForTickets(jiraKeys) {
    const result = new Map();
    if (!jiraKeys || jiraKeys.length === 0) return result;

    // SQLite has a limit on the number of variables in a query (typically 999).
    // Process in chunks of 500 to stay well under the limit.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < jiraKeys.length; i += CHUNK_SIZE) {
      const chunk = jiraKeys.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM ticket_truth WHERE jiraKey IN (${placeholders}) ORDER BY jiraKey ASC, version ASC`
      ).all(...chunk);

      for (const row of rows) {
        const truth = truthFromRow(row);
        if (!result.has(truth.jiraKey)) {
          result.set(truth.jiraKey, []);
        }
        result.get(truth.jiraKey).push(truth);
      }
    }

    return result;
  }

  /**
   * Slim truth for home page — only health, healthCategory, version per ticket.
   * Returns Map<jiraKey, { health, healthCategory, version }[]>.
   */
  getTruthForTicketsSlim(jiraKeys) {
    const result = new Map();
    if (!jiraKeys || jiraKeys.length === 0) return result;

    const CHUNK_SIZE = 500;
    for (let i = 0; i < jiraKeys.length; i += CHUNK_SIZE) {
      const chunk = jiraKeys.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT jiraKey, version, health, healthCategory FROM ticket_truth
         WHERE jiraKey IN (${placeholders}) ORDER BY jiraKey ASC, version ASC`
      ).all(...chunk);

      for (const row of rows) {
        if (!result.has(row.jiraKey)) result.set(row.jiraKey, []);
        result.get(row.jiraKey).push({
          version: row.version,
          health: row.health,
          healthCategory: row.healthCategory,
        });
      }
    }

    return result;
  }

  /**
   * Get truth for a specific ticket across all releases.
   * @param {string} jiraKey
   * @returns {Array<object>}
   */
  getTruthForTicket(jiraKey) {
    return this.db.prepare(
      'SELECT * FROM ticket_truth WHERE jiraKey = ? ORDER BY version ASC'
    ).all(jiraKey).map(truthFromRow);
  }

  /**
   * Get truth for all tickets in a release.
   * @param {string} repo
   * @param {string} version
   * @returns {Array<object>}
   */
  getTruthForRelease(repo, version) {
    return this.db.prepare(
      'SELECT * FROM ticket_truth WHERE repo = ? AND version = ? ORDER BY jiraKey ASC'
    ).all(repo, version).map(truthFromRow);
  }

  /**
   * Get truth rollup for a release (counts by healthCategory).
   * @param {string} repo
   * @param {string} version
   * @returns {{ done: number, inQa: number, awaitingCp: number, inDev: number, attention: number, rogue: number }}
   */
  getTruthRollup(repo, version) {
    const rows = this.db.prepare(`
      SELECT healthCategory, COUNT(*) AS n
      FROM ticket_truth WHERE repo = ? AND version = ?
      GROUP BY healthCategory
    `).all(repo, version);

    const rollup = { done: 0, inQa: 0, awaitingCp: 0, inDev: 0, attention: 0, rogue: 0 };
    for (const row of rows) {
      switch (row.healthCategory) {
        case 'done': rollup.done = row.n; break;
        case 'in-qa': rollup.inQa = row.n; break;
        case 'awaiting-cp': rollup.awaitingCp = row.n; break;
        case 'in-dev': rollup.inDev = row.n; break;
        case 'attention': rollup.attention = row.n; break;
      }
    }

    // Count rogues separately (health='rogue' in attention category)
    const rogueCount = this.db.prepare(
      "SELECT COUNT(*) AS n FROM ticket_truth WHERE repo = ? AND version = ? AND health = 'rogue'"
    ).get(repo, version).n;
    rollup.rogue = rogueCount;

    return rollup;
  }

  /**
   * Clear truth for a release (before recompute).
   * @param {string} repo
   * @param {string} version
   */
  clearTruthForRelease(repo, version) {
    this.db.prepare(
      'DELETE FROM ticket_truth WHERE repo = ? AND version = ?'
    ).run(repo, version);
  }

  // ── Delivery Forecast ────────────────────────────────

  // NOTE: getDeliveryForecast() has been removed.
  // Delivery forecasting is now handled by VelocityEngine (src/core/velocity-engine.js),
  // which provides per-person simulation, bottleneck detection, and risk assessment.
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

function truthFromRow(row) {
  return {
    jiraKey: row.jiraKey,
    repo: row.repo,
    version: row.version,
    health: row.health,
    healthCategory: row.healthCategory,
    healthMessage: row.healthMessage,
    onBranch: !!row.onBranch,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    stage: row.stage,
    inTarget: !!row.inTarget,
    inFixVersion: !!row.inFixVersion,
    computedAt: row.computedAt,
  };
}

/**
 * Parse an enriched row (with releases_json, prs_json, truth_json columns)
 * into a fully-populated ticket object with releases, prs, truth arrays.
 */
function enrichedTicketFromRow(row) {
  const ticket = ticketFromRow(row);
  const today = new Date().toISOString().slice(0, 10);

  // Parse releases
  const rawReleases = row.releases_json ? JSON.parse(row.releases_json) : [];
  const fixSet = new Set(ticket.fixVersions || []);
  const targetSet = new Set(ticket.targetFixVersions || []);
  ticket.releases = rawReleases
    .filter(r => r.version) // filter out nulls from empty json_group_array
    .map(r => {
      const inFixVersion = fixSet.has(r.version);
      const inTarget = targetSet.has(r.version);
      const isShipped = r.state === 'done' || !!r.jiraReleased;
      const isOverdue = !!r.jiraReleaseDate && r.jiraReleaseDate < today && !isShipped;
      return {
        repo: r.repo,
        version: r.version,
        state: r.state,
        jiraReleaseDate: r.jiraReleaseDate || null,
        isImmediate: false,
        isShipped,
        isOverdue,
        inTarget,
        inFixVersion,
        source: inTarget && inFixVersion ? 'both' : inTarget ? 'target' : 'fixVersion',
      };
    })
    .sort((a, b) => {
      if (a.isShipped !== b.isShipped) return a.isShipped ? 1 : -1;
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      return (a.jiraReleaseDate || 'zzzz').localeCompare(b.jiraReleaseDate || 'zzzz');
    });

  // Parse PRs
  const rawPrs = row.prs_json ? JSON.parse(row.prs_json) : [];
  ticket.prs = rawPrs.filter(p => p.prNumber).map(p => ({
    prNumber: p.prNumber,
    repo: p.repo,
    status: p.status,
    baseBranch: p.baseBranch,
    prUrl: p.prUrl,
  }));

  // Parse truth
  const rawTruth = row.truth_json ? JSON.parse(row.truth_json) : [];
  ticket.truth = rawTruth.filter(t => t.health).map(t => ({
    version: t.version,
    health: t.health,
    healthCategory: t.healthCategory,
    healthMessage: t.healthMessage,
    onBranch: !!t.onBranch,
  }));

  // Add jiraStatus alias
  ticket.jiraStatus = ticket.status || 'Unknown';

  return ticket;
}

module.exports = TicketStore;
