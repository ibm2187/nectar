import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const TicketStore = require('../../src/core/ticket-store');
const TaskQueue = require('../../src/core/task-queue');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

function createMockServices() {
  const db = createTestDb();
  const audit = new Audit({ db });
  const releases = new ReleaseManager(audit, { db });
  const ticketStore = new TicketStore({ db });
  releases.setTicketStore(ticketStore);
  const themeConfig = new ThemeConfig({ db });
  const taskQueue = new TaskQueue({ db });

  return {
    releases, ticketStore, taskQueue,
    repoManager: { getStatus: () => [] },
    github: {
      isConfigured: () => false,
      listIssues: vi.fn(),
      createIssue: vi.fn(),
    },
    risk: { assess: vi.fn() },
    validator: { validate: vi.fn() },
    approvals: new ApprovalEngine(releases, {
      approvals: { required: ['engineering', 'qa'], highRiskAdditional: ['product'] },
    }),
    customers: {},
    cherryPickWatcher: { syncRelease: vi.fn() },
    discovery: { getStatus: () => ({}), run: vi.fn() },
    jiraSync: { getStatus: () => ({}), run: vi.fn() },
    releaseTruth: { compute: vi.fn(), computeImpact: vi.fn() },
    customerStore: {
      listCustomers: () => [],
      listVisibleCustomers: () => [],
      listEnvironments: () => [],
      getCustomer: () => null,
      updateCustomer: vi.fn(),
      getEnvironment: () => null,
      listDeployments: () => [],
      setManualVersionBulk: vi.fn(() => []),
      setManualVersion: vi.fn(),
    },
    webplatformScanner: { scan: vi.fn(), getStatus: () => null },
    envPoller: { run: vi.fn(), getStatus: () => ({}) },
    themeConfig,
  };
}

function createTestApp(services = createMockServices(), config = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes(services, config));
  return { app, services };
}

async function request(app, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const opts = {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
          } catch {
            resolve({ status: res.statusCode, body: data, raw: data });
          }
        });
      });

      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('GET /api/releases/:version/draft', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear S3 env vars so S3 is "not configured"
    delete process.env.RELEASE_ARTIFACTS_BUCKET;
    delete process.env.RELEASE_ARTIFACTS_REGION;
    delete process.env.RELEASE_ARTIFACTS_AWS_ACCESS_KEY_ID;
    delete process.env.RELEASE_ARTIFACTS_AWS_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns release.notes as fallback when S3 is not configured', async () => {
    const { app, services } = createTestApp();
    services.releases.create({ version: '4.2.0', repo: 'webplatform' });
    services.releases.update('4.2.0', { notes: '# Release 4.2.0\n\nChanges here.' }, 'test');

    const res = await request(app, 'GET', '/api/releases/4.2.0/draft');
    expect(res.status).toBe(200);
    expect(res.raw).toBe('# Release 4.2.0\n\nChanges here.');
  });

  it('returns 404 when S3 not configured and no release.notes', async () => {
    const { app, services } = createTestApp();
    services.releases.create({ version: '4.2.0', repo: 'webplatform' });

    const res = await request(app, 'GET', '/api/releases/4.2.0/draft');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No draft found/);
  });

  it('returns 404 when S3 not configured and release does not exist', async () => {
    const { app } = createTestApp();

    const res = await request(app, 'GET', '/api/releases/9.9.9/draft');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No draft found/);
  });
});

describe('PUT /api/releases/:version/draft', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.RELEASE_ARTIFACTS_BUCKET;
    delete process.env.RELEASE_ARTIFACTS_AWS_ACCESS_KEY_ID;
    delete process.env.RELEASE_ARTIFACTS_AWS_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('saves draft to release.notes when S3 is not configured', async () => {
    const { app, services } = createTestApp();
    services.releases.create({ version: '4.2.0', repo: 'webplatform' });

    const res = await request(app, 'PUT', '/api/releases/4.2.0/draft', {
      content: '# Edited notes\n\nUpdated.',
      regenerate: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);

    // Verify it persisted on the release
    const release = services.releases.get('4.2.0');
    expect(release.notes).toBe('# Edited notes\n\nUpdated.');
  });

  it('round-trips: PUT then GET returns the edited content', async () => {
    const { app, services } = createTestApp();
    services.releases.create({ version: '4.2.0', repo: 'webplatform' });

    await request(app, 'PUT', '/api/releases/4.2.0/draft', {
      content: '# Round trip test',
      regenerate: false,
    });

    const res = await request(app, 'GET', '/api/releases/4.2.0/draft');
    expect(res.status).toBe(200);
    expect(res.raw).toBe('# Round trip test');
  });

  it('rejects missing content', async () => {
    const { app, services } = createTestApp();
    services.releases.create({ version: '4.2.0', repo: 'webplatform' });

    const res = await request(app, 'PUT', '/api/releases/4.2.0/draft', {
      regenerate: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content.*required/i);
  });

  it('returns 404 when release does not exist', async () => {
    const { app } = createTestApp();

    const res = await request(app, 'PUT', '/api/releases/9.9.9/draft', {
      content: '# Does not exist',
      regenerate: false,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
