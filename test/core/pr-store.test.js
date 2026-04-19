import { describe, it, expect, beforeEach } from 'vitest';

const PrStore = require('../../src/core/pr-store');
const { createTestDb } = require('../../src/core/db');

function makePr(overrides = {}) {
  return {
    prNumber: 25500,
    repo: 'mavencare/webplatform',
    prTitle: 'Fix DEV-1234: login timeout',
    prAuthor: 'alice',
    prUrl: 'https://github.com/mavencare/webplatform/pull/25500',
    status: 'open',
    baseBranch: 'main',
    headBranch: 'fix/login-timeout',
    prCreatedAt: '2026-04-10T08:00:00Z',
    prUpdatedAt: '2026-04-16T14:00:00Z',
    syncedAt: '2026-04-16T15:00:00Z',
    ...overrides,
  };
}

describe('PrStore', () => {
  let db, store;

  beforeEach(() => {
    db = createTestDb();
    // Seed singleton rows (migrations v2 and v3)
    db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();
    store = new PrStore({ db });
  });

  // ── Core CRUD ─────────────────────────────────────

  describe('upsert + get', () => {
    it('inserts and retrieves a PR', () => {
      store.upsert(makePr(), ['DEV-1234']);
      const pr = store.get('mavencare/webplatform', 25500);
      expect(pr.prNumber).toBe(25500);
      expect(pr.prTitle).toBe('Fix DEV-1234: login timeout');
      expect(pr.jiraKeys).toEqual(['DEV-1234']);
    });

    it('updates an existing PR', () => {
      store.upsert(makePr(), ['DEV-1234']);
      store.upsert(makePr({ status: 'merged' }), ['DEV-1234']);
      const pr = store.get('mavencare/webplatform', 25500);
      expect(pr.status).toBe('merged');
    });

    it('replaces JIRA keys on update', () => {
      store.upsert(makePr(), ['DEV-1234']);
      store.upsert(makePr(), ['DEV-1234', 'DEV-5678']);
      const pr = store.get('mavencare/webplatform', 25500);
      expect(pr.jiraKeys.sort()).toEqual(['DEV-1234', 'DEV-5678']);
    });

    it('returns null for unknown PR', () => {
      expect(store.get('mavencare/webplatform', 99999)).toBeNull();
    });
  });

  describe('upsertBatch', () => {
    it('inserts multiple PRs with JIRA keys', () => {
      store.upsertBatch([
        { pr: makePr({ prNumber: 100 }), jiraKeys: ['DEV-1'] },
        { pr: makePr({ prNumber: 101 }), jiraKeys: ['DEV-2', 'DEV-3'] },
        { pr: makePr({ prNumber: 102 }), jiraKeys: [] },
      ]);
      expect(store.count()).toBe(3);
      expect(store.get('mavencare/webplatform', 101).jiraKeys.sort()).toEqual(['DEV-2', 'DEV-3']);
    });
  });

  // ── Indexed lookups ───────────────────────────────

  describe('findByBranch', () => {
    it('finds PR by head branch', () => {
      store.upsert(makePr({ headBranch: 'fix/timeout' }), []);
      const pr = store.findByBranch('fix/timeout');
      expect(pr).not.toBeNull();
      expect(pr.prNumber).toBe(25500);
    });

    it('prefers open PRs over closed', () => {
      store.upsert(makePr({ prNumber: 100, headBranch: 'feat/x', status: 'closed' }), []);
      store.upsert(makePr({ prNumber: 101, headBranch: 'feat/x', status: 'open' }), []);
      const pr = store.findByBranch('feat/x');
      expect(pr.prNumber).toBe(101);
    });

    it('tiebreaks by highest prNumber', () => {
      store.upsert(makePr({ prNumber: 100, headBranch: 'feat/x', status: 'merged' }), []);
      store.upsert(makePr({ prNumber: 200, headBranch: 'feat/x', status: 'merged' }), []);
      const pr = store.findByBranch('feat/x');
      expect(pr.prNumber).toBe(200);
    });

    it('returns null for unknown branch', () => {
      expect(store.findByBranch('nonexistent')).toBeNull();
    });
  });

  describe('findByJiraKey', () => {
    it('finds PRs associated with a JIRA key', () => {
      store.upsert(makePr({ prNumber: 100 }), ['DEV-1234']);
      store.upsert(makePr({ prNumber: 101 }), ['DEV-1234', 'DEV-5678']);
      store.upsert(makePr({ prNumber: 102 }), ['DEV-5678']);

      const prs = store.findByJiraKey('DEV-1234');
      expect(prs).toHaveLength(2);
      expect(prs.map(p => p.prNumber).sort()).toEqual([100, 101]);
    });

    it('returns empty array for unknown key', () => {
      expect(store.findByJiraKey('DEV-9999')).toEqual([]);
    });
  });

  describe('findByJiraKeys', () => {
    it('returns Map of key → PRs', () => {
      store.upsert(makePr({ prNumber: 100 }), ['DEV-1']);
      store.upsert(makePr({ prNumber: 101 }), ['DEV-2']);

      const result = store.findByJiraKeys(['DEV-1', 'DEV-2', 'DEV-3']);
      expect(result.size).toBe(2);
      expect(result.get('DEV-1')).toHaveLength(1);
      expect(result.get('DEV-2')).toHaveLength(1);
      expect(result.has('DEV-3')).toBe(false);
    });

    it('handles empty input', () => {
      expect(store.findByJiraKeys([]).size).toBe(0);
    });
  });

  // ── Search ────────────────────────────────────────

  describe('search', () => {
    beforeEach(() => {
      store.upsertBatch([
        { pr: makePr({ prNumber: 100, prTitle: 'Fix login', prAuthor: 'alice' }), jiraKeys: [] },
        { pr: makePr({ prNumber: 101, prTitle: 'Add dashboard', prAuthor: 'bob' }), jiraKeys: [] },
        { pr: makePr({ prNumber: 102, prTitle: 'Login refactor', prAuthor: 'carol' }), jiraKeys: [] },
      ]);
    });

    it('searches by title', () => {
      const result = store.search('login');
      expect(result.prs).toHaveLength(2);
    });

    it('searches by author', () => {
      const result = store.search('bob');
      expect(result.prs).toHaveLength(1);
    });

    it('returns total count', () => {
      const result = store.search('login');
      expect(result.total).toBe(2);
    });
  });

  // ── Sync metadata ─────────────────────────────────

  describe('syncMeta', () => {
    it('gets initial empty sync meta', () => {
      const meta = store.getSyncMeta();
      expect(meta.lastSyncTime).toBeNull();
      expect(meta.totalPrsSynced).toBe(0);
    });

    it('updates sync meta', () => {
      store.updateSyncMeta({ lastSyncTime: '2026-04-16T15:00:00Z', totalPrsSynced: 250 });
      const meta = store.getSyncMeta();
      expect(meta.lastSyncTime).toBe('2026-04-16T15:00:00Z');
      expect(meta.totalPrsSynced).toBe(250);
    });
  });
});
