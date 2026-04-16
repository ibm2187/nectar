import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const Discovery = require('../../src/core/discovery');
const { createTestDb } = require('../../src/core/db');

describe('Discovery', () => {
  let audit, releases, discovery, db;
  let mockRepoManager;

  const config = {
    polling: { discovery: 60000 },
    discovery: { maxAgeDays: 90, maxPerRepo: 20 },
    repos: [
      {
        name: 'webplatform',
        github: 'mavencare/webplatform',
        releaseBranchPrefix: 'releases/',
        jiraProject: 'DEV',
      },
      {
        name: 'android',
        github: 'mavencare/android',
        releaseBranchPrefix: 'release/',
        jiraProject: 'DEV',
      },
    ],
  };

  beforeEach(() => {
    db = createTestDb();
    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });

    mockRepoManager = {
      fetch: vi.fn().mockResolvedValue(undefined),
      listBranches: vi.fn().mockResolvedValue([]),
      getBranchDate: vi.fn().mockResolvedValue(new Date().toISOString()),
      getBranchHead: vi.fn().mockResolvedValue('abc123def'),
      commitsWithJiraKeys: vi.fn().mockResolvedValue([]),
      mergeBase: vi.fn().mockResolvedValue(null),
      log: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(null),
      getStatus: vi.fn().mockReturnValue({}),
    };

    discovery = new Discovery(releases, mockRepoManager, config);
  });

  describe('no release creation from branches', () => {
    it('does not create releases from git branches', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0',
        'releases/4.1.0',
        'releases/4.0.0',
      ]);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(0);
      expect(releases.list()).toHaveLength(0);
    });
  });

  describe('branch enrichment', () => {
    it('fills in branch for JIRA-created release without one', async () => {
      // JIRA sync creates a release without branch info
      releases.create({ repo: 'webplatform', version: '4.2.0' });
      const before = releases.get('4.2.0', 'webplatform');
      expect(before.branch).toBeNull();

      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);
      mockRepoManager.getBranchHead.mockResolvedValue('sha456');

      await discovery.run();

      const after = releases.get('4.2.0', 'webplatform');
      expect(after.branch).toBe('releases/4.2.0');
      expect(after.cutFrom).toBe('sha456');
    });

    it('does not overwrite existing branch', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.0', branch: 'releases/4.2.0' });

      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(0);
      expect(releases.list({ repo: 'webplatform' })).toHaveLength(1);
    });

    it('enriches across multiple repos', async () => {
      releases.create({ repo: 'webplatform', version: '4.2.0' });
      releases.create({ repo: 'android', version: '3.9.0' });

      mockRepoManager.listBranches
        .mockResolvedValueOnce(['releases/4.2.0'])
        .mockResolvedValueOnce(['release/3.9.0']);
      mockRepoManager.getBranchHead.mockResolvedValue('sha789');

      await discovery.run();

      expect(releases.get('4.2.0', 'webplatform').branch).toBe('releases/4.2.0');
      expect(releases.get('3.9.0', 'android').branch).toBe('release/3.9.0');
    });
  });

  describe('fetch', () => {
    it('continues if fetch fails', async () => {
      mockRepoManager.fetch.mockRejectedValue(new Error('network'));
      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);

      // Should not throw
      const result = await discovery.run();
      expect(result).toBeTruthy();
    });
  });

  describe('concurrency guard', () => {
    it('skips concurrent runs', async () => {
      mockRepoManager.listBranches.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 50));
        return [];
      });

      const p1 = discovery.run();
      const p2 = discovery.run();

      await Promise.all([p1, p2]);
      // Only one actual run should have called listBranches
      // (second run returns lastResults)
    });
  });
});
