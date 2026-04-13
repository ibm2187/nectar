import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const ZohoSync = require('../src/core/zoho-sync');

function makeRelease(version, tickets = [], opts = {}) {
  return {
    repo: opts.repo || 'webplatform',
    version,
    state: opts.state || 'stabilizing',
    jiraArchived: false,
    tickets,
    zohoTickets: [],
    zohoByJiraKey: {},
    ...opts,
  };
}

function makeMockReleases(releaseList) {
  const map = new Map();
  for (const r of releaseList) {
    map.set(`${r.repo}:${r.version}`, r);
  }
  return {
    list: () => releaseList,
    releases: map,
    _key: (repo, version) => `${repo}:${version}`,
    _debounceSave: vi.fn(),
  };
}

// Raw Zoho ticket (full, with custom fields)
function makeZohoTicket(id, opts = {}) {
  return {
    id,
    ticketNumber: opts.ticketNumber || `VHC-${id}`,
    subject: opts.subject || 'Test ticket',
    status: opts.status || 'Open',
    statusType: opts.statusType || 'Open',
    modifiedTime: opts.modifiedTime || '2026-04-13T18:00:00.000Z',
    departmentId: opts.departmentId || 'd1',
    webUrl: `https://zoho/t/${id}`,
    cf: {
      cf_associated_jira_issues: opts.jiraKeys || null,
      cf_associated_jira_issues_count: opts.jiraKeys ? '1' : null,
      cf_ticket_type: 'Bug Report',
    },
  };
}

function makeMockZoho(ticketsToReturn = []) {
  const ticketMap = {};
  for (const t of ticketsToReturn) ticketMap[t.id] = t;

  return {
    isConfigured: () => true,
    _request: vi.fn(async (method, path) => {
      if (path.includes('/tickets?')) {
        if (path.includes('from=0') || !path.includes('from=')) {
          // Return stubs (no cf fields, like the real list endpoint)
          return { data: ticketsToReturn.map(t => ({
            id: t.id, ticketNumber: t.ticketNumber, subject: t.subject,
            status: t.status, statusType: t.statusType || 'Open',
            modifiedTime: t.modifiedTime || '2026-04-13T18:00:00.000Z',
            departmentId: t.departmentId,
          })) };
        }
        return { data: [] };
      }
      return { data: [] };
    }),
    getTicket: vi.fn(async (id) => ticketMap[id] || null),
  };
}

describe('ZohoSync — incremental sync', () => {
  let releases, zoho, sync;

  beforeEach(() => {
    releases = makeMockReleases([
      makeRelease('4.3.0', [
        { key: 'DEV-100', source: 'jira' },
        { key: 'DEV-101', source: 'jira' },
      ]),
    ]);
  });

  it('first run is a full sync', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100', subject: 'Bug A' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    const results = await sync.run();

    expect(results.incremental).toBe(false);
    expect(results.zohoFetched).toBe(1);
    expect(results.detailsFetched).toBe(1);
    expect(sync._ticketCache.size).toBe(1);
  });

  it('second run is incremental', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});

    await sync.run(); // full
    expect(sync._ticketCache.size).toBe(1);

    // Second run — return no new tickets
    zoho._request = vi.fn(async () => ({ data: [] }));
    zoho.getTicket.mockClear();
    const results = await sync.run();

    expect(results.incremental).toBe(true);
    expect(results.zohoFetched).toBe(0);
    expect(results.detailsFetched).toBe(0);
    // Cache persists — matching still works
    expect(results.withJiraLinks).toBe(1);
    expect(results.matched).toBe(1);
    // No new detail fetches needed
    expect(zoho.getTicket).not.toHaveBeenCalled();
  });

  it('incremental fetches only modified tickets', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run(); // full

    // Set lastSyncTime to the past so the new ticket is "after" it
    sync._lastSyncTime = '2026-04-13T17:00:00.000Z';

    const futureTime = '2026-04-13T20:00:00.000Z';
    const z2 = makeZohoTicket('z2', { jiraKeys: 'DEV-101', modifiedTime: futureTime });
    zoho._request = vi.fn(async () => ({
      data: [{ id: 'z2', ticketNumber: 'VHC-z2', status: 'Open', statusType: 'Open', modifiedTime: futureTime }],
    }));
    zoho.getTicket = vi.fn(async (id) => id === 'z2' ? z2 : null);

    const results = await sync.run();
    expect(results.incremental).toBe(true);
    expect(results.detailsFetched).toBe(1); // only z2
    expect(sync._ticketCache.size).toBe(2); // z1 from cache + z2 new
    expect(results.matched).toBe(2);
  });

  it('incremental removes closed tickets from cache', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run(); // full — z1 in cache
    expect(sync._ticketCache.size).toBe(1);

    sync._lastSyncTime = '2026-04-13T17:00:00.000Z';
    const futureTime = '2026-04-13T20:00:00.000Z';

    // z1 is now closed
    zoho._request = vi.fn(async () => ({
      data: [{ id: 'z1', ticketNumber: 'VHC-z1', status: 'Closed', statusType: 'Closed', modifiedTime: futureTime }],
    }));
    zoho.getTicket.mockClear();

    const results = await sync.run();
    expect(sync._ticketCache.size).toBe(0);
    expect(results.detailsFetched).toBe(0); // no detail fetch for closed
    expect(results.matched).toBe(0);
  });

  it('matches from cache even when no new tickets fetched', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
      makeZohoTicket('z2', { jiraKeys: 'DEV-101' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run(); // full

    // No changes on incremental
    zoho._request = vi.fn(async () => ({ data: [] }));
    const results = await sync.run();

    // Still matches from cache
    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(2);
    expect(results.matched).toBe(2);
  });

  it('clears stale release data when cache no longer matches', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(1);

    // z1 gets closed
    sync._lastSyncTime = '2026-04-13T17:00:00.000Z';
    zoho._request = vi.fn(async () => ({
      data: [{ id: 'z1', statusType: 'Closed', modifiedTime: '2026-04-13T20:00:00.000Z' }],
    }));
    await sync.run();

    expect(release.zohoTickets).toHaveLength(0);
  });

  it('handles API errors gracefully', async () => {
    zoho = {
      isConfigured: () => true,
      _request: vi.fn(async () => { throw new Error('API down'); }),
      getTicket: vi.fn(),
    };
    sync = new ZohoSync(releases, zoho, {});
    const results = await sync.run();
    expect(results.zohoFetched).toBe(0);
  });

  it('emits sync:completed', async () => {
    zoho = makeMockZoho([]);
    sync = new ZohoSync(releases, zoho, {});
    const handler = vi.fn();
    sync.on('sync:completed', handler);
    await sync.run();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ incremental: false }));
  });

  it('prevents concurrent runs', async () => {
    zoho = {
      isConfigured: () => true,
      _request: vi.fn(async () => { await new Promise(r => setTimeout(r, 100)); return { data: [] }; }),
      getTicket: vi.fn(),
    };
    sync = new ZohoSync(releases, zoho, {});
    const p1 = sync.run();
    const p2 = sync.run();
    await Promise.all([p1, p2]);
    expect(zoho._request).toHaveBeenCalledTimes(1);
  });

  it('parses JIRA keys from various formats', () => {
    sync = new ZohoSync(releases, makeMockZoho([]), {});
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'DEV-43254' })).toEqual(['DEV-43254']);
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'DEV-100, DEV-101' })).toEqual(['DEV-100', 'DEV-101']);
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'Linked to DEV-100 and DEV-200' })).toEqual(['DEV-100', 'DEV-200']);
    expect(sync._extractJiraKeys({ associatedJiraIssues: null })).toEqual([]);
    expect(sync._extractJiraKeys({ associatedJiraIssues: '' })).toEqual([]);
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'DEV-100 DEV-100' })).toEqual(['DEV-100']);
  });

  it('getStatus includes cache size', async () => {
    zoho = makeMockZoho([makeZohoTicket('z1', { jiraKeys: 'DEV-100' })]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();
    const status = sync.getStatus();
    expect(status.cacheSize).toBe(1);
  });
});
