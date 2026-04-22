import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const TicketStore = require('../../src/core/ticket-store');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

// Regression for mavencare/nectar#64 and #65.
//
// iOS 2026.4.0 and Android 2026.4.0 are distinct JIRA versions but both clean
// to "2026.4.0" on the nectar side. The /releases/home route previously keyed
// its tickets-per-release cache by `release.version` alone, so the second
// release in the loop overwrote the first release's list. Every subsequent
// lookup returned the LAST-written list. That meant:
//   (#64) Android tickets appeared under the iOS release panel, and
//   (#65) iOS "In Testing" tickets vanished from the QA board because Android
//         had no "In Testing" tickets for that assignee.
//
// This test creates the collision, exercises /releases/home with a QA person
// filter, and asserts each release carries its own platform's tickets.

const inOneWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
      const req = http.request({
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
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

function createDatedRelease(services, { version, repo, jiraReleaseDate }) {
  services.releases.create({ repo, version });
  const release = services.releases.get(version, repo);
  release.jiraReleaseDate = jiraReleaseDate;
  services.releases.persist(release);
  return release;
}

function upsertTicket(ticketStore, t) {
  ticketStore.upsert({
    key: t.key,
    summary: t.summary || `Summary for ${t.key}`,
    status: t.status,
    statusCategory: t.statusCategory || null,
    state: t.state || 'pending',
    type: t.type || 'Bug',
    assignee: t.assignee || null,
    reporter: t.reporter || null,
    qaAssignee: t.qaAssignee || null,
    productAssignee: null,
    component: null,
    module: null,
    product: [],
    projects: [],
    priority: null,
    riskLevel: null,
    customerPriority: null,
    fixVersions: t.fixVersions || [],
    targetFixVersions: t.targetFixVersions || [],
    customerTags: [],
    deployedEnvironments: [],
    labels: [],
    platforms: t.platforms || [],
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: null,
    updatedInJira: null,
    syncedAt: new Date().toISOString(),
  });
}

describe('GET /api/releases/home — iOS/Android version collision (#64, #65)', () => {
  let app, services;

  beforeEach(() => {
    ({ app, services } = createTestApp());
    createDatedRelease(services, { version: '2026.4.0', repo: 'ios', jiraReleaseDate: inOneWeek });
    createDatedRelease(services, { version: '2026.4.0', repo: 'android', jiraReleaseDate: inOneWeek });

    // Piyush's iOS 'In Testing' ticket — should appear in the iOS panel only
    upsertTicket(services.ticketStore, {
      key: 'DEV-40175', qaAssignee: 'Piyush Puri', status: 'In Testing',
      fixVersions: ['2026.4.0'], targetFixVersions: ['2026.4.0'], platforms: ['ios'],
    });
    // Piyush's Android 'Blocked' ticket — should appear in the Android panel only
    upsertTicket(services.ticketStore, {
      key: 'DEV-40174', qaAssignee: 'Piyush Puri', status: 'Blocked',
      fixVersions: ['2026.4.0'], targetFixVersions: ['2026.4.0'], platforms: ['android'],
    });
  });

  it('iOS release returns only iOS-platform tickets, not Android ones', async () => {
    const res = await request(app, 'GET', '/api/releases/home?view=qa&person=Piyush%20Puri&range=nextweek');
    expect(res.status).toBe(200);

    const iosRelease = res.body.find(r => r.repo === 'ios' && r.version === '2026.4.0');
    const androidRelease = res.body.find(r => r.repo === 'android' && r.version === '2026.4.0');

    expect(iosRelease).toBeTruthy();
    expect(androidRelease).toBeTruthy();

    const iosKeys = iosRelease.tickets.map(t => t.key).sort();
    const androidKeys = androidRelease.tickets.map(t => t.key).sort();

    // Before the fix: both panels returned the same last-written list (Android's).
    // After: each panel carries its own platform's tickets.
    expect(iosKeys).toEqual(['DEV-40175']);
    expect(androidKeys).toEqual(['DEV-40174']);
  });

  it('the "In Testing" iOS ticket surfaces in the QA view (#65 regression)', async () => {
    const res = await request(app, 'GET', '/api/releases/home?view=qa&person=Piyush%20Puri&range=nextweek');
    const allTickets = res.body.flatMap(r => r.tickets);
    const statuses = allTickets.map(t => t.jiraStatus).sort();
    expect(statuses).toContain('In Testing');
    expect(allTickets.some(t => t.key === 'DEV-40175' && t.jiraStatus === 'In Testing')).toBe(true);
  });

  it('GET /api/releases does not swap tickets between colliding releases (#64 regression)', async () => {
    const res = await request(app, 'GET', '/api/releases');
    expect(res.status).toBe(200);
    const ios = res.body.find(r => r.repo === 'ios' && r.version === '2026.4.0');
    const android = res.body.find(r => r.repo === 'android' && r.version === '2026.4.0');
    expect(ios.tickets.map(t => t.key)).toEqual(['DEV-40175']);
    expect(android.tickets.map(t => t.key)).toEqual(['DEV-40174']);
  });
});

describe('Release mutation endpoints — compound key support under collision', () => {
  let app, services;

  beforeEach(() => {
    ({ app, services } = createTestApp());
    createDatedRelease(services, { version: '2026.4.0', repo: 'ios', jiraReleaseDate: inOneWeek });
    createDatedRelease(services, { version: '2026.4.0', repo: 'android', jiraReleaseDate: inOneWeek });
  });

  // Without the compound-key parsing in ReleaseManager.get(), these mutations
  // would silently hit the first-match release (bug class #64). With the new
  // ambiguity warn they'd 404 if the client sent a bare version. The fix:
  // client sends "repo:version", server parses it and targets the right one.

  it('PATCH /releases/ios:2026.4.0 transitions only the iOS release', async () => {
    const res = await request(app, 'PATCH', `/api/releases/${encodeURIComponent('ios:2026.4.0')}`, { state: 'cutting' });
    expect(res.status).toBe(200);
    expect(services.releases.get('2026.4.0', 'ios').state).toBe('cutting');
    expect(services.releases.get('2026.4.0', 'android').state).toBe('planning');
  });

  it('PATCH /releases/android:2026.4.0 transitions only the Android release', async () => {
    const res = await request(app, 'PATCH', `/api/releases/${encodeURIComponent('android:2026.4.0')}`, { state: 'cutting' });
    expect(res.status).toBe(200);
    expect(services.releases.get('2026.4.0', 'android').state).toBe('cutting');
    expect(services.releases.get('2026.4.0', 'ios').state).toBe('planning');
  });

  it('PATCH /releases/2026.4.0 (bare, ambiguous) hard-fails instead of silently picking a side', async () => {
    // Pre-fix: silently hit whichever iterated first. Post-fix: _getOrThrow
    // surfaces the ambiguity loudly via a 404/500 rather than a wrong write.
    const res = await request(app, 'PATCH', '/api/releases/2026.4.0', { state: 'cutting' });
    expect(res.status).not.toBe(200);
    // Both releases stay at initial state — no silent side-effect.
    expect(services.releases.get('2026.4.0', 'ios').state).toBe('planning');
    expect(services.releases.get('2026.4.0', 'android').state).toBe('planning');
  });
});
