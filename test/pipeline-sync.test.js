import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const PipelineSync = require('../src/core/pipeline-sync');

function makeRelease(version, opts = {}) {
  return {
    repo: opts.repo || 'webplatform',
    version,
    state: opts.state || 'stabilizing',
    jiraArchived: false,
    tickets: opts.tickets || [],
    pipeline: null,
    ...opts,
  };
}

function makeMockReleases(releaseList) {
  const map = new Map();
  for (const r of releaseList) map.set(`${r.repo}:${r.version}`, r);
  return {
    list: () => releaseList,
    releases: map,
    _key: (repo, version) => `${repo}:${version}`,
    _debounceSave: vi.fn(),
    get: (version, repo = 'webplatform') => map.get(`${repo}:${version}`) || null,
  };
}

function makeMockAws(opts = {}, crossAccounts = []) {
  const projects = opts.projects || ['ECR-Build_viv-release-4_3_0'];
  const builds = opts.builds || [{
    id: 'ECR-Build_viv-release-4_3_0:1',
    buildNumber: 1,
    buildStatus: 'SUCCEEDED',
    startTime: new Date('2026-04-13T10:00:00Z'),
    endTime: new Date('2026-04-13T10:25:00Z'),
    sourceVersion: 'releases/4.3.0',
    resolvedSourceVersion: 'abc123',
    initiator: 'webhook',
  }];
  const pipelines = opts.pipelines || ['Deploy-Viv_Dev03'];
  const pipelineState = opts.pipelineState || {
    stageStates: [
      {
        stageName: 'Source',
        latestExecution: { status: 'Succeeded', lastStatusChange: new Date('2026-04-13T10:00:00Z') },
        actionStates: [],
      },
      {
        stageName: 'Deploy',
        latestExecution: { status: 'Succeeded', lastStatusChange: new Date('2026-04-13T10:30:00Z') },
        actionStates: [],
      },
    ],
  };

  return {
    isConfigured: () => true,
    getCrossAccountRoles: () => crossAccounts,
    listProjects: vi.fn(async () => projects),
    getBuildsForProject: vi.fn(async () => builds.map(b => ({
      id: b.id,
      buildNumber: b.buildNumber,
      status: b.buildStatus,
      startTime: b.startTime?.toISOString(),
      endTime: b.endTime?.toISOString(),
      durationSec: b.startTime && b.endTime ? Math.round((b.endTime - b.startTime) / 1000) : null,
      sourceVersion: b.sourceVersion,
      resolvedSourceVersion: b.resolvedSourceVersion,
      initiator: b.initiator,
    }))),
    listPipelines: vi.fn(async () => pipelines),
    getPipelineConfig: vi.fn(async (name) => ({
      name,
      ecrRepo: 'viv-release',
      ecrImageTag: '4.3.0',
    })),
    getPipelineState: vi.fn(async (name) => ({
      name,
      stages: pipelineState.stageStates.map(s => ({
        stageName: s.stageName,
        status: s.latestExecution?.status || null,
        lastUpdated: s.latestExecution?.lastStatusChange?.toISOString() || null,
        actions: (s.actionStates || []).map(a => ({
          actionName: a.actionName,
          status: a.latestExecution?.status || null,
        })),
      })),
    })),
  };
}

function makeMockRepoManager() {
  return {
    log: vi.fn(async () => [
      { sha: 'abc1234', message: 'CHERRY_PICK [DEV-45329] Fix sendMode' },
      { sha: 'def5678', message: 'CHERRY_PICK [DEV-45718] Fix 403 on PUT' },
    ]),
  };
}

describe('PipelineSync', () => {
  let releases, aws, repoManager, sync;

  beforeEach(() => {
    releases = makeMockReleases([
      makeRelease('4.3.0'),
      makeRelease('4.2.0', { state: 'done' }), // done, skipped
      makeRelease('2026.4.0', { repo: 'ios' }), // non-webplatform, skipped
    ]);
    aws = makeMockAws();
    repoManager = makeMockRepoManager();
    sync = new PipelineSync(releases, aws, repoManager, {});
  });

  it('discovers CodeBuild projects', async () => {
    await sync.run();
    expect(aws.listProjects).toHaveBeenCalled();
    expect(sync._projectList).toContain('ECR-Build_viv-release-4_3_0');
  });

  it('fetches builds for each project', async () => {
    await sync.run();
    expect(aws.getBuildsForProject).toHaveBeenCalledWith('ECR-Build_viv-release-4_3_0', 5);
  });

  it('stores build data on the sync service', async () => {
    await sync.run();
    expect(sync.buildProjects.length).toBeGreaterThan(0);
    const card = sync.buildProjects.find(b => b.version === '4.3.0');
    expect(card).toBeTruthy();
    expect(card.latestStatus).toBe('SUCCEEDED');
    expect(card.builds[0].commitSha).toBe('abc123');
  });

  it('gets new commits from local git', async () => {
    await sync.run();
    const card = sync.buildProjects.find(b => b.version === '4.3.0');
    expect(card.newCommits).toHaveLength(2);
    expect(card.jiraKeys).toContain('DEV-45329');
    expect(card.jiraKeys).toContain('DEV-45718');
  });

  it('fetches deploy pipeline configs for ECR mapping', async () => {
    await sync.run();
    expect(aws.listPipelines).toHaveBeenCalled();
    expect(aws.getPipelineConfig).toHaveBeenCalled();
  });

  it('provides builds page data via getBuildsPageData', async () => {
    await sync.run();
    const data = sync.getBuildsPageData();
    expect(Array.isArray(data.customers)).toBe(true);
    expect(data.customers.length).toBeGreaterThan(0);
    expect(data.deployTargets).toBeTruthy();
    expect(data.lastRun).toBeTruthy();
  });

  it('handles AWS errors gracefully', async () => {
    aws.listProjects = vi.fn(async () => { throw new Error('AWS down'); });
    sync = new PipelineSync(releases, aws, repoManager, {});
    const results = await sync.run();
    expect(results.errors).toBeGreaterThan(0);
    expect(sync.buildProjects).toHaveLength(0);
  });

  it('handles empty project list', async () => {
    aws = makeMockAws({ projects: [] });
    sync = new PipelineSync(releases, aws, repoManager, {});
    const results = await sync.run();
    expect(results.builds).toBe(0);
    expect(sync.buildProjects).toHaveLength(0);
  });

  it('emits sync:completed', async () => {
    const handler = vi.fn();
    sync.on('sync:completed', handler);
    await sync.run();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('prevents concurrent runs', async () => {
    aws.listProjects = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 100));
      return ['ECR-Build_viv-release-4_3_0'];
    });
    sync = new PipelineSync(releases, aws, repoManager, {});
    const p1 = sync.run();
    const p2 = sync.run();
    await Promise.all([p1, p2]);
    expect(aws.listProjects).toHaveBeenCalledTimes(1);
  });

  it('getStatus reports project and deploy counts', async () => {
    await sync.run();
    const status = sync.getStatus();
    expect(status.configured).toBe(true);
    expect(status.projectCount).toBeGreaterThan(0);
    expect(status.deployCount).toBeGreaterThanOrEqual(0);
  });

  it('handles FAILED build status', async () => {
    aws = makeMockAws({
      builds: [{
        id: 'build:1', buildNumber: 2, buildStatus: 'FAILED',
        startTime: new Date('2026-04-13T12:00:00Z'),
        endTime: new Date('2026-04-13T12:19:00Z'),
        sourceVersion: 'releases/4.3.0', resolvedSourceVersion: 'fail123',
        initiator: 'webhook',
      }, {
        id: 'build:2', buildNumber: 1, buildStatus: 'SUCCEEDED',
        startTime: new Date('2026-04-13T10:00:00Z'),
        endTime: new Date('2026-04-13T10:25:00Z'),
        sourceVersion: 'releases/4.3.0', resolvedSourceVersion: 'abc123',
        initiator: 'webhook',
      }],
    });
    sync = new PipelineSync(releases, aws, repoManager, {});
    await sync.run();

    const card = sync.buildProjects.find(b => b.version === '4.3.0');
    expect(card.latestStatus).toBe('FAILED');
    expect(card.builds).toHaveLength(2);
    expect(repoManager.log).toHaveBeenCalled();
  });

  describe('getBuildsPageData customer grouping', () => {
    function makeCard(overrides = {}) {
      return {
        projectName: 'ECR-Build_viv-master',
        branch: 'master',
        account: 'Viv',
        latestStatus: 'SUCCEEDED',
        latestStartTime: '2026-04-10T00:00:00Z',
        builds: [],
        newCommits: [],
        jiraKeys: [],
        ecrRepo: 'viv-master',
        imageTag: 'master',
        ...overrides,
      };
    }

    it('groups Viv builds under the viv customer', () => {
      sync.buildProjects = [makeCard()];
      sync.deployTargets = { master: [{ pipelineName: 'Deploy-Viv_Dev03', account: 'Viv' }] };
      const data = sync.getBuildsPageData();
      const viv = data.customers.find(c => c.key === 'viv');
      expect(viv).toBeTruthy();
      expect(viv.allBuilds).toHaveLength(1);
    });

    it('groups cross-account builds under their customer key', () => {
      sync.buildProjects = [makeCard({
        projectName: 'ECR-Build_viv-release-ck',
        account: 'ck',
        ecrRepo: 'viv-release-ck',
        imageTag: '4.3.0',
        branch: 'releases/4.3.0',
      })];
      sync.deployTargets = { '4.3.0': [{ pipelineName: 'Deploy-CK_QA', account: 'ck' }] };
      const data = sync.getBuildsPageData();
      const ck = data.customers.find(c => c.key === 'ck');
      expect(ck).toBeTruthy();
      expect(ck.allBuilds).toHaveLength(1);
    });

    it('omits customers with no builds', () => {
      sync.buildProjects = [makeCard()];
      sync.deployTargets = { master: [{ pipelineName: 'Deploy-Viv_Dev03', account: 'Viv' }] };
      const data = sync.getBuildsPageData();
      expect(data.customers).toHaveLength(1);
      expect(data.customers[0].key).toBe('viv');
    });

    it('customer entries include label, key, account, allBuilds, pinnedBuild, recentBuilds fields', () => {
      sync.buildProjects = [makeCard()];
      sync.deployTargets = { master: [{ pipelineName: 'Deploy-Viv_Dev03', account: 'Viv' }] };
      const data = sync.getBuildsPageData();
      const viv = data.customers[0];
      expect(viv).toHaveProperty('key');
      expect(viv).toHaveProperty('label');
      expect(viv).toHaveProperty('account');
      expect(viv).toHaveProperty('allBuilds');
      expect(viv).toHaveProperty('pinnedBuild');
      expect(viv).toHaveProperty('recentBuilds');
      expect(viv).not.toHaveProperty('pipelineCounts');
      expect(viv).not.toHaveProperty('activeReleaseVersion');
    });

    it('returns customers in CUSTOMER_ORDER with viv first', () => {
      sync.buildProjects = [
        makeCard({
          projectName: 'ECR-Build_viv-release-bayada',
          account: 'bayada',
          ecrRepo: 'viv-release-bayada',
          imageTag: '4.3.0',
        }),
        makeCard(),
      ];
      sync.deployTargets = {
        master: [{ pipelineName: 'Deploy-Viv_Dev03', account: 'Viv' }],
        '4.3.0': [{ pipelineName: 'Deploy-Bayada_Uat', account: 'bayada' }],
      };
      const data = sync.getBuildsPageData();
      expect(data.customers.map(c => c.key)).toEqual(['viv', 'bayada']);
    });
  });

  describe('getBuildsPageData pinning', () => {
    function makeCard(overrides = {}) {
      return {
        projectName: 'proj',
        branch: 'master',
        account: 'Viv',
        latestStatus: 'SUCCEEDED',
        latestStartTime: '2026-04-10T00:00:00Z',
        builds: [], newCommits: [], jiraKeys: [],
        ecrRepo: 'viv-master', imageTag: 'master',
        ...overrides,
      };
    }

    it('pins the viv-master build for viv', () => {
      sync.buildProjects = [
        makeCard({ projectName: 'A', ecrRepo: 'viv-custom', branch: 'eric/foo', imageTag: 'foo' }),
        makeCard({ projectName: 'B', ecrRepo: 'viv-master', branch: 'master', imageTag: 'master' }),
      ];
      sync.deployTargets = {
        foo: [{ pipelineName: 'Deploy-Viv_Foo', account: 'Viv' }],
        master: [{ pipelineName: 'Deploy-Viv_Dev03', account: 'Viv' }],
      };
      const data = sync.getBuildsPageData();
      const viv = data.customers.find(c => c.key === 'viv');
      expect(viv.pinnedBuild?.projectName).toBe('B');
    });

    it('falls back to most recent viv-release-<customer> build when no version match', () => {
      sync.buildProjects = [
        makeCard({ projectName: 'older', account: 'ck', ecrRepo: 'viv-release-ck', imageTag: '4.1.0', latestStartTime: '2026-04-10T00:00:00Z' }),
        makeCard({ projectName: 'newer', account: 'ck', ecrRepo: 'viv-release-ck', imageTag: '4.2.0', latestStartTime: '2026-04-12T00:00:00Z' }),
      ];
      sync.deployTargets = {
        '4.1.0': [{ pipelineName: 'Deploy-CK_Older', account: 'ck' }],
        '4.2.0': [{ pipelineName: 'Deploy-CK_Newer', account: 'ck' }],
      };
      const data = sync.getBuildsPageData();
      const ck = data.customers.find(c => c.key === 'ck');
      expect(ck.pinnedBuild?.projectName).toBe('newer');
    });

    it('pinnedBuild is null when there are no matching cards', () => {
      sync.buildProjects = [
        makeCard({ projectName: 'custom', account: 'ck', ecrRepo: 'viv-custom', imageTag: 'foo', branch: 'eric/foo' }),
      ];
      sync.deployTargets = { foo: [{ pipelineName: 'Deploy-CK_Foo', account: 'ck' }] };
      const data = sync.getBuildsPageData();
      const ck = data.customers.find(c => c.key === 'ck');
      expect(ck.pinnedBuild).toBeNull();
    });
  });

  describe('getBuildsPageData recent list', () => {
    function makeCard(overrides = {}) {
      return {
        projectName: 'proj', branch: 'releases/4.3.0', account: 'ck',
        latestStatus: 'SUCCEEDED', latestStartTime: '2026-04-10T00:00:00Z',
        builds: [], newCommits: [], jiraKeys: [],
        ecrRepo: 'viv-release-ck', imageTag: '4.3.0',
        ...overrides,
      };
    }

    it('recentBuilds excludes the pinned build and is sorted by latestStartTime desc, capped at 4', () => {
      sync.buildProjects = [
        makeCard({ projectName: 'pinned', imageTag: '4.3.0', latestStartTime: '2026-04-15T00:00:00Z' }),
        makeCard({ projectName: 'c1', ecrRepo: 'viv-custom', imageTag: 'a', latestStartTime: '2026-04-01T00:00:00Z' }),
        makeCard({ projectName: 'c2', ecrRepo: 'viv-custom', imageTag: 'b', latestStartTime: '2026-04-02T00:00:00Z' }),
        makeCard({ projectName: 'c3', ecrRepo: 'viv-custom', imageTag: 'c', latestStartTime: '2026-04-03T00:00:00Z' }),
        makeCard({ projectName: 'c4', ecrRepo: 'viv-custom', imageTag: 'd', latestStartTime: '2026-04-04T00:00:00Z' }),
        makeCard({ projectName: 'c5', ecrRepo: 'viv-custom', imageTag: 'e', latestStartTime: '2026-04-05T00:00:00Z' }),
        makeCard({ projectName: 'c6', ecrRepo: 'viv-custom', imageTag: 'f', latestStartTime: '2026-04-06T00:00:00Z' }),
      ];
      sync.deployTargets = {
        '4.3.0': [{ pipelineName: 'Deploy-CK_Pin', account: 'ck' }],
        a: [{ pipelineName: 'Deploy-CK_a', account: 'ck' }],
        b: [{ pipelineName: 'Deploy-CK_b', account: 'ck' }],
        c: [{ pipelineName: 'Deploy-CK_c', account: 'ck' }],
        d: [{ pipelineName: 'Deploy-CK_d', account: 'ck' }],
        e: [{ pipelineName: 'Deploy-CK_e', account: 'ck' }],
        f: [{ pipelineName: 'Deploy-CK_f', account: 'ck' }],
      };
      const data = sync.getBuildsPageData();
      const ck = data.customers.find(c => c.key === 'ck');
      expect(ck.pinnedBuild?.projectName).toBe('pinned');
      expect(ck.recentBuilds.map(b => b.projectName)).toEqual(['c6', 'c5', 'c4', 'c3']);
    });
  });

  describe('getBuildsPageData PR enrichment', () => {
    function makeCard(overrides = {}) {
      return {
        projectName: 'p', branch: 'eric/foo', account: 'Viv',
        latestStatus: 'SUCCEEDED', latestStartTime: '2026-04-10T00:00:00Z',
        builds: [], newCommits: [], jiraKeys: [],
        ecrRepo: 'viv-custom', imageTag: 'foo',
        ...overrides,
      };
    }

    const vivFooTargets = { foo: [{ pipelineName: 'Deploy-Viv_Foo', account: 'Viv' }] };

    it('enriches cards with prUrl from pr-sync.findPRByBranch', () => {
      sync.setPrSync({
        findPRByBranch: vi.fn().mockReturnValue({ prUrl: 'https://github.com/mavencare/webplatform/pull/42' }),
      });
      sync.buildProjects = [makeCard()];
      sync.deployTargets = vivFooTargets;
      const data = sync.getBuildsPageData();
      const card = data.customers[0].allBuilds[0];
      expect(card.prUrl).toBe('https://github.com/mavencare/webplatform/pull/42');
    });

    it('falls back to githubBranchUrl when pr-sync returns null', () => {
      sync.setPrSync({ findPRByBranch: vi.fn().mockReturnValue(null) });
      sync.buildProjects = [makeCard({ branch: 'some/branch' })];
      sync.deployTargets = vivFooTargets;
      const data = sync.getBuildsPageData();
      const card = data.customers[0].allBuilds[0];
      expect(card.prUrl).toBeNull();
      expect(card.githubBranchUrl).toBe('https://github.com/mavencare/webplatform/tree/some%2Fbranch');
    });

    it('works without a pr-sync wired in', () => {
      sync.buildProjects = [makeCard({ branch: 'a/b' })];
      sync.deployTargets = vivFooTargets;
      const data = sync.getBuildsPageData();
      const card = data.customers[0].allBuilds[0];
      expect(card.prUrl).toBeNull();
      expect(card.githubBranchUrl).toBe('https://github.com/mavencare/webplatform/tree/a%2Fb');
    });
  });

  it('sources real branch from CodeBuild sourceVersion (strips refs/heads/)', async () => {
    aws = makeMockAws({
      projects: ['ECR-Build_viv-release-4_3_0'],
      builds: [{
        id: 'b:1', buildNumber: 1, buildStatus: 'SUCCEEDED',
        startTime: new Date('2026-04-13T10:00:00Z'),
        endTime: new Date('2026-04-13T10:25:00Z'),
        sourceVersion: 'refs/heads/some-real-branch',
        resolvedSourceVersion: 'abc123',
        initiator: 'webhook',
      }],
    });
    sync = new PipelineSync(releases, aws, repoManager, {});
    await sync.run();
    const card = sync.buildProjects[0];
    expect(card.branch).toBe('some-real-branch');
  });

  describe('getBuildsPageData customer-account filter', () => {
    function makeCard(overrides = {}) {
      return {
        projectName: 'proj', branch: 'master', account: 'ck',
        latestStatus: 'SUCCEEDED', latestStartTime: '2026-04-10T00:00:00Z',
        builds: [], newCommits: [], jiraKeys: [],
        ecrRepo: 'viv-release-ck', imageTag: 'has-targets',
        ...overrides,
      };
    }

    it('excludes cards with no deploy targets in the customer\'s account', () => {
      sync.buildProjects = [
        makeCard({ projectName: 'has', imageTag: 'has-targets' }),
        makeCard({ projectName: 'no', imageTag: 'no-targets' }),
      ];
      sync.deployTargets = {
        'has-targets': [{ pipelineName: 'Deploy-CK_Uat', account: 'ck' }],
      };
      const data = sync.getBuildsPageData();
      const ck = data.customers.find(c => c.key === 'ck');
      expect(ck.allBuilds.map(b => b.projectName)).toEqual(['has']);
    });

    it('respects TAG_ALIASES for master/latest', () => {
      sync.buildProjects = [makeCard({
        projectName: 'viv-master', account: 'Viv', ecrRepo: 'viv-master', imageTag: 'master', branch: 'master',
      })];
      sync.deployTargets = {
        latest: [{ pipelineName: 'Deploy-Viv_Dev03', account: 'Viv' }],
      };
      const data = sync.getBuildsPageData();
      const viv = data.customers.find(c => c.key === 'viv');
      expect(viv).toBeTruthy();
      expect(viv.allBuilds).toHaveLength(1);
    });

    it('pinned build skips empty builds and picks the most recent with targets', () => {
      sync.buildProjects = [
        makeCard({ projectName: 'older', imageTag: '4.1.0', latestStartTime: '2026-04-10T00:00:00Z' }),
        makeCard({ projectName: 'newer', imageTag: '4.2.0', latestStartTime: '2026-04-12T00:00:00Z' }),
      ];
      sync.deployTargets = {
        '4.1.0': [{ pipelineName: 'Deploy-CK_Older', account: 'ck' }],
        // newer has no matching target — should be excluded
      };
      const data = sync.getBuildsPageData();
      const ck = data.customers.find(c => c.key === 'ck');
      expect(ck.pinnedBuild?.projectName).toBe('older');
    });
  });

  it('handles IN_PROGRESS build', async () => {
    aws = makeMockAws({
      builds: [{
        id: 'build:1', buildNumber: 3, buildStatus: 'IN_PROGRESS',
        startTime: new Date('2026-04-13T14:00:00Z'), endTime: null,
        sourceVersion: 'releases/4.3.0', resolvedSourceVersion: 'inprog123',
        initiator: 'webhook',
      }],
    });
    sync = new PipelineSync(releases, aws, repoManager, {});
    await sync.run();

    const card = sync.buildProjects.find(b => b.version === '4.3.0');
    expect(card.latestStatus).toBe('IN_PROGRESS');
  });
});
