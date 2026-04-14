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
  };
}

function makeMockAws(opts = {}) {
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

  it('maps CodeBuild projects to releases', async () => {
    await sync.run();
    expect(aws.listProjects).toHaveBeenCalled();
    expect(sync._projectMap.has('4.3.0')).toBe(true);
  });

  it('fetches build status for active webplatform releases', async () => {
    await sync.run();
    expect(aws.getBuildsForProject).toHaveBeenCalledWith('ECR-Build_viv-release-4_3_0', 5);
  });

  it('skips done releases', async () => {
    const results = await sync.run();
    // Only 4.3.0 should be checked (4.2.0 is done, ios is not webplatform)
    expect(results.buildsChecked).toBe(1);
  });

  it('stores pipeline data on the release', async () => {
    await sync.run();
    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.pipeline).toBeTruthy();
    expect(release.pipeline.latest.status).toBe('SUCCEEDED');
    expect(release.pipeline.latest.buildNumber).toBe(1);
    expect(release.pipeline.latest.commitSha).toBe('abc123');
  });

  it('gets new commits from local git', async () => {
    await sync.run();
    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.pipeline.newCommits).toHaveLength(2);
    expect(release.pipeline.jiraKeys).toContain('DEV-45329');
    expect(release.pipeline.jiraKeys).toContain('DEV-45718');
  });

  it('does not fetch deploy pipelines (deploy status comes from env poller)', async () => {
    await sync.run();
    expect(aws.listPipelines).not.toHaveBeenCalled();
  });

  it('calls debounceSave', async () => {
    await sync.run();
    expect(releases._debounceSave).toHaveBeenCalled();
  });

  it('handles AWS errors gracefully', async () => {
    aws.listProjects = vi.fn(async () => { throw new Error('AWS down'); });
    sync = new PipelineSync(releases, aws, repoManager, {});
    const results = await sync.run();
    // Errors are caught internally — sync completes without crashing
    expect(results.releasesUpdated).toBe(0);
    // getBuildsForProject should not have been called since project map is empty
    expect(aws.getBuildsForProject).not.toHaveBeenCalled();
  });

  it('handles missing CodeBuild project for a release', async () => {
    aws = makeMockAws({ projects: [] }); // no projects
    sync = new PipelineSync(releases, aws, repoManager, {});
    const results = await sync.run();
    expect(results.buildsChecked).toBe(1);
    expect(results.releasesUpdated).toBe(0);
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

  it('getStatus reports project count', async () => {
    await sync.run();
    const status = sync.getStatus();
    expect(status.configured).toBe(true);
    expect(status.projectCount).toBe(1);
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

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.pipeline.latest.status).toBe('FAILED');
    expect(release.pipeline.builds).toHaveLength(2);
    // Should still compute commits between succeeded and failed
    expect(repoManager.log).toHaveBeenCalled();
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

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.pipeline.latest.status).toBe('IN_PROGRESS');
  });
});
