const { EventEmitter } = require('events');
const { getDb } = require('./db');

const MAX_ENTRIES = 5000;

/**
 * Audit trail — records every action on every release.
 * Emits 'entry' on each new audit record for WebSocket broadcasting.
 *
 * Persistence: rows live in the `audit` SQLite table. An in-memory
 * mirror is kept so `audit.entries` stays an array for consumers that
 * iterate or mutate it directly (many tests, release-truth, etc.).
 *
 * Assignment `audit.entries = [...]` is supported: it replaces both the
 * mirror AND the DB rows, so test teardown semantics are preserved.
 */
class Audit extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db]
   */
  constructor(opts = {}) {
    super();
    this._db = opts.db || getDb();
    this._entries = []; // mirror
    this._hasNewColumns = this._checkNewColumns();
    this._load();
  }

  get entries() {
    return this._entries;
  }

  /**
   * Replace the entire entry log. Used by legacy callers (e.g.,
   * release.js legacy loadState) and tests that reset state between runs.
   */
  set entries(next) {
    const arr = Array.isArray(next) ? next : [];
    this._entries = arr;
    this._replaceAll(arr);
  }

  /**
   * Record an audit entry.
   * @param {string} version - Release version (e.g., '4.2.1')
   * @param {string} action - What happened (e.g., 'state:transition', 'cherry-pick:added')
   * @param {object} detail - Action-specific data
   * @param {string|null} user - Who did it (null = system)
   */
  record(version, action, detail = {}, user = null) {
    const entry = {
      id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      version,
      action,
      detail,
      user,
      at: new Date().toISOString(),
    };
    this._entries.push(entry);
    this._insert(entry);
    this.emit('entry', entry);
    return entry;
  }

  /**
   * Get audit entries for a specific release.
   * Queries the DB directly for efficiency (avoids loading all entries into memory).
   */
  forRelease(version) {
    try {
      const rows = this._db.prepare('SELECT * FROM audit WHERE version = ? ORDER BY at ASC, rowid ASC').all(version);
      return rows.map(r => ({
        id: r.id,
        version: r.version,
        action: r.action,
        detail: safeParse(r.detail, {}),
        user: r.user,
        at: r.at,
      }));
    } catch {
      return this._entries.filter(e => e.version === version);
    }
  }

  /**
   * Serialize for state persistence. Kept for backwards compat with
   * callers that expect a trimmed array of entries.
   */
  toJSON() {
    // Keep last 5000 entries to avoid unbounded growth
    return this._entries.slice(-MAX_ENTRIES);
  }

  /**
   * Restore from persisted state. Kept for backwards compat — the
   * SQLite-backed ReleaseManager no longer calls this, but legacy JSON
   * migration uses it to seed the store.
   */
  loadState(entries) {
    this.entries = entries; // goes through setter
  }

  // ── Internal ────────────────────────────────────────────

  _insert(entry) {
    const detail = entry.detail || {};
    const params = {
      id: entry.id,
      version: entry.version ?? null,
      action: entry.action,
      detail: JSON.stringify(detail),
      user: entry.user ?? null,
      at: entry.at,
    };

    if (this._hasNewColumns) {
      this._db.prepare(`
        INSERT INTO audit (id, version, action, detail, user, at, resource, capability)
        VALUES (@id, @version, @action, @detail, @user, @at, @resource, @capability)
      `).run({
        ...params,
        resource: detail.resource || entry.resource || null,
        capability: detail.capability || entry.capability || null,
      });
    } else {
      this._db.prepare(`
        INSERT INTO audit (id, version, action, detail, user, at)
        VALUES (@id, @version, @action, @detail, @user, @at)
      `).run(params);
    }
  }

  _checkNewColumns() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(audit)').all();
      return cols.some(c => c.name === 'resource');
    } catch {
      return false;
    }
  }

  _replaceAll(entries) {
    const tx = this._db.transaction((arr) => {
      this._db.prepare('DELETE FROM audit').run();
      const stmt = this._db.prepare(`
        INSERT INTO audit (id, version, action, detail, user, at)
        VALUES (@id, @version, @action, @detail, @user, @at)
      `);
      for (const e of arr) {
        if (!e || !e.id) continue;
        stmt.run({
          id: e.id,
          version: e.version ?? null,
          action: e.action || '',
          detail: JSON.stringify(e.detail || {}),
          user: e.user ?? null,
          at: e.at || new Date().toISOString(),
        });
      }
    });
    tx(entries);
  }

  _load() {
    try {
      const rows = this._db.prepare('SELECT * FROM audit ORDER BY at ASC, rowid ASC').all();
      this._entries = rows.map(r => ({
        id: r.id,
        version: r.version,
        action: r.action,
        detail: safeParse(r.detail, {}),
        user: r.user,
        at: r.at,
      }));
    } catch {
      this._entries = [];
    }
  }
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

Audit.MAX_ENTRIES = MAX_ENTRIES;

module.exports = Audit;
