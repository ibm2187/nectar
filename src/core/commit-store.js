const { getDb } = require('./db');
const JiraClient = require('../integrations/jira');

/**
 * SQLite-backed store for git commits and their JIRA key mappings.
 *
 * Persists commit data from release branches so truth computation
 * can read from the database instead of running git commands every time.
 *
 * Tables used:
 *   git_commits      — one row per (repo, sha, branch) with metadata
 *   commit_jira_keys — junction table linking commits to JIRA keys
 */
class CommitStore {
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    this._prepareStatements();
  }

  _prepareStatements() {
    this._upsertCommit = this.db.prepare(`
      INSERT INTO git_commits (sha, repo, branch, message, author, authorDate, isPostCut, syncedAt)
      VALUES (@sha, @repo, @branch, @message, @author, @authorDate, @isPostCut, @syncedAt)
      ON CONFLICT(repo, sha, branch) DO UPDATE SET
        message    = excluded.message,
        author     = excluded.author,
        authorDate = excluded.authorDate,
        isPostCut  = excluded.isPostCut,
        syncedAt   = excluded.syncedAt
    `);

    this._insertJiraKey = this.db.prepare(
      'INSERT OR IGNORE INTO commit_jira_keys (repo, sha, jiraKey) VALUES (?, ?, ?)'
    );

    this._deleteCommitsForBranch = this.db.prepare(
      'DELETE FROM git_commits WHERE repo = ? AND branch = ?'
    );

    this._deleteJiraKeysForBranch = this.db.prepare(`
      DELETE FROM commit_jira_keys WHERE repo = ? AND sha IN (
        SELECT sha FROM git_commits WHERE repo = ? AND branch = ?
      )
    `);

    this._getForBranch = this.db.prepare(
      'SELECT * FROM git_commits WHERE repo = ? AND branch = ? ORDER BY syncedAt DESC'
    );

    this._getPostCutForBranch = this.db.prepare(
      'SELECT * FROM git_commits WHERE repo = ? AND branch = ? AND isPostCut = 1 ORDER BY syncedAt DESC'
    );

    this._getForJiraKey = this.db.prepare(`
      SELECT gc.* FROM git_commits gc
      JOIN commit_jira_keys cjk ON cjk.repo = gc.repo AND cjk.sha = gc.sha
      WHERE cjk.jiraKey = ?
      ORDER BY gc.syncedAt DESC
    `);
  }

  /**
   * Sync commits for a branch -- upserts commits and their JIRA key mappings.
   *
   * @param {string} repo - Repository name (e.g., 'webplatform')
   * @param {string} branch - Branch name (e.g., 'releases/4.2.0')
   * @param {Array<{sha: string, message: string, author?: string, authorDate?: string}>} commits
   * @param {boolean} isPostCut - Whether these are post-cut (cherry-pick) commits
   */
  syncBranch(repo, branch, commits, isPostCut = false) {
    const now = new Date().toISOString();

    const run = this.db.transaction((commits) => {
      for (const commit of commits) {
        this._upsertCommit.run({
          sha: commit.sha,
          repo,
          branch,
          message: commit.message || null,
          author: commit.author || null,
          authorDate: commit.authorDate || null,
          isPostCut: isPostCut ? 1 : 0,
          syncedAt: now,
        });

        // Extract JIRA keys from the commit message and store mappings
        const keys = JiraClient.extractKeys(commit.message || '');
        for (const key of keys) {
          this._insertJiraKey.run(repo, commit.sha, key);
        }
      }
    });

    run(commits);
  }

  /**
   * Get all commits on a branch.
   * @param {string} repo
   * @param {string} branch
   * @returns {Array<object>}
   */
  getForBranch(repo, branch) {
    return this._getForBranch.all(repo, branch).map(commitFromRow);
  }

  /**
   * Get post-cut commits (cherry-picks) on a branch.
   * @param {string} repo
   * @param {string} branch
   * @returns {Array<object>}
   */
  getPostCutForBranch(repo, branch) {
    return this._getPostCutForBranch.all(repo, branch).map(commitFromRow);
  }

  /**
   * Get JIRA keys from post-cut commits on a branch.
   * @param {string} repo
   * @param {string} branch
   * @returns {Set<string>}
   */
  getPostCutKeysForBranch(repo, branch) {
    const rows = this.db.prepare(`
      SELECT DISTINCT cjk.jiraKey FROM commit_jira_keys cjk
      JOIN git_commits gc ON gc.repo = cjk.repo AND gc.sha = cjk.sha
      WHERE gc.repo = ? AND gc.branch = ? AND gc.isPostCut = 1
    `).all(repo, branch);
    return new Set(rows.map(r => r.jiraKey));
  }

  /**
   * Get all JIRA keys on a branch.
   * @param {string} repo
   * @param {string} branch
   * @returns {Set<string>}
   */
  getKeysForBranch(repo, branch) {
    const rows = this.db.prepare(`
      SELECT DISTINCT cjk.jiraKey FROM commit_jira_keys cjk
      JOIN git_commits gc ON gc.repo = cjk.repo AND gc.sha = cjk.sha
      WHERE gc.repo = ? AND gc.branch = ?
    `).all(repo, branch);
    return new Set(rows.map(r => r.jiraKey));
  }

  /**
   * Find commits mentioning a JIRA key (across all branches).
   * @param {string} jiraKey
   * @returns {Array<object>}
   */
  getForJiraKey(jiraKey) {
    return this._getForJiraKey.all(jiraKey).map(commitFromRow);
  }

  /**
   * Clear all commits for a branch (before re-sync).
   * Also removes orphaned JIRA key mappings for those commits.
   * @param {string} repo
   * @param {string} branch
   */
  clearBranch(repo, branch) {
    const run = this.db.transaction(() => {
      // Delete JIRA key mappings for commits on this branch
      // Note: a commit SHA may appear on multiple branches; only delete
      // keys for SHAs that are exclusively on this branch.
      this._deleteJiraKeysForBranch.run(repo, repo, branch);
      this._deleteCommitsForBranch.run(repo, branch);
    });
    run();
  }

  /**
   * Get total commit count (for diagnostics).
   */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM git_commits').get().n;
  }
}

// ── Row mapping ─────────────────────────────────────

function commitFromRow(row) {
  return {
    sha: row.sha,
    repo: row.repo,
    branch: row.branch,
    message: row.message,
    author: row.author,
    authorDate: row.authorDate,
    isPostCut: !!row.isPostCut,
    syncedAt: row.syncedAt,
  };
}

module.exports = CommitStore;
