import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const TicketStore = require('../../src/core/ticket-store');
const PrStore = require('../../src/core/pr-store');
const CommitStore = require('../../src/core/commit-store');
const TruthSync = require('../../src/core/truth-sync');
const { createTestDb } = require('../../src/core/db');

const config = {
  repos: [
    {
      name: 'webplatform',
      github: 'mavencare/webplatform',
      releaseBranchPrefix: 'releases/',
      jiraProject: 'DEV',
    },
  ],
};

function makeTicket(overrides = {}) {
  return {
    key: 'DEV-100',
    summary: 'Fix bug',
    status: 'Done',
    jiraStatus: 'Done',
    statusCategory: 'Done',
    state: 'done',
    type: 'Bug',
    assignee: 'John',
    reporter: null,
    qaAssignee: null,
    productAssignee: null,
    component: null,
    module: null,
    product: [],
    projects: [],
    priority: null,
    riskLevel: null,
    customerPriority: null,
    fixVersions: ['4.2.0'],
    targetFixVersions: [],
    customerTags: [],
    deployedEnvironments: [],
    labels: [],
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: null,
    updatedInJira: null,
    syncedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('TruthSync', () => {
  let db, audit, releases, ticketStore, prStore, commitStore, truthSync;
  let mockRepoManager;

  beforeEach(() => {
    db = createTestDb();
    // Seed singleton rows needed by stores
    db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();

    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });
    ticketStore = new TicketStore({ db });
    prStore = new PrStore({ db });
    commitStore = new CommitStore({ db });
    releases.setTicketStore(ticketStore);

    mockRepoManager = {
      fetch: vi.fn().mockResolvedValue(undefined),
      commitsWithJiraKeys: vi.fn().mockResolvedValue([]),
      mergeBase: vi.fn().mockResolvedValue(null),
      log: vi.fn().mockResolvedValue([]),
    };

    truthSync = new TruthSync(releases, mockRepoManager, commitStore, ticketStore, prStore, config);
  });

  /**
   * Helper: create a release, add tickets via TicketStore, and sync commits.
   */
  function setupRelease(opts = {}) {
    const version = opts.version || '4.2.0';
    const branch = opts.branch || 'releases/4.2.0';

    releases.create({
      repo: 'webplatform',
      version,
      branch,
      cutFrom: opts.cutFrom || 'abc123',
    });

    // Add tickets to TicketStore (not via releases.addTicket)
    if (opts.tickets) {
      ticketStore.upsertBatch(opts.tickets);
    }

    // Add commits to CommitStore
    if (opts.commits) {
      commitStore.syncBranch('webplatform', branch, opts.commits, false);
    }
    if (opts.postCutCommits) {
      commitStore.syncBranch('webplatform', branch, opts.postCutCommits, true);
    }
  }

  // ── computeRelease: basic health verdicts ────────────

  describe('computeRelease', () => {
    it('computes healthy verdict for certified ticket on branch', async () => {
      // TESTING: Ticket certified + code on branch = healthy (done)
      //
      // SETUP:
      // - Ticket DEV-100 with status "QA Certified" in fixVersion 4.2.0
      // - Commit on the branch mentioning DEV-100
      //
      // EXPECTED RESULT:
      // - ticket_truth row with health='healthy', healthCategory='done'
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', status: 'QA Certified', jiraStatus: 'QA Certified' })],
        commits: [{ sha: 'abc', message: 'DEV-100 fix bug' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-100');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('healthy');
      expect(truth[0].healthCategory).toBe('done');
      expect(truth[0].onBranch).toBe(true);
      expect(truth[0].version).toBe('4.2.0');
    });

    it('computes awaiting-cp for ticket waiting for cherry pick', async () => {
      // TESTING: Ticket awaiting cherry-pick + NOT on branch = awaiting-cp
      //
      // SETUP:
      // - Ticket DEV-200 with status "Waiting for Cherry Pick"
      // - No commit on branch mentioning DEV-200
      // - Branch has other commits (branchHasCommits = true)
      //
      // EXPECTED RESULT:
      // - health='awaiting-cp', healthCategory='awaiting-cp'
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-200', status: 'Waiting for Cherry Pick', jiraStatus: 'Waiting for Cherry Pick' })],
        commits: [{ sha: 'aaa', message: 'DEV-999 unrelated commit' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-200');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('awaiting-cp');
      expect(truth[0].healthCategory).toBe('awaiting-cp');
      expect(truth[0].onBranch).toBe(false);
    });

    it('computes not-on-branch for certified ticket missing from branch', async () => {
      // TESTING: Ticket certified in JIRA but code NOT on the branch = attention
      //
      // SETUP:
      // - Ticket DEV-300 certified but no commit on branch
      // - Branch has other commits (branchHasCommits = true)
      //
      // EXPECTED RESULT:
      // - health='not-on-branch', healthCategory='attention'
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-300', status: 'QA Certified', jiraStatus: 'QA Certified' })],
        commits: [{ sha: 'xyz', message: 'DEV-999 other work' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-300');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('not-on-branch');
      expect(truth[0].healthCategory).toBe('attention');
    });

    it('computes in-qa for ticket on branch being tested', async () => {
      // TESTING: Ticket in QA status + on branch = in-qa
      //
      // SETUP:
      // - Ticket DEV-400 with status "Ready for Testing", commit on branch
      //
      // EXPECTED RESULT:
      // - health='in-qa', healthCategory='in-qa'
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-400', status: 'Ready for Testing', jiraStatus: 'Ready for Testing' })],
        commits: [{ sha: 'abc', message: 'DEV-400 fix something' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-400');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('in-qa');
      expect(truth[0].healthCategory).toBe('in-qa');
    });

    it('computes no-code for resolved without code', async () => {
      // TESTING: Resolved without code = done regardless of branch state
      //
      // SETUP:
      // - Ticket DEV-500 with status "Resolved Without Code"
      //
      // EXPECTED RESULT:
      // - health='no-code', healthCategory='done'
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-500', status: 'Resolved Without Code', jiraStatus: 'Resolved Without Code' })],
        commits: [{ sha: 'xyz', message: 'DEV-999 other' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-500');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('no-code');
      expect(truth[0].healthCategory).toBe('done');
    });
  });

  // ── Rogue detection ──────────────────────────────────

  describe('rogue detection', () => {
    it('does NOT detect rogues in base truth (only in impact view)', async () => {
      // Rogue detection is deferred to computeImpact() where we know the
      // prod version and can compute a proper delta. Base truth should not
      // flag post-cut keys as rogues.
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', status: 'Done', jiraStatus: 'Done' })],
        commits: [{ sha: 'aaa', message: 'DEV-100 fix' }],
        postCutCommits: [
          { sha: 'aaa', message: 'DEV-100 fix' },
          { sha: 'bbb', message: 'DEV-999 rogue commit' },
        ],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      // DEV-999 should NOT appear in truth — rogues are impact-only
      const rogueTruth = ticketStore.getTruthForTicket('DEV-999');
      expect(rogueTruth).toHaveLength(0);
    });

    it('does not flag planned tickets as rogues', async () => {
      // TESTING: Planned tickets should not be marked as rogues even if post-cut
      //
      // SETUP:
      // - DEV-100 is in fixVersion AND in post-cut commits
      //
      // EXPECTED RESULT:
      // - DEV-100 is NOT a rogue — it has a normal health verdict
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', status: 'Done', jiraStatus: 'Done' })],
        commits: [{ sha: 'aaa', message: 'DEV-100 fix' }],
        postCutCommits: [{ sha: 'aaa', message: 'DEV-100 fix' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-100');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).not.toBe('rogue');
    });
  });

  // ── PR-pending detection ─────────────────────────────

  describe('PR-pending detection', () => {
    it('detects pr-pending when open PR targets release branch', async () => {
      // TESTING: Open PR targeting release branch = pr-pending
      //
      // SETUP:
      // - Ticket DEV-600 awaiting cherry-pick
      // - Open PR #789 targeting the release branch, linked to DEV-600
      // - Branch has other commits (so branchHasCommits = true)
      //
      // EXPECTED RESULT:
      // - health='pr-pending' with prNumber=789
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-600', status: 'Waiting for Cherry Pick', jiraStatus: 'Waiting for Cherry Pick' })],
        commits: [{ sha: 'xyz', message: 'DEV-999 other commit' }],
      });

      // Add an open PR targeting the release branch
      prStore.upsert({
        prNumber: 789,
        repo: 'mavencare/webplatform',
        prTitle: 'DEV-600 cherry pick',
        prAuthor: 'dev1',
        prUrl: 'https://github.com/mavencare/webplatform/pull/789',
        status: 'open',
        baseBranch: 'releases/4.2.0',
        headBranch: 'cherry-pick/DEV-600',
        prCreatedAt: '2026-04-15T10:00:00Z',
        prUpdatedAt: '2026-04-15T10:00:00Z',
        syncedAt: new Date().toISOString(),
      }, ['DEV-600']);

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForTicket('DEV-600');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('pr-pending');
      expect(truth[0].prNumber).toBe(789);
    });
  });

  // ── getTruthForRelease ───────────────────────────────

  describe('getTruthForRelease', () => {
    it('returns all truth rows for a release', async () => {
      // TESTING: Batch retrieval of truth for a release
      //
      // SETUP:
      // - Three tickets in release 4.2.0 with various statuses
      //
      // EXPECTED RESULT:
      // - getTruthForRelease returns all three rows
      setupRelease({
        tickets: [
          makeTicket({ key: 'DEV-100', status: 'QA Certified', jiraStatus: 'QA Certified' }),
          makeTicket({ key: 'DEV-200', status: 'In Progress', jiraStatus: 'In Progress' }),
          makeTicket({ key: 'DEV-300', status: 'Resolved Without Code', jiraStatus: 'Resolved Without Code' }),
        ],
        commits: [{ sha: 'aaa', message: 'DEV-100 fix' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const truth = ticketStore.getTruthForRelease('webplatform', '4.2.0');
      expect(truth).toHaveLength(3);
      const keys = truth.map(t => t.jiraKey).sort();
      expect(keys).toEqual(['DEV-100', 'DEV-200', 'DEV-300']);
    });
  });

  // ── getTruthRollup ───────────────────────────────────

  describe('getTruthRollup', () => {
    it('returns correct rollup counts by healthCategory', async () => {
      // TESTING: Rollup computation from persisted truth
      //
      // SETUP:
      // - DEV-100: certified + on branch = done
      // - DEV-200: ready for testing + on branch = in-qa
      // - DEV-300: waiting for cherry pick = awaiting-cp
      // - DEV-400: in progress = in-dev
      // - DEV-500: blocked = attention
      // - DEV-600: resolved without code = done
      //
      // EXPECTED RESULT:
      // - done=2, inQa=1, awaitingCp=1, inDev=1, attention=1
      setupRelease({
        tickets: [
          makeTicket({ key: 'DEV-100', status: 'QA Certified', jiraStatus: 'QA Certified' }),
          makeTicket({ key: 'DEV-200', status: 'Ready for Testing', jiraStatus: 'Ready for Testing' }),
          makeTicket({ key: 'DEV-300', status: 'Waiting for Cherry Pick', jiraStatus: 'Waiting for Cherry Pick' }),
          makeTicket({ key: 'DEV-400', status: 'In Progress', jiraStatus: 'In Progress' }),
          makeTicket({ key: 'DEV-500', status: 'Blocked', jiraStatus: 'Blocked' }),
          makeTicket({ key: 'DEV-600', status: 'Resolved Without Code', jiraStatus: 'Resolved Without Code' }),
        ],
        commits: [
          { sha: 'aaa', message: 'DEV-100 fix' },
          { sha: 'bbb', message: 'DEV-200 test' },
        ],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const rollup = ticketStore.getTruthRollup('webplatform', '4.2.0');
      expect(rollup.done).toBe(2);      // DEV-100 (healthy) + DEV-600 (no-code)
      expect(rollup.inQa).toBe(1);      // DEV-200
      expect(rollup.awaitingCp).toBe(1); // DEV-300
      expect(rollup.inDev).toBe(1);     // DEV-400
      expect(rollup.attention).toBe(1); // DEV-500
    });

    it('rogues are zero in base truth (only computed in impact view)', async () => {
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', status: 'Done', jiraStatus: 'Done' })],
        commits: [{ sha: 'aaa', message: 'DEV-100 fix' }],
        postCutCommits: [
          { sha: 'aaa', message: 'DEV-100 fix' },
          { sha: 'bbb', message: 'DEV-999 rogue' },
        ],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      const rollup = ticketStore.getTruthRollup('webplatform', '4.2.0');
      expect(rollup.rogue).toBe(0);
    });
  });

  // ── clearTruthForRelease ─────────────────────────────

  describe('clearTruthForRelease', () => {
    it('clears truth before recompute', async () => {
      // TESTING: Truth is cleared and recomputed cleanly
      //
      // SETUP:
      // - Compute truth, then recompute after ticket status changes
      //
      // EXPECTED RESULT:
      // - Old truth is replaced with new results
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', status: 'In Progress', jiraStatus: 'In Progress' })],
        commits: [{ sha: 'xyz', message: 'DEV-999 other' }],
      });

      await truthSync.computeRelease('webplatform', '4.2.0');

      let truth = ticketStore.getTruthForTicket('DEV-100');
      expect(truth[0].health).toBe('in-dev');

      // Update the ticket status and recompute
      ticketStore.upsert(makeTicket({ key: 'DEV-100', status: 'QA Certified', jiraStatus: 'QA Certified' }));
      // Also add DEV-100 to the branch
      commitStore.syncBranch('webplatform', 'releases/4.2.0', [
        { sha: 'abc', message: 'DEV-100 fix' },
      ], false);

      await truthSync.computeRelease('webplatform', '4.2.0');

      truth = ticketStore.getTruthForTicket('DEV-100');
      expect(truth).toHaveLength(1);
      expect(truth[0].health).toBe('healthy');
      expect(truth[0].healthCategory).toBe('done');
    });
  });

  // ── run (batch computation) ──────────────────────────

  describe('run', () => {
    it('computes truth for all active releases', async () => {
      // TESTING: Batch computation across multiple releases
      //
      // SETUP:
      // - Two active releases with tickets and commits
      //
      // EXPECTED RESULT:
      // - Truth computed for both releases
      setupRelease({
        version: '4.1.0',
        branch: 'releases/4.1.0',
        tickets: [makeTicket({ key: 'DEV-50', fixVersions: ['4.1.0'], status: 'Done', jiraStatus: 'Done' })],
        commits: [{ sha: 'aaa', message: 'DEV-50 fix' }],
      });

      setupRelease({
        version: '4.2.0',
        branch: 'releases/4.2.0',
        tickets: [makeTicket({ key: 'DEV-100', fixVersions: ['4.2.0'], status: 'Done', jiraStatus: 'Done' })],
        commits: [{ sha: 'bbb', message: 'DEV-100 fix' }],
      });

      const result = await truthSync.run();

      expect(result.computed).toBe(2);
      expect(result.errors).toHaveLength(0);

      const truth1 = ticketStore.getTruthForRelease('webplatform', '4.1.0');
      expect(truth1).toHaveLength(1);

      const truth2 = ticketStore.getTruthForRelease('webplatform', '4.2.0');
      expect(truth2).toHaveLength(1);
    });

    it('skips done releases', async () => {
      // TESTING: Done releases are not recomputed
      //
      // SETUP:
      // - One active release, one done release
      //
      // EXPECTED RESULT:
      // - Only the active release gets truth computed
      setupRelease({
        version: '4.2.0',
        tickets: [makeTicket({ key: 'DEV-100', status: 'Done', jiraStatus: 'Done' })],
        commits: [{ sha: 'aaa', message: 'DEV-100 fix' }],
      });

      // Create and transition a release to done
      releases.create({ repo: 'webplatform', version: '4.0.0', branch: 'releases/4.0.0' });
      releases.transition('4.0.0', 'cutting', 'test');
      releases.transition('4.0.0', 'stabilizing', 'test');
      releases.transition('4.0.0', 'approved', 'test');
      releases.transition('4.0.0', 'deploying', 'test');
      releases.transition('4.0.0', 'done', 'test');

      const result = await truthSync.run();

      // Only the active release (4.2.0) should be computed
      expect(result.computed).toBe(1);
    });
  });

  // ── getTruthForTicket across releases ────────────────

  describe('getTruthForTicket (cross-release)', () => {
    it('returns truth for a ticket across multiple releases', async () => {
      // TESTING: A ticket in multiple releases has separate truth entries
      //
      // SETUP:
      // - DEV-100 is in fixVersion for both 4.1.0 and 4.2.0
      // - On branch in 4.2.0 but not in 4.1.0
      //
      // EXPECTED RESULT:
      // - Two truth rows with different health verdicts
      setupRelease({
        version: '4.1.0',
        branch: 'releases/4.1.0',
        tickets: [makeTicket({ key: 'DEV-100', fixVersions: ['4.1.0', '4.2.0'], status: 'QA Certified', jiraStatus: 'QA Certified' })],
        commits: [{ sha: 'xyz', message: 'DEV-999 other' }],
      });

      setupRelease({
        version: '4.2.0',
        branch: 'releases/4.2.0',
        tickets: [], // already inserted above with both versions
        commits: [{ sha: 'abc', message: 'DEV-100 fix' }],
      });

      await truthSync.run();

      const truth = ticketStore.getTruthForTicket('DEV-100');
      expect(truth).toHaveLength(2);

      const v41 = truth.find(t => t.version === '4.1.0');
      const v42 = truth.find(t => t.version === '4.2.0');

      expect(v41.health).toBe('not-on-branch'); // certified but not on 4.1.0 branch
      expect(v41.healthCategory).toBe('attention');
      expect(v42.health).toBe('healthy'); // certified and on 4.2.0 branch
      expect(v42.healthCategory).toBe('done');
    });
  });
});
