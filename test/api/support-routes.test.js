import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';
import express from 'express';

const { createSupportRoutes } = require('../../src/api/support-routes');
const ZohoStore = require('../../src/core/zoho-store');
const UserStore = require('../../src/core/user-store');
const { createTestDb } = require('../../src/core/db');

// ─────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────

function makeApp({ withMirrorSync = false } = {}) {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
     VALUES ('admin', 'Admin', '', '[]', 1, ?, ?)`
  ).run(now, now);
  const zohoStore = new ZohoStore({ db });
  const userStore = new UserStore({ db });
  const zohoMirrorSync = withMirrorSync
    ? { refreshTicket: vi.fn(async (id) => zohoStore.getTicketById(id)) }
    : null;

  const app = express();
  app.use(express.json());
  app.use('/api/support', createSupportRoutes({ zohoStore, zohoMirrorSync, userStore }));

  return { app, zohoStore, userStore, zohoMirrorSync };
}

function request(app, method, path, body = null) {
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
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

function makeTicket(overrides = {}) {
  return {
    id: '1078812000011967813',
    ticketNumber: 'VHC-4165',
    subject: 'Add client document types',
    status: 'Investigating',
    statusType: 'Open',
    priority: 'Medium',
    category: 'Client Documents',
    assigneeEmail: 'bryan@v.com',
    assigneeZohoAgentId: 'agent-bryan',
    accountId: 'acct-1',
    createdAt: '2026-03-20T15:33:50.000Z',
    modifiedAt: '2026-04-22T22:15:28.000Z',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────

describe('GET /api/support/sync-status', () => {
  it('returns the seeded meta row', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/api/support/sync-status');
    expect(res.status).toBe(200);
    expect(res.body.backfillStatus).toBe('pending');
    expect(res.body.ticketCount).toBe(0);
    expect(res.body.openTicketCount).toBe(0);
  });

  it('reflects populated state after tickets are inserted', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket());
    zohoStore.upsertTicket(makeTicket({ id: '2', ticketNumber: 'VHC-4166', statusType: 'Closed' }));
    zohoStore.updateSyncMeta({ backfillStatus: 'done', lastRunAt: '2026-04-23T10:00:00Z' });

    const res = await request(app, 'GET', '/api/support/sync-status');
    expect(res.body.ticketCount).toBe(2);
    expect(res.body.openTicketCount).toBe(1);
    expect(res.body.backfillStatus).toBe('done');
  });
});

describe('GET /api/support/stats', () => {
  it('groups by assignee with open + total counts', async () => {
    const { app, zohoStore, userStore } = makeApp();
    userStore.upsertIdentity({ email: 'bryan@v.com', displayNameZoho: 'Bryan Nothling' });
    zohoStore.upsertTicket(makeTicket({ id: '1', ticketNumber: 'VHC-1', statusType: 'Open' }));
    zohoStore.upsertTicket(makeTicket({ id: '2', ticketNumber: 'VHC-2', statusType: 'Closed' }));

    const res = await request(app, 'GET', '/api/support/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.open).toBe(1);
    const bryan = res.body.assignees.find(a => a.assigneeEmail === 'bryan@v.com');
    expect(bryan.displayName).toBe('Bryan Nothling');
    expect(bryan.total).toBe(2);
    expect(bryan.openCount).toBe(1);
  });
});

describe('GET /api/support/tickets', () => {
  it('lists tickets with enrichment (assigneeName, accountName, ageDays)', async () => {
    const { app, zohoStore, userStore } = makeApp();
    userStore.upsertIdentity({ email: 'bryan@v.com', displayNameZoho: 'Bryan Nothling' });
    zohoStore.upsertAccount({ id: 'acct-1', name: 'Comfort Keepers - 163' });
    zohoStore.upsertTicket(makeTicket());

    const res = await request(app, 'GET', '/api/support/tickets');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    const t = res.body.tickets[0];
    expect(t.assigneeName).toBe('Bryan Nothling');
    expect(t.accountName).toBe('Comfort Keepers - 163');
    expect(t.ageDays).toBeGreaterThan(0);
    expect(t.rawPayload).toBeUndefined(); // stripped from list response
  });

  it('respects query filters (assigneeEmail, statuses, openOnly)', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket({ id: '1', ticketNumber: 'VHC-1', assigneeEmail: 'a@v.com', status: 'Investigating', statusType: 'Open' }));
    zohoStore.upsertTicket(makeTicket({ id: '2', ticketNumber: 'VHC-2', assigneeEmail: 'b@v.com', status: 'Closed', statusType: 'Closed' }));
    zohoStore.upsertTicket(makeTicket({ id: '3', ticketNumber: 'VHC-3', assigneeEmail: 'a@v.com', status: 'Closed', statusType: 'Closed' }));

    const r1 = await request(app, 'GET', '/api/support/tickets?assigneeEmail=a@v.com');
    expect(r1.body.tickets).toHaveLength(2);

    const r2 = await request(app, 'GET', '/api/support/tickets?openOnly=true');
    expect(r2.body.tickets).toHaveLength(1);

    const r3 = await request(app, 'GET', '/api/support/tickets?statuses=Investigating,Waiting');
    expect(r3.body.tickets).toHaveLength(1);
    expect(r3.body.tickets[0].status).toBe('Investigating');
  });

  it('parses comma-separated multi-value filters', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket({ id: '1', ticketNumber: 'VHC-1', priority: 'Urgent' }));
    zohoStore.upsertTicket(makeTicket({ id: '2', ticketNumber: 'VHC-2', priority: 'High' }));
    zohoStore.upsertTicket(makeTicket({ id: '3', ticketNumber: 'VHC-3', priority: 'Low' }));

    const res = await request(app, 'GET', '/api/support/tickets?priorities=Urgent,High');
    expect(res.body.tickets).toHaveLength(2);
  });
});

describe('GET /api/support/tickets/:ticketNumber', () => {
  it('returns ticket + linked JIRAs + history + aging', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket());
    zohoStore.upsertHistoryEntry({
      ticketId: '1078812000011967813',
      changedAt: '2026-04-20T10:00:00.000Z',
      fieldName: 'status',
      fromValue: 'Open',
      toValue: 'Investigating',
    });
    zohoStore.upsertLink({ jiraKey: 'DEV-45019', zohoTicketId: '1078812000011967813', source: 'customfield_11157' });

    const res = await request(app, 'GET', '/api/support/tickets/VHC-4165');
    expect(res.status).toBe(200);
    expect(res.body.ticket.ticketNumber).toBe('VHC-4165');
    expect(res.body.linkedJiraKeys).toHaveLength(1);
    expect(res.body.linkedJiraKeys[0].jiraKey).toBe('DEV-45019');
    expect(res.body.history).toHaveLength(1);
    expect(res.body.daysInCurrentStatus).toBeGreaterThanOrEqual(0);
  });

  it('404 when ticket not in mirror', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/api/support/tickets/NOPE-1');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/support/tickets/:ticketNumber/refresh', () => {
  it('calls zohoMirrorSync.refreshTicket when available', async () => {
    const { app, zohoStore, zohoMirrorSync } = makeApp({ withMirrorSync: true });
    zohoStore.upsertTicket(makeTicket());
    const res = await request(app, 'POST', '/api/support/tickets/VHC-4165/refresh');
    expect(res.status).toBe(200);
    expect(zohoMirrorSync.refreshTicket).toHaveBeenCalledWith('1078812000011967813');
  });

  it('503 when mirror sync is not wired', async () => {
    const { app, zohoStore } = makeApp(); // no mirror sync
    zohoStore.upsertTicket(makeTicket());
    const res = await request(app, 'POST', '/api/support/tickets/VHC-4165/refresh');
    expect(res.status).toBe(503);
  });

  it('404 when ticket not in mirror yet', async () => {
    const { app } = makeApp({ withMirrorSync: true });
    const res = await request(app, 'POST', '/api/support/tickets/NOPE-1/refresh');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/support/jira/links/batch', () => {
  it('returns link map keyed by jira key', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket({ id: 'z1', ticketNumber: 'VHC-1' }));
    zohoStore.upsertTicket(makeTicket({ id: 'z2', ticketNumber: 'BYD-1', deptPrefix: 'BYD' }));
    zohoStore.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z1', source: 'customfield_11157' });
    zohoStore.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z2', source: 'customfield_11157' });
    zohoStore.upsertLink({ jiraKey: 'DEV-2', zohoTicketId: 'z1', source: 'customfield_11157' });

    const res = await request(app, 'POST', '/api/support/jira/links/batch', { keys: ['DEV-1', 'DEV-2', 'DEV-NONE'] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.linksByJiraKey).sort()).toEqual(['DEV-1', 'DEV-2']);
    expect(res.body.linksByJiraKey['DEV-1']).toHaveLength(2);
  });

  it('returns empty map for empty keys array', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/support/jira/links/batch', { keys: [] });
    expect(res.status).toBe(200);
    expect(res.body.linksByJiraKey).toEqual({});
  });

  it('caps input at 200 keys and reports truncation', async () => {
    const { app } = makeApp();
    const keys = Array.from({ length: 250 }, (_, i) => `DEV-${i}`);
    const res = await request(app, 'POST', '/api/support/jira/links/batch', { keys });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(50);
  });
});

describe('GET /api/support/jira/:jiraKey/links', () => {
  it('returns all Zoho tickets linked to a JIRA key', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket({ id: 'z1', ticketNumber: 'VHC-1' }));
    zohoStore.upsertTicket(makeTicket({ id: 'z2', ticketNumber: 'BYD-1', deptPrefix: 'BYD' }));
    zohoStore.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z1', source: 'customfield_11157' });
    zohoStore.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z2', source: 'customfield_11157' });

    const res = await request(app, 'GET', '/api/support/jira/DEV-1/links');
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(2);
    expect(res.body.tickets).toHaveLength(2);
    const nums = res.body.tickets.map(t => t.ticketNumber).sort();
    expect(nums).toEqual(['BYD-1', 'VHC-1']);
  });

  it('returns empty arrays for a JIRA with no links', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/api/support/jira/NONE/links');
    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([]);
    expect(res.body.tickets).toEqual([]);
  });
});

describe('GET /api/support/accounts', () => {
  it('lists accounts ordered by name', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertAccount({ id: 'b', name: 'Bayada' });
    zohoStore.upsertAccount({ id: 'a', name: 'Amazing Care' });

    const res = await request(app, 'GET', '/api/support/accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.accounts[0].name).toBe('Amazing Care');
  });
});

describe('GET /api/support/departments', () => {
  it('returns distinct ticket-prefix departments with counts', async () => {
    const { app, zohoStore } = makeApp();
    zohoStore.upsertTicket(makeTicket({ id: '1', ticketNumber: 'VHC-1', deptPrefix: 'VHC' }));
    zohoStore.upsertTicket(makeTicket({ id: '2', ticketNumber: 'VHC-2', deptPrefix: 'VHC' }));
    zohoStore.upsertTicket(makeTicket({ id: '3', ticketNumber: 'BYD-1', deptPrefix: 'BYD' }));

    const res = await request(app, 'GET', '/api/support/departments');
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([
      { deptPrefix: 'BYD', count: 1 },
      { deptPrefix: 'VHC', count: 2 },
    ]);
  });
});

describe('GET /api/support/tickets — maxAgeDays', () => {
  it('passes maxAgeDays through to listTickets', async () => {
    const { app, zohoStore } = makeApp();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    zohoStore.upsertTicket(makeTicket({ id: 'fresh', ticketNumber: 'VHC-N', createdAt: oneDayAgo }));
    zohoStore.upsertTicket(makeTicket({ id: 'ancient', ticketNumber: 'VHC-O', createdAt: ninetyDaysAgo }));

    const res = await request(app, 'GET', '/api/support/tickets?maxAgeDays=7');
    expect(res.status).toBe(200);
    const ids = res.body.tickets.map(t => t.id);
    expect(ids).toContain('fresh');
    expect(ids).not.toContain('ancient');
  });
});

describe('degraded mode', () => {
  it('returns 503 on every route when zohoStore is absent', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/support', createSupportRoutes({})); // no deps

    const r1 = await request(app, 'GET', '/api/support/sync-status');
    expect(r1.status).toBe(503);
    const r2 = await request(app, 'GET', '/api/support/tickets');
    expect(r2.status).toBe(503);
  });
});
