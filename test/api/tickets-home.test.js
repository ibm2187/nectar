import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

// Date helpers — relative to "now" so tests are stable across calendar changes
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const inTenDays = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const inTwoMonths = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function createMockServices() {
  const db = createTestDb();
  const audit = new Audit({ db });
  const releases = new ReleaseManager(audit, { db });
  const themeConfig = new ThemeConfig({ db });

  return {
    releases,
    repoManager: { getStatus: () => [] },
    github: { isConfigured: () => false, listIssues: vi.fn(), createIssue: vi.fn() },
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
        hostname: 'localhost', port, path, method,
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

function createReleaseWithDate(services, { version, repo = 'webplatform', jiraReleaseDate, state }) {
  services.releases.create({ repo, version });
  const key = `${repo}:${version}`;
  const release = services.releases.get(version, repo);
  if (jiraReleaseDate) {
    // jiraReleaseDate is set by the JIRA sync, not by update(); mutate directly for tests
    release.jiraReleaseDate = jiraReleaseDate;
  }
  if (state && state !== 'planning') {
    const path = ['planning', 'cutting', 'stabilizing', 'approved', 'deploying', 'done'];
    const target = path.indexOf(state);
    for (let i = 1; i <= target; i++) {
      services.releases.transition(key, path[i]);
    }
  }
  return release;
}

function makeTicket(opts = {}) {
  return {
    key: opts.key,
    summary: opts.summary || `Summary for ${opts.key}`,
    state: opts.state || 'pending',
    jiraStatus: opts.jiraStatus || 'In Progress',
    type: opts.type || 'Bug',
    assignee: opts.assignee || null,
    qaAssignee: opts.qaAssignee || null,
    fixVersions: opts.fixVersions || [],
    targetFixVersions: opts.targetFixVersions || [],
    deployedEnvironments: opts.deployedEnvironments || [],
    source: 'jira',
  };
}

describe('GET /api/tickets/home', () => {
  let app, services;

  beforeEach(() => {
    ({ app, services } = createTestApp());
  });

  it('returns empty list when no releases exist', async () => {
    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toEqual([]);
  });

  it('returns tickets from immediate releases (overdue + upcoming 2w + unscheduled)', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-1', summary: 'In overdue', fixVersions: ['4.2.0'],
    }));

    createReleaseWithDate(services, { version: '4.3.0', repo: 'webplatform', jiraReleaseDate: inFiveDays });
    services.releases.addTicket('webplatform:4.3.0', makeTicket({
      key: 'DEV-2', summary: 'In upcoming', fixVersions: ['4.3.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.status).toBe(200);
    const keys = res.body.tickets.map(t => t.key).sort();
    expect(keys).toEqual(['DEV-1', 'DEV-2']);
  });

  it('excludes tickets only in non-immediate releases (>2 weeks out)', async () => {
    createReleaseWithDate(services, { version: '4.5.0', repo: 'webplatform', jiraReleaseDate: inTwoMonths });
    services.releases.addTicket('webplatform:4.5.0', makeTicket({
      key: 'DEV-100', fixVersions: ['4.5.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.body.tickets).toHaveLength(0);
  });

  it('excludes tickets only in done releases', async () => {
    createReleaseWithDate(services, { version: '4.0.0', repo: 'webplatform', jiraReleaseDate: lastMonth, state: 'done' });
    services.releases.addTicket('webplatform:4.0.0', makeTicket({
      key: 'DEV-OLD', fixVersions: ['4.0.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.body.tickets).toHaveLength(0);
  });

  it('includes a ticket in immediate AND enriches with all releases (including past/future)', async () => {
    // Past shipped release where DEV-50 was first delivered
    createReleaseWithDate(services, { version: '4.0.0', repo: 'webplatform', jiraReleaseDate: lastMonth, state: 'done' });
    services.releases.addTicket('webplatform:4.0.0', makeTicket({
      key: 'DEV-50', fixVersions: ['4.0.0', '4.2.0', '4.5.0'],
      targetFixVersions: ['4.0.0', '4.2.0', '4.5.0'],
    }));

    // Immediate release
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-50', fixVersions: ['4.0.0', '4.2.0', '4.5.0'],
      targetFixVersions: ['4.0.0', '4.2.0', '4.5.0'],
    }));

    // Future release out of immediate window
    createReleaseWithDate(services, { version: '4.5.0', repo: 'webplatform', jiraReleaseDate: inTwoMonths });
    services.releases.addTicket('webplatform:4.5.0', makeTicket({
      key: 'DEV-50', fixVersions: ['4.0.0', '4.2.0', '4.5.0'],
      targetFixVersions: ['4.0.0', '4.2.0', '4.5.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.body.tickets).toHaveLength(1);
    const ticket = res.body.tickets[0];
    expect(ticket.key).toBe('DEV-50');
    const versions = ticket.releases.map(r => r.version).sort();
    expect(versions).toEqual(['4.0.0', '4.2.0', '4.5.0']);

    // Past release should be marked shipped
    const past = ticket.releases.find(r => r.version === '4.0.0');
    expect(past.isShipped).toBe(true);

    // Immediate release should have isImmediate flag
    const immediate = ticket.releases.find(r => r.version === '4.2.0');
    expect(immediate.isImmediate).toBe(true);

    // Future release should not be immediate or shipped
    const future = ticket.releases.find(r => r.version === '4.5.0');
    expect(future.isImmediate).toBe(false);
    expect(future.isShipped).toBe(false);
  });

  it('dedupes a ticket that appears in multiple immediate releases', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    createReleaseWithDate(services, { version: '4.3.0', repo: 'webplatform', jiraReleaseDate: inFiveDays });

    const ticket = makeTicket({
      key: 'DEV-X', fixVersions: ['4.2.0', '4.3.0'], targetFixVersions: ['4.2.0', '4.3.0'],
    });
    services.releases.addTicket('webplatform:4.2.0', ticket);
    services.releases.addTicket('webplatform:4.3.0', ticket);

    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].releases).toHaveLength(2);
  });

  it('marks overdue releases on ticket', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-1', fixVersions: ['4.2.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home');
    const ticket = res.body.tickets[0];
    const rel = ticket.releases.find(r => r.version === '4.2.0');
    expect(rel.isOverdue).toBe(true);
  });

  it('filters by dev role + person (only their assignee tickets)', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-A', assignee: 'Alice', fixVersions: ['4.2.0'],
    }));
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-B', assignee: 'Bob', fixVersions: ['4.2.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home?view=dev&person=Alice');
    expect(res.body.tickets.map(t => t.key)).toEqual(['DEV-A']);
  });

  it('filters by qa role + person (only their qaAssignee tickets)', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-A', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: ['4.2.0'],
    }));
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-B', assignee: 'Bob', qaAssignee: 'Dave', fixVersions: ['4.2.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home?view=qa&person=Carol');
    expect(res.body.tickets.map(t => t.key)).toEqual(['DEV-A']);
  });

  it('PM view + person filters across BOTH assignee and qaAssignee', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-DEV',     assignee: 'Alice',  qaAssignee: 'Carol', fixVersions: ['4.2.0'],
    }));
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-QA',      assignee: 'Bob',    qaAssignee: 'Alice', fixVersions: ['4.2.0'],
    }));
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-NEITHER', assignee: 'Bob',    qaAssignee: 'Carol', fixVersions: ['4.2.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home?view=pm&person=Alice');
    const keys = res.body.tickets.map(t => t.key).sort();
    expect(keys).toEqual(['DEV-DEV', 'DEV-QA']); // both roles, not the third
  });

  it('PM view without person returns all tickets', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-A', assignee: 'Alice', fixVersions: ['4.2.0'],
    }));
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-B', assignee: 'Bob', fixVersions: ['4.2.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home?view=pm');
    expect(res.body.tickets).toHaveLength(2);
  });

  it('returns the immediate-releases column list', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    createReleaseWithDate(services, { version: '4.3.0', repo: 'webplatform', jiraReleaseDate: inFiveDays });
    // Future release should not appear in column list
    createReleaseWithDate(services, { version: '4.5.0', repo: 'webplatform', jiraReleaseDate: inTwoMonths });

    const res = await request(app, 'GET', '/api/tickets/home');
    const versions = res.body.releases.map(r => r.version).sort();
    expect(versions).toEqual(['4.2.0', '4.3.0']);
  });

  it('sorts tickets by most urgent release date', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    createReleaseWithDate(services, { version: '4.3.0', repo: 'webplatform', jiraReleaseDate: inFiveDays });
    createReleaseWithDate(services, { version: '4.4.0', repo: 'webplatform', jiraReleaseDate: inTenDays });

    services.releases.addTicket('webplatform:4.4.0', makeTicket({
      key: 'DEV-LATER', fixVersions: ['4.4.0'],
    }));
    services.releases.addTicket('webplatform:4.2.0', makeTicket({
      key: 'DEV-OVERDUE', fixVersions: ['4.2.0'],
    }));
    services.releases.addTicket('webplatform:4.3.0', makeTicket({
      key: 'DEV-MIDDLE', fixVersions: ['4.3.0'],
    }));

    const res = await request(app, 'GET', '/api/tickets/home?days=14');
    const keys = res.body.tickets.map(t => t.key);
    expect(keys).toEqual(['DEV-OVERDUE', 'DEV-MIDDLE', 'DEV-LATER']);
  });

  it('sorts ticket release list with shipped at end and overdue first', async () => {
    createReleaseWithDate(services, { version: '4.0.0', repo: 'webplatform', jiraReleaseDate: lastMonth, state: 'done' });

    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    createReleaseWithDate(services, { version: '4.3.0', repo: 'webplatform', jiraReleaseDate: inFiveDays });

    const ticket = makeTicket({
      key: 'DEV-MULTI', fixVersions: ['4.0.0', '4.2.0', '4.3.0'],
      targetFixVersions: ['4.0.0', '4.2.0', '4.3.0'],
    });
    services.releases.addTicket('webplatform:4.0.0', ticket);
    services.releases.addTicket('webplatform:4.2.0', ticket);
    services.releases.addTicket('webplatform:4.3.0', ticket);

    const res = await request(app, 'GET', '/api/tickets/home');
    const versions = res.body.tickets[0].releases.map(r => r.version);
    // Overdue (4.2.0) first, then upcoming (4.3.0), then shipped (4.0.0)
    expect(versions).toEqual(['4.2.0', '4.3.0', '4.0.0']);
  });

  it('skips tickets without source=jira', async () => {
    createReleaseWithDate(services, { version: '4.2.0', repo: 'webplatform', jiraReleaseDate: yesterday });
    // addTicket directly to bypass the jira source default
    const release = services.releases.get('4.2.0', 'webplatform');
    release.tickets.push({
      key: 'MANUAL-1', summary: 'Manual', state: 'pending', jiraStatus: 'Open',
      fixVersions: ['4.2.0'], targetFixVersions: [], source: 'manual',
    });

    const res = await request(app, 'GET', '/api/tickets/home');
    expect(res.body.tickets).toHaveLength(0);
  });
});
