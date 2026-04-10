const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-state.json');

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

    tickets: [],
    cherryPicks: [],

    ci: { status: null, buildUrl: null, lastRun: null },
    risk: { score: null, numericScore: null, factors: [] },

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
 * Events emitted:
 *   release:created   (release)
 *   release:updated   (release, changes)
 *   release:transition (release, { from, to })
 *   release:deleted   (version)
 *   cherry-pick:added (release, cherryPick)
 *   approval:added   (release, approval)
 *   deployment:added  (release, deployment)
 *   deployment:updated (release, deployment)
 */
class ReleaseManager extends EventEmitter {
  constructor(audit) {
    super();
    this.releases = new Map(); // id → release object
    this.audit = audit;
    this._saveTimer = null;
    this._loadState();
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

    this.audit.record(version, 'release:created', {
      branch: release.branch, cutFrom, cutBy,
    }, cutBy);

    this.emit('release:created', release);
    this._debounceSave();
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

    this.audit.record(version, 'state:transition', { from, to: toState }, user);
    this.emit('release:transition', release, { from, to: toState, user });
    this._debounceSave();
    return release;
  }

  // ── Update fields ───────────────────────────────────────

  update(version, changes, user = null) {
    const release = this._getOrThrow(version);

    // Only allow updating safe fields
    const allowed = ['branch', 'cutFrom', 'cutBy', 'ci', 'risk', 'notes'];
    const applied = {};
    for (const key of allowed) {
      if (key in changes) {
        release[key] = changes[key];
        applied[key] = changes[key];
      }
    }

    release.updatedAt = new Date().toISOString();
    this.audit.record(version, 'release:updated', applied, user);
    this.emit('release:updated', release, applied);
    this._debounceSave();
    return release;
  }

  // ── Tickets ─────────────────────────────────────────────

  addTicket(version, ticket, user = null) {
    const release = this._getOrThrow(version);
    const existing = release.tickets.find(t => t.key === ticket.key);
    if (existing) {
      Object.assign(existing, ticket);
    } else {
      release.tickets.push({
        ...ticket,
        summary: ticket.summary || '',
        state: ticket.state || 'pending',
        pr: ticket.pr || null,
      });
    }
    release.updatedAt = new Date().toISOString();
    this.audit.record(version, 'ticket:added', { key: ticket.key }, user);
    this.emit('release:updated', release, { tickets: release.tickets });
    this._debounceSave();
    return release;
  }

  removeTicket(version, ticketKey, user = null) {
    const release = this._getOrThrow(version);
    release.tickets = release.tickets.filter(t => t.key !== ticketKey);
    release.updatedAt = new Date().toISOString();
    this.audit.record(version, 'ticket:removed', { key: ticketKey }, user);
    this.emit('release:updated', release, { tickets: release.tickets });
    this._debounceSave();
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

    // Update matching ticket state
    if (cp.ticket) {
      const ticket = release.tickets.find(t => t.key === cp.ticket);
      if (ticket) {
        ticket.state = cp.status === 'merged' ? 'cherry-picked' : 'in-progress';
        if (cp.pr) ticket.pr = cp.pr;
      }
    }

    release.updatedAt = new Date().toISOString();
    this.audit.record(version, 'cherry-pick:added', {
      sha: cp.sha, ticket: cp.ticket, status: cp.status,
    }, user);
    this.emit('cherry-pick:added', release, cp);
    this._debounceSave();
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
    this.audit.record(version, 'approval:added', record, approval.user);
    this.emit('approval:added', release, record);
    this._debounceSave();
    return release;
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
    this._debounceSave();
    return release;
  }

  // ── Delete ──────────────────────────────────────────────

  delete(version, repo = null, user = null) {
    const key = this._key(repo, version);
    // Try repo-scoped key first, then plain version
    if (this.releases.has(key)) {
      this.releases.delete(key);
    } else if (this.releases.has(version)) {
      this.releases.delete(version);
    } else {
      throw new Error(`Release ${version} not found`);
    }
    this.audit.record(version, 'release:deleted', { repo }, user);
    this.emit('release:deleted', version);
    this._debounceSave();
  }

  // ── Persistence (mirrors Hive's .hive-state.json pattern) ─────────────

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

      if (Array.isArray(data.releases)) {
        for (const r of data.releases) {
          const key = this._key(r.repo, r.version);
          this.releases.set(key, r);
        }
      }

      if (Array.isArray(data.audit)) {
        this.audit.loadState(data.audit);
      }

      log.info(`Loaded state: ${this.releases.size} releases, ${this.audit.entries.length} audit entries`);
    } catch {
      // No state file yet — that's fine
    }
  }

  _saveState() {
    const data = {
      releases: Array.from(this.releases.values()),
      audit: this.audit.toJSON(),
      savedAt: new Date().toISOString(),
    };
    try {
      const json = JSON.stringify(data, null, 2);
      const tmpFile = STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, STATE_FILE);
    } catch (err) {
      log.error('Failed to save state:', err.message);
      // Clean up tmp file if rename failed
      try { fs.unlinkSync(STATE_FILE + '.tmp'); } catch { /* ok */ }
    }
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveState();
    }, 5000);
  }

  /** Force immediate save (for shutdown). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveState();
  }

  // ── Helpers ─────────────────────────────────────────────

  _getOrThrow(version, repo = null) {
    const key = this._key(repo, version);
    const release = this.releases.get(key) || this._findByVersion(version);
    if (!release) throw new Error(`Release ${version} not found`);
    return release;
  }
}

// Export state constants for API validation
ReleaseManager.STATES = STATES;
ReleaseManager.TRANSITIONS = TRANSITIONS;

module.exports = ReleaseManager;
