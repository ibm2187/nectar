import { describe, it, expect, beforeEach, vi } from 'vitest';

const ZohoStore = require('../../src/core/zoho-store');
const { createTestDb } = require('../../src/core/db');

describe('ZohoStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createTestDb();
    store = new ZohoStore({ db });
  });

  const sampleTicket = (overrides = {}) => ({
    id: '1078812000011967813',
    ticketNumber: 'VHC-4165',
    departmentId: 'dept-vhc',
    accountId: 'acct-ck163',
    contactId: 'contact-1',
    assigneeEmail: 'Bryan.Nothling@vivtechnologies.com',
    assigneeZohoAgentId: 'agent-1',
    subject: 'Add client document types',
    status: 'Investigating',
    statusType: 'Open',
    priority: 'Medium',
    category: 'Client Documents',
    channel: 'Web',
    commentCount: 2,
    threadCount: 1,
    createdAt: '2026-03-20T15:33:50.000Z',
    modifiedAt: '2026-04-22T22:15:28.000Z',
    webUrl: 'https://support.vivtechnologies.com/x',
    ...overrides,
  });

  // ───────────────────────────── Tickets ───────────────────

  describe('upsertTicket / getTicketById / count', () => {
    it('inserts a new ticket', () => {
      store.upsertTicket(sampleTicket());
      expect(store.count()).toBe(1);
      const got = store.getTicketById('1078812000011967813');
      expect(got).toBeTruthy();
      expect(got.ticketNumber).toBe('VHC-4165');
    });

    it('normalizes assignee email to lowercase', () => {
      store.upsertTicket(sampleTicket({ assigneeEmail: 'ALICE@VIVTECHNOLOGIES.COM' }));
      expect(store.getTicketById('1078812000011967813').assigneeEmail).toBe('alice@vivtechnologies.com');
    });

    it('derives deptPrefix from ticketNumber when not supplied', () => {
      store.upsertTicket(sampleTicket());
      expect(store.getTicketById('1078812000011967813').deptPrefix).toBe('VHC');
    });

    it('updates on conflict (idempotent)', () => {
      store.upsertTicket(sampleTicket({ status: 'Investigating' }));
      store.upsertTicket(sampleTicket({ status: 'Closed', statusType: 'Closed' }));
      expect(store.count()).toBe(1);
      const got = store.getTicketById('1078812000011967813');
      expect(got.status).toBe('Closed');
      expect(got.statusType).toBe('Closed');
    });

    it('getTicketByNumber returns the same ticket', () => {
      store.upsertTicket(sampleTicket());
      expect(store.getTicketByNumber('VHC-4165').id).toBe('1078812000011967813');
    });

    it('countOpen excludes Closed tickets', () => {
      store.upsertTicket(sampleTicket({ id: 'a', ticketNumber: 'VHC-1', statusType: 'Open' }));
      store.upsertTicket(sampleTicket({ id: 'b', ticketNumber: 'VHC-2', statusType: 'Closed' }));
      store.upsertTicket(sampleTicket({ id: 'c', ticketNumber: 'VHC-3', statusType: 'On Hold' }));
      expect(store.count()).toBe(3);
      expect(store.countOpen()).toBe(2);
    });
  });

  describe('upsertTicketBatch', () => {
    it('atomically inserts many', () => {
      const tickets = Array.from({ length: 10 }, (_, i) => sampleTicket({
        id: `id-${i}`, ticketNumber: `VHC-${100 + i}`,
      }));
      store.upsertTicketBatch(tickets);
      expect(store.count()).toBe(10);
    });
  });

  describe('maxModifiedAt', () => {
    it('returns null when no tickets', () => {
      expect(store.maxModifiedAt()).toBeNull();
    });

    it('returns the greatest modifiedAt across all rows', () => {
      store.upsertTicket(sampleTicket({ id: 'a', modifiedAt: '2026-04-01T00:00:00.000Z' }));
      store.upsertTicket(sampleTicket({ id: 'b', modifiedAt: '2026-04-23T00:00:00.000Z' }));
      store.upsertTicket(sampleTicket({ id: 'c', modifiedAt: '2026-04-10T00:00:00.000Z' }));
      expect(store.maxModifiedAt()).toBe('2026-04-23T00:00:00.000Z');
    });
  });

  describe('listTickets filters', () => {
    beforeEach(() => {
      store.upsertTicketBatch([
        sampleTicket({ id: '1', ticketNumber: 'VHC-1', assigneeEmail: 'bryan@v.com', status: 'Investigating', statusType: 'Open', priority: 'Urgent', deptPrefix: 'VHC' }),
        sampleTicket({ id: '2', ticketNumber: 'VHC-2', assigneeEmail: 'bryan@v.com', status: 'Waiting for Viv Response', statusType: 'On Hold', priority: 'Medium', deptPrefix: 'VHC' }),
        sampleTicket({ id: '3', ticketNumber: 'BYD-1', assigneeEmail: 'alice@v.com', status: 'Investigating', statusType: 'Open', priority: 'High', deptPrefix: 'BYD' }),
        sampleTicket({ id: '4', ticketNumber: 'BYD-2', assigneeEmail: 'alice@v.com', status: 'Closed',        statusType: 'Closed', priority: 'Low', deptPrefix: 'BYD' }),
      ]);
    });

    it('filters by assignee', () => {
      expect(store.listTickets({ assigneeEmail: 'bryan@v.com' })).toHaveLength(2);
    });

    it('filters by status list', () => {
      expect(store.listTickets({ statuses: ['Investigating'] })).toHaveLength(2);
    });

    it('filters by statusType list', () => {
      expect(store.listTickets({ statusTypes: ['Open'] })).toHaveLength(2);
    });

    it('filters by priority list', () => {
      expect(store.listTickets({ priorities: ['Urgent', 'High'] })).toHaveLength(2);
    });

    it('filters by deptPrefix', () => {
      expect(store.listTickets({ deptPrefixes: ['BYD'] })).toHaveLength(2);
    });

    it('openOnly excludes Closed', () => {
      expect(store.listTickets({ openOnly: true })).toHaveLength(3);
    });

    it('closedOnly returns only Closed', () => {
      expect(store.listTickets({ closedOnly: true })).toHaveLength(1);
    });

    it('combines filters (AND semantics)', () => {
      const result = store.listTickets({
        assigneeEmail: 'bryan@v.com',
        statuses: ['Investigating'],
      });
      expect(result).toHaveLength(1);
      expect(result[0].ticketNumber).toBe('VHC-1');
    });

    it('search matches on subject or ticketNumber (case-insensitive via LIKE)', () => {
      const r1 = store.listTickets({ search: 'VHC-2' });
      expect(r1).toHaveLength(1);
      expect(r1[0].id).toBe('2');
    });

    it('limit caps results', () => {
      expect(store.listTickets({ limit: 2 })).toHaveLength(2);
    });

    it('maxAgeDays excludes tickets older than the bound', () => {
      // Insert one ancient + one fresh ticket beyond the seed batch
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      store.upsertTicket(sampleTicket({ id: 'fresh', ticketNumber: 'VHC-NEW', createdAt: oneDayAgo, deptPrefix: 'VHC' }));
      store.upsertTicket(sampleTicket({ id: 'ancient', ticketNumber: 'VHC-OLD', createdAt: ninetyDaysAgo, deptPrefix: 'VHC' }));

      // Window: created within last 7d → only the fresh one
      const recent = store.listTickets({ maxAgeDays: 7 });
      const ids = recent.map(r => r.id);
      expect(ids).toContain('fresh');
      expect(ids).not.toContain('ancient');
    });

    it('minAgeDays + maxAgeDays form an inclusive window', () => {
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const seventyDaysAgo = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString();
      store.upsertTicket(sampleTicket({ id: 'mid', createdAt: fortyDaysAgo, deptPrefix: 'VHC', ticketNumber: 'VHC-MID' }));
      store.upsertTicket(sampleTicket({ id: 'recent', createdAt: tenDaysAgo, deptPrefix: 'VHC', ticketNumber: 'VHC-REC' }));
      store.upsertTicket(sampleTicket({ id: 'old', createdAt: seventyDaysAgo, deptPrefix: 'VHC', ticketNumber: 'VHC-OLD2' }));

      // Window: 31-60 days old → only 'mid' qualifies
      const result = store.listTickets({ minAgeDays: 31, maxAgeDays: 60 });
      const ids = result.map(r => r.id);
      expect(ids).toContain('mid');
      expect(ids).not.toContain('recent');
      expect(ids).not.toContain('old');
    });

    it('hasJiraLinks filters to only ticket IDs present in jira_zoho_links', () => {
      // Tickets '1' and '2' are linked; '3' and '4' are not.
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: '1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-2', zohoTicketId: '2', source: 'customfield_11157' });
      expect(store.listTickets({ hasJiraLinks: true })).toHaveLength(2);
    });

    it('offset paginates while preserving order', () => {
      const all = store.listTickets({ orderBy: 'created', orderDir: 'asc' });
      const page1 = store.listTickets({ orderBy: 'created', orderDir: 'asc', limit: 2, offset: 0 });
      const page2 = store.listTickets({ orderBy: 'created', orderDir: 'asc', limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).toBe(all[0].id);
      expect(page2[0].id).toBe(all[2].id);
    });

    it('countTickets returns the total ignoring limit/offset/order', () => {
      // Total across the four seed tickets = 4. The ?limit=2 in listTickets
      // doesn't affect countTickets.
      expect(store.countTickets()).toBe(4);
      expect(store.listTickets({ limit: 2 })).toHaveLength(2);

      // Filters apply identically: openOnly excludes the one Closed seed.
      expect(store.countTickets({ openOnly: true })).toBe(3);
    });

    it('sort whitelist falls back to modifiedAt for unknown orderBy', () => {
      // Pass a bogus sort key — must not blow up and must produce stable output.
      const r1 = store.listTickets({ orderBy: 'nope; DROP TABLE zoho_tickets;--' });
      expect(r1).toHaveLength(4);
    });

    it('age sort: DESC returns oldest tickets first (highest age)', () => {
      // Replace the seed batch with tickets whose createdAt clearly differs.
      db.prepare('DELETE FROM zoho_tickets').run();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      store.upsertTicketBatch([
        sampleTicket({ id: 'new', ticketNumber: 'VHC-N', createdAt: new Date(now - 1 * day).toISOString() }),
        sampleTicket({ id: 'mid', ticketNumber: 'VHC-M', createdAt: new Date(now - 30 * day).toISOString() }),
        sampleTicket({ id: 'old', ticketNumber: 'VHC-O', createdAt: new Date(now - 90 * day).toISOString() }),
      ]);

      // Age DESC should put the oldest ticket first (90d > 30d > 1d).
      const desc = store.listTickets({ orderBy: 'age', orderDir: 'desc' });
      expect(desc.map(t => t.id)).toEqual(['old', 'mid', 'new']);

      // Age ASC = newest first (lowest age).
      const asc = store.listTickets({ orderBy: 'age', orderDir: 'asc' });
      expect(asc.map(t => t.id)).toEqual(['new', 'mid', 'old']);
    });

    it('fixVersions filter narrows to tickets whose linked JIRA ships in any version', () => {
      // Seed JIRAs with distinct fix versions
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, syncedAt, fixVersions)
                  VALUES ('DEV-A', 'A', 'In Dev', '2026-04-25T00:00:00Z', '["4.2.0"]')`).run();
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, syncedAt, fixVersions)
                  VALUES ('DEV-B', 'B', 'In Dev', '2026-04-25T00:00:00Z', '["4.1.4","4.1.3.1"]')`).run();
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, syncedAt, fixVersions)
                  VALUES ('DEV-C', 'C', 'In Dev', '2026-04-25T00:00:00Z', '["3.9.0"]')`).run();
      // Link them to seed tickets
      store.upsertLink({ jiraKey: 'DEV-A', zohoTicketId: '1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-B', zohoTicketId: '2', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-C', zohoTicketId: '3', source: 'customfield_11157' });

      // Single version
      const r1 = store.listTickets({ fixVersions: ['4.2.0'] });
      expect(r1.map(t => t.id)).toEqual(['1']);

      // Multiple versions OR semantics
      const r2 = store.listTickets({ fixVersions: ['4.2.0', '4.1.4'] });
      expect(r2.map(t => t.id).sort()).toEqual(['1', '2']);

      // No match
      const r3 = store.listTickets({ fixVersions: ['9.9.9'] });
      expect(r3).toHaveLength(0);
    });
  });

  describe('groupedStats', () => {
    beforeEach(() => {
      store.upsertAccount({ id: 'acct-1', name: 'Bayada' });
      store.upsertAccount({ id: 'acct-2', name: 'Comfort Keepers' });
      store.upsertTicketBatch([
        sampleTicket({ id: '1', ticketNumber: 'BYD-1', deptPrefix: 'BYD', accountId: 'acct-1', assigneeEmail: 'bryan@v.com', statusType: 'Open' }),
        sampleTicket({ id: '2', ticketNumber: 'BYD-2', deptPrefix: 'BYD', accountId: 'acct-1', assigneeEmail: 'bryan@v.com', statusType: 'Closed' }),
        sampleTicket({ id: '3', ticketNumber: 'CK-1',  deptPrefix: 'CK',  accountId: 'acct-2', assigneeEmail: 'alice@v.com', statusType: 'Open' }),
      ]);
    });

    it('groupBy=assignee returns per-assignee totals + openCounts', () => {
      const rows = store.groupedStats({}, 'assignee');
      const map = Object.fromEntries(rows.map(r => [r.key, r]));
      expect(map['bryan@v.com'].total).toBe(2);
      expect(map['bryan@v.com'].openCount).toBe(1);
      expect(map['alice@v.com'].total).toBe(1);
      expect(map['alice@v.com'].openCount).toBe(1);
    });

    it('groupBy=account joins zoho_accounts for displayName', () => {
      const rows = store.groupedStats({}, 'account');
      const map = Object.fromEntries(rows.map(r => [r.key, r]));
      expect(map['acct-1'].displayName).toBe('Bayada');
      expect(map['acct-1'].total).toBe(2);
      expect(map['acct-2'].displayName).toBe('Comfort Keepers');
      expect(map['acct-2'].total).toBe(1);
    });

    it('groupBy=deptPrefix returns per-prefix totals', () => {
      const rows = store.groupedStats({}, 'deptPrefix');
      const map = Object.fromEntries(rows.map(r => [r.key, r]));
      expect(map['BYD'].total).toBe(2);
      expect(map['CK'].total).toBe(1);
    });

    it('groupBy=fixVersion expands JSON arrays via json_each', () => {
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, syncedAt, fixVersions)
                  VALUES ('DEV-A', 'A', 'In Dev', '2026-04-25T00:00:00Z', '["4.2.0", "4.1.4"]')`).run();
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, syncedAt, fixVersions)
                  VALUES ('DEV-B', 'B', 'In Dev', '2026-04-25T00:00:00Z', '["4.2.0"]')`).run();
      store.upsertLink({ jiraKey: 'DEV-A', zohoTicketId: '1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-B', zohoTicketId: '3', source: 'customfield_11157' });

      const rows = store.groupedStats({}, 'fixVersion');
      const map = Object.fromEntries(rows.map(r => [r.key, r]));
      // 4.2.0 backs both DEV-A (ticket 1) and DEV-B (ticket 3) → 2 distinct
      expect(map['4.2.0'].total).toBe(2);
      // 4.1.4 only via DEV-A (ticket 1) → 1
      expect(map['4.1.4'].total).toBe(1);
    });

    it('strips the grouped dimension from filters', () => {
      // assigneeEmail filter should be ignored when groupBy=assignee — we
      // want the cross-assignee distribution.
      const rows = store.groupedStats({ assigneeEmail: 'bryan@v.com' }, 'assignee');
      expect(rows.length).toBeGreaterThan(1);
    });

    it('groupBy=account composes with hasJiraLinks (zoho_accounts.id ambiguity guard)', () => {
      // Both zoho_tickets and zoho_accounts have an `id` column. The
      // hasJiraLinks filter adds `id IN (...)` to the WHERE; without aliasing
      // the JOIN through `t`, SQLite raised "ambiguous column name: id".
      store.upsertLink({ jiraKey: 'DEV-X', zohoTicketId: '1', source: 'customfield_11157' });
      const rows = store.groupedStats({ hasJiraLinks: true }, 'account');
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe('acct-1');
    });

    it('respects other filters while grouping (e.g. openOnly)', () => {
      const rows = store.groupedStats({ openOnly: true }, 'assignee');
      const map = Object.fromEntries(rows.map(r => [r.key, r]));
      // bryan has 1 open out of 2 total
      expect(map['bryan@v.com'].total).toBe(1);
    });
  });

  describe('listDeptPrefixes', () => {
    beforeEach(() => {
      store.upsertTicketBatch([
        sampleTicket({ id: '1', ticketNumber: 'VHC-1', deptPrefix: 'VHC' }),
        sampleTicket({ id: '2', ticketNumber: 'VHC-2', deptPrefix: 'VHC' }),
        sampleTicket({ id: '3', ticketNumber: 'BYD-1', deptPrefix: 'BYD' }),
      ]);
    });

    it('returns distinct prefixes with counts', () => {
      const rows = store.listDeptPrefixes();
      expect(rows).toEqual([
        { deptPrefix: 'BYD', count: 1 },
        { deptPrefix: 'VHC', count: 2 },
      ]);
    });
  });

  describe('assigneeStats', () => {
    it('groups by assignee with open/total counts', () => {
      store.upsertTicketBatch([
        sampleTicket({ id: '1', ticketNumber: 'VHC-1', assigneeEmail: 'bryan@v.com', statusType: 'Open' }),
        sampleTicket({ id: '2', ticketNumber: 'VHC-2', assigneeEmail: 'bryan@v.com', statusType: 'Closed' }),
        sampleTicket({ id: '3', ticketNumber: 'VHC-3', assigneeEmail: 'alice@v.com', statusType: 'Open' }),
      ]);
      const stats = store.assigneeStats();
      const map = Object.fromEntries(stats.map(s => [s.assigneeEmail, s]));
      expect(map['bryan@v.com'].total).toBe(2);
      expect(map['bryan@v.com'].openCount).toBe(1);
      expect(map['alice@v.com'].total).toBe(1);
      expect(map['alice@v.com'].openCount).toBe(1);
    });
  });

  // ───────────────────────────── Accounts + Contacts ───────

  describe('accounts', () => {
    it('upsert + get + list', () => {
      store.upsertAccount({ id: 'a1', name: 'Comfort Keepers - 163' });
      store.upsertAccount({ id: 'a2', name: 'Bayada' });
      expect(store.getAccount('a1').name).toBe('Comfort Keepers - 163');
      expect(store.listAccounts()).toHaveLength(2);
    });
  });

  describe('contacts', () => {
    it('normalizes email to lowercase', () => {
      store.upsertContact({ id: 'c1', email: 'Kate@Example.com', name: 'Kate' });
      expect(store.getContact('c1').email).toBe('kate@example.com');
    });
  });

  // ───────────────────────────── History ───────────────────

  describe('history + daysInCurrentStatus', () => {
    it('upserts history entries (idempotent via PK)', () => {
      store.upsertTicket(sampleTicket());
      store.upsertHistoryEntry({
        ticketId: '1078812000011967813',
        changedAt: '2026-04-20T10:00:00.000Z',
        fieldName: 'status',
        fromValue: 'Open',
        toValue: 'Investigating',
      });
      // Re-inserting the same (ticketId, changedAt, fieldName) is a replace.
      store.upsertHistoryEntry({
        ticketId: '1078812000011967813',
        changedAt: '2026-04-20T10:00:00.000Z',
        fieldName: 'status',
        fromValue: 'Open',
        toValue: 'Investigating',
      });
      expect(store.listHistory('1078812000011967813')).toHaveLength(1);
    });

    it('daysInCurrentStatus returns null when no history', () => {
      expect(store.daysInCurrentStatus('no-such')).toBeNull();
    });

    it('daysInCurrentStatus uses the most recent status change', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-23T10:00:00.000Z'));

      store.upsertTicket(sampleTicket());
      store.upsertHistoryEntry({
        ticketId: '1078812000011967813',
        changedAt: '2026-04-15T10:00:00.000Z',
        fieldName: 'status',
        toValue: 'Investigating',
      });
      store.upsertHistoryEntry({
        ticketId: '1078812000011967813',
        changedAt: '2026-04-20T10:00:00.000Z',
        fieldName: 'status',
        toValue: 'Waiting for Viv Response',
      });

      expect(store.daysInCurrentStatus('1078812000011967813')).toBe(3);

      vi.useRealTimers();
    });
  });

  // ───────────────────────────── Links ─────────────────────

  describe('links', () => {
    it('upsert + list by jira + by zoho', () => {
      store.upsertLink({ jiraKey: 'DEV-45019', zohoTicketId: 'zoho-1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-45019', zohoTicketId: 'zoho-2', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-45020', zohoTicketId: 'zoho-1', source: 'customfield_11157' });

      expect(store.listLinksByJira('DEV-45019')).toHaveLength(2);
      expect(store.listLinksByZoho('zoho-1')).toHaveLength(2);
      expect(store.listLinksByJira('DEV-45020')).toHaveLength(1);
    });

    it('linkedZohoByJiraKeys batches many JIRA keys in one query', () => {
      store.upsertTicket(sampleTicket({ id: 'z1', ticketNumber: 'VHC-1' }));
      store.upsertTicket(sampleTicket({ id: 'z2', ticketNumber: 'BYD-1', deptPrefix: 'BYD' }));
      store.upsertAccount({ id: 'acct-ck163', name: 'CK 163' });
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z2', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-2', zohoTicketId: 'z1', source: 'customfield_11157' });

      const map = store.linkedZohoByJiraKeys(['DEV-1', 'DEV-2', 'DEV-NONE']);
      expect(map.get('DEV-1')).toHaveLength(2);
      expect(map.get('DEV-2')).toHaveLength(1);
      expect(map.has('DEV-NONE')).toBe(false);

      // Verify enrichment — ticketNumber + accountName join worked
      const dev1Entries = map.get('DEV-1');
      expect(dev1Entries[0].ticketNumber).toBeTruthy();
      const ck = dev1Entries.find(e => e.zohoTicketId === 'z1');
      expect(ck.accountName).toBe('CK 163');
    });

    it('linkedZohoByJiraKeys returns empty map for empty input', () => {
      expect(store.linkedZohoByJiraKeys([]).size).toBe(0);
      expect(store.linkedZohoByJiraKeys(null).size).toBe(0);
    });

    it('linkedJirasByTicketId joins with jira_tickets for enrichment', () => {
      // Seed a jira_tickets row
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, statusCategory, syncedAt, fixVersions, priority, assignee)
                  VALUES ('DEV-1', 'Fix x', 'In Review', 'In Progress', '2026-04-23T00:00:00Z', '["4.2.0"]', 'High', 'Jeff')`).run();

      store.upsertTicket(sampleTicket({ id: 'z1', ticketNumber: 'VHC-1' }));
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-UNKNOWN', zohoTicketId: 'z1', source: 'customfield_11157' });

      const map = store.linkedJirasByTicketId(['z1']);
      const entries = map.get('z1');
      expect(entries).toHaveLength(2);
      const dev1 = entries.find(e => e.jiraKey === 'DEV-1');
      expect(dev1.summary).toBe('Fix x');
      expect(dev1.status).toBe('In Review');
      expect(dev1.statusCategory).toBe('In Progress');
      expect(dev1.priority).toBe('High');
      expect(dev1.assignee).toBe('Jeff');
      expect(dev1.fixVersions).toEqual(['4.2.0']);
      expect(dev1.truth).toEqual([]); // no ticket_truth rows seeded yet
      // Unknown JIRA still returns the row with null fields (outer join)
      const dev2 = entries.find(e => e.jiraKey === 'DEV-UNKNOWN');
      expect(dev2.status).toBeNull();
      expect(dev2.summary).toBeNull();
    });

    it('linkedJirasByTicketId attaches ticket_truth rows per JIRA', () => {
      db.prepare(`INSERT INTO jira_tickets (key, summary, status, syncedAt, fixVersions)
                  VALUES ('DEV-1', 'Fix x', 'In Review', '2026-04-23T00:00:00Z', '["4.1.4","4.1.3.1"]')`).run();
      // Two truth rows for two releases
      db.prepare(`INSERT INTO ticket_truth (jiraKey, repo, version, health, healthCategory, healthMessage, stage, prNumber, prUrl, onBranch, inFixVersion, computedAt)
                  VALUES ('DEV-1', 'webplatform', '4.1.4', 'green', 'in-qa', 'PR approved, awaiting QA', 'testing', 123, 'https://github.com/x/123', 1, 1, '2026-04-23T00:00:00Z')`).run();
      db.prepare(`INSERT INTO ticket_truth (jiraKey, repo, version, health, healthCategory, healthMessage, stage, onBranch, inFixVersion, computedAt)
                  VALUES ('DEV-1', 'webplatform', '4.1.3.1', 'yellow', 'awaiting-cp', 'Cherry-pick branch missing', 'cherry-pick', 0, 1, '2026-04-23T00:00:00Z')`).run();

      store.upsertTicket(sampleTicket({ id: 'z1', ticketNumber: 'VHC-1' }));
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z1', source: 'customfield_11157' });

      const map = store.linkedJirasByTicketId(['z1']);
      const entry = map.get('z1')[0];
      expect(entry.truth).toHaveLength(2);
      const v414 = entry.truth.find(t => t.version === '4.1.4');
      expect(v414.healthCategory).toBe('in-qa');
      expect(v414.prNumber).toBe(123);
      expect(v414.onBranch).toBe(true);
      const v413 = entry.truth.find(t => t.version === '4.1.3.1');
      expect(v413.healthCategory).toBe('awaiting-cp');
      expect(v413.onBranch).toBe(false);
    });

    it('linkedJirasByTicketId caps at 3 entries per zoho ticket', () => {
      store.upsertTicket(sampleTicket({ id: 'z1', ticketNumber: 'VHC-1' }));
      for (let i = 0; i < 5; i++) {
        store.upsertLink({ jiraKey: `DEV-${i}`, zohoTicketId: 'z1', source: 'customfield_11157' });
      }
      const map = store.linkedJirasByTicketId(['z1']);
      expect(map.get('z1')).toHaveLength(3);
    });

    it('replaceLinksFromSource removes old and adds new', () => {
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z1', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z2', source: 'customfield_11157' });
      store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'z3', source: 'zoho_associated_jira' });

      store.replaceLinksFromSource('DEV-1', 'customfield_11157', ['z2', 'z4']);

      const all = store.listLinksByJira('DEV-1');
      const ids = all.map(l => l.zohoTicketId).sort();
      expect(ids).toEqual(['z2', 'z3', 'z4']);
      // z3 wasn't touched because it came from a different source
      const z3 = all.find(l => l.zohoTicketId === 'z3');
      expect(z3.source).toBe('zoho_associated_jira');
    });
  });

  // ───────────────────────────── Sync meta + lock ──────────

  describe('sync meta', () => {
    it('getSyncMeta seeds row on first call', () => {
      const meta = store.getSyncMeta();
      expect(meta).toBeTruthy();
      expect(meta.backfillStatus).toBe('pending');
      expect(meta.backfillProgress).toBe(0);
    });

    it('updateSyncMeta persists partial updates', () => {
      store.updateSyncMeta({ lastModifiedCursor: '2026-04-23T10:00:00Z', backfillStatus: 'in_progress' });
      const meta = store.getSyncMeta();
      expect(meta.lastModifiedCursor).toBe('2026-04-23T10:00:00Z');
      expect(meta.backfillStatus).toBe('in_progress');
      expect(meta.updatedAt).toBeTruthy();
    });
  });

  describe('worker lock', () => {
    it('acquireLock succeeds when no lock held', () => {
      expect(store.acquireLock(60000)).toBe(true);
      const meta = store.getSyncMeta();
      expect(meta.workerLockUntil).toBeTruthy();
    });

    it('acquireLock fails when another lock is active', () => {
      expect(store.acquireLock(60000)).toBe(true);
      expect(store.acquireLock(60000)).toBe(false);
    });

    it('acquireLock succeeds when prior lock has expired', () => {
      // Manually set an expired lock
      store.updateSyncMeta({ workerLockUntil: new Date(Date.now() - 1000).toISOString() });
      expect(store.acquireLock(60000)).toBe(true);
    });

    it('releaseLock clears the lock', () => {
      store.acquireLock(60000);
      store.releaseLock();
      expect(store.getSyncMeta().workerLockUntil).toBeNull();
    });
  });
});
