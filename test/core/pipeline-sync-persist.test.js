import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const { createTestDb } = require('../../src/core/db');
const PipelineSync = require('../../src/core/pipeline-sync');

function makeMockReleases() {
  return {
    list: () => [],
    releases: new Map(),
    _key: (repo, version) => `${repo}:${version}`,
    get: () => null,
    persist: vi.fn(),
  };
}

function makeMockAws() {
  return {
    isConfigured: () => true,
    getCrossAccountRoles: () => [],
    listProjects: vi.fn(async () => []),
    getBuildsForProject: vi.fn(async () => []),
    listPipelines: vi.fn(async () => []),
    getPipelineConfig: vi.fn(async () => ({ ecrRepo: 'test', ecrImageTag: 'master' })),
    getPipelineState: vi.fn(async () => ({ stages: [{ stageName: 'Deploy', status: 'Succeeded' }] })),
  };
}

function makeMockRepoManager() {
  return { log: vi.fn(async () => []) };
}

describe('PipelineSync SQLite persistence', () => {
  let db, sync, releases, aws, repoManager;

  beforeEach(() => {
    db = createTestDb();
    releases = makeMockReleases();
    aws = makeMockAws();
    repoManager = makeMockRepoManager();
    sync = new PipelineSync(releases, aws, repoManager, { polling: {} }, { db });
  });

  describe('_persistToDb', () => {
    it('writes build cards to SQLite', () => {
      sync.buildProjects = [
        {
          projectName: 'ECR-Build_viv-master',
          account: 'Viv',
          imageTag: 'master',
          latestStatus: 'SUCCEEDED',
          latestStartTime: '2026-04-17T10:00:00Z',
          builds: [],
        },
        {
          projectName: 'ECR-Build_viv-release-4_3_0',
          account: 'Viv',
          imageTag: '4.3.0',
          latestStatus: 'IN_PROGRESS',
          latestStartTime: '2026-04-17T11:00:00Z',
          builds: [],
        },
      ];
      sync.deployTargets = {};

      sync._persistToDb();

      const rows = db.prepare('SELECT * FROM build_cards ORDER BY projectName').all();
      expect(rows).toHaveLength(2);
      expect(rows[0].projectName).toBe('ECR-Build_viv-master');
      expect(rows[0].latestStatus).toBe('SUCCEEDED');
      expect(rows[0].imageTag).toBe('master');
      expect(rows[1].projectName).toBe('ECR-Build_viv-release-4_3_0');
      expect(rows[1].latestStatus).toBe('IN_PROGRESS');
    });

    it('writes deploy states to SQLite', () => {
      sync.buildProjects = [];
      sync.deployTargets = {
        'master': [
          { pipelineName: 'Deploy-Viv_Prod', customer: 'viv', env: 'production', status: 'Succeeded', account: 'Viv' },
          { pipelineName: 'Deploy-Viv_Staging', customer: 'viv', env: 'staging', status: 'Succeeded', account: 'Viv' },
        ],
        '4.3.0': [
          { pipelineName: 'Deploy-CK_Prod', customer: 'ck', env: 'production', status: 'InProgress', account: 'ck' },
        ],
      };

      sync._persistToDb();

      const rows = db.prepare('SELECT * FROM deploy_states ORDER BY pipelineName').all();
      expect(rows).toHaveLength(3);
      expect(rows[0].pipelineName).toBe('Deploy-CK_Prod');
      expect(rows[0].imageTag).toBe('4.3.0');
      expect(rows[0].customer).toBe('ck');
      expect(rows[1].pipelineName).toBe('Deploy-Viv_Prod');
      expect(rows[1].imageTag).toBe('master');
    });

    it('upserts on conflict (updates existing rows)', () => {
      sync.buildProjects = [
        { projectName: 'ECR-Build_test', account: 'Viv', imageTag: 'master', latestStatus: 'IN_PROGRESS', builds: [] },
      ];
      sync.deployTargets = {};
      sync._persistToDb();

      // Update status
      sync.buildProjects = [
        { projectName: 'ECR-Build_test', account: 'Viv', imageTag: 'master', latestStatus: 'SUCCEEDED', builds: [] },
      ];
      sync._persistToDb();

      const rows = db.prepare('SELECT * FROM build_cards').all();
      expect(rows).toHaveLength(1);
      expect(rows[0].latestStatus).toBe('SUCCEEDED');
    });
  });

  describe('getBuildsPageDataFromDb', () => {
    it('reads build cards and deploy states from SQLite', () => {
      // Persist some data first
      sync.buildProjects = [
        {
          projectName: 'ECR-Build_viv-master',
          account: 'Viv',
          imageTag: 'master',
          ecrRepo: 'viv-master',
          latestStatus: 'SUCCEEDED',
          latestStartTime: '2026-04-17T10:00:00Z',
          branch: 'master',
          builds: [],
        },
      ];
      sync.deployTargets = {
        'master': [
          { pipelineName: 'Deploy-Viv_Prod', customer: 'viv', env: 'production', status: 'Succeeded', account: 'Viv', ecrRepo: 'viv-master' },
        ],
      };
      sync._persistToDb();

      // Clear in-memory state to prove we read from DB
      sync.buildProjects = [];
      sync.deployTargets = {};

      const data = sync.getBuildsPageDataFromDb();
      expect(data.deployTargets).toHaveProperty('master');
      expect(data.deployTargets['master']).toHaveLength(1);
      expect(data.deployTargets['master'][0].pipelineName).toBe('Deploy-Viv_Prod');
    });

    it('returns empty data when DB is empty', () => {
      const data = sync.getBuildsPageDataFromDb();
      expect(data.customers).toEqual([]);
      expect(data.deployTargets).toEqual({});
    });
  });

  describe('in-progress tier query', () => {
    it('finds only IN_PROGRESS builds from DB', () => {
      // Insert test data directly
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO build_cards (projectName, account, imageTag, latestStatus, latestStartTime, data, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'ECR-Build_active', 'Viv', 'master', 'IN_PROGRESS', now, '{"projectName":"ECR-Build_active"}', now
      );
      db.prepare(`INSERT INTO build_cards (projectName, account, imageTag, latestStatus, latestStartTime, data, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'ECR-Build_done', 'Viv', '4.3.0', 'SUCCEEDED', now, '{"projectName":"ECR-Build_done"}', now
      );

      const rows = db.prepare("SELECT * FROM build_cards WHERE latestStatus = 'IN_PROGRESS'").all();
      expect(rows).toHaveLength(1);
      expect(rows[0].projectName).toBe('ECR-Build_active');
    });
  });

  describe('persistence during full sync', () => {
    it('persists after full sync completes', async () => {
      aws.listProjects.mockResolvedValue(['ECR-Build_viv-master']);
      aws.getBuildsForProject.mockResolvedValue([{
        buildNumber: 1,
        status: 'SUCCEEDED',
        startTime: '2026-04-17T10:00:00Z',
        endTime: '2026-04-17T10:25:00Z',
        resolvedSourceVersion: 'abc123',
        sourceVersion: 'refs/heads/master',
      }]);
      aws.listPipelines.mockResolvedValue([]);

      await sync.run();

      const rows = db.prepare('SELECT * FROM build_cards').all();
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
