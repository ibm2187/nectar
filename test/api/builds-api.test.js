import { describe, it, expect } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

const CANNED = {
  customers: [
    {
      key: 'viv',
      label: 'Viv',
      account: 'viv',
      pinnedBuild: null,
      recentBuilds: [],
      allBuilds: [],
    },
  ],
  deployTargets: {},
  lastRun: '2026-04-14T00:00:00Z',
};

function createBaseServices() {
  const db = createTestDb();
  const audit = new Audit({ db });
  const releases = new ReleaseManager(audit, { db });
  const themeConfig = new ThemeConfig({ db });

  return {
    releases,
    repoManager: { getStatus: () => [] },
    github: { isConfigured: () => false },
    risk: {},
    validator: {},
    approvals: new ApprovalEngine(releases, {
      approvals: { required: ['engineering', 'qa'], highRiskAdditional: ['product'] },
    }),
    customers: {},
    cherryPickWatcher: {},
    discovery: { getStatus: () => ({}) },
    jiraSync: { getStatus: () => ({}) },
    releaseTruth: {},
    customerStore: {
      listCustomers: () => [],
      listEnvironments: () => [],
      getCustomer: () => null,
      getEnvironment: () => null,
      listDeployments: () => [],
    },
    webplatformScanner: { getStatus: () => null },
    envPoller: { getStatus: () => ({}) },
    themeConfig,
  };
}

function createTestApp(services) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes(services, {}));
  return app;
}

async function getJson(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        { hostname: 'localhost', port, path, method: 'GET' },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

describe('GET /api/pipeline/builds', () => {
  it('returns customer-grouped shape from pipelineSync.getBuildsPageData', async () => {
    const services = createBaseServices();
    services.pipelineSync = { getBuildsPageData: () => CANNED };
    const app = createTestApp(services);

    const res = await getJson(app, '/api/pipeline/builds');
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(1);
    expect(res.body.customers[0].label).toBe('Viv');
    expect(res.body.customers[0]).not.toHaveProperty('pipelineCounts');
    expect(res.body.customers[0]).not.toHaveProperty('activeReleaseVersion');
    expect(res.body.deployTargets).toEqual({});
    expect(res.body.lastRun).toBe('2026-04-14T00:00:00Z');
  });

  it('falls back to empty builds payload when pipelineSync is not configured', async () => {
    const services = createBaseServices();
    // Intentionally no services.pipelineSync
    const app = createTestApp(services);

    const res = await getJson(app, '/api/pipeline/builds');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ builds: [], deployTargets: {}, lastRun: null });
  });
});
