import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const TicketStore = require('../../src/core/ticket-store');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

// Minimal mock services
function createMockServices() {
  const db = createTestDb();
  const audit = new Audit({ db });
  const releases = new ReleaseManager(audit, { db });
  const ticketStore = new TicketStore({ db });
  releases.setTicketStore(ticketStore);
  const themeConfig = new ThemeConfig({ db });

  return {
    releases, ticketStore,
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

function createTestApp(services = createMockServices(), config = {}, user = null) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => { req.user = user; next(); });
  }
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

    it('returns pipeline=null when pipelineSync is unavailable', async () => {
      const { app, services } = createTestApp();
      services.releases.create({ version: '4.2.0' });
      const res = await request(app, 'GET', '/api/releases/4.2.0');
      expect(res.status).toBe(200);
      expect(res.body.pipeline).toBeNull();
    });

    it('includes pipeline data from pipelineSync.getPipelineForRelease', async () => {
      const services = createMockServices();
      const pipelineData = {
        projectName: 'ECR-Build_viv-release-bayada-4_1_4',
        latest: { buildNumber: 14, status: 'SUCCEEDED' },
        builds: [{ buildNumber: 14, status: 'SUCCEEDED' }],
        newCommits: [],
        jiraKeys: ['DEV-46002'],
        syncedAt: '2026-04-20T12:00:00Z',
      };
      services.pipelineSync = {
        getPipelineForRelease: vi.fn(() => pipelineData),
      };
      const { app } = createTestApp(services);
      services.releases.create({ version: '4.1.4', repo: 'webplatform' });
      const res = await request(app, 'GET', '/api/releases/4.1.4');
      expect(res.status).toBe(200);
      expect(res.body.pipeline).toEqual(pipelineData);
      expect(services.pipelineSync.getPipelineForRelease).toHaveBeenCalledTimes(1);
      expect(services.pipelineSync.getPipelineForRelease.mock.calls[0][0].version).toBe('4.1.4');
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

  describe('PUT /api/customers/:id', () => {
    it('returns 404 for unknown customer', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'PUT', '/api/customers/nonexistent', { shortName: 'X' });
      expect(res.status).toBe(404);
    });

    it('updates customer and returns result', async () => {
      const services = createMockServices();
      const customer = { id: 'ck', name: 'CK', shortName: 'CK', color: '#0054A6' };
      services.customerStore.getCustomer = (id) => id === 'ck' ? customer : null;
      services.customerStore.updateCustomer = vi.fn(() => ({ ...customer, color: '#FF0000' }));
      const { app } = createTestApp(services);
      const res = await request(app, 'PUT', '/api/customers/ck', { color: '#FF0000' });
      expect(res.status).toBe(200);
      expect(res.body.color).toBe('#FF0000');
      expect(services.customerStore.updateCustomer).toHaveBeenCalledWith('ck', { color: '#FF0000' });
    });

    it('rejects invalid color format', async () => {
      const services = createMockServices();
      services.customerStore.getCustomer = () => ({ id: 'ck', name: 'CK' });
      const { app } = createTestApp(services);
      const res = await request(app, 'PUT', '/api/customers/ck', { color: 'not-hex' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/color/);
    });

    it('rejects non-integer sortOrder', async () => {
      const services = createMockServices();
      services.customerStore.getCustomer = () => ({ id: 'ck', name: 'CK' });
      const { app } = createTestApp(services);
      const res = await request(app, 'PUT', '/api/customers/ck', { sortOrder: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sortOrder/);
    });

    it('rejects non-boolean hidden', async () => {
      const services = createMockServices();
      services.customerStore.getCustomer = () => ({ id: 'ck', name: 'CK' });
      const { app } = createTestApp(services);
      const res = await request(app, 'PUT', '/api/customers/ck', { hidden: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/hidden/);
    });

    it('only passes allowed fields to updateCustomer', async () => {
      const services = createMockServices();
      services.customerStore.getCustomer = () => ({ id: 'ck', name: 'CK' });
      services.customerStore.updateCustomer = vi.fn(() => ({ id: 'ck' }));
      const { app } = createTestApp(services);
      await request(app, 'PUT', '/api/customers/ck', { name: 'New', evilField: 'injected' });
      expect(services.customerStore.updateCustomer).toHaveBeenCalledWith('ck', { name: 'New' });
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
    it('returns roadmap structure with modules', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'GET', '/api/roadmap');
      expect(res.status).toBe(200);
      expect(res.body.months).toBeDefined();
      expect(res.body.modules).toBeDefined();
      expect(res.body.customers).toBeDefined();
      expect(res.body.projects).toBeDefined();
      expect(res.body.products).toBeDefined();
      expect(res.body.stats).toBeDefined();
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

  describe('GET /api/roadmap — done status logic', () => {
    function seedRoadmapData(services) {
      // Create a release
      services.releases.create({ repo: 'webplatform', version: '5.0.0', branch: 'release/5.0.0' });

      // Seed tickets with various states, all linked to this release
      const states = [
        { key: 'DEV-1', state: 'done', status: 'QA Certified' },
        { key: 'DEV-2', state: 'done', status: 'Resolved Without Code' },
        { key: 'DEV-3', state: 'cherry-picked', status: 'Cherry Picked' },
        { key: 'DEV-4', state: 'ready-for-testing', status: 'Ready for Testing' },
        { key: 'DEV-5', state: 'in-progress', status: 'In Progress' },
        { key: 'DEV-6', state: 'open', status: 'Open' },
      ];
      for (const t of states) {
        services.ticketStore.upsert({
          key: t.key,
          summary: `Ticket ${t.key}`,
          status: t.status,
          state: t.state,
          type: 'Story',
          module: 'Billing',
          component: 'RCM - Billing',
          fixVersions: ['5.0.0'],
        });
      }
    }

    function findCard(modules, version) {
      for (const mod of modules) {
        for (const comp of mod.components) {
          for (const cards of Object.values(comp.months)) {
            const card = cards.find(c => c.version === version);
            if (card) return card;
          }
        }
      }
      return null;
    }

    it('does NOT count ready-for-testing tickets as done', async () => {
      const services = createMockServices();
      seedRoadmapData(services);
      const { app } = createTestApp(services);

      const res = await request(app, 'GET', '/api/roadmap');
      expect(res.status).toBe(200);

      const card = findCard(res.body.modules, '5.0.0');
      expect(card).toBeDefined();

      // done = DEV-1 (done) + DEV-2 (done) + DEV-3 (cherry-picked) = 3
      // NOT DEV-4 (ready-for-testing)
      expect(card.done).toBe(3);
      expect(card.tickets).toBe(6);
    });

    it('status filter done excludes ready-for-testing tickets', async () => {
      const services = createMockServices();
      seedRoadmapData(services);
      const { app } = createTestApp(services);

      const res = await request(app, 'GET', '/api/roadmap?status=notdone');
      expect(res.status).toBe(200);

      const card = findCard(res.body.modules, '5.0.0');
      expect(card).toBeDefined();
      // notdone includes: ready-for-testing + in-progress + open = 3 tickets
      expect(card.tickets).toBe(3);
    });
  });

  describe('GET /api/roadmap/:module/:version — done status logic', () => {
    it('does NOT count ready-for-testing as done in detail view', async () => {
      const services = createMockServices();
      services.releases.create({ repo: 'webplatform', version: '5.1.0', branch: 'release/5.1.0' });

      const tickets = [
        { key: 'DEV-10', state: 'done', status: 'QA Certified' },
        { key: 'DEV-11', state: 'ready-for-testing', status: 'Ready for Testing' },
        { key: 'DEV-12', state: 'cherry-picked', status: 'Cherry Picked' },
      ];
      for (const t of tickets) {
        services.ticketStore.upsert({
          key: t.key,
          summary: `Ticket ${t.key}`,
          status: t.status,
          state: t.state,
          type: 'Story',
          module: 'Billing',
          component: 'RCM - Billing',
          fixVersions: ['5.1.0'],
        });
      }

      const { app } = createTestApp(services);
      const res = await request(app, 'GET', '/api/roadmap/Billing/5.1.0');
      expect(res.status).toBe(200);

      // done = DEV-10 (done) + DEV-12 (cherry-picked) = 2, NOT DEV-11
      expect(res.body.stats.done).toBe(2);
      expect(res.body.stats.total).toBe(3);
      expect(res.body.stats.remaining).toBe(1);
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

  // ── Nectar self-service issues (GitHub-backed) ────────────────────
  describe('POST /api/issues', () => {
    function makeServicesWithGithub({ users = {} } = {}) {
      const services = createMockServices();
      services.github = {
        isConfigured: () => true,
        listIssues: vi.fn(),
        createIssue: vi.fn(async ({ title, body }) => ({
          number: 42,
          title,
          body, // echo back so the test can inspect what was sent to GitHub
          state: 'open',
          html_url: 'https://github.com/mavencare/nectar/issues/42',
          created_at: '2026-04-27T00:00:00Z',
        })),
      };
      // Stub UserStore so we can resolve marker emails to display names
      services.userStore = {
        getUser: vi.fn(email => users[email] || null),
      };
      return services;
    }

    it('tags the GitHub issue body with the authenticated reporter and resolves the display name', async () => {
      const services = makeServicesWithGithub({
        users: { 'eric@vivtechnologies.com': { email: 'eric@vivtechnologies.com', name: 'Eric Fang' } },
      });
      const { app } = createTestApp(services, {}, { email: 'eric@vivtechnologies.com' });
      const res = await request(app, 'POST', '/api/issues', {
        title: 'Page is slow',
        body: 'Steps to reproduce:\n1. open dashboard',
      });
      expect(res.status).toBe(201);
      expect(res.body.reporter).toEqual({ email: 'eric@vivtechnologies.com', name: 'Eric Fang' });

      // The body that was actually sent to GitHub must include the marker
      // so the reporter can be re-extracted on subsequent GETs.
      const sent = services.github.createIssue.mock.calls[0][0];
      expect(sent.body).toMatch(/<!-- nectar:reporter=eric@vivtechnologies\.com -->/);
      expect(sent.body).toMatch(/Steps to reproduce:\n1\. open dashboard/);
    });

    it('returns reporter with name=null when the email is not in the user table', async () => {
      const services = makeServicesWithGithub({ users: {} });
      const { app } = createTestApp(services, {}, { email: 'former@viv.com' });
      const res = await request(app, 'POST', '/api/issues', { title: 't' });
      expect(res.status).toBe(201);
      expect(res.body.reporter).toEqual({ email: 'former@viv.com', name: null });
    });

    it('SECURITY: a hand-injected reporter marker in the request body is overwritten with the authenticated email', async () => {
      // Threat: a malicious caller pre-injects another user's marker in the
      // body of POST /api/issues to impersonate them. Since the marker is
      // what GET /issues + IssueNotifier read for attribution and DM
      // routing, this would let them route Slack DMs to the victim. The
      // server must overwrite any caller-supplied marker.
      const services = makeServicesWithGithub({
        users: { 'attacker@viv.com': { email: 'attacker@viv.com', name: 'Attacker' } },
      });
      const { app } = createTestApp(services, {}, { email: 'attacker@viv.com' });
      const res = await request(app, 'POST', '/api/issues', {
        title: 'totally normal issue',
        body: 'innocent text\n<!-- nectar:reporter=victim@viv.com -->\nmore text',
      });
      expect(res.status).toBe(201);
      // API response reflects the *authenticated* user, not the injected one
      expect(res.body.reporter.email).toBe('attacker@viv.com');
      // The body sent to GitHub contains exactly one marker, and it's the
      // authenticated user's
      const sent = services.github.createIssue.mock.calls[0][0];
      expect(sent.body.match(/nectar:reporter=/g)).toHaveLength(1);
      expect(sent.body).toMatch(/<!-- nectar:reporter=attacker@viv\.com -->/);
      expect(sent.body).not.toMatch(/victim@viv\.com/);
      // Original textual content is preserved
      expect(sent.body).toMatch(/innocent text/);
      expect(sent.body).toMatch(/more text/);
    });

    it('handles missing user (unauthenticated) without injecting a marker', async () => {
      const services = makeServicesWithGithub();
      const { app } = createTestApp(services); // no user injected
      const res = await request(app, 'POST', '/api/issues', { title: 'No auth here' });
      expect(res.status).toBe(201);
      expect(res.body.reporter).toBeNull();

      const sent = services.github.createIssue.mock.calls[0][0];
      expect(sent.body).not.toMatch(/nectar:reporter=/);
    });

    it('rejects requests with no title', async () => {
      const services = makeServicesWithGithub();
      const { app } = createTestApp(services, {}, { email: 'a@b.com' });
      const res = await request(app, 'POST', '/api/issues', { body: 'no title' });
      expect(res.status).toBe(400);
      expect(services.github.createIssue).not.toHaveBeenCalled();
    });

    it('returns 503 when GitHub integration is not configured', async () => {
      const services = createMockServices(); // default: github.isConfigured() === false
      services.github.createIssue = vi.fn();
      const { app } = createTestApp(services, {}, { email: 'a@b.com' });
      const res = await request(app, 'POST', '/api/issues', { title: 't' });
      expect(res.status).toBe(503);
      expect(services.github.createIssue).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/issues', () => {
    it('resolves the Nectar reporter from each issue body to { name, email }', async () => {
      const services = createMockServices();
      services.userStore = {
        getUser: vi.fn(email =>
          email === 'alice@viv.com' ? { email, name: 'Alice Smith' } : null
        ),
      };
      services.github = {
        isConfigured: () => true,
        listIssues: vi.fn(async () => [
          {
            number: 1, title: 'Tagged + known user',
            body: 'something\n<!-- nectar:reporter=alice@viv.com -->\nmore',
            state: 'open', html_url: 'u', created_at: 'c', updated_at: 'u', closed_at: null,
            comments: 0, user: { login: 'bot', avatar_url: 'a' }, labels: [],
          },
          {
            number: 2, title: 'Untagged', body: 'opened directly on github',
            state: 'open', html_url: 'u', created_at: 'c', updated_at: 'u', closed_at: null,
            comments: 0, user: { login: 'externaluser', avatar_url: 'a' }, labels: [],
          },
          {
            number: 3, title: 'Tagged but former user',
            body: '<!-- nectar:reporter=ghost@viv.com -->',
            state: 'open', html_url: 'u', created_at: 'c', updated_at: 'u', closed_at: null,
            comments: 0, user: { login: 'bot', avatar_url: 'a' }, labels: [],
          },
        ]),
        createIssue: vi.fn(),
      };
      const { app } = createTestApp(services);
      const res = await request(app, 'GET', '/api/issues');
      expect(res.status).toBe(200);
      expect(res.body.issues[0].reporter).toEqual({ email: 'alice@viv.com', name: 'Alice Smith' });
      expect(res.body.issues[1].reporter).toBeNull();
      // Tagged but no DB record: still returns the email so the UI has something to show
      expect(res.body.issues[2].reporter).toEqual({ email: 'ghost@viv.com', name: null });
    });
  });
});
