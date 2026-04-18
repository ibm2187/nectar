const { EventEmitter } = require('events');
const { getDb } = require('./db');

/**
 * Normalized GitHub PR database.
 *
 * Persists PRs to SQLite with a junction table (pr_jira_keys) linking
 * PRs to JIRA tickets. Replaces the volatile in-memory _prCache and
 * the prsByJiraKey blob written onto releases each sync cycle.
 *
 * SQLite-only — no in-memory Map. With 500-2000 PRs and proper indexes,
 * all lookups run in sub-millisecond.
 *
 * Events:
 *   prs:synced ({ total, upserted, durationMs })
 */
class PrStore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.db = opts.db || getDb();
    this._prepareStatements();
  }

  _prepareStatements() {
    this._upsertPr = this.db.prepare(`
      INSERT INTO github_prs (
        prNumber, repo, prTitle, prAuthor, prUrl, status,
        baseBranch, headBranch, prCreatedAt, prUpdatedAt, syncedAt
      ) VALUES (
        @prNumber, @repo, @prTitle, @prAuthor, @prUrl, @status,
        @baseBranch, @headBranch, @prCreatedAt, @prUpdatedAt, @syncedAt
      )
      ON CONFLICT(repo, prNumber) DO UPDATE SET
        prTitle = excluded.prTitle,
        prAuthor = excluded.prAuthor,
        prUrl = excluded.prUrl,
        status = excluded.status,
        baseBranch = excluded.baseBranch,
        headBranch = excluded.headBranch,
        prCreatedAt = excluded.prCreatedAt,
        prUpdatedAt = excluded.prUpdatedAt,
        syncedAt = excluded.syncedAt
    `);

    this._deleteJiraKeys = this.db.prepare(
      'DELETE FROM pr_jira_keys WHERE repo = ? AND prNumber = ?'
    );
    this._insertJiraKey = this.db.prepare(
      'INSERT OR IGNORE INTO pr_jira_keys (repo, prNumber, jiraKey) VALUES (?, ?, ?)'
    );

    this._getPr = this.db.prepare('SELECT * FROM github_prs WHERE repo = ? AND prNumber = ?');
    this._countPrs = this.db.prepare('SELECT COUNT(*) AS n FROM github_prs');
  }

  // ── Core CRUD ─────────────────────────────────────

  upsert(pr, jiraKeys = []) {
    this._upsertPr.run(prToRow(pr));
    this._deleteJiraKeys.run(pr.repo, pr.prNumber);
    for (const key of jiraKeys) {
      this._insertJiraKey.run(pr.repo, pr.prNumber, key);
    }
  }

  upsertBatch(prsWithKeys) {
    const run = this.db.transaction((items) => {
      for (const { pr, jiraKeys } of items) {
        this._upsertPr.run(prToRow(pr));
        this._deleteJiraKeys.run(pr.repo, pr.prNumber);
        for (const key of jiraKeys) {
          this._insertJiraKey.run(pr.repo, pr.prNumber, key);
        }
      }
    });
    run(prsWithKeys);
  }

  get(repo, prNumber) {
    const row = this._getPr.get(repo, prNumber);
    if (!row) return null;
    const pr = prFromRow(row);
    pr.jiraKeys = this._getJiraKeysForPr(repo, prNumber);
    return pr;
  }

  count() {
    return this._countPrs.get().n;
  }

  // ── Indexed lookups ───────────────────────────────

  /**
   * Find the best PR for a branch (replaces _prByBranch Map).
   * Prefers open PRs; tiebreaks by highest prNumber.
   */
  findByBranch(headBranch) {
    if (!headBranch) return null;
    const row = this.db.prepare(`
      SELECT * FROM github_prs
      WHERE headBranch = ?
      ORDER BY
        CASE status WHEN 'open' THEN 0 ELSE 1 END,
        prNumber DESC
      LIMIT 1
    `).get(headBranch);
    return row ? prFromRow(row) : null;
  }

  /**
   * Find all PRs for a JIRA key (replaces _prCache.get(key)).
   */
  findByJiraKey(jiraKey) {
    const rows = this.db.prepare(`
      SELECT p.* FROM github_prs p
      JOIN pr_jira_keys j ON j.repo = p.repo AND j.prNumber = p.prNumber
      WHERE j.jiraKey = ?
      ORDER BY p.prUpdatedAt DESC
    `).all(jiraKey);
    return rows.map(prFromRow);
  }

  /**
   * Batch lookup: find PRs for multiple JIRA keys.
   * Returns Map<jiraKey, PR[]>.
   */
  findByJiraKeys(jiraKeys) {
    if (!jiraKeys || jiraKeys.length === 0) return new Map();

    const result = new Map();
    // Use a temp table approach for large batches, simple loop for small
    for (const key of jiraKeys) {
      const prs = this.findByJiraKey(key);
      if (prs.length > 0) result.set(key, prs);
    }
    return result;
  }

  // ── Search / filter ───────────────────────────────

  search(query, opts = {}) {
    const limit = opts.limit || 50;
    const offset = opts.offset || 0;
    const pattern = `%${query}%`;

    const rows = this.db.prepare(`
      SELECT * FROM github_prs
      WHERE prTitle LIKE ? OR prAuthor LIKE ? OR CAST(prNumber AS TEXT) LIKE ?
      ORDER BY prUpdatedAt DESC
      LIMIT ? OFFSET ?
    `).all(pattern, pattern, pattern, limit + 1, offset);

    const hasMore = rows.length > limit;
    const prs = rows.slice(0, limit).map(prFromRow);

    const total = this.db.prepare(`
      SELECT COUNT(*) AS n FROM github_prs
      WHERE prTitle LIKE ? OR prAuthor LIKE ? OR CAST(prNumber AS TEXT) LIKE ?
    `).get(pattern, pattern, pattern).n;

    return { prs, total, hasMore };
  }

  getByFilter(opts = {}) {
    const conditions = [];
    const params = [];

    if (opts.repo) { conditions.push('repo = ?'); params.push(opts.repo); }
    if (opts.status) { conditions.push('status = ?'); params.push(opts.status); }
    if (opts.author) { conditions.push('prAuthor = ?'); params.push(opts.author); }
    if (opts.since) { conditions.push('prUpdatedAt >= ?'); params.push(opts.since); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = opts.limit || 100;
    const offset = opts.offset || 0;

    const rows = this.db.prepare(
      `SELECT * FROM github_prs ${where} ORDER BY prUpdatedAt DESC LIMIT ? OFFSET ?`
    ).all(...params, limit + 1, offset);

    const hasMore = rows.length > limit;
    const prs = rows.slice(0, limit).map(prFromRow);

    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM github_prs ${where}`
    ).get(...params).n;

    return { prs, total, hasMore };
  }

  // ── Sync metadata ─────────────────────────────────

  getSyncMeta() {
    const row = this.db.prepare('SELECT * FROM pr_sync_meta WHERE id = 1').get();
    if (!row) return { lastSyncTime: null, totalPrsSynced: 0, lastSyncDurationMs: null, lastSyncError: null };
    return {
      lastSyncTime: row.lastSyncTime || null,
      totalPrsSynced: row.totalPrsSynced || 0,
      lastSyncDurationMs: row.lastSyncDurationMs || null,
      lastSyncError: row.lastSyncError || null,
    };
  }

  updateSyncMeta(data) {
    const meta = this.getSyncMeta();
    const merged = { ...meta, ...data, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      INSERT INTO pr_sync_meta (id, lastSyncTime, totalPrsSynced, lastSyncDurationMs, lastSyncError, updatedAt)
      VALUES (1, @lastSyncTime, @totalPrsSynced, @lastSyncDurationMs, @lastSyncError, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        lastSyncTime = excluded.lastSyncTime,
        totalPrsSynced = excluded.totalPrsSynced,
        lastSyncDurationMs = excluded.lastSyncDurationMs,
        lastSyncError = excluded.lastSyncError,
        updatedAt = excluded.updatedAt
    `).run(merged);
  }

  // ── Helpers ───────────────────────────────────────

  _getJiraKeysForPr(repo, prNumber) {
    return this.db.prepare(
      'SELECT jiraKey FROM pr_jira_keys WHERE repo = ? AND prNumber = ?'
    ).all(repo, prNumber).map(r => r.jiraKey);
  }

  flush() { /* no-op */ }
}

// ── Row mapping ─────────────────────────────────────

function prToRow(pr) {
  return {
    prNumber: pr.prNumber,
    repo: pr.repo,
    prTitle: pr.prTitle || null,
    prAuthor: pr.prAuthor || null,
    prUrl: pr.prUrl || null,
    status: pr.status || 'open',
    baseBranch: pr.baseBranch || null,
    headBranch: pr.headBranch || null,
    prCreatedAt: pr.prCreatedAt || null,
    prUpdatedAt: pr.prUpdatedAt || null,
    syncedAt: pr.syncedAt || new Date().toISOString(),
  };
}

function prFromRow(row) {
  return {
    prNumber: row.prNumber,
    repo: row.repo,
    prTitle: row.prTitle,
    prAuthor: row.prAuthor,
    prUrl: row.prUrl,
    status: row.status,
    baseBranch: row.baseBranch,
    headBranch: row.headBranch,
    prCreatedAt: row.prCreatedAt,
    prUpdatedAt: row.prUpdatedAt,
    syncedAt: row.syncedAt,
  };
}

module.exports = PrStore;
