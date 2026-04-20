import { describe, it, expect, beforeEach } from 'vitest';

const CommitStore = require('../../src/core/commit-store');
const { createTestDb } = require('../../src/core/db');

function makeCommit(overrides = {}) {
  return {
    sha: 'abc123def456',
    message: 'DEV-1234 Fix login timeout',
    author: 'Alice',
    authorDate: '2026-04-15T10:00:00Z',
    ...overrides,
  };
}

describe('CommitStore', () => {
  let db, store;

  beforeEach(() => {
    db = createTestDb();
    store = new CommitStore({ db });
  });

  // ── syncBranch ───────────────────────────────────────

  describe('syncBranch', () => {
    it('stores commits and extracts JIRA keys from messages', () => {
      // TESTING: Basic sync — commits are persisted and JIRA keys are extracted
      //
      // SETUP:
      // - Sync two commits on a branch, one mentioning DEV-1234, the other DEV-5678
      //
      // EXPECTED RESULT:
      // - Both commits should be stored
      // - JIRA keys should be queryable
      const commits = [
        makeCommit({ sha: 'aaa', message: 'DEV-1234 Fix login' }),
        makeCommit({ sha: 'bbb', message: 'DEV-5678 Add feature' }),
      ];

      store.syncBranch('webplatform', 'releases/4.2.0', commits, false);

      const stored = store.getForBranch('webplatform', 'releases/4.2.0');
      expect(stored).toHaveLength(2);
      expect(stored[0].sha).toBe('aaa');
      expect(stored[0].isPostCut).toBe(false);
    });

    it('extracts multiple JIRA keys from a single commit message', () => {
      // TESTING: Multi-key extraction from a single commit
      //
      // SETUP:
      // - One commit mentioning both DEV-100 and DEV-200
      //
      // EXPECTED RESULT:
      // - Both keys should be retrievable via getKeysForBranch
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 DEV-200 merged fix' }),
      ], false);

      const keys = store.getKeysForBranch('webplatform', 'releases/4.2.0');
      expect(keys).toEqual(new Set(['DEV-100', 'DEV-200']));
    });

    it('stores post-cut flag correctly', () => {
      // TESTING: isPostCut flag distinction
      //
      // SETUP:
      // - Sync some commits as non-post-cut, then add post-cut commits
      //
      // EXPECTED RESULT:
      // - getPostCutForBranch returns only post-cut commits
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 before cut' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-200 cherry pick' }),
      ], true);

      const all = store.getForBranch('webplatform', 'releases/4.2.0');
      expect(all).toHaveLength(2);

      const postCut = store.getPostCutForBranch('webplatform', 'releases/4.2.0');
      expect(postCut).toHaveLength(1);
      expect(postCut[0].sha).toBe('bbb');
      expect(postCut[0].isPostCut).toBe(true);
    });

    it('upserts commits on re-sync (same sha)', () => {
      // TESTING: Upsert behavior — re-syncing same SHA updates metadata
      //
      // SETUP:
      // - Sync a commit, then sync it again with updated message
      //
      // EXPECTED RESULT:
      // - Only one row for that SHA, with the updated message
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 original' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 updated message' }),
      ], false);

      const stored = store.getForBranch('webplatform', 'releases/4.2.0');
      expect(stored).toHaveLength(1);
      expect(stored[0].message).toBe('DEV-100 updated message');
    });

    it('handles commits with no JIRA keys', () => {
      // TESTING: Commits without JIRA keys should still be stored
      //
      // SETUP:
      // - Sync a commit with no JIRA key in the message
      //
      // EXPECTED RESULT:
      // - Commit is stored, but no JIRA keys are linked
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'chore: bump version' }),
      ], false);

      const stored = store.getForBranch('webplatform', 'releases/4.2.0');
      expect(stored).toHaveLength(1);

      const keys = store.getKeysForBranch('webplatform', 'releases/4.2.0');
      expect(keys.size).toBe(0);
    });
  });

  // ── getForBranch ──────────────────────────────────────

  describe('getForBranch', () => {
    it('returns empty array for unknown branch', () => {
      expect(store.getForBranch('webplatform', 'nonexistent')).toEqual([]);
    });

    it('returns only commits for the specified branch', () => {
      // TESTING: Branch isolation — commits on different branches don't mix
      //
      // SETUP:
      // - Sync commits to two different branches
      //
      // EXPECTED RESULT:
      // - Each branch query returns only its own commits
      store.syncBranch('webplatform', 'releases/4.1.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-200 feat' }),
      ], false);

      const branch1 = store.getForBranch('webplatform', 'releases/4.1.0');
      expect(branch1).toHaveLength(1);
      expect(branch1[0].sha).toBe('aaa');

      const branch2 = store.getForBranch('webplatform', 'releases/4.2.0');
      expect(branch2).toHaveLength(1);
      expect(branch2[0].sha).toBe('bbb');
    });
  });

  // ── getPostCutForBranch ───────────────────────────────

  describe('getPostCutForBranch', () => {
    it('returns empty when no post-cut commits exist', () => {
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix' }),
      ], false);

      const postCut = store.getPostCutForBranch('webplatform', 'releases/4.2.0');
      expect(postCut).toHaveLength(0);
    });
  });

  // ── getPostCutKeysForBranch ───────────────────────────

  describe('getPostCutKeysForBranch', () => {
    it('returns JIRA keys from post-cut commits only', () => {
      // TESTING: Post-cut JIRA key filtering
      //
      // SETUP:
      // - Pre-cut commit with DEV-100
      // - Post-cut commits with DEV-200 and DEV-300
      //
      // EXPECTED RESULT:
      // - Only DEV-200 and DEV-300 returned
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 pre-cut' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-200 cherry pick' }),
        makeCommit({ sha: 'ccc', message: 'DEV-300 another cp' }),
      ], true);

      const keys = store.getPostCutKeysForBranch('webplatform', 'releases/4.2.0');
      expect(keys).toEqual(new Set(['DEV-200', 'DEV-300']));
    });
  });

  // ── getKeysForBranch ──────────────────────────────────

  describe('getKeysForBranch', () => {
    it('returns all JIRA keys across pre-cut and post-cut commits', () => {
      // TESTING: Complete key set for a branch
      //
      // SETUP:
      // - Pre-cut commit with DEV-100
      // - Post-cut commit with DEV-200
      //
      // EXPECTED RESULT:
      // - Both DEV-100 and DEV-200 returned
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-200 cherry pick' }),
      ], true);

      const keys = store.getKeysForBranch('webplatform', 'releases/4.2.0');
      expect(keys).toEqual(new Set(['DEV-100', 'DEV-200']));
    });

    it('deduplicates keys across multiple commits', () => {
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 part 1' }),
        makeCommit({ sha: 'bbb', message: 'DEV-100 part 2' }),
      ], false);

      const keys = store.getKeysForBranch('webplatform', 'releases/4.2.0');
      expect(keys).toEqual(new Set(['DEV-100']));
    });
  });

  // ── getForJiraKey ─────────────────────────────────────

  describe('getForJiraKey', () => {
    it('finds commits mentioning a JIRA key across all branches', () => {
      // TESTING: Cross-branch JIRA key lookup
      //
      // SETUP:
      // - DEV-100 appears on two different branches
      //
      // EXPECTED RESULT:
      // - Both commits returned
      store.syncBranch('webplatform', 'releases/4.1.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix v1' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-100 cherry-pick' }),
      ], true);

      const commits = store.getForJiraKey('DEV-100');
      expect(commits).toHaveLength(2);
      expect(commits.map(c => c.sha).sort()).toEqual(['aaa', 'bbb']);
    });

    it('returns empty array for unknown JIRA key', () => {
      expect(store.getForJiraKey('DEV-99999')).toEqual([]);
    });
  });

  // ── clearBranch ───────────────────────────────────────

  describe('clearBranch', () => {
    it('removes all commits and JIRA key mappings for a branch', () => {
      // TESTING: Branch cleanup before re-sync
      //
      // SETUP:
      // - Sync commits to a branch, then clear it
      //
      // EXPECTED RESULT:
      // - No commits or keys remain for that branch
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix' }),
        makeCommit({ sha: 'bbb', message: 'DEV-200 feat' }),
      ], false);

      expect(store.getForBranch('webplatform', 'releases/4.2.0')).toHaveLength(2);

      store.clearBranch('webplatform', 'releases/4.2.0');

      expect(store.getForBranch('webplatform', 'releases/4.2.0')).toHaveLength(0);
      expect(store.getKeysForBranch('webplatform', 'releases/4.2.0').size).toBe(0);
    });

    it('does not affect other branches', () => {
      // TESTING: Clear isolation — only the specified branch is cleared
      //
      // SETUP:
      // - Sync commits to two branches, clear one
      //
      // EXPECTED RESULT:
      // - The other branch's commits are untouched
      store.syncBranch('webplatform', 'releases/4.1.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix' }),
      ], false);

      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-200 feat' }),
      ], false);

      store.clearBranch('webplatform', 'releases/4.2.0');

      expect(store.getForBranch('webplatform', 'releases/4.1.0')).toHaveLength(1);
      expect(store.getForBranch('webplatform', 'releases/4.2.0')).toHaveLength(0);
    });
  });

  // ── count ─────────────────────────────────────────────

  describe('count', () => {
    it('returns total commit count across all branches', () => {
      store.syncBranch('webplatform', 'releases/4.1.0', [
        makeCommit({ sha: 'aaa', message: 'DEV-100 fix' }),
      ], false);
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'bbb', message: 'DEV-200 feat' }),
        makeCommit({ sha: 'ccc', message: 'DEV-300 fix' }),
      ], false);

      expect(store.count()).toBe(3);
    });
  });

  // ── MAV project key support ───────────────────────────

  describe('MAV project key support', () => {
    it('extracts MAV-prefixed JIRA keys', () => {
      // TESTING: Multi-project JIRA key extraction
      //
      // SETUP:
      // - Commit mentioning MAV-500 (not DEV-xxx)
      //
      // EXPECTED RESULT:
      // - MAV-500 is extracted and queryable
      store.syncBranch('webplatform', 'releases/4.2.0', [
        makeCommit({ sha: 'aaa', message: 'MAV-500 mobile fix' }),
      ], false);

      const keys = store.getKeysForBranch('webplatform', 'releases/4.2.0');
      expect(keys).toEqual(new Set(['MAV-500']));

      const commits = store.getForJiraKey('MAV-500');
      expect(commits).toHaveLength(1);
    });
  });
});
