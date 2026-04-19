import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const TicketStore = require('../../src/core/ticket-store');
const PrStore = require('../../src/core/pr-store');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

const today = new Date().toISOString().slice(0, 10);
const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function createMockServices(db) {
  const audit = new Audit({ db });
  const releases = new ReleaseManager(audit, { db });
  const themeConfig = new ThemeConfig({ db });
  const ticketStore = new TicketStore({ db });
  const prStore = new PrStore({ db });

  releases.setTicketStore(ticketStore);
  return {
    releases, ticketStore, prStore, themeConfig,
    repoManager: { getStatus: () => [] },
    github: { isConfigured: () => false, listIssues: vi.fn(), createIssue: vi.fn() },
    risk: { assess: vi.fn() },
    validator: { validate: vi.fn() },
    approvals: new ApprovalEngine(releases, { approvals: { required: ['engineering', 'qa'] } }),
    customers: {},
    cherryPickWatcher: { syncRelease: vi.fn() },
    discovery: { getStatus: () => ({}), run: vi.fn() },
    jiraSync: { getStatus: () => ({}), run: vi.fn(), runTicketSync: vi.fn() },
    releaseTruth: { compute: vi.fn(), computeImpact: vi.fn() },
    customerStore: {
      listCustomers: () => [], listEnvironments: () => [], getCustomer: () => null,
      getEnvironment: () => null, listDeployments: () => [],
      setManualVersionBulk: vi.fn(() => []), setManualVersion: vi.fn(),
    },
    webplatformScanner: { scan: vi.fn(), getStatus: () => null },
    envPoller: { run: vi.fn(), getStatus: () => ({}) },
  };
}

function createTestApp(services, config = {}) {
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
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json' },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function seedRelease(services, { version, repo = 'webplatform', jiraReleaseDate, state = 'stabilizing' }) {
  const release = services.releases.create({ repo, version, branch: `releases/${version}` });
  release.jiraReleaseDate = jiraReleaseDate;
  release.jiraVersionName = version;
  // Transition to desired state
  const key = services.releases._key(repo, version);
  if (state === 'stabilizing') {
    services.releases.transition(key, 'cutting', 'test');
    services.releases.transition(key, 'stabilizing', 'test');
  }
  services.releases.persist(release);
  return release;
}

function seedTicket(ticketStore, overrides = {}) {
  ticketStore.upsert({
    key: 'DEV-100',
    summary: 'Test ticket',
    status: 'In Review',
    statusCategory: 'In Progress',
    state: 'in-progress',
    type: 'Bug',
    assignee: 'Alice',
    reporter: 'Bob',
    qaAssignee: 'Carol',
    productAssignee: null,
    component: 'Auth',
    priority: 'High',
    riskLevel: null,
    customerPriority: null,
    fixVersions: ['4.2.1'],
    targetFixVersions: ['4.2.1'],
    customerTags: [],
    deployedEnvironments: [],
    labels: [],
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: '2026-04-10T10:00:00Z',
    updatedInJira: '2026-04-16T14:00:00Z',
    syncedAt: '2026-04-16T15:00:00Z',
    ...overrides,
  });
}

describe('Routes with TicketStore', () => {
  let db, services, app;

  beforeEach(() => {
    db = createTestDb();
    db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();
    services = createMockServices(db);
    ({ app } = createTestApp(services));
  });

  describe('GET /api/releases/home', () => {
    it('returns tickets from TicketStore for each release', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', fixVersions: ['4.2.1'], assignee: 'Alice' });
      seedTicket(services.ticketStore, { key: 'DEV-101', fixVersions: ['4.2.1'], assignee: 'Bob' });

      const res = await request(app, 'GET', '/api/releases/home');
      expect(res.status).toBe(200);
      const release = res.body.find(r => r.version === '4.2.1');
      expect(release).toBeDefined();
      expect(release.tickets).toHaveLength(2);
      expect(release.tickets[0].key).toBe('DEV-100');
      expect(release.tickets[0].jiraStatus).toBe('In Review');
    });

    it('filters tickets by person and view', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', fixVersions: ['4.2.1'], assignee: 'Alice' });
      seedTicket(services.ticketStore, { key: 'DEV-101', fixVersions: ['4.2.1'], assignee: 'Bob' });

      const res = await request(app, 'GET', '/api/releases/home?view=dev&person=Alice');
      expect(res.status).toBe(200);
      const release = res.body.find(r => r.version === '4.2.1');
      expect(release.tickets).toHaveLength(1);
      expect(release.tickets[0].assignee).toBe('Alice');
    });
  });

  describe('GET /api/tickets', () => {
    it('aggregates tickets across releases from TicketStore', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedRelease(services, { version: '4.3.0', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', fixVersions: ['4.2.1'], targetFixVersions: ['4.2.1'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', fixVersions: ['4.3.0'], targetFixVersions: [] });

      const res = await request(app, 'GET', '/api/tickets');
      expect(res.status).toBe(200);
      expect(res.body.tickets).toHaveLength(2);
      expect(res.body.stats.total).toBe(2);
    });

    it('correctly identifies release source (both/target/fixVersion)', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, {
        key: 'DEV-100',
        fixVersions: ['4.2.1'],
        targetFixVersions: ['4.2.1'],
      });
      seedTicket(services.ticketStore, {
        key: 'DEV-101',
        fixVersions: [],
        targetFixVersions: ['4.2.1'],
      });

      const res = await request(app, 'GET', '/api/tickets');
      const t100 = res.body.tickets.find(t => t.key === 'DEV-100');
      const t101 = res.body.tickets.find(t => t.key === 'DEV-101');
      expect(t100.releases[0].source).toBe('both');
      expect(t101.releases[0].source).toBe('target');
    });

    it('deduplicates tickets across releases', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedRelease(services, { version: '4.3.0', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, {
        key: 'DEV-100',
        fixVersions: ['4.2.1', '4.3.0'],
        targetFixVersions: [],
      });

      const res = await request(app, 'GET', '/api/tickets');
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].releases).toHaveLength(2);
    });
  });

  describe('GET /api/tickets/scope', () => {
    it('returns QA scope tickets', async () => {
      seedTicket(services.ticketStore, {
        key: 'DEV-100', statusCategory: 'Done', status: 'QA Certified',
        fixVersions: [], state: 'done',
      });
      seedTicket(services.ticketStore, {
        key: 'DEV-101', statusCategory: 'In Progress', status: 'In Review',
        fixVersions: [], state: 'in-progress',
      });

      const res = await request(app, 'GET', '/api/tickets/scope');
      expect(res.status).toBe(200);
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].key).toBe('DEV-100');
    });
  });

  describe('GET /api/tickets/triage', () => {
    it('returns recently created To Do tickets', async () => {
      seedTicket(services.ticketStore, {
        key: 'DEV-100', statusCategory: 'To Do', created: today, state: 'pending',
      });
      seedTicket(services.ticketStore, {
        key: 'DEV-101', statusCategory: 'In Progress', created: today, state: 'in-progress',
      });

      const res = await request(app, 'GET', '/api/tickets/triage?since=' + today);
      expect(res.status).toBe(200);
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].key).toBe('DEV-100');
    });
  });

  describe('GET /api/tickets/sync-status', () => {
    it('returns sync metadata and stats', async () => {
      seedTicket(services.ticketStore, { key: 'DEV-100', statusCategory: 'Done', type: 'Bug' });
      seedTicket(services.ticketStore, { key: 'DEV-101', statusCategory: 'In Progress', type: 'Story' });

      const res = await request(app, 'GET', '/api/tickets/sync-status');
      expect(res.status).toBe(200);
      expect(res.body.stats.total).toBe(2);
      expect(res.body.stats.byStatusCategory.Done).toBe(1);
      expect(res.body.stats.byType.Bug).toBe(1);
    });
  });

  describe('GET /api/tickets/search', () => {
    it('searches tickets by query', async () => {
      seedTicket(services.ticketStore, { key: 'DEV-100', summary: 'Login bug' });
      seedTicket(services.ticketStore, { key: 'DEV-101', summary: 'Dashboard fix' });

      const res = await request(app, 'GET', '/api/tickets/search?q=login');
      expect(res.status).toBe(200);
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].key).toBe('DEV-100');
    });
  });

  describe('GET /api/tickets/:key/releases', () => {
    it('returns releases for a ticket from TicketStore', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', fixVersions: ['4.2.1'], targetFixVersions: [] });

      const res = await request(app, 'GET', '/api/tickets/DEV-100/releases');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].version).toBe('4.2.1');
    });

    it('returns empty array for unknown ticket', async () => {
      const res = await request(app, 'GET', '/api/tickets/DEV-999/releases');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/prs/by-ticket/:key', () => {
    it('returns PRs linked to a ticket', async () => {
      services.prStore.upsert({
        prNumber: 25500, repo: 'mavencare/webplatform', prTitle: 'Fix DEV-100',
        prAuthor: 'alice', prUrl: 'https://github.com/test/25500', status: 'open',
        baseBranch: 'main', headBranch: 'fix/login', prCreatedAt: '2026-04-10T08:00:00Z',
        prUpdatedAt: '2026-04-16T14:00:00Z', syncedAt: '2026-04-16T15:00:00Z',
      }, ['DEV-100']);

      const res = await request(app, 'GET', '/api/prs/by-ticket/DEV-100');
      expect(res.status).toBe(200);
      expect(res.body.prs).toHaveLength(1);
      expect(res.body.prs[0].prNumber).toBe(25500);
    });
  });

  describe('GET /api/search', () => {
    it('searches tickets from TicketStore', async () => {
      seedTicket(services.ticketStore, { key: 'DEV-100', summary: 'Login timeout bug' });

      const res = await request(app, 'GET', '/api/search?q=login');
      expect(res.status).toBe(200);
      const tickets = (res.body.results || res.body).filter(r => r.type === 'ticket');
      expect(tickets).toHaveLength(1);
      expect(tickets[0].key).toBe('DEV-100');
    });
  });

  describe('GET /api/people', () => {
    it('extracts people from TicketStore tickets', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, {
        key: 'DEV-100', fixVersions: ['4.2.1'], assignee: 'Alice', qaAssignee: 'Carol',
      });

      const res = await request(app, 'GET', '/api/people');
      expect(res.status).toBe(200);
      const alice = res.body.find(p => p.name === 'Alice');
      const carol = res.body.find(p => p.name === 'Carol');
      expect(alice).toBeDefined();
      expect(carol).toBeDefined();
    });
  });

  describe('empty TicketStore', () => {
    it('returns empty tickets when TicketStore has no data', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });

      const res = await request(app, 'GET', '/api/releases/home');
      expect(res.status).toBe(200);
      const release = res.body.find(r => r.version === '4.2.1');
      expect(release.tickets).toHaveLength(0);
    });
  });

  // ── Taxonomy field endpoints ─────────────────────────

  describe('GET /api/tickets/filter-options', () => {
    it('returns distinct values for filter dropdowns', async () => {
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', customerTags: ['CK'], product: ['Web Platform'], projects: ['RCM V2'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Scheduling', customerTags: ['Lumen'], product: ['Mobile (iOS)'], projects: [] });

      const res = await request(app, 'GET', '/api/tickets/filter-options');
      expect(res.status).toBe(200);
      expect(res.body.modules.sort()).toEqual(['Billing', 'Scheduling']);
      expect(res.body.customers.sort()).toEqual(['CK', 'Lumen']);
      expect(res.body.products.sort()).toEqual(['Mobile (iOS)', 'Web Platform']);
      expect(res.body.projects).toEqual(['RCM V2']);
    });
  });

  describe('GET /api/tickets/by-module', () => {
    it('returns modules with counts', async () => {
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing' });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing' });
      seedTicket(services.ticketStore, { key: 'DEV-102', module: 'AI' });

      const res = await request(app, 'GET', '/api/tickets/by-module');
      expect(res.status).toBe(200);
      expect(res.body.modules).toEqual([
        { module: 'Billing', count: 2 },
        { module: 'AI', count: 1 },
      ]);
    });
  });

  describe('GET /api/tickets/by-module/:module/components', () => {
    it('returns components for a module', async () => {
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', component: 'RCM - Invoicing' });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing', component: 'RCM - Invoicing' });
      seedTicket(services.ticketStore, { key: 'DEV-102', module: 'Billing', component: 'RCM - Payments' });

      const res = await request(app, 'GET', '/api/tickets/by-module/Billing/components');
      expect(res.status).toBe(200);
      expect(res.body.components).toEqual([
        { component: 'RCM - Invoicing', count: 2 },
        { component: 'RCM - Payments', count: 1 },
      ]);
    });
  });

  describe('GET /api/tickets/search with taxonomy filters', () => {
    beforeEach(() => {
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', component: 'RCM - Invoicing', customerTags: ['CK'], product: ['Web Platform'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing', component: 'RCM - Payments', customerTags: [], product: ['Web Platform'] });
      seedTicket(services.ticketStore, { key: 'DEV-102', module: 'Scheduling', component: 'Visit Editing', customerTags: ['Bayada'], product: ['Web Platform'] });
    });

    it('filters by module', async () => {
      const res = await request(app, 'GET', '/api/tickets/search?module=Billing');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    });

    it('filters by component', async () => {
      const res = await request(app, 'GET', '/api/tickets/search?component=RCM%20-%20Invoicing');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
    });

    it('filters by customer (includes untagged)', async () => {
      const res = await request(app, 'GET', '/api/tickets/search?customer=CK');
      expect(res.status).toBe(200);
      // DEV-100 (CK) + DEV-101 (no customer = included)
      expect(res.body.total).toBe(2);
    });
  });

  // ── Roadmap with modules ─────────────────────────────

  describe('GET /api/roadmap with modules', () => {
    it('returns modules instead of themes', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', component: 'RCM - Invoicing', fixVersions: ['4.2.1'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing', component: 'RCM - Payments', fixVersions: ['4.2.1'] });
      seedTicket(services.ticketStore, { key: 'DEV-102', module: 'Scheduling', component: 'Visit Editing', fixVersions: ['4.2.1'] });

      const res = await request(app, 'GET', '/api/roadmap');
      expect(res.status).toBe(200);
      expect(res.body.modules).toBeDefined();
      expect(res.body.modules.length).toBeGreaterThanOrEqual(2);

      const billing = res.body.modules.find(m => m.name === 'Billing');
      expect(billing).toBeDefined();
      expect(billing.totalTickets).toBe(2);
      expect(billing.components).toHaveLength(2);
      expect(billing.components.map(c => c.name).sort()).toEqual(['RCM - Invoicing', 'RCM - Payments']);

      const scheduling = res.body.modules.find(m => m.name === 'Scheduling');
      expect(scheduling).toBeDefined();
      expect(scheduling.totalTickets).toBe(1);
    });

    it('filters by customer — includes untagged tickets', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', fixVersions: ['4.2.1'], customerTags: ['CK'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing', fixVersions: ['4.2.1'], customerTags: [] });
      seedTicket(services.ticketStore, { key: 'DEV-102', module: 'Billing', fixVersions: ['4.2.1'], customerTags: ['Bayada'] });

      const res = await request(app, 'GET', '/api/roadmap?customer=CK');
      expect(res.status).toBe(200);
      const billing = res.body.modules.find(m => m.name === 'Billing');
      // DEV-100 (CK) + DEV-101 (no customer) included; DEV-102 (Bayada only) excluded
      expect(billing.totalTickets).toBe(2);
    });

    it('filters by project', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', fixVersions: ['4.2.1'], projects: ['RCM V2'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing', fixVersions: ['4.2.1'], projects: [] });

      const res = await request(app, 'GET', '/api/roadmap?project=RCM%20V2');
      expect(res.status).toBe(200);
      const billing = res.body.modules.find(m => m.name === 'Billing');
      expect(billing.totalTickets).toBe(1);
    });
  });

  describe('GET /api/roadmap/:module/:version', () => {
    it('returns tickets for a module and release', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', component: 'RCM - Invoicing', fixVersions: ['4.2.1'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Scheduling', component: 'Visit Editing', fixVersions: ['4.2.1'] });

      const res = await request(app, 'GET', '/api/roadmap/Billing/4.2.1');
      expect(res.status).toBe(200);
      expect(res.body.module).toBe('Billing');
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].key).toBe('DEV-100');
      expect(res.body.tickets[0].module).toBe('Billing');
      expect(res.body.tickets[0].component).toBe('RCM - Invoicing');
    });

    it('filters by component within module', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, { key: 'DEV-100', module: 'Billing', component: 'RCM - Invoicing', fixVersions: ['4.2.1'] });
      seedTicket(services.ticketStore, { key: 'DEV-101', module: 'Billing', component: 'RCM - Payments', fixVersions: ['4.2.1'] });

      const res = await request(app, 'GET', '/api/roadmap/Billing/4.2.1?component=RCM%20-%20Invoicing');
      expect(res.status).toBe(200);
      expect(res.body.tickets).toHaveLength(1);
      expect(res.body.tickets[0].key).toBe('DEV-100');
      expect(res.body.component).toBe('RCM - Invoicing');
    });

    it('includes taxonomy fields in ticket response', async () => {
      seedRelease(services, { version: '4.2.1', jiraReleaseDate: inFiveDays });
      seedTicket(services.ticketStore, {
        key: 'DEV-100', module: 'Billing', component: 'RCM - Invoicing',
        fixVersions: ['4.2.1'], customerTags: ['CK'], product: ['Web Platform'],
        projects: ['RCM V2'], labels: ['rcm-v2', 'top30'],
      });

      const res = await request(app, 'GET', '/api/roadmap/Billing/4.2.1');
      expect(res.status).toBe(200);
      const ticket = res.body.tickets[0];
      expect(ticket.customerTags).toEqual(['CK']);
      expect(ticket.product).toEqual(['Web Platform']);
      expect(ticket.projects).toEqual(['RCM V2']);
      expect(ticket.labels).toEqual(['rcm-v2', 'top30']);
    });
  });
});
