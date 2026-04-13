import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the log module to suppress output during tests
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

function makeMockZoho(ticketsToReturn = []) {
  // Build a map of id → full ticket for detail fetches
  const ticketMap = {};
  for (const t of ticketsToReturn) {
    ticketMap[t.id] = t;
  }

  return {
    isConfigured: () => true,
    // List endpoint returns stubs (no custom fields)
    _request: vi.fn(async (method, path) => {
      if (path.includes('/tickets?') || path === '/tickets') {
        if (path.includes('from=0') || !path.includes('from=')) {
          return { data: ticketsToReturn.map(t => ({
            id: t.id,
            ticketNumber: t.ticketNumber,
            subject: t.subject,
            status: t.status,
            statusType: t.statusType || 'Open',
            departmentId: t.departmentId,
          })) };
        }
        return { data: [] };
      }
      return { data: [] };
    }),
    // Detail endpoint returns full ticket with custom fields
    getTicket: vi.fn(async (id) => {
      return ticketMap[id] || null;
    }),
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
    departmentId: opts.departmentId || 'd1',
    webUrl: `https://zoho/t/${id}`,
    cf: {
      cf_associated_jira_issues: opts.jiraKeys || null,
      cf_associated_jira_issues_count: opts.jiraKeys ? '1' : null,
      cf_ticket_type: 'Bug Report',
    },
  };
}

describe('ZohoSync — Zoho→JIRA direction', () => {
  let releases, zoho, sync;

  beforeEach(() => {
    releases = makeMockReleases([
      makeRelease('4.3.0', [
        { key: 'DEV-100', source: 'jira' },
        { key: 'DEV-101', source: 'jira' },
      ]),
      makeRelease('4.2.0', [], { state: 'done' }), // done, should be skipped
    ]);
  });

  it('matches Zoho tickets to JIRA keys in active releases', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100', subject: 'Schedule bug' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    const results = await sync.run();

    expect(results.zohoFetched).toBe(1);
    expect(results.withJiraLinks).toBe(1);
    expect(results.matched).toBe(1);

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(1);
    expect(release.zohoTickets[0].subject).toBe('Schedule bug');
  });

  it('extracts multiple JIRA keys from one Zoho ticket', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100, DEV-101' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(1); // same ticket, deduplicated
    expect(release.zohoByJiraKey['DEV-100']).toHaveLength(1);
    expect(release.zohoByJiraKey['DEV-101']).toHaveLength(1);
  });

  it('ignores Zoho tickets with no JIRA association', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: null, subject: 'No link' }),
      makeZohoTicket('z2', { jiraKeys: 'DEV-100', subject: 'Has link' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    const results = await sync.run();

    expect(results.zohoFetched).toBe(2);
    expect(results.withJiraLinks).toBe(1);

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(1);
    expect(release.zohoTickets[0].subject).toBe('Has link');
  });

  it('ignores Zoho tickets linked to JIRA keys not in any release', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-999' }), // not in any release
    ]);
    sync = new ZohoSync(releases, zoho, {});
    const results = await sync.run();

    expect(results.withJiraLinks).toBe(1);
    expect(results.matched).toBe(0);

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(0);
  });

  it('does not match against done releases', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-200' }),
    ]);
    // DEV-200 is only in the done release
    releases = makeMockReleases([
      makeRelease('4.2.0', [{ key: 'DEV-200', source: 'jira' }], { state: 'done' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    const results = await sync.run();

    expect(results.matched).toBe(0);
  });

  it('deduplicates Zoho tickets linked to multiple JIRA keys in same release', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100 DEV-101' }), // linked to both
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoTickets).toHaveLength(1); // one unique ticket
    expect(release.zohoByJiraKey['DEV-100']).toHaveLength(1);
    expect(release.zohoByJiraKey['DEV-101']).toHaveLength(1);
  });

  it('sets zohoSyncedAt timestamp', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.zohoSyncedAt).toBeTruthy();
  });

  it('calls debounceSave when matches found', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    expect(releases._debounceSave).toHaveBeenCalled();
  });

  it('does not call debounceSave when no matches', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-999' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    expect(releases._debounceSave).not.toHaveBeenCalled();
  });

  it('clears stale zoho data from releases that no longer match', async () => {
    // Release previously had zoho data
    const rel = makeRelease('4.3.0', [{ key: 'DEV-100', source: 'jira' }]);
    rel.zohoTickets = [{ id: 'old-z1', subject: 'Old ticket' }];
    rel.zohoByJiraKey = { 'DEV-100': [{ id: 'old-z1' }] };
    releases = makeMockReleases([rel]);

    // No Zoho tickets match anymore
    zoho = makeMockZoho([]);
    sync = new ZohoSync(releases, zoho, {});
    await sync.run();

    expect(rel.zohoTickets).toHaveLength(0);
    expect(rel.zohoByJiraKey).toEqual({});
  });

  it('handles Zoho API errors gracefully', async () => {
    zoho = {
      isConfigured: () => true,
      _request: vi.fn(async () => { throw new Error('Zoho API down'); }),
    };
    sync = new ZohoSync(releases, zoho, {});

    const results = await sync.run();
    // Fetch errors are caught per-page, so no tickets are fetched but it doesn't crash
    expect(results.zohoFetched).toBe(0);
  });

  it('emits sync:completed event', async () => {
    zoho = makeMockZoho([
      makeZohoTicket('z1', { jiraKeys: 'DEV-100' }),
    ]);
    sync = new ZohoSync(releases, zoho, {});
    const handler = vi.fn();
    sync.on('sync:completed', handler);
    await sync.run();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      zohoFetched: 1,
      matched: 1,
    }));
  });

  it('prevents concurrent runs', async () => {
    zoho = {
      isConfigured: () => true,
      _request: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 100));
        return { data: [] };
      }),
    };
    sync = new ZohoSync(releases, zoho, {});

    const p1 = sync.run();
    const p2 = sync.run(); // should be skipped
    await Promise.all([p1, p2]);

    // Only one actual API call should have happened
    expect(zoho._request).toHaveBeenCalledTimes(1);
  });

  it('parses JIRA keys from various formats', () => {
    sync = new ZohoSync(releases, makeMockZoho([]), {});

    // Direct key
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'DEV-43254' })).toEqual(['DEV-43254']);
    // Multiple keys
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'DEV-100, DEV-101' })).toEqual(['DEV-100', 'DEV-101']);
    // With extra text
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'Linked to DEV-100 and DEV-200' })).toEqual(['DEV-100', 'DEV-200']);
    // MAV prefix
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'MAV-500' })).toEqual(['MAV-500']);
    // Empty
    expect(sync._extractJiraKeys({ associatedJiraIssues: null })).toEqual([]);
    expect(sync._extractJiraKeys({ associatedJiraIssues: '' })).toEqual([]);
    // Deduplicates
    expect(sync._extractJiraKeys({ associatedJiraIssues: 'DEV-100 DEV-100' })).toEqual(['DEV-100']);
  });

  it('getStatus returns correct state', async () => {
    zoho = makeMockZoho([]);
    sync = new ZohoSync(releases, zoho, {});

    expect(sync.getStatus()).toEqual({
      running: false,
      lastRun: null,
      lastResults: null,
      configured: true,
    });

    await sync.run();
    const status = sync.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastRun).toBeTruthy();
    expect(status.lastResults.zohoFetched).toBe(0);
  });
});
