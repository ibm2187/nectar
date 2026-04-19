import { describe, it, expect, beforeEach } from 'vitest';

const TicketStore = require('../../src/core/ticket-store');
const { createTestDb } = require('../../src/core/db');

function makeTicket(overrides = {}) {
  return {
    key: 'DEV-1001',
    summary: 'Fix login timeout',
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
    customerTags: ['Viv'],
    deployedEnvironments: [],
    labels: ['urgent'],
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: '2026-04-10T10:00:00.000Z',
    updatedInJira: '2026-04-16T14:00:00.000Z',
    syncedAt: '2026-04-16T15:00:00.000Z',
    ...overrides,
  };
}

describe('TicketStore', () => {
  let db, store;

  beforeEach(() => {
    db = createTestDb();
    db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();
    store = new TicketStore({ db });
  });

  // ── Core CRUD ─────────────────────────────────────

  describe('upsert + get', () => {
    it('inserts and retrieves a ticket', () => {
      store.upsert(makeTicket());
      const got = store.get('DEV-1001');
      expect(got.key).toBe('DEV-1001');
      expect(got.summary).toBe('Fix login timeout');
      expect(got.state).toBe('in-progress');
      expect(got.fixVersions).toEqual(['4.2.1']);
      expect(got.labels).toEqual(['urgent']);
    });

    it('preserves all fields round-trip', () => {
      const original = makeTicket({
        zohoRef: { kind: 'url', id: '123', zohoUrl: 'https://zoho/123' },
        customerTags: ['Viv', 'CK'],
        deployedEnvironments: ['prod', 'staging'],
      });
      store.upsert(original);
      const got = store.get('DEV-1001');
      expect(got.zohoRef).toEqual(original.zohoRef);
      expect(got.customerTags).toEqual(['Viv', 'CK']);
      expect(got.deployedEnvironments).toEqual(['prod', 'staging']);
      expect(got.statusCategory).toBe('In Progress');
      expect(got.reporter).toBe('Bob');
      expect(got.qaAssignee).toBe('Carol');
    });

    it('updates an existing ticket', () => {
      store.upsert(makeTicket());
      store.upsert(makeTicket({ summary: 'Updated', status: 'Done', state: 'done' }));
      const got = store.get('DEV-1001');
      expect(got.summary).toBe('Updated');
      expect(got.status).toBe('Done');
      expect(got.state).toBe('done');
    });

    it('returns null for unknown key', () => {
      expect(store.get('DEV-9999')).toBeNull();
    });
  });

  describe('upsertBatch', () => {
    it('inserts multiple tickets in a transaction', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1001' }),
        makeTicket({ key: 'DEV-1002', summary: 'Second ticket' }),
        makeTicket({ key: 'DEV-1003', summary: 'Third ticket' }),
      ]);
      expect(store.count()).toBe(3);
      expect(store.get('DEV-1002').summary).toBe('Second ticket');
    });

    it('handles empty array', () => {
      store.upsertBatch([]);
      expect(store.count()).toBe(0);
    });

    it('updates existing tickets in batch', () => {
      store.upsert(makeTicket({ key: 'DEV-1', summary: 'Old' }));
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', summary: 'New' }),
        makeTicket({ key: 'DEV-2', summary: 'Brand new' }),
      ]);
      expect(store.count()).toBe(2);
      expect(store.get('DEV-1').summary).toBe('New');
    });
  });

  describe('count', () => {
    it('returns 0 for empty store', () => {
      expect(store.count()).toBe(0);
    });

    it('returns correct count', () => {
      store.upsert(makeTicket({ key: 'DEV-1' }));
      store.upsert(makeTicket({ key: 'DEV-2' }));
      expect(store.count()).toBe(2);
    });
  });

  // ── Release-scoped queries ────────────────────────

  describe('getForVersion', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', fixVersions: ['4.2.1'], targetFixVersions: ['4.2.1'], state: 'done' }),
        makeTicket({ key: 'DEV-2', fixVersions: ['4.2.1'], targetFixVersions: [], state: 'in-progress' }),
        makeTicket({ key: 'DEV-3', fixVersions: [], targetFixVersions: ['4.2.1'], state: 'pending' }),
        makeTicket({ key: 'DEV-4', fixVersions: ['4.3.0'], targetFixVersions: ['4.3.0'], state: 'pending' }),
        makeTicket({ key: 'DEV-5', fixVersions: [], targetFixVersions: [], state: 'pending' }),
      ]);
    });

    it('returns tickets with fixVersion matching the version', () => {
      const tickets = store.getForVersion('4.2.1');
      const keys = tickets.map(t => t.key).sort();
      expect(keys).toEqual(['DEV-1', 'DEV-2', 'DEV-3']);
    });

    it('returns tickets with targetFixVersion matching the version', () => {
      const tickets = store.getForVersion('4.2.1');
      expect(tickets.find(t => t.key === 'DEV-3')).toBeDefined();
    });

    it('does not return tickets from other versions', () => {
      const tickets = store.getForVersion('4.2.1');
      expect(tickets.find(t => t.key === 'DEV-4')).toBeUndefined();
    });

    it('does not return unversioned tickets', () => {
      const tickets = store.getForVersion('4.2.1');
      expect(tickets.find(t => t.key === 'DEV-5')).toBeUndefined();
    });

    it('annotates release source correctly — both', () => {
      const tickets = store.getForVersion('4.2.1');
      const t1 = tickets.find(t => t.key === 'DEV-1');
      expect(t1._releaseSource).toBe('both');
    });

    it('annotates release source correctly — fixVersion only', () => {
      const tickets = store.getForVersion('4.2.1');
      const t2 = tickets.find(t => t.key === 'DEV-2');
      expect(t2._releaseSource).toBe('fixVersion');
    });

    it('annotates release source correctly — target only', () => {
      const tickets = store.getForVersion('4.2.1');
      const t3 = tickets.find(t => t.key === 'DEV-3');
      expect(t3._releaseSource).toBe('target');
    });

    it('returns empty array for unknown version', () => {
      expect(store.getForVersion('99.99.99')).toEqual([]);
    });
  });

  describe('getForVersions', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', fixVersions: ['4.2.1'], targetFixVersions: [] }),
        makeTicket({ key: 'DEV-2', fixVersions: ['4.3.0'], targetFixVersions: [] }),
      ]);
    });

    it('returns Map<version, tickets[]>', () => {
      const result = store.getForVersions(['4.2.1', '4.3.0']);
      expect(result.size).toBe(2);
      expect(result.get('4.2.1')).toHaveLength(1);
      expect(result.get('4.3.0')).toHaveLength(1);
    });
  });

  describe('getKeysForVersion', () => {
    it('returns just the keys', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', fixVersions: ['4.2.1'], targetFixVersions: [] }),
        makeTicket({ key: 'DEV-2', fixVersions: ['4.2.1'], targetFixVersions: [] }),
        makeTicket({ key: 'DEV-3', fixVersions: ['4.3.0'], targetFixVersions: [] }),
      ]);
      const keys = store.getKeysForVersion('4.2.1');
      expect(keys.sort()).toEqual(['DEV-1', 'DEV-2']);
    });
  });

  // ── Search ────────────────────────────────────────

  describe('search', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1001', summary: 'Login timeout bug', assignee: 'Alice' }),
        makeTicket({ key: 'DEV-1002', summary: 'Dashboard performance', assignee: 'Bob' }),
        makeTicket({ key: 'DEV-1003', summary: 'Mobile login crash', assignee: 'Alice' }),
      ]);
    });

    it('searches by key', () => {
      const result = store.search('DEV-1002');
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].key).toBe('DEV-1002');
    });

    it('searches by summary', () => {
      const result = store.search('login');
      expect(result.tickets).toHaveLength(2);
    });

    it('searches by assignee', () => {
      const result = store.search('Alice');
      expect(result.tickets).toHaveLength(2);
    });

    it('returns total count', () => {
      const result = store.search('login');
      expect(result.total).toBe(2);
    });

    it('respects limit', () => {
      const result = store.search('DEV', { limit: 1 });
      expect(result.tickets).toHaveLength(1);
      expect(result.hasMore).toBe(true);
    });

    it('respects offset', () => {
      const result = store.search('DEV', { limit: 1, offset: 1 });
      expect(result.tickets).toHaveLength(1);
      expect(result.total).toBe(3);
    });
  });

  // ── Filtered queries ──────────────────────────────

  describe('getByFilter', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', statusCategory: 'In Progress', assignee: 'Alice', type: 'Bug' }),
        makeTicket({ key: 'DEV-2', statusCategory: 'Done', assignee: 'Bob', type: 'Story' }),
        makeTicket({ key: 'DEV-3', statusCategory: 'To Do', assignee: 'Alice', type: 'Bug', created: '2026-04-15T00:00:00Z' }),
        makeTicket({ key: 'DEV-4', statusCategory: 'Done', assignee: 'Alice', type: 'Bug', fixVersions: [] }),
      ]);
    });

    it('filters by statusCategory', () => {
      const result = store.getByFilter({ statusCategory: 'Done' });
      expect(result.tickets).toHaveLength(2);
    });

    it('filters by assignee', () => {
      const result = store.getByFilter({ assignee: 'Alice' });
      expect(result.tickets).toHaveLength(3);
    });

    it('filters by type', () => {
      const result = store.getByFilter({ type: 'Bug' });
      expect(result.tickets).toHaveLength(3);
    });

    it('filters by hasFixVersion false', () => {
      const result = store.getByFilter({ hasFixVersion: false });
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].key).toBe('DEV-4');
    });

    it('filters by hasFixVersion true', () => {
      const result = store.getByFilter({ hasFixVersion: true });
      expect(result.tickets).toHaveLength(3);
    });

    it('filters by createdSince', () => {
      const result = store.getByFilter({ createdSince: '2026-04-14' });
      // DEV-3 created 2026-04-15, others 2026-04-10
      expect(result.tickets).toHaveLength(1);
    });

    it('combines multiple filters', () => {
      const result = store.getByFilter({ statusCategory: 'Done', assignee: 'Alice' });
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].key).toBe('DEV-4');
    });

    it('returns total for pagination', () => {
      const result = store.getByFilter({ assignee: 'Alice', limit: 1 });
      expect(result.tickets).toHaveLength(1);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(true);
    });
  });

  // ── Analytical views ──────────────────────────────

  describe('getQAScope', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', statusCategory: 'Done', status: 'QA Certified', fixVersions: [], state: 'done' }),
        makeTicket({ key: 'DEV-2', statusCategory: 'Done', status: 'NO QA - Certified', fixVersions: [], state: 'done' }),
        makeTicket({ key: 'DEV-3', statusCategory: 'Done', status: 'Resolved Without Code', fixVersions: [], state: 'done' }),
        makeTicket({ key: 'DEV-4', statusCategory: 'Done', status: 'QA Certified', fixVersions: ['4.2.1'], state: 'done' }),
        makeTicket({ key: 'DEV-5', statusCategory: 'In Progress', status: 'In Review', fixVersions: [], state: 'in-progress' }),
      ]);
    });

    it('returns Done tickets with empty fixVersions', () => {
      const result = store.getQAScope();
      expect(result.tickets).toHaveLength(2);
      const keys = result.tickets.map(t => t.key).sort();
      expect(keys).toEqual(['DEV-1', 'DEV-2']);
    });

    it('excludes Resolved Without Code', () => {
      const result = store.getQAScope();
      expect(result.tickets.find(t => t.key === 'DEV-3')).toBeUndefined();
    });

    it('excludes tickets with fixVersions', () => {
      const result = store.getQAScope();
      expect(result.tickets.find(t => t.key === 'DEV-4')).toBeUndefined();
    });

    it('excludes non-Done tickets', () => {
      const result = store.getQAScope();
      expect(result.tickets.find(t => t.key === 'DEV-5')).toBeUndefined();
    });

    it('returns correct total', () => {
      const result = store.getQAScope();
      expect(result.total).toBe(2);
    });

    it('supports pagination', () => {
      const result = store.getQAScope({ limit: 1 });
      expect(result.tickets).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(2);
    });
  });

  describe('getTriage', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', statusCategory: 'To Do', created: '2026-04-17T10:00:00Z' }),
        makeTicket({ key: 'DEV-2', statusCategory: 'To Do', created: '2026-04-16T10:00:00Z' }),
        makeTicket({ key: 'DEV-3', statusCategory: 'To Do', created: '2026-04-01T10:00:00Z' }),
        makeTicket({ key: 'DEV-4', statusCategory: 'In Progress', created: '2026-04-17T10:00:00Z' }),
      ]);
    });

    it('returns To Do tickets created since date', () => {
      const result = store.getTriage({ since: '2026-04-16' });
      expect(result.tickets).toHaveLength(2);
    });

    it('excludes non-To Do tickets', () => {
      const result = store.getTriage({ since: '2026-04-16' });
      expect(result.tickets.find(t => t.key === 'DEV-4')).toBeUndefined();
    });

    it('excludes old tickets', () => {
      const result = store.getTriage({ since: '2026-04-16' });
      expect(result.tickets.find(t => t.key === 'DEV-3')).toBeUndefined();
    });

    it('returns since in response', () => {
      const result = store.getTriage({ since: '2026-04-16' });
      expect(result.since).toBe('2026-04-16');
    });

    it('defaults to 7 days ago', () => {
      const result = store.getTriage({});
      expect(result.since).toBeDefined();
    });
  });

  // ── Stats ─────────────────────────────────────────

  describe('getStats', () => {
    it('returns counts by category and type', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', statusCategory: 'Done', type: 'Bug' }),
        makeTicket({ key: 'DEV-2', statusCategory: 'Done', type: 'Story' }),
        makeTicket({ key: 'DEV-3', statusCategory: 'In Progress', type: 'Bug' }),
      ]);
      const stats = store.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byStatusCategory.Done).toBe(2);
      expect(stats.byStatusCategory['In Progress']).toBe(1);
      expect(stats.byType.Bug).toBe(2);
      expect(stats.byType.Story).toBe(1);
    });

    it('returns zero for empty store', () => {
      const stats = store.getStats();
      expect(stats.total).toBe(0);
    });
  });

  // ── Sync metadata ─────────────────────────────────

  describe('syncMeta', () => {
    it('gets initial empty sync meta', () => {
      const meta = store.getSyncMeta();
      expect(meta.lastTicketSyncTime).toBeNull();
      expect(meta.totalTicketsSynced).toBe(0);
    });

    it('updates sync meta', () => {
      store.updateSyncMeta({
        lastTicketSyncTime: '2026-04-16T15:00:00Z',
        totalTicketsSynced: 500,
        lastSyncDurationMs: 12000,
      });
      const meta = store.getSyncMeta();
      expect(meta.lastTicketSyncTime).toBe('2026-04-16T15:00:00Z');
      expect(meta.totalTicketsSynced).toBe(500);
      expect(meta.lastSyncDurationMs).toBe(12000);
      expect(meta.lastSyncError).toBeNull();
    });

    it('preserves existing meta on partial update', () => {
      store.updateSyncMeta({ lastTicketSyncTime: '2026-04-16T15:00:00Z', totalTicketsSynced: 500 });
      store.updateSyncMeta({ lastSyncError: 'oops' });
      const meta = store.getSyncMeta();
      expect(meta.lastTicketSyncTime).toBe('2026-04-16T15:00:00Z');
      expect(meta.totalTicketsSynced).toBe(500);
      expect(meta.lastSyncError).toBe('oops');
    });
  });

  // ── Edge cases ────────────────────────────────────

  describe('edge cases', () => {
    it('handles tickets with no fixVersions or targetFixVersions', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: [], targetFixVersions: [] }));
      const got = store.get('DEV-1');
      expect(got.fixVersions).toEqual([]);
      expect(got.targetFixVersions).toEqual([]);
    });

    it('handles tickets with multiple versions', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: ['4.2.1', '4.3.0'], targetFixVersions: ['4.2.1'] }));
      const in421 = store.getForVersion('4.2.1');
      const in430 = store.getForVersion('4.3.0');
      expect(in421).toHaveLength(1);
      expect(in430).toHaveLength(1);
      expect(in421[0]._releaseSource).toBe('both');
      expect(in430[0]._releaseSource).toBe('fixVersion');
    });

    it('version pattern does not match partial version strings', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: ['4.2.10'], targetFixVersions: [] }));
      // Should NOT match "4.2.1" — only "4.2.10"
      const result = store.getForVersion('4.2.1');
      expect(result).toHaveLength(0);
    });

    it('handles null/undefined fields gracefully', () => {
      store.upsert({
        key: 'DEV-1',
        summary: null,
        status: null,
        statusCategory: null,
        state: null,
        type: null,
        assignee: null,
        reporter: null,
        qaAssignee: null,
        productAssignee: null,
        component: null,
        priority: null,
        riskLevel: null,
        customerPriority: null,
        fixVersions: null,
        targetFixVersions: null,
        customerTags: null,
        deployedEnvironments: null,
        labels: null,
        zohoRef: null,
        submitterName: null,
        submitterEmail: null,
        created: null,
        updatedInJira: null,
        syncedAt: '2026-04-16T15:00:00Z',
      });
      const got = store.get('DEV-1');
      expect(got.key).toBe('DEV-1');
      expect(got.fixVersions).toEqual([]);
    });
  });

  // ── Product taxonomy fields ─────────────────────────

  describe('module/product/projects fields', () => {
    it('stores and retrieves module field', () => {
      store.upsert(makeTicket({ module: 'Billing' }));
      const got = store.get('DEV-1001');
      expect(got.module).toBe('Billing');
    });

    it('stores and retrieves product as JSON array', () => {
      store.upsert(makeTicket({ product: ['Web Platform', 'Mobile (iOS)'] }));
      const got = store.get('DEV-1001');
      expect(got.product).toEqual(['Web Platform', 'Mobile (iOS)']);
    });

    it('stores and retrieves projects as JSON array', () => {
      store.upsert(makeTicket({ projects: ['RCM V2', 'Lumen Phase 2'] }));
      const got = store.get('DEV-1001');
      expect(got.projects).toEqual(['RCM V2', 'Lumen Phase 2']);
    });

    it('defaults to empty arrays when not set', () => {
      store.upsert(makeTicket());
      const got = store.get('DEV-1001');
      expect(got.product).toEqual([]);
      expect(got.projects).toEqual([]);
      expect(got.module).toBeNull();
    });

    it('updates module on upsert', () => {
      store.upsert(makeTicket({ module: 'Billing' }));
      store.upsert(makeTicket({ module: 'Scheduling' }));
      expect(store.get('DEV-1001').module).toBe('Scheduling');
    });

    it('preserves all taxonomy fields in batch upsert', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', module: 'Billing', product: ['Web Platform'], projects: ['RCM V2'] }),
        makeTicket({ key: 'DEV-2', module: 'AI', product: ['Web Platform', 'Mobile (iOS)'], projects: [] }),
      ]);
      expect(store.get('DEV-1').module).toBe('Billing');
      expect(store.get('DEV-1').projects).toEqual(['RCM V2']);
      expect(store.get('DEV-2').module).toBe('AI');
      expect(store.get('DEV-2').product).toEqual(['Web Platform', 'Mobile (iOS)']);
    });
  });

  // ── Module/component grouping queries ───────────────

  describe('getModules', () => {
    it('returns distinct modules with counts', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', module: 'Billing' }),
        makeTicket({ key: 'DEV-2', module: 'Billing' }),
        makeTicket({ key: 'DEV-3', module: 'Scheduling' }),
        makeTicket({ key: 'DEV-4', module: null }),
      ]);
      const mods = store.getModules();
      expect(mods).toEqual([
        { module: 'Billing', count: 2 },
        { module: 'Scheduling', count: 1 },
      ]);
    });
  });

  describe('getComponentsForModule', () => {
    it('returns components within a module', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', module: 'Billing', component: 'RCM - Invoicing' }),
        makeTicket({ key: 'DEV-2', module: 'Billing', component: 'RCM - Invoicing' }),
        makeTicket({ key: 'DEV-3', module: 'Billing', component: 'RCM - Payments' }),
        makeTicket({ key: 'DEV-4', module: 'Scheduling', component: 'Visit Editing' }),
      ]);
      const comps = store.getComponentsForModule('Billing');
      expect(comps).toEqual([
        { component: 'RCM - Invoicing', count: 2 },
        { component: 'RCM - Payments', count: 1 },
      ]);
    });

    it('returns empty for unknown module', () => {
      expect(store.getComponentsForModule('Nonexistent')).toEqual([]);
    });
  });

  // ── Filter queries with new fields ──────────────────

  describe('getByFilter with taxonomy fields', () => {
    beforeEach(() => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', module: 'Billing', component: 'RCM - Invoicing', customerTags: ['CK'], product: ['Web Platform'], projects: ['RCM V2'] }),
        makeTicket({ key: 'DEV-2', module: 'Billing', component: 'RCM - Payments', customerTags: [], product: ['Web Platform'], projects: [] }),
        makeTicket({ key: 'DEV-3', module: 'Scheduling', component: 'Visit Editing', customerTags: ['Bayada'], product: ['Web Platform'], projects: [] }),
        makeTicket({ key: 'DEV-4', module: 'AI', component: 'AI CoPilot', customerTags: [], product: ['Web Platform', 'Mobile (iOS)'], projects: ['Lumen Phase 2'] }),
      ]);
    });

    it('filters by module', () => {
      const result = store.getByFilter({ module: 'Billing' });
      expect(result.total).toBe(2);
      expect(result.tickets.map(t => t.key).sort()).toEqual(['DEV-1', 'DEV-2']);
    });

    it('filters by component', () => {
      const result = store.getByFilter({ component: 'RCM - Invoicing' });
      expect(result.total).toBe(1);
      expect(result.tickets[0].key).toBe('DEV-1');
    });

    it('filters by customer — includes untagged tickets', () => {
      const result = store.getByFilter({ customer: 'CK' });
      // Should include DEV-1 (tagged CK) + DEV-2 and DEV-4 (no customer = all customers)
      expect(result.total).toBe(3);
      const keys = result.tickets.map(t => t.key).sort();
      expect(keys).toEqual(['DEV-1', 'DEV-2', 'DEV-4']);
    });

    it('filters by project', () => {
      const result = store.getByFilter({ project: 'RCM V2' });
      expect(result.total).toBe(1);
      expect(result.tickets[0].key).toBe('DEV-1');
    });

    it('filters by product', () => {
      const result = store.getByFilter({ product: 'Mobile (iOS)' });
      expect(result.total).toBe(1);
      expect(result.tickets[0].key).toBe('DEV-4');
    });

    it('combines module and customer filters', () => {
      const result = store.getByFilter({ module: 'Billing', customer: 'CK' });
      // DEV-1 (Billing + CK) and DEV-2 (Billing + no customer)
      expect(result.total).toBe(2);
    });
  });

  // ── Filter options ──────────────────────────────────

  describe('getFilterOptions', () => {
    it('returns distinct values for all filter fields', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', module: 'Billing', customerTags: ['CK', 'Bayada'], product: ['Web Platform'], projects: ['RCM V2'] }),
        makeTicket({ key: 'DEV-2', module: 'Scheduling', customerTags: ['Lumen'], product: ['Mobile (iOS)'], projects: ['Lumen Phase 2'] }),
        makeTicket({ key: 'DEV-3', module: 'Billing', customerTags: [], product: ['Web Platform'], projects: [] }),
      ]);
      const opts = store.getFilterOptions();
      expect(opts.modules.sort()).toEqual(['Billing', 'Scheduling']);
      expect(opts.customers.sort()).toEqual(['Bayada', 'CK', 'Lumen']);
      expect(opts.projects.sort()).toEqual(['Lumen Phase 2', 'RCM V2']);
      expect(opts.products.sort()).toEqual(['Mobile (iOS)', 'Web Platform']);
    });
  });

  // ── Stats with module breakdown ─────────────────────

  describe('getStats with module', () => {
    it('includes byModule breakdown', () => {
      store.upsertBatch([
        makeTicket({ key: 'DEV-1', module: 'Billing' }),
        makeTicket({ key: 'DEV-2', module: 'Billing' }),
        makeTicket({ key: 'DEV-3', module: 'AI' }),
      ]);
      const stats = store.getStats();
      expect(stats.byModule).toEqual({ Billing: 2, AI: 1 });
    });
  });

  // ── Cut Scope (merged to main, no fixVersion) ──────

  describe('getCutScope', () => {
    function seedPr(db, { repo = 'webplatform', prNumber, jiraKey, status = 'merged', baseBranch = 'main' }) {
      db.prepare(`
        INSERT OR REPLACE INTO github_prs (repo, prNumber, status, baseBranch, syncedAt)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(repo, prNumber, status, baseBranch);
      db.prepare(`
        INSERT OR IGNORE INTO pr_jira_keys (repo, prNumber, jiraKey) VALUES (?, ?, ?)
      `).run(repo, prNumber, jiraKey);
    }

    it('returns tickets with merged PRs to main and no fixVersion', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: [], status: 'Ready For Testing' }));
      store.upsert(makeTicket({ key: 'DEV-2', fixVersions: ['4.2.1'], status: 'Done' }));
      store.upsert(makeTicket({ key: 'DEV-3', fixVersions: [], status: 'In Review' }));

      seedPr(db, { prNumber: 100, jiraKey: 'DEV-1', status: 'merged', baseBranch: 'main' });
      seedPr(db, { prNumber: 101, jiraKey: 'DEV-2', status: 'merged', baseBranch: 'main' });
      seedPr(db, { prNumber: 102, jiraKey: 'DEV-3', status: 'open', baseBranch: 'main' }); // not merged

      const result = store.getCutScope();
      expect(result.total).toBe(1); // Only DEV-1: merged + no fixVersion
      expect(result.tickets[0].key).toBe('DEV-1');
    });

    it('includes PRs merged to master as well as main', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: [] }));
      store.upsert(makeTicket({ key: 'DEV-2', fixVersions: [] }));

      seedPr(db, { prNumber: 100, jiraKey: 'DEV-1', baseBranch: 'main' });
      seedPr(db, { prNumber: 101, jiraKey: 'DEV-2', baseBranch: 'master' });

      const result = store.getCutScope();
      expect(result.total).toBe(2);
    });

    it('excludes PRs merged to release branches', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: [] }));

      seedPr(db, { prNumber: 100, jiraKey: 'DEV-1', baseBranch: 'releases/4.2.0' });

      const result = store.getCutScope();
      expect(result.total).toBe(0);
    });

    it('filters by module', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: [], module: 'Billing' }));
      store.upsert(makeTicket({ key: 'DEV-2', fixVersions: [], module: 'Scheduling' }));

      seedPr(db, { prNumber: 100, jiraKey: 'DEV-1', baseBranch: 'main' });
      seedPr(db, { prNumber: 101, jiraKey: 'DEV-2', baseBranch: 'main' });

      const result = store.getCutScope({ module: 'Billing' });
      expect(result.total).toBe(1);
      expect(result.tickets[0].key).toBe('DEV-1');
    });

    it('filters by search', () => {
      store.upsert(makeTicket({ key: 'DEV-1', fixVersions: [], summary: 'Fix login bug' }));
      store.upsert(makeTicket({ key: 'DEV-2', fixVersions: [], summary: 'Add payment flow' }));

      seedPr(db, { prNumber: 100, jiraKey: 'DEV-1', baseBranch: 'main' });
      seedPr(db, { prNumber: 101, jiraKey: 'DEV-2', baseBranch: 'main' });

      const result = store.getCutScope({ search: 'login' });
      expect(result.total).toBe(1);
      expect(result.tickets[0].key).toBe('DEV-1');
    });

    it('paginates correctly', () => {
      for (let i = 1; i <= 5; i++) {
        store.upsert(makeTicket({ key: `DEV-${i}`, fixVersions: [], created: `2026-04-${String(i).padStart(2, '0')}T10:00:00Z` }));
        seedPr(db, { prNumber: 100 + i, jiraKey: `DEV-${i}`, baseBranch: 'main' });
      }

      const page1 = store.getCutScope({ limit: 2, sort: 'created', sortDir: 'desc' });
      expect(page1.tickets).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.hasMore).toBe(true);

      const page2 = store.getCutScope({ limit: 2, offset: 2, sort: 'created', sortDir: 'desc' });
      expect(page2.tickets).toHaveLength(2);
      expect(page2.hasMore).toBe(true);
    });
  });
});
