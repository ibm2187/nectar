const { EventEmitter } = require('events');
const log = require('./log');
const { getDb } = require('./db');

// ── State machine definition ────────────────────────────────────────────────

const STATES = ['planning', 'cutting', 'stabilizing', 'approved', 'deploying', 'done'];

const TRANSITIONS = {
  planning:    ['cutting'],
  cutting:     ['stabilizing'],
  stabilizing: ['approved'],
  approved:    ['deploying'],
  deploying:   ['done', 'stabilizing'], // can regress on deploy failure
  done:        [],
};

// Fields that the `update` method is allowed to touch.
const UPDATABLE_FIELDS = ['branch', 'cutFrom', 'cutBy', 'ci', 'risk', 'notes', 'presentationUrl'];

// Fields that are first-class columns in the `releases` table.
// Anything outside this set (that we also preserve on load) is stashed in `extra`.
const KNOWN_COLUMNS = [
  'id','repo','version','state','branch','cutFrom','cutAt','cutBy',
  'cherryPicks','ci','risk','comments','deployments','approvals',
  'notes','presentationUrl',
  'jiraVersionId','jiraVersionName','jiraReleased','jiraReleaseDate','jiraArchived',
  'createdAt','updatedAt',
];

const JSON_COLUMNS = ['cherryPicks','ci','risk','comments','deployments','approvals'];

// ── Release factory ─────────────────────────────────────────────────────────

function createRelease({ repo, version, branch, cutFrom, cutBy }) {
  return {
    id: repo ? `rel-${repo}-${version}` : `rel-${version}`,
    repo: repo || null,
    version,
    state: 'planning',
    // branch is null until discovery confirms one exists in the repo
    branch: branch || null,
    cutFrom: cutFrom || null,
    cutAt: null,
    cutBy: cutBy || null,

    cherryPicks: [],

    ci: { status: null, buildUrl: null, lastRun: null },
    risk: { score: null, numericScore: null, factors: [] },

    comments: [],
    deployments: [],
    approvals: [],
    notes: null,

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── ReleaseManager ──────────────────────────────────────────────────────────

/**
 * Manages all releases: CRUD, state transitions, persistence.
 * Extends EventEmitter for loose coupling with WebSocket/Slack/etc.
 *
 * Persistence: rows live in the `releases` SQLite table. An in-memory
 * Map mirrors the DB for fast lookups; every mutation writes through.
 *
 * Events emitted:
 *   release:created   (release)
 *   release:updated   (release, changes)
 *   release:transition (release, { from, to })
 *   release:deleted   (version)
 *   cherry-pick:added (release, cherryPick)
 *   approval:added   (release, approval)
 *   deployment:added  (release, deployment)
 *   deployment:updated (release, deployment)
 *   comment:added    (release, comment)
 *   comment:deleted  (release, commentId)
 */
class ReleaseManager extends EventEmitter {
  /**
   * @param {Audit} audit
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db]
   */
  constructor(audit, opts = {}) {
    super();
    this.db = opts.db || getDb();
    this.releases = new Map(); // id → release object
    this.audit = audit;
    this._ticketStore = null;
    this._loadState();
  }

  /**
   * Set the TicketStore for normalized ticket queries.
   * When set, getTickets() reads from TicketStore instead of release.tickets[].
   */
  setTicketStore(ticketStore) {
    this._ticketStore = ticketStore || null;
  }

  /**
   * Get tickets for a release. Queries the normalized TicketStore.
   * Returns tickets in the standard format with jiraStatus, state, etc.
   */
  getTickets(release) {
    if (this._ticketStore) {
      return this._ticketStore.getForVersion(release.version).map(t => ({
        key: t.key,
        summary: t.summary || '',
        state: t.state || 'pending',
        jiraStatus: t.status || 'Unknown',
        type: t.type || null,
        assignee: t.assignee || null,
        reporter: t.reporter || null,
        qaAssignee: t.qaAssignee || null,
        productAssignee: t.productAssignee || null,
        fixVersions: t.fixVersions || [],
        targetFixVersions: t.targetFixVersions || [],
        component: t.component || null,
        module: t.module || null,
        product: t.product || [],
        projects: t.projects || [],
        labels: t.labels || [],
        customerTags: t.customerTags || [],
        deployedEnvironments: t.deployedEnvironments || [],
        priority: t.priority || null,
        riskLevel: t.riskLevel || null,
        customerPriority: t.customerPriority || null,
        zohoRef: t.zohoRef || null,
        source: 'jira',
        _releaseSource: t._releaseSource || null,
      }));
    }
    return [];
  }

  // ── Key helpers ─────────────────────────────────────────

  /** Build the map key for a release. Repo-scoped if repo provided. */
  _key(repo, version) {
    return repo ? `${repo}:${version}` : version;
  }

  // ── Queries ─────────────────────────────────────────────

  list(filter = {}) {
    let results = Array.from(this.releases.values());
    if (filter.repo) results = results.filter(r => r.repo === filter.repo);
    if (filter.state) results = results.filter(r => r.state === filter.state);
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(version, repo = null) {
    // Try repo-scoped key first, then plain version for backward compat
    if (repo) return this.releases.get(this._key(repo, version)) || null;
    return this.releases.get(version) || this._findByVersion(version);
  }

  _findByVersion(version) {
    for (const r of this.releases.values()) {
      if (r.version === version) return r;
    }
    return null;
  }

  getByState(state) {
    return this.list().filter(r => r.state === state);
  }

  active() {
    return this.list().filter(r => r.state !== 'done');
  }

  // ── Create ──────────────────────────────────────────────

  create({ repo, version, branch, cutFrom, cutBy }) {
    const key = this._key(repo, version);
    if (this.releases.has(key)) {
      throw new Error(`Release ${repo ? repo + ':' : ''}${version} already exists`);
    }
    const release = createRelease({ repo, version, branch, cutFrom, cutBy });
    this.releases.set(key, release);
    this._upsertRow(key, release);

    this.audit.record(version, 'release:created', {
      branch: release.branch, cutFrom, cutBy,
    }, cutBy);

    this.emit('release:created', release);
    return release;
  }

  // ── State transitions ───────────────────────────────────

  transition(version, toState, user = null) {
    const release = this._getOrThrow(version);
    const from = release.state;

    if (!TRANSITIONS[from].includes(toState)) {
      throw new Error(
        `Invalid transition: ${from} → ${toState}. ` +
        `Allowed: ${TRANSITIONS[from].join(', ') || 'none'}`
      );
    }

    release.state = toState;
    release.updatedAt = new Date().toISOString();

    // Set cutAt when entering 'cutting'
    if (toState === 'cutting' && !release.cutAt) {
      release.cutAt = release.updatedAt;
    }

    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'state:transition', { from, to: toState }, user);
    this.emit('release:transition', release, { from, to: toState, user });
    return release;
  }

  // ── Update fields ───────────────────────────────────────

  update(version, changes, user = null) {
    const release = this._getOrThrow(version);

    // Only allow updating safe fields
    const applied = {};
    for (const key of UPDATABLE_FIELDS) {
      if (key in changes) {
        release[key] = changes[key];
        applied[key] = changes[key];
      }
    }

    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'release:updated', applied, user);
    this.emit('release:updated', release, applied);
    return release;
  }

  // ── Tickets ─────────────────────────────────────────────

  addTicket(version, ticket, user = null) {
    const release = this._getOrThrow(version);
    if (!this._ticketStore) throw new Error('TicketStore not configured');

    const existing = this._ticketStore.get(ticket.key);
    const releaseVersion = release.version;
    const data = {
      ...ticket,
      summary: ticket.summary || '',
      state: ticket.state || 'pending',
      status: ticket.jiraStatus || ticket.status || 'Unknown',
      statusCategory: ticket.statusCategory || null,
      fixVersions: Array.isArray(ticket.fixVersions) ? ticket.fixVersions : (existing ? existing.fixVersions : []),
      targetFixVersions: Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : (existing ? existing.targetFixVersions : []),
      syncedAt: new Date().toISOString(),
    };
    // Ensure the release version is in fixVersions
    if (!data.fixVersions.includes(releaseVersion)) {
      data.fixVersions = [...data.fixVersions, releaseVersion];
    }
    this._ticketStore.upsert(data);

    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'ticket:added', { key: ticket.key }, user);
    this.emit('release:updated', release, { tickets: this.getTickets(release) });
    return release;
  }

  removeTicket(version, ticketKey, user = null) {
    const release = this._getOrThrow(version);
    if (!this._ticketStore) throw new Error('TicketStore not configured');

    const ticket = this._ticketStore.get(ticketKey);
    if (ticket) {
      ticket.fixVersions = (ticket.fixVersions || []).filter(v => v !== release.version);
      ticket.targetFixVersions = (ticket.targetFixVersions || []).filter(v => v !== release.version);
      this._ticketStore.upsert(ticket);
    }

    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'ticket:removed', { key: ticketKey }, user);
    this.emit('release:updated', release, { tickets: this.getTickets(release) });
    return release;
  }

  // ── Cherry-picks ────────────────────────────────────────

  addCherryPick(version, cp, user = null) {
    const release = this._getOrThrow(version);
    const existing = release.cherryPicks.find(c => c.sha === cp.sha);
    if (existing) {
      Object.assign(existing, cp);
    } else {
      release.cherryPicks.push({
        sha: cp.sha,
        pr: cp.pr || null,
        ticket: cp.ticket || null,
        status: cp.status || 'pending',
      });
    }

    // NOTE: We no longer update the global ticket state here.
    // Cherry-pick status is per-release, stored in ticket_truth table.
    // The global jira_tickets.state reflects the JIRA workflow status
    // and should only be updated by JIRA sync or webhook.

    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'cherry-pick:added', {
      sha: cp.sha, ticket: cp.ticket, status: cp.status,
    }, user);
    this.emit('cherry-pick:added', release, cp);
    return release;
  }

  // ── Approvals ───────────────────────────────────────────

  addApproval(version, approval) {
    const release = this._getOrThrow(version);
    // Replace existing approval from same role
    release.approvals = release.approvals.filter(a => a.role !== approval.role);
    const record = {
      user: approval.user,
      role: approval.role,
      at: new Date().toISOString(),
    };
    release.approvals.push(record);

    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'approval:added', record, approval.user);
    this.emit('approval:added', release, record);
    return release;
  }

  // ── Comments ────────────────────────────────────────────

  addComment(version, { text, user }) {
    const release = this._getOrThrow(version);
    const comment = {
      id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      user: user || 'anonymous',
      createdAt: new Date().toISOString(),
    };
    if (!release.comments) release.comments = [];
    release.comments.push(comment);
    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'comment:added', { commentId: comment.id }, user);
    this.emit('comment:added', release, comment);
    return comment;
  }

  deleteComment(version, commentId, user) {
    const release = this._getOrThrow(version);
    if (!release.comments) release.comments = [];
    const idx = release.comments.findIndex(c => c.id === commentId);
    if (idx === -1) throw new Error(`Comment ${commentId} not found`);
    // Authorization (author vs admin) is handled by the API layer
    release.comments.splice(idx, 1);
    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    this.audit.record(version, 'comment:deleted', { commentId }, user);
    this.emit('comment:deleted', release, commentId);
    return { ok: true };
  }

  // ── Deployments ─────────────────────────────────────────

  addDeployment(version, deployment, user = null) {
    const release = this._getOrThrow(version);
    const existing = release.deployments.find(
      d => d.customer === deployment.customer && d.env === deployment.env
    );
    if (existing) {
      Object.assign(existing, deployment);
      this.audit.record(version, 'deployment:updated', deployment, user);
      this.emit('deployment:updated', release, existing);
    } else {
      const record = {
        customer: deployment.customer,
        env: deployment.env,
        status: deployment.status || 'pending',
        at: deployment.at || new Date().toISOString(),
        triggeredBy: user,
      };
      release.deployments.push(record);
      this.audit.record(version, 'deployment:added', record, user);
      this.emit('deployment:added', release, record);
    }

    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
    return release;
  }

  // ── Delete ──────────────────────────────────────────────

  delete(version, repo = null, user = null) {
    const key = this._key(repo, version);
    let actualKey = null;
    // Try repo-scoped key first, then plain version
    if (this.releases.has(key)) {
      actualKey = key;
    } else if (this.releases.has(version)) {
      actualKey = version;
    } else {
      throw new Error(`Release ${version} not found`);
    }
    this.releases.delete(actualKey);
    this.db.prepare('DELETE FROM releases WHERE key = ?').run(actualKey);
    this.audit.record(version, 'release:deleted', { repo }, user);
    this.emit('release:deleted', version);
  }

  // ── Persistence ─────────────────────────────────────────

  /**
   * Write through a release that was mutated in place.
   * Prefer the typed mutation methods (addTicket, removeTicket, etc.) —
   * this hook exists for external callers (jira-sync) that need to bulk
   * edit release fields and then flush.
   */
  persist(release) {
    if (!release || !release.version) return;
    release.updatedAt = new Date().toISOString();
    this._upsertRow(this._keyOf(release), release);
  }

  /**
   * Backwards-compat no-op — writes are synchronous with SQLite.
   */
  flush() { /* no-op */ }

  // ── Helpers ─────────────────────────────────────────────

  _getOrThrow(version, repo = null) {
    const key = this._key(repo, version);
    const release = this.releases.get(key) || this._findByVersion(version);
    if (!release) throw new Error(`Release ${version} not found`);
    return release;
  }

  _keyOf(release) {
    return this._key(release.repo, release.version);
  }

  _loadState() {
    try {
      const rows = this.db.prepare('SELECT * FROM releases').all();
      for (const row of rows) {
        const release = rowToRelease(row);
        this.releases.set(row.key, release);
      }
      log.info(`Loaded state: ${this.releases.size} releases, ${this.audit.entries.length} audit entries`);
    } catch (err) {
      log.warn(`Failed to load releases: ${err.message}`);
    }
  }

  _upsertRow(key, release) {
    const row = releaseToRow(key, release);
    this.db.prepare(`
      INSERT INTO releases (key, id, repo, version, state, branch, cutFrom, cutAt, cutBy,
                            cherryPicks, ci, risk, comments, deployments, approvals,
                            notes, presentationUrl,
                            jiraVersionId, jiraVersionName, jiraReleased, jiraReleaseDate, jiraArchived,
                            extra, createdAt, updatedAt)
      VALUES (@key, @id, @repo, @version, @state, @branch, @cutFrom, @cutAt, @cutBy,
              @cherryPicks, @ci, @risk, @comments, @deployments, @approvals,
              @notes, @presentationUrl,
              @jiraVersionId, @jiraVersionName, @jiraReleased, @jiraReleaseDate, @jiraArchived,
              @extra, @createdAt, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        id              = excluded.id,
        repo            = excluded.repo,
        version         = excluded.version,
        state           = excluded.state,
        branch          = excluded.branch,
        cutFrom         = excluded.cutFrom,
        cutAt           = excluded.cutAt,
        cutBy           = excluded.cutBy,
        cherryPicks     = excluded.cherryPicks,
        ci              = excluded.ci,
        risk            = excluded.risk,
        comments        = excluded.comments,
        deployments     = excluded.deployments,
        approvals       = excluded.approvals,
        notes           = excluded.notes,
        presentationUrl = excluded.presentationUrl,
        jiraVersionId   = excluded.jiraVersionId,
        jiraVersionName = excluded.jiraVersionName,
        jiraReleased    = excluded.jiraReleased,
        jiraReleaseDate = excluded.jiraReleaseDate,
        jiraArchived    = excluded.jiraArchived,
        extra           = excluded.extra,
        updatedAt       = excluded.updatedAt
    `).run(row);
  }
}

// ── Row ↔ object mapping ────────────────────────────────────────────────────

function releaseToRow(key, release) {
  // Preserve any unknown fields in `extra` so round-trips don't lose data.
  const extra = {};
  for (const k of Object.keys(release)) {
    if (!KNOWN_COLUMNS.includes(k)) extra[k] = release[k];
  }

  return {
    key,
    id: release.id,
    repo: release.repo ?? null,
    version: release.version,
    state: release.state || 'planning',
    branch: release.branch ?? null,
    cutFrom: release.cutFrom ?? null,
    cutAt: release.cutAt ?? null,
    cutBy: release.cutBy ?? null,
    cherryPicks: JSON.stringify(release.cherryPicks || []),
    ci: JSON.stringify(release.ci || {}),
    risk: JSON.stringify(release.risk || {}),
    comments: JSON.stringify(release.comments || []),
    deployments: JSON.stringify(release.deployments || []),
    approvals: JSON.stringify(release.approvals || []),
    notes: release.notes ?? null,
    presentationUrl: release.presentationUrl ?? null,
    jiraVersionId: release.jiraVersionId ?? null,
    jiraVersionName: release.jiraVersionName ?? null,
    jiraReleased: release.jiraReleased == null ? null : (release.jiraReleased ? 1 : 0),
    jiraReleaseDate: release.jiraReleaseDate ?? null,
    jiraArchived: release.jiraArchived == null ? null : (release.jiraArchived ? 1 : 0),
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
  };
}

function rowToRelease(row) {
  const release = {
    id: row.id,
    repo: row.repo,
    version: row.version,
    state: row.state,
    branch: row.branch,
    cutFrom: row.cutFrom,
    cutAt: row.cutAt,
    cutBy: row.cutBy,
    notes: row.notes,
    presentationUrl: row.presentationUrl,
    jiraVersionId: row.jiraVersionId,
    jiraVersionName: row.jiraVersionName,
    jiraReleased: row.jiraReleased == null ? null : !!row.jiraReleased,
    jiraReleaseDate: row.jiraReleaseDate,
    jiraArchived: row.jiraArchived == null ? null : !!row.jiraArchived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  for (const col of JSON_COLUMNS) {
    release[col] = safeParse(row[col], col === 'ci' || col === 'risk' ? {} : []);
  }
  // Spread `extra` fields back onto the object
  if (row.extra) {
    try {
      const extra = JSON.parse(row.extra);
      if (extra && typeof extra === 'object') Object.assign(release, extra);
    } catch { /* ignore malformed */ }
  }
  return release;
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

// Export state constants for API validation
ReleaseManager.STATES = STATES;
ReleaseManager.TRANSITIONS = TRANSITIONS;

module.exports = ReleaseManager;
