import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ReleaseTruth = require('../../src/core/release-truth');
const { createTestDb } = require('../../src/core/db');

describe('ReleaseTruth', () => {
  let audit, releases, truth, db;
  let mockRepoManager, mockGithub, mockJira;

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
      jiraStatus: 'Done',
      type: 'Bug',
      assignee: 'John',
      source: 'jira',
      fixVersions: ['4.2.0'],
      targetFixVersions: [],
      component: null,
      customerTags: [],
      qaAssignee: null,
      deployedEnvironments: [],
      zohoRef: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });

    mockRepoManager = {
      fetch: vi.fn().mockResolvedValue(undefined),
      commitsWithJiraKeys: vi.fn().mockResolvedValue([]),
      mergeBase: vi.fn().mockResolvedValue(null),
      log: vi.fn().mockResolvedValue([]),
    };

    mockGithub = {
      isConfigured: vi.fn().mockReturnValue(false),
      listPRsForBranch: vi.fn().mockResolvedValue([]),
    };

    mockJira = {
      isConfigured: vi.fn().mockReturnValue(false),
      searchAllIssues: vi.fn().mockResolvedValue([]),
    };

    truth = new ReleaseTruth(releases, mockRepoManager, mockGithub, mockJira, config);
  });

  // Helper to create a release with tickets and run verification
  function setupRelease(opts = {}) {
    const version = opts.version || '4.2.0';
    const branch = opts.branch || 'releases/4.2.0';
    releases.create({
      repo: 'webplatform',
      version,
      branch,
      cutFrom: opts.cutFrom || 'abc123',
    });
    const releaseKey = releases._key('webplatform', version);
    if (opts.tickets) {
      for (const t of opts.tickets) {
        releases.addTicket(releaseKey, t, 'test');
      }
    }
    return releaseKey;
  }

  describe('_verifyTicket', () => {
    // These tests call _verifyTicket directly with controlled inputs

    describe('healthy: certified + on branch', () => {
      it('returns healthy when certified and on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'QA Certified' });
        const gitKeys = new Set(['DEV-100']);
        const prByKey = new Map();

        const result = truth._verifyTicket(ticket, gitKeys, prByKey, true, '4.2.0');

        expect(result.health).toBe('healthy');
        expect(result.healthCategory).toBe('done');
        expect(result.onBranch).toBe(true);
      });

      it('returns healthy for Done + on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Done' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('healthy');
        expect(result.healthCategory).toBe('done');
      });

      it('returns healthy for Released + on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Released' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('healthy');
        expect(result.healthCategory).toBe('done');
      });
    });

    describe('in-qa: testing in branch + on branch', () => {
      it('returns in-qa for Ready for Testing + on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Ready for Testing' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('in-qa');
        expect(result.healthCategory).toBe('in-qa');
      });

      it('returns in-qa for Testing in Branch + on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Testing in Branch' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('in-qa');
        expect(result.healthCategory).toBe('in-qa');
      });

      it('returns in-qa for Cherry Picked + on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Cherry Picked' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('in-qa');
        expect(result.healthCategory).toBe('in-qa');
      });
    });

    describe('awaiting-cp: waiting for cherry pick + not on branch', () => {
      it('returns awaiting-cp when waiting for cherry pick', () => {
        const ticket = makeTicket({ jiraStatus: 'Waiting for Cherry Pick' });
        const gitKeys = new Set(); // not on branch

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('awaiting-cp');
        expect(result.healthCategory).toBe('awaiting-cp');
      });

      it('returns awaiting-cp for Ready for Cherry Pick', () => {
        const ticket = makeTicket({ jiraStatus: 'Ready for Cherry Pick' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('awaiting-cp');
        expect(result.healthCategory).toBe('awaiting-cp');
      });

      it('returns status-stale when awaiting-cp but already on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Waiting for Cherry Pick' });
        const gitKeys = new Set(['DEV-100']); // on branch

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('status-stale');
        expect(result.healthCategory).toBe('in-qa');
        expect(result.healthMessage).toContain('Already on branch');
      });
    });

    describe('in-dev: in progress + not on branch', () => {
      it('returns in-dev for In Progress + not on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'In Progress' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('in-dev');
        expect(result.healthCategory).toBe('in-dev');
      });

      it('returns in-dev for Development in Progress', () => {
        const ticket = makeTicket({ jiraStatus: 'Development in Progress' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('in-dev');
        expect(result.healthCategory).toBe('in-dev');
      });

      it('returns status-stale when in-dev but already on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'In Progress' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('status-stale');
        expect(result.healthCategory).toBe('in-qa');
      });
    });

    describe('not-on-branch: certified but NOT on branch (lying)', () => {
      it('returns not-on-branch when certified but not on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'QA Certified' });
        const gitKeys = new Set(); // not on branch

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('not-on-branch');
        expect(result.healthCategory).toBe('attention');
        expect(result.healthMessage).toContain('not found on this branch');
      });

      it('returns not-on-branch for Done status not on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Done' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('not-on-branch');
        expect(result.healthCategory).toBe('attention');
      });
    });

    describe('no-code: resolved without code', () => {
      it('returns no-code for Resolved Without Code', () => {
        const ticket = makeTicket({ jiraStatus: 'Resolved Without Code' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('no-code');
        expect(result.healthCategory).toBe('done');
      });

      it('returns no-code for Won\'t Do', () => {
        const ticket = makeTicket({ jiraStatus: "Won't Do" });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('no-code');
        expect(result.healthCategory).toBe('done');
      });

      it('returns no-code for Duplicate', () => {
        const ticket = makeTicket({ jiraStatus: 'Duplicate' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('no-code');
        expect(result.healthCategory).toBe('done');
      });

      it('returns no-code for Cancelled', () => {
        const ticket = makeTicket({ jiraStatus: 'Cancelled' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('no-code');
        expect(result.healthCategory).toBe('done');
      });

      it('resolved-no-code is the same regardless of branch state', () => {
        const ticket = makeTicket({ jiraStatus: 'Resolved Without Code' });
        const onBranchResult = truth._verifyTicket(ticket, new Set(['DEV-100']), new Map(), true, '4.2.0');
        const offBranchResult = truth._verifyTicket(ticket, new Set(), new Map(), true, '4.2.0');

        expect(onBranchResult.health).toBe('no-code');
        expect(offBranchResult.health).toBe('no-code');
        expect(onBranchResult.healthCategory).toBe('done');
        expect(offBranchResult.healthCategory).toBe('done');
      });
    });

    describe('blocked: blocked status', () => {
      it('returns blocked when not on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Blocked' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('blocked');
        expect(result.healthCategory).toBe('attention');
      });

      it('returns in-qa when blocked but code is on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Blocked' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('in-qa');
        expect(result.healthCategory).toBe('in-qa');
        expect(result.healthMessage).toContain('JIRA status may be outdated');
      });

      it('returns blocked for On Hold status', () => {
        const ticket = makeTicket({ jiraStatus: 'On Hold' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('blocked');
        expect(result.healthCategory).toBe('attention');
      });
    });

    describe('failed-qa: testing failed', () => {
      it('returns failed-qa when not on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Testing Failed' });
        const gitKeys = new Set();

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('failed-qa');
        expect(result.healthCategory).toBe('attention');
        expect(result.healthMessage).toContain('rework required');
      });

      it('returns failed-qa when on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Testing Failed' });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('failed-qa');
        expect(result.healthCategory).toBe('attention');
        expect(result.healthMessage).toContain('awaiting re-test');
      });
    });

    describe('PR pending scenarios', () => {
      it('returns pr-pending when certified but has open PR', () => {
        const ticket = makeTicket({ jiraStatus: 'QA Certified' });
        const gitKeys = new Set(); // not on branch
        const prByKey = new Map([['DEV-100', { prNumber: 123, prTitle: 'CP DEV-100' }]]);

        const result = truth._verifyTicket(ticket, gitKeys, prByKey, true, '4.2.0');

        expect(result.health).toBe('pr-pending');
        expect(result.healthCategory).toBe('in-qa');
        expect(result.healthMessage).toContain('#123');
      });

      it('returns pr-pending when awaiting-cp with open PR', () => {
        const ticket = makeTicket({ jiraStatus: 'Waiting for Cherry Pick' });
        const gitKeys = new Set();
        const prByKey = new Map([['DEV-100', { prNumber: 456 }]]);

        const result = truth._verifyTicket(ticket, gitKeys, prByKey, true, '4.2.0');

        expect(result.health).toBe('pr-pending');
        expect(result.healthCategory).toBe('awaiting-cp');
      });

      it('returns pr-pending when in-dev with open PR', () => {
        const ticket = makeTicket({ jiraStatus: 'In Progress' });
        const gitKeys = new Set();
        const prByKey = new Map([['DEV-100', { prNumber: 789 }]]);

        const result = truth._verifyTicket(ticket, gitKeys, prByKey, true, '4.2.0');

        expect(result.health).toBe('pr-pending');
        expect(result.healthCategory).toBe('awaiting-cp');
      });
    });

    describe('pre-branch: trusts JIRA alone when branch not cut', () => {
      it('returns healthy for certified when branch not cut', () => {
        const ticket = makeTicket({ jiraStatus: 'QA Certified' });
        const result = truth._verifyTicket(ticket, new Set(), new Map(), false, '4.2.0');

        expect(result.health).toBe('healthy');
        expect(result.healthCategory).toBe('done');
        expect(result.healthMessage).toContain('branch not cut');
      });

      it('returns in-qa when branch not cut', () => {
        const ticket = makeTicket({ jiraStatus: 'Ready for Testing' });
        const result = truth._verifyTicket(ticket, new Set(), new Map(), false, '4.2.0');

        expect(result.health).toBe('in-qa');
        expect(result.healthCategory).toBe('in-qa');
      });

      it('returns awaiting-cp when branch not cut', () => {
        const ticket = makeTicket({ jiraStatus: 'Waiting for Cherry Pick' });
        const result = truth._verifyTicket(ticket, new Set(), new Map(), false, '4.2.0');

        expect(result.health).toBe('awaiting-cp');
        expect(result.healthCategory).toBe('awaiting-cp');
        expect(result.healthMessage).toBe('Waiting for branch cut');
      });

      it('returns in-dev when branch not cut', () => {
        const ticket = makeTicket({ jiraStatus: 'In Progress' });
        const result = truth._verifyTicket(ticket, new Set(), new Map(), false, '4.2.0');

        expect(result.health).toBe('in-dev');
        expect(result.healthCategory).toBe('in-dev');
      });

      it('returns pre-dev for To Do when branch not cut', () => {
        const ticket = makeTicket({ jiraStatus: 'To Do' });
        const result = truth._verifyTicket(ticket, new Set(), new Map(), false, '4.2.0');

        expect(result.health).toBe('pre-dev');
        expect(result.healthCategory).toBe('in-dev');
      });
    });

    describe('unknown status', () => {
      it('returns unknown for unrecognized JIRA status not on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Some Weird Custom Status' });
        const result = truth._verifyTicket(ticket, new Set(), new Map(), true, '4.2.0');

        expect(result.health).toBe('unknown');
        expect(result.healthCategory).toBe('attention');
        expect(result.healthMessage).toContain('Unrecognized');
      });

      it('returns status-stale for unknown status on branch', () => {
        const ticket = makeTicket({ jiraStatus: 'Some Weird Custom Status' });
        const gitKeys = new Set(['DEV-100']);
        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.health).toBe('status-stale');
        expect(result.healthCategory).toBe('in-qa');
      });
    });

    describe('ticket metadata passthrough', () => {
      it('includes all metadata fields in result', () => {
        const ticket = makeTicket({
          jiraStatus: 'Done',
          type: 'Story',
          assignee: 'Jane',
          component: 'Billing',
          customerTags: ['CK', 'Lumen'],
          qaAssignee: 'QA Person',
          deployedEnvironments: ['staging', 'prod'],
          zohoRef: { kind: 'url', id: '123' },
          fixVersions: ['4.2.0'],
          targetFixVersions: ['4.2.0'],
        });
        const gitKeys = new Set(['DEV-100']);

        const result = truth._verifyTicket(ticket, gitKeys, new Map(), true, '4.2.0');

        expect(result.key).toBe('DEV-100');
        expect(result.type).toBe('Story');
        expect(result.assignee).toBe('Jane');
        expect(result.component).toBe('Billing');
        expect(result.customerTags).toEqual(['CK', 'Lumen']);
        expect(result.qaAssignee).toBe('QA Person');
        expect(result.deployedEnvironments).toEqual(['staging', 'prod']);
        expect(result.zohoRef).toEqual({ kind: 'url', id: '123' });
        expect(result.inTarget).toBe(true);
        expect(result.inFixVersion).toBe(true);
      });
    });
  });

  describe('rogue detection', () => {
    it('detects JIRA keys in commits but not in fixVersion', async () => {
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', jiraStatus: 'Done' })],
      });

      // Simulate branch exists with commits
      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'abc', message: 'DEV-100 fix bug' },
      ]);

      // Post-cut commits include DEV-100 and DEV-999 (rogue)
      mockRepoManager.mergeBase.mockResolvedValue('base123');
      mockRepoManager.log.mockResolvedValue([
        { sha: 'abc', message: 'DEV-100 fix bug' },
        { sha: 'def', message: 'DEV-999 rogue commit' },
      ]);

      const result = await truth.compute('webplatform', '4.2.0');

      expect(result.rogues).toHaveLength(1);
      expect(result.rogues[0].key).toBe('DEV-999');
      expect(result.rogues[0].commitSha).toBe('def');
      expect(result.rollup.rogue).toBe(1);
    });

    it('does not flag JIRA keys that are in fixVersion as rogues', async () => {
      setupRelease({
        tickets: [
          makeTicket({ key: 'DEV-100', jiraStatus: 'Done' }),
          makeTicket({ key: 'DEV-200', jiraStatus: 'In Progress' }),
        ],
      });

      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'abc', message: 'DEV-100 fix' },
        { sha: 'def', message: 'DEV-200 feature' },
      ]);
      mockRepoManager.mergeBase.mockResolvedValue('base123');
      mockRepoManager.log.mockResolvedValue([
        { sha: 'abc', message: 'DEV-100 fix' },
        { sha: 'def', message: 'DEV-200 feature' },
      ]);

      const result = await truth.compute('webplatform', '4.2.0');
      expect(result.rogues).toHaveLength(0);
    });
  });

  describe('rollup calculation', () => {
    it('computes correct counts per category', async () => {
      setupRelease({
        tickets: [
          makeTicket({ key: 'DEV-100', jiraStatus: 'QA Certified' }),  // done
          makeTicket({ key: 'DEV-101', jiraStatus: 'Ready for Testing' }), // in-qa
          makeTicket({ key: 'DEV-102', jiraStatus: 'Waiting for Cherry Pick' }), // awaiting-cp
          makeTicket({ key: 'DEV-103', jiraStatus: 'In Progress' }),   // in-dev
          makeTicket({ key: 'DEV-104', jiraStatus: 'Blocked' }),       // attention
          makeTicket({ key: 'DEV-105', jiraStatus: 'Resolved Without Code' }), // done
        ],
      });

      // DEV-100 and DEV-101 are on the branch
      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'a', message: 'DEV-100 fix' },
        { sha: 'b', message: 'DEV-101 test' },
      ]);

      const result = await truth.compute('webplatform', '4.2.0');

      expect(result.rollup.planned).toBe(6);
      expect(result.rollup.done).toBe(2);     // DEV-100 (healthy) + DEV-105 (no-code)
      expect(result.rollup.inQa).toBe(1);     // DEV-101
      expect(result.rollup.awaitingCp).toBe(1); // DEV-102
      expect(result.rollup.inDev).toBe(1);    // DEV-103
      expect(result.rollup.attention).toBe(1); // DEV-104
    });
  });

  describe('_deriveState', () => {
    it('returns done when JIRA version is released', () => {
      const release = { jiraReleased: true, branch: 'releases/4.2.0' };
      const rollup = { planned: 5, done: 5 };
      expect(truth._deriveState(release, rollup, 10)).toBe('done');
    });

    it('returns planning when no branch', () => {
      const release = { jiraReleased: false, branch: null };
      const rollup = { planned: 5, done: 0 };
      expect(truth._deriveState(release, rollup, 0)).toBe('planning');
    });

    it('returns cutting when branch exists but no commits', () => {
      const release = { jiraReleased: false, branch: 'releases/4.2.0' };
      const rollup = { planned: 5, done: 0 };
      expect(truth._deriveState(release, rollup, 0)).toBe('cutting');
    });

    it('returns approved when all planned tickets are done', () => {
      const release = { jiraReleased: false, branch: 'releases/4.2.0' };
      const rollup = { planned: 5, done: 5 };
      expect(truth._deriveState(release, rollup, 10)).toBe('approved');
    });

    it('returns stabilizing when some tickets are not done', () => {
      const release = { jiraReleased: false, branch: 'releases/4.2.0' };
      const rollup = { planned: 5, done: 3 };
      expect(truth._deriveState(release, rollup, 10)).toBe('stabilizing');
    });

    it('returns cutting when no planned tickets but has commits', () => {
      const release = { jiraReleased: false, branch: 'releases/4.2.0' };
      const rollup = { planned: 0, done: 0 };
      expect(truth._deriveState(release, rollup, 10)).toBe('cutting');
    });
  });

  describe('compute full pipeline', () => {
    it('returns complete truth structure', async () => {
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', jiraStatus: 'Done' })],
      });

      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'abc', message: 'DEV-100 fix' },
      ]);

      const result = await truth.compute('webplatform', '4.2.0');

      expect(result.repo).toBe('webplatform');
      expect(result.version).toBe('4.2.0');
      expect(result.branch).toBe('releases/4.2.0');
      expect(result.git.branchExists).toBe(true);
      expect(result.git.commitCount).toBe(1);
      expect(result.verified).toHaveLength(1);
      expect(result.rollup).toBeDefined();
      expect(result.derivedState).toBeDefined();
      expect(result.currentState).toBeDefined();
      expect(result.computedAt).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws for nonexistent release', async () => {
      await expect(truth.compute('webplatform', 'nonexistent'))
        .rejects.toThrow('not found');
    });

    it('throws for unconfigured repo', async () => {
      releases.create({ repo: 'unknown', version: '1.0.0' });
      await expect(truth.compute('unknown', '1.0.0'))
        .rejects.toThrow('not configured');
    });

    it('handles branchless release (not yet cut)', async () => {
      releases.create({ repo: 'webplatform', version: '5.0.0' });
      // No branch set

      const result = await truth.compute('webplatform', '5.0.0');

      expect(result.git.branchExists).toBe(false);
      expect(result.git.commitCount).toBe(0);
      expect(result.derivedState).toBe('planning');
    });

    it('handles fetch failure gracefully', async () => {
      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', jiraStatus: 'Done' })],
      });
      mockRepoManager.fetch.mockRejectedValue(new Error('network error'));

      // Should not throw; will proceed with whatever cached data is available
      const result = await truth.compute('webplatform', '4.2.0');
      expect(result).toBeDefined();
      expect(result.verified).toHaveLength(1);
    });
  });

  describe('impact computation', () => {
    it('computes delta between two versions', async () => {
      // Target release
      setupRelease({
        version: '4.2.0',
        branch: 'releases/4.2.0',
        tickets: [
          makeTicket({ key: 'DEV-100', jiraStatus: 'Done' }),
          makeTicket({ key: 'DEV-200', jiraStatus: 'Ready for Testing' }),
        ],
      });

      // Prod release
      releases.create({
        repo: 'webplatform',
        version: '4.1.0',
        branch: 'releases/4.1.0',
      });
      const prodKey = releases._key('webplatform', '4.1.0');
      releases.addTicket(prodKey, makeTicket({ key: 'DEV-50', jiraStatus: 'Done' }), 'test');

      // Git setup for compute()
      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'a', message: 'DEV-100 fix' },
        { sha: 'b', message: 'DEV-200 feature' },
      ]);

      // Delta commits between prod and target
      mockRepoManager.log.mockResolvedValue([
        { sha: 'a', message: 'DEV-100 fix' },
        { sha: 'b', message: 'DEV-200 feature' },
      ]);

      const impact = await truth.computeImpact('webplatform', '4.2.0', '4.1.0');

      expect(impact.target.version).toBe('4.2.0');
      expect(impact.prod.version).toBe('4.1.0');
      expect(impact.delta).toBeDefined();
      expect(impact.delta.tickets.new.length).toBeGreaterThanOrEqual(0);
      expect(impact.targetTruth).toBeDefined();
      expect(impact.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws for unconfigured repo', async () => {
      await expect(truth.computeImpact('unknown', '4.2.0', '4.1.0'))
        .rejects.toThrow('not configured');
    });
  });

  describe('JIRA live refresh', () => {
    it('refreshes ticket statuses from JIRA when configured', async () => {
      mockJira.isConfigured.mockReturnValue(true);
      mockJira.searchAllIssues.mockResolvedValue([
        {
          key: 'DEV-100',
          fields: {
            summary: 'Updated summary',
            status: { name: 'QA Certified' },
            issuetype: { name: 'Bug' },
            assignee: { displayName: 'Jane' },
            fixVersions: [{ name: '4.2.0' }],
            labels: [],
          },
        },
      ]);

      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', jiraStatus: 'In Progress', summary: 'Old summary' })],
      });

      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'abc', message: 'DEV-100 fix' },
      ]);

      const result = await truth.compute('webplatform', '4.2.0');

      // The ticket should have been refreshed with new data
      const verified = result.verified.find(v => v.key === 'DEV-100');
      expect(verified.jiraStatus).toBe('QA Certified');
      expect(verified.summary).toBe('Updated summary');
    });
  });

  describe('open PRs detection', () => {
    it('maps PR info to tickets by JIRA key', async () => {
      mockGithub.isConfigured.mockReturnValue(true);
      mockGithub.listPRsForBranch.mockResolvedValue([
        {
          number: 789,
          title: 'DEV-100 cherry pick',
          body: 'Cherry pick for DEV-100',
          html_url: 'https://github.com/mavencare/webplatform/pull/789',
          user: { login: 'dev1' },
          created_at: '2026-04-01T00:00:00Z',
        },
      ]);

      setupRelease({
        tickets: [makeTicket({ key: 'DEV-100', jiraStatus: 'Waiting for Cherry Pick' })],
      });

      // Branch must have commits for full verification (branchHasCommits = true)
      mockRepoManager.commitsWithJiraKeys.mockResolvedValue([
        { sha: 'xyz', message: 'DEV-999 unrelated commit' },
      ]);

      const result = await truth.compute('webplatform', '4.2.0');

      const verified = result.verified.find(v => v.key === 'DEV-100');
      expect(verified.pr).not.toBeNull();
      expect(verified.pr.prNumber).toBe(789);
      expect(verified.health).toBe('pr-pending');
      expect(result.pullRequests.open).toBe(1);
    });
  });

  describe('HEALTH_PRIORITY', () => {
    it('orders worst health first', () => {
      const p = ReleaseTruth.HEALTH_PRIORITY;
      expect(p['failed-qa']).toBeLessThan(p['not-on-branch']);
      expect(p['not-on-branch']).toBeLessThan(p['blocked']);
      expect(p['blocked']).toBeLessThan(p['healthy']);
      expect(p['healthy']).toBeLessThan(p['no-code']);
    });
  });
});
