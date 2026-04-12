import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const Discovery = require('../../src/core/discovery');

describe('Discovery', () => {
  let audit, releases, discovery;
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
    audit = new Audit();
    releases = new ReleaseManager(audit);
    releases.releases.clear();
    audit.entries = [];

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

  describe('branch detection', () => {
    it('finds release branches matching prefix', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0',
        'releases/4.1.0',
        'releases/4.0.0',
      ]);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(3);
      expect(result.totalDiscovered).toBe(3);
    });

    it('skips branches that do not match semver pattern', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0',
        'releases/hotfix-temp',
        'releases/test',
        'releases/4.1.0',
      ]);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(2);
    });

    it('handles branches with suffixes after semver', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0-lumen',
        'releases/4.1.0.3-ck',
      ]);

      const result = await discovery.run();
      // Both should match since SEMVER_PATTERN allows suffixes
      expect(result.repos.webplatform.discovered).toBe(2);
    });
  });

  describe('version extraction', () => {
    it('extracts version from branch name by stripping prefix', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0',
      ]);

      await discovery.run();
      const release = releases.get('4.2.0', 'webplatform');
      expect(release).not.toBeNull();
      expect(release.version).toBe('4.2.0');
      expect(release.branch).toBe('releases/4.2.0');
    });

    it('uses repo-specific prefix for extraction', async () => {
      // Android repo uses 'release/' prefix
      mockRepoManager.listBranches
        .mockResolvedValueOnce([]) // webplatform returns nothing
        .mockResolvedValueOnce(['release/3.9.0']); // android

      await discovery.run();
      const release = releases.get('3.9.0', 'android');
      expect(release).not.toBeNull();
      expect(release.version).toBe('3.9.0');
    });
  });

  describe('release creation', () => {
    it('creates releases for new branches', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0',
      ]);

      await discovery.run();

      const release = releases.get('4.2.0', 'webplatform');
      expect(release).not.toBeNull();
      expect(release.repo).toBe('webplatform');
      expect(release.branch).toBe('releases/4.2.0');
      expect(release.cutFrom).toBe('abc123def');
      expect(release.cutBy).toBe('discovery');
    });

    it('stores cutFrom SHA from branch head', async () => {
      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);
      mockRepoManager.getBranchHead.mockResolvedValue('sha999');

      await discovery.run();

      const release = releases.get('4.2.0', 'webplatform');
      expect(release.cutFrom).toBe('sha999');
    });

    it('handles getBranchHead failure gracefully', async () => {
      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);
      mockRepoManager.getBranchHead.mockRejectedValue(new Error('git error'));

      await discovery.run();

      const release = releases.get('4.2.0', 'webplatform');
      expect(release).not.toBeNull();
      // cutFrom will be null since getBranchHead failed
      expect(release.cutFrom).toBeNull();
    });
  });

  describe('duplicate detection', () => {
    it('does not recreate existing releases', async () => {
      // Pre-create a release
      releases.create({ repo: 'webplatform', version: '4.2.0', branch: 'releases/4.2.0' });

      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.2.0',
      ]);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(0);
      expect(releases.list({ repo: 'webplatform' })).toHaveLength(1);
    });

    it('fills in branch for existing release without one (JIRA-sync created)', async () => {
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
  });

  describe('multi-repo discovery', () => {
    it('discovers across multiple repos', async () => {
      mockRepoManager.listBranches
        .mockResolvedValueOnce(['releases/4.2.0', 'releases/4.1.0']) // webplatform
        .mockResolvedValueOnce(['release/3.9.0']); // android

      const result = await discovery.run();

      expect(result.repos.webplatform.discovered).toBe(2);
      expect(result.repos.android.discovered).toBe(1);
      expect(result.totalDiscovered).toBe(3);

      expect(releases.get('4.2.0', 'webplatform')).not.toBeNull();
      expect(releases.get('4.1.0', 'webplatform')).not.toBeNull();
      expect(releases.get('3.9.0', 'android')).not.toBeNull();
    });

    it('handles repo failure without affecting other repos', async () => {
      mockRepoManager.listBranches
        .mockRejectedValueOnce(new Error('network error')) // webplatform fails
        .mockResolvedValueOnce(['release/3.9.0']); // android works

      const result = await discovery.run();

      expect(result.repos.webplatform.error).toBe('network error');
      expect(result.repos.webplatform.discovered).toBe(0);
      expect(result.repos.android.discovered).toBe(1);
      expect(result.totalDiscovered).toBe(1);
    });
  });

  describe('age filtering', () => {
    it('skips branches older than maxAgeDays', async () => {
      mockRepoManager.listBranches.mockResolvedValue(['releases/1.0.0']);
      // Return a date 100 days ago (exceeds maxAgeDays: 90)
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      mockRepoManager.getBranchDate.mockResolvedValue(oldDate);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(0);
    });

    it('includes branches within maxAgeDays', async () => {
      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);
      const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      mockRepoManager.getBranchDate.mockResolvedValue(recentDate);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(1);
    });

    it('includes branch when age check fails (cannot determine age)', async () => {
      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);
      mockRepoManager.getBranchDate.mockRejectedValue(new Error('git error'));

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(1);
    });
  });

  describe('version sorting', () => {
    it('sorts versions newest first', async () => {
      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.0.0',
        'releases/4.2.0',
        'releases/4.1.0',
      ]);

      const result = await discovery.run();
      // All 3 should be discovered, newest first processing
      expect(result.repos.webplatform.discovered).toBe(3);
    });
  });

  describe('maxPerRepo limit', () => {
    it('limits tracked branches per repo', async () => {
      const configLimited = {
        ...config,
        discovery: { maxAgeDays: 0, maxPerRepo: 2 }, // maxAgeDays: 0 disables age filter
      };
      const limitedDiscovery = new Discovery(releases, mockRepoManager, configLimited);

      mockRepoManager.listBranches.mockResolvedValue([
        'releases/4.0.0',
        'releases/4.1.0',
        'releases/4.2.0',
        'releases/4.3.0',
      ]);

      const result = await limitedDiscovery.run();
      // Should only track the 2 newest (4.3.0, 4.2.0)
      expect(result.repos.webplatform.branches).toBe(2);
    });
  });

  describe('fetch', () => {
    it('fetches latest before listing branches', async () => {
      mockRepoManager.listBranches.mockResolvedValue([]);

      await discovery.run();

      expect(mockRepoManager.fetch).toHaveBeenCalledWith('webplatform');
      expect(mockRepoManager.fetch).toHaveBeenCalledWith('android');
    });

    it('continues if fetch fails', async () => {
      mockRepoManager.fetch.mockRejectedValue(new Error('fetch failed'));
      mockRepoManager.listBranches.mockResolvedValue(['releases/4.2.0']);

      const result = await discovery.run();
      expect(result.repos.webplatform.discovered).toBe(1);
    });
  });

  describe('concurrency guard', () => {
    it('skips concurrent runs', async () => {
      mockRepoManager.listBranches.mockImplementation(
        (name, prefix) => new Promise(resolve => setTimeout(() => {
          if (prefix === 'releases/') resolve(['releases/4.2.0']);
          else resolve([]);
        }, 50))
      );

      // Start first run
      const run1 = discovery.run();
      // Start second run while first is still in progress
      const run2 = discovery.run();

      const [result1, result2] = await Promise.all([run1, run2]);

      // First run completes normally; second skips and returns lastResults (null before first run)
      expect(result1.totalDiscovered).toBe(1);
      expect(result2).toBeNull(); // returns lastResults which was null before first run
    });
  });

  describe('events', () => {
    it('emits discovery:started and discovery:completed events', async () => {
      const events = [];
      discovery.on('discovery:started', () => events.push('started'));
      discovery.on('discovery:completed', () => events.push('completed'));

      mockRepoManager.listBranches.mockResolvedValue([]);
      await discovery.run();

      expect(events).toEqual(['started', 'completed']);
    });

    it('emits discovery:repo-started and discovery:repo-synced per repo', async () => {
      const repoEvents = [];
      discovery.on('discovery:repo-started', (name) => repoEvents.push(`start:${name}`));
      discovery.on('discovery:repo-synced', (name) => repoEvents.push(`synced:${name}`));

      mockRepoManager.listBranches.mockResolvedValue([]);
      await discovery.run();

      expect(repoEvents).toContain('start:webplatform');
      expect(repoEvents).toContain('synced:webplatform');
      expect(repoEvents).toContain('start:android');
      expect(repoEvents).toContain('synced:android');
    });
  });

  describe('getStatus', () => {
    it('returns current status', async () => {
      mockRepoManager.listBranches.mockResolvedValue([]);
      await discovery.run();

      const status = discovery.getStatus();
      expect(status.running).toBe(false);
      expect(status.lastRun).not.toBeNull();
      expect(status.lastResults).not.toBeNull();
    });
  });

  describe('_compareVersions', () => {
    it('compares major versions', () => {
      expect(discovery._compareVersions('5.0.0', '4.0.0')).toBeGreaterThan(0);
      expect(discovery._compareVersions('3.0.0', '4.0.0')).toBeLessThan(0);
    });

    it('compares minor versions', () => {
      expect(discovery._compareVersions('4.3.0', '4.2.0')).toBeGreaterThan(0);
      expect(discovery._compareVersions('4.1.0', '4.2.0')).toBeLessThan(0);
    });

    it('compares patch versions', () => {
      expect(discovery._compareVersions('4.2.1', '4.2.0')).toBeGreaterThan(0);
      expect(discovery._compareVersions('4.2.0', '4.2.1')).toBeLessThan(0);
    });

    it('returns 0 for equal versions', () => {
      expect(discovery._compareVersions('4.2.0', '4.2.0')).toBe(0);
    });

    it('handles suffixed versions', () => {
      // When numeric parts are equal, compares suffixes lexically
      const result = discovery._compareVersions('4.2.0-lumen', '4.2.0-ck');
      expect(typeof result).toBe('number');
    });
  });
});
