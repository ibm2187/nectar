import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const createRoutes = require('../../src/api/routes');

// Minimal mock services
function createMockServices() {
  const audit = new Audit();
  const releases = new ReleaseManager(audit);
  // Clear any state loaded from disk so tests start clean
  releases.releases.clear();
  audit.entries = [];
  const themeConfig = new ThemeConfig();
  themeConfig.themes = [];
  themeConfig.unmappedLabel = 'Other';

  return {
    releases,
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
      listEnvironments: () => [],
      getCustomer: () => null,
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
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });

      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('API Routes', () => {

  describe('GET /api/releases', () => {
    it('returns empty array when no releases', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/releases');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns releases after creation', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0', repo: 'webplatform' });
      const res = await request(app, 'GET', '/api/releases');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].version).toBe('4.2.0');
    });
  });

  describe('POST /api/releases', () => {
    it('creates a release', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'POST', '/api/releases', {
        version: '4.3.0',
        repo: 'webplatform',
      });
      expect(res.status).toBe(201);
      expect(res.body.version).toBe('4.3.0');
    });

    it('returns 400 on duplicate', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'POST', '/api/releases', { version: '4.2.0' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already exists');
    });
  });

  describe('GET /api/releases/:version', () => {
    it('returns a release by version', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'GET', '/api/releases/4.2.0');
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('4.2.0');
    });

    it('returns 404 for unknown version', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/releases/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/releases/:version', () => {
    it('transitions release state', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'PATCH', '/api/releases/4.2.0', {
        state: 'cutting',
        user: 'tester',
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('cutting');
    });

    it('updates release fields', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'PATCH', '/api/releases/4.2.0', {
        notes: 'Important release',
      });
      expect(res.status).toBe(200);
      expect(res.body.notes).toBe('Important release');
    });

    it('returns 400 for invalid transition', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'PATCH', '/api/releases/4.2.0', {
        state: 'done',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/releases/:version', () => {
    it('deletes a release', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'DELETE', '/api/releases/4.2.0', { user: 'admin' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 404 for nonexistent release', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'DELETE', '/api/releases/nonexistent', {});
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/releases/:version/tickets', () => {
    it('adds a ticket', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'POST', '/api/releases/4.2.0/tickets', {
        key: 'DEV-100',
        summary: 'Fix bug',
      });
      expect(res.status).toBe(200);
      expect(res.body.tickets).toHaveLength(1);
    });
  });

  describe('POST /api/releases/:version/approve', () => {
    it('records approval', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'POST', '/api/releases/4.2.0/approve', {
        user: 'jsmith',
        role: 'engineering',
      });
      expect(res.status).toBe(200);
      expect(res.body.fullyApproved).toBe(false);
    });

    it('rejects invalid role', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'POST', '/api/releases/4.2.0/approve', {
        user: 'jsmith',
        role: 'legal',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tickets', () => {
    it('returns empty when no active releases', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/tickets');
      expect(res.status).toBe(200);
      expect(res.body.tickets).toEqual([]);
    });
  });

  describe('GET /api/states', () => {
    it('returns state machine definition', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/states');
      expect(res.status).toBe(200);
      expect(res.body.states).toContain('planning');
      expect(res.body.transitions).toBeDefined();
    });
  });

  describe('GET /api/customers', () => {
    it('returns empty customer list', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/customers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/config', () => {
    it('returns config values', async () => {
      const { app } = createTestApp(undefined, { repos: [] });
      const res = await request(app, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('jiraBaseUrl');
    });
  });

  describe('GET /api/roadmap', () => {
    it('returns roadmap structure', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/roadmap');
      expect(res.status).toBe(200);
      expect(res.body.months).toBeDefined();
      expect(res.body.themes).toBeDefined();
      expect(res.body.customers).toBeDefined();
    });
  });

  describe('GET/PUT /api/config/themes', () => {
    it('returns theme config', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/config/themes');
      expect(res.status).toBe(200);
      expect(res.body.themes).toBeDefined();
      expect(res.body.unmappedLabel).toBeDefined();
    });

    it('updates theme config', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'PUT', '/api/config/themes', {
        themes: [{ name: 'Billing', components: ['RCM - Billing'], icon: null }],
        unmappedLabel: 'Uncategorized',
      });
      expect(res.status).toBe(200);
      expect(res.body.themes).toHaveLength(1);
      expect(res.body.unmappedLabel).toBe('Uncategorized');
    });
  });

  describe('Error handling', () => {
    it('returns structured error for thrown errors', async () => {
      const { app, services } = createTestApp();
      // Force an error by trying to transition a nonexistent release
      const res = await request(app, 'PATCH', '/api/releases/nonexistent', {
        state: 'cutting',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });
  });
});
