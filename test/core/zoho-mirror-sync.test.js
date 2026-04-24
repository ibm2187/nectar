import { describe, it, expect, beforeEach, vi } from 'vitest';

const ZohoMirrorSync = require('../../src/core/zoho-mirror-sync');
const { normalizeTicket } = require('../../src/core/zoho-mirror-sync');
const ZohoStore = require('../../src/core/zoho-store');
const UserStore = require('../../src/core/user-store');
const { createTestDb } = require('../../src/core/db');

// ─────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────

function makeTicket(overrides = {}) {
  return {
    id: '1078812000011967813',
    ticketNumber: 'VHC-4165',
    subject: 'Add client document types',
    status: 'Investigating',
    statusType: 'Open',
    priority: 'Medium',
    category: 'Client Documents',
    channel: 'Web',
    departmentId: 'dept-vhc',
    accountId: 'acct-ck163',
    contactId: 'contact-1',
    assigneeId: 'zoho-agent-bryan',
    commentCount: '2',
    threadCount: '1',
    createdTime: '2026-03-20T15:33:50.000Z',
    modifiedTime: '2026-04-22T22:15:28.000Z',
    webUrl: 'https://support.vivtechnologies.com/x',
    ...overrides,
  };
}

function makeZohoClientMock({ pages = [], getAccount = null, getContact = null, getTicket = null } = {}) {
  // pages is an array-of-arrays: call N returns pages[N]
  let callIdx = 0;
  return {
    isConfigured: () => true,
    listTicketsPage: vi.fn(async (opts) => {
      const data = pages[callIdx++] || [];
      return { data, hasMore: data.length >= (opts.pageSize || 100) };
    }),
    getAccount: vi.fn(async (id) => getAccount ? getAccount(id) : ({ id, accountName: `Acct ${id}` })),
    getContact: vi.fn(async (id) => getContact ? getContact(id) : ({
      id, accountId: 'acct-ck163', email: `contact-${id}@example.com`, firstName: 'Kate', lastName: 'Smith',
    })),
    getTicket: vi.fn(async (id) => getTicket ? getTicket(id) : null),
  };
}

function setupServices() {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
     VALUES ('admin', 'Admin', '', '[]', 1, ?, ?)`
  ).run(now, now);
  const zohoStore = new ZohoStore({ db });
  const userStore = new UserStore({ db });
  // Seed an assignee so normalizeTicket can resolve email
  userStore.upsertIdentity({
    email: 'bryan@v.com',
    zohoAgentId: 'zoho-agent-bryan',
    displayNameZoho: 'Bryan Nothling',
  });
  return { db, zohoStore, userStore };
}

// ─────────────────────────────────────────────────────────
// normalizeTicket
// ─────────────────────────────────────────────────────────

describe('normalizeTicket', () => {
  it('maps Zoho fields to Nectar row shape', () => {
    const { userStore } = setupServices();
    const row = normalizeTicket(makeTicket(), { userStore });
    expect(row.id).toBe('1078812000011967813');
    expect(row.ticketNumber).toBe('VHC-4165');
    expect(row.deptPrefix).toBe('VHC');
    expect(row.createdAt).toBe('2026-03-20T15:33:50.000Z');
    expect(row.modifiedAt).toBe('2026-04-22T22:15:28.000Z');
    expect(row.commentCount).toBe(2); // coerced from string
    expect(row.rawPayload).toBeTruthy();
  });

  it('resolves assignee email via userStore.findByZohoAgentId', () => {
    const { userStore } = setupServices();
    const row = normalizeTicket(makeTicket(), { userStore });
    expect(row.assigneeEmail).toBe('bryan@v.com');
    expect(row.assigneeZohoAgentId).toBe('zoho-agent-bryan');
  });

  it('leaves assigneeEmail null when no user mapping exists', () => {
    const { userStore } = setupServices();
    const row = normalizeTicket(makeTicket({ assigneeId: 'unknown-agent' }), { userStore });
    expect(row.assigneeEmail).toBeNull();
    expect(row.assigneeZohoAgentId).toBe('unknown-agent');
  });

  it('handles tickets with null/missing fields gracefully', () => {
    const { userStore } = setupServices();
    const minimal = { id: '1', ticketNumber: 'VIV-509', subject: 'Test' };
    const row = normalizeTicket(minimal, { userStore });
    expect(row.id).toBe('1');
    expect(row.status).toBeNull();
    expect(row.commentCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// Backfill
// ─────────────────────────────────────────────────────────

describe('ZohoMirrorSync.backfill', () => {
  it('writes all tickets from a single page', async () => {
    const services = setupServices();
    const zoho = makeZohoClientMock({
      pages: [[makeTicket(), makeTicket({ id: '2', ticketNumber: 'VHC-4166' })], []],
    });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    const results = await sync.backfill();

    expect(results.ticketsUpserted).toBe(2);
    expect(services.zohoStore.count()).toBe(2);
    const meta = services.zohoStore.getSyncMeta();
    expect(meta.backfillStatus).toBe('done');
    expect(meta.lastModifiedCursor).toBeTruthy();
    expect(meta.workerLockUntil).toBeNull(); // released
  });

  it('filters out tickets older than backfillSinceDays floor', async () => {
    const services = setupServices();
    const old = makeTicket({ id: 'old', ticketNumber: 'VHC-1', createdTime: '2024-01-01T00:00:00.000Z' });
    const recent = makeTicket({ id: 'recent', ticketNumber: 'VHC-2', createdTime: new Date().toISOString() });
    const zoho = makeZohoClientMock({ pages: [[old, recent], []] });
    const sync = new ZohoMirrorSync({
      zoho,
      zohoStore: services.zohoStore,
      userStore: services.userStore,
      config: { zohoMirror: { backfillSinceDays: 30, throttleMs: 0 } },
    });

    const results = await sync.backfill();
    expect(results.ticketsUpserted).toBe(1);
    expect(services.zohoStore.getTicketById('old')).toBeNull();
    expect(services.zohoStore.getTicketById('recent')).toBeTruthy();
  });

  it('lazily caches accounts + contacts', async () => {
    const services = setupServices();
    const zoho = makeZohoClientMock({ pages: [[makeTicket()], []] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    await sync.backfill();
    expect(zoho.getAccount).toHaveBeenCalledWith('acct-ck163');
    expect(zoho.getContact).toHaveBeenCalledWith('contact-1');

    const acct = services.zohoStore.getAccount('acct-ck163');
    expect(acct.name).toBe('Acct acct-ck163');
    const contact = services.zohoStore.getContact('contact-1');
    expect(contact.email).toBe('contact-contact-1@example.com');
    expect(contact.name).toBe('Kate Smith');
  });

  it('does not refetch accounts already in the store', async () => {
    const services = setupServices();
    services.zohoStore.upsertAccount({ id: 'acct-ck163', name: 'Pre-existing' });

    const zoho = makeZohoClientMock({ pages: [[makeTicket()], []] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    await sync.backfill();
    expect(zoho.getAccount).not.toHaveBeenCalled();
  });

  it('respects the worker lock — concurrent backfills return null', async () => {
    const services = setupServices();
    const zoho = makeZohoClientMock({ pages: [[makeTicket()], []] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    // Manually acquire the lock first
    services.zohoStore.acquireLock(60000);
    const result = await sync.backfill();
    expect(result).toBeNull();
  });

  it('updates backfillProgress per page for resumability', async () => {
    const services = setupServices();
    const pageA = Array.from({ length: 100 }, (_, i) => makeTicket({ id: `A-${i}`, ticketNumber: `VHC-A${i}` }));
    const pageB = [makeTicket({ id: 'B-0', ticketNumber: 'VHC-B0' })];
    const zoho = makeZohoClientMock({ pages: [pageA, pageB, []] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0, pageSize: 100 } } });

    await sync.backfill();
    const meta = services.zohoStore.getSyncMeta();
    expect(meta.backfillStatus).toBe('done');
    expect(services.zohoStore.count()).toBe(101);
  });
});

// ─────────────────────────────────────────────────────────
// Incremental
// ─────────────────────────────────────────────────────────

describe('ZohoMirrorSync.runIncremental', () => {
  it('skips when backfill has not completed', async () => {
    const services = setupServices();
    // default backfillStatus = 'pending' from the seed
    const zoho = makeZohoClientMock({ pages: [[makeTicket()]] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });
    const result = await sync.runIncremental();
    expect(result).toBeNull();
    expect(zoho.listTicketsPage).not.toHaveBeenCalled();
  });

  it('retries backfill on tick when previous run failed', async () => {
    const services = setupServices();
    // Simulate a prior failed backfill
    services.zohoStore.updateSyncMeta({ backfillStatus: 'failed', lastSyncError: 'Zoho 429' });

    const zoho = makeZohoClientMock({ pages: [[makeTicket()], []] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    const result = await sync.runIncremental();
    // Should have run a full backfill, not an incremental
    expect(result).toBeTruthy();
    expect(result.ticketsUpserted).toBe(1);
    const meta = services.zohoStore.getSyncMeta();
    expect(meta.backfillStatus).toBe('done');
  });

  it('early-exits when every ticket on a page is older than the cursor', async () => {
    const services = setupServices();
    services.zohoStore.updateSyncMeta({ backfillStatus: 'done', lastModifiedCursor: '2026-04-22T22:15:28.000Z' });

    // Every ticket on the page is OLDER than the cursor → none upserted
    const older = [
      makeTicket({ id: '1', modifiedTime: '2026-04-20T10:00:00.000Z' }),
      makeTicket({ id: '2', modifiedTime: '2026-04-15T10:00:00.000Z' }),
    ];
    const zoho = makeZohoClientMock({ pages: [older] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    const result = await sync.runIncremental();
    expect(result.ticketsUpserted).toBe(0);
    expect(result.ticketsChecked).toBe(1); // stopped on the first older entry
  });

  it('upserts tickets newer than the cursor and advances it', async () => {
    const services = setupServices();
    services.zohoStore.updateSyncMeta({ backfillStatus: 'done', lastModifiedCursor: '2026-04-22T00:00:00.000Z' });

    const newer = [
      makeTicket({ id: '1', modifiedTime: '2026-04-23T10:00:00.000Z' }),
      makeTicket({ id: '2', ticketNumber: 'VHC-4166', modifiedTime: '2026-04-22T10:00:00.000Z' }),
      makeTicket({ id: '3', ticketNumber: 'VHC-4167', modifiedTime: '2026-04-21T10:00:00.000Z' }), // older: stop
    ];
    const zoho = makeZohoClientMock({ pages: [newer] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    const result = await sync.runIncremental();
    expect(result.ticketsUpserted).toBe(2);
    const meta = services.zohoStore.getSyncMeta();
    expect(meta.lastModifiedCursor).toBe('2026-04-23T10:00:00.000Z');
  });

  it('respects the worker lock — concurrent incremental returns null', async () => {
    const services = setupServices();
    services.zohoStore.updateSyncMeta({ backfillStatus: 'done' });
    services.zohoStore.acquireLock(60000);

    const zoho = makeZohoClientMock({ pages: [[makeTicket()]] });
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });
    const result = await sync.runIncremental();
    expect(result).toBeNull();
    expect(zoho.listTicketsPage).not.toHaveBeenCalled();
  });

  it('records sync errors on the meta row', async () => {
    const services = setupServices();
    services.zohoStore.updateSyncMeta({ backfillStatus: 'done' });

    const zoho = {
      isConfigured: () => true,
      listTicketsPage: vi.fn(async () => { throw new Error('Zoho 429 TOO_MANY_REQUESTS'); }),
      getAccount: vi.fn(), getContact: vi.fn(), getTicket: vi.fn(),
    };
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    const result = await sync.runIncremental();
    expect(result.errors).toBe(1);
    const meta = services.zohoStore.getSyncMeta();
    expect(meta.lastSyncError).toContain('429');
    expect(meta.workerLockUntil).toBeNull(); // lock released even on error
  });
});

// ─────────────────────────────────────────────────────────
// refreshTicket (manual button)
// ─────────────────────────────────────────────────────────

describe('ZohoMirrorSync.refreshTicket', () => {
  it('fetches + upserts a single ticket', async () => {
    const services = setupServices();
    const raw = makeTicket();
    const zoho = {
      isConfigured: () => true,
      listTicketsPage: vi.fn(),
      getTicket: vi.fn(async () => raw),
      getAccount: vi.fn(async () => ({ id: 'acct-ck163', accountName: 'CK 163' })),
      getContact: vi.fn(async () => ({ id: 'contact-1', email: 'c@x.com', firstName: 'Kate' })),
    };
    const sync = new ZohoMirrorSync({ zoho, zohoStore: services.zohoStore, userStore: services.userStore, config: { zohoMirror: { throttleMs: 0 } } });

    const result = await sync.refreshTicket('1078812000011967813');
    expect(result).toBeTruthy();
    expect(result.ticketNumber).toBe('VHC-4165');
    expect(services.zohoStore.count()).toBe(1);
  });
});
