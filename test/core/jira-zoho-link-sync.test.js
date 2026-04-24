import { describe, it, expect, beforeEach, vi } from 'vitest';

const JiraZohoLinkSync = require('../../src/core/jira-zoho-link-sync');
const ZohoStore = require('../../src/core/zoho-store');
const { createTestDb } = require('../../src/core/db');

/**
 * Mocks the JIRA client so the test exercises the orchestration logic
 * without network I/O. ADF payloads are the same real-world shape verified
 * by the zoho-link-parser suite.
 */

function makeJiraMock(issues) {
  return {
    isConfigured: () => true,
    listIssuesWithZohoLinks: vi.fn(async () => issues),
  };
}

const ADF = (text, href) => ({
  value: {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
      },
    ],
  },
});

function issueWith(key, customfield) {
  return {
    key,
    fields: { summary: 'x', customfield_11157: customfield },
  };
}

describe('JiraZohoLinkSync', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createTestDb();
    store = new ZohoStore({ db });
  });

  it('parses a single-link ADF and writes to jira_zoho_links', async () => {
    const jira = makeJiraMock([
      issueWith('DEV-45019', ADF('#VHC-4165', 'https://support.vivtechnologies.com/x#Cases/dv/1078812000011967813').value),
    ]);
    const sync = new JiraZohoLinkSync({ jira, zohoStore: store });

    const results = await sync.run();
    expect(results.issuesScanned).toBe(1);
    expect(results.jiraKeysWithLinks).toBe(1);
    expect(results.linksUpserted).toBe(1);

    const links = store.listLinksByJira('DEV-45019');
    expect(links).toHaveLength(1);
    expect(links[0].zohoTicketId).toBe('1078812000011967813');
    expect(links[0].source).toBe('customfield_11157');
  });

  it('handles multiple links on the same JIRA', async () => {
    const multi = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: '#VHC-4165', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000011967813' } }] },
        { type: 'text', text: ', ' },
        { type: 'text', text: '#BYD-3115', marks: [{ type: 'link', attrs: { href: 'https://y/dv/1078812000012008034' } }] },
      ]}],
    };
    const jira = makeJiraMock([issueWith('DEV-1', multi)]);
    const sync = new JiraZohoLinkSync({ jira, zohoStore: store });

    const results = await sync.run();
    expect(results.linksUpserted).toBe(2);
    expect(store.listLinksByJira('DEV-1')).toHaveLength(2);
  });

  it('removes stale links when customfield_11157 value shrinks', async () => {
    // First sync: DEV-1 → [zoho-A, zoho-B]
    const initial = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: '#VHC-1', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000000000001' } }] },
        { type: 'text', text: '#VHC-2', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000000000002' } }] },
      ]}],
    };
    const sync = new JiraZohoLinkSync({
      jira: makeJiraMock([issueWith('DEV-1', initial)]),
      zohoStore: store,
    });
    await sync.run();
    expect(store.listLinksByJira('DEV-1')).toHaveLength(2);

    // Second sync: DEV-1 → [zoho-A] only
    const shrunk = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: '#VHC-1', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000000000001' } }] },
      ]}],
    };
    const sync2 = new JiraZohoLinkSync({
      jira: makeJiraMock([issueWith('DEV-1', shrunk)]),
      zohoStore: store,
    });
    await sync2.run();

    const after = store.listLinksByJira('DEV-1');
    expect(after).toHaveLength(1);
    expect(after[0].zohoTicketId).toBe('1078812000000000001');
  });

  it('clears all links when customfield_11157 goes to a junk placeholder', async () => {
    // First sync: real link
    const real = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: '#VHC-1', marks: [{ type: 'link', attrs: { href: 'https://x/dv/1078812000000000001' } }] },
      ]}],
    };
    const sync1 = new JiraZohoLinkSync({
      jira: makeJiraMock([issueWith('DEV-1', real)]),
      zohoStore: store,
    });
    await sync1.run();
    expect(store.listLinksByJira('DEV-1')).toHaveLength(1);

    // Second sync: field now contains just "."
    const junk = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '.' }] }] };
    const sync2 = new JiraZohoLinkSync({
      jira: makeJiraMock([issueWith('DEV-1', junk)]),
      zohoStore: store,
    });
    await sync2.run();
    expect(store.listLinksByJira('DEV-1')).toHaveLength(0);
  });

  it('preserves links from a different source (Zoho-side)', async () => {
    // Pre-seed a Zoho-side link
    store.upsertLink({ jiraKey: 'DEV-1', zohoTicketId: 'zoho-from-zoho-side', source: 'zoho_associated_jira' });

    const adf = {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: '#VHC-1', marks: [{ type: 'link', attrs: { href: 'https://x/dv/zoho-from-jira-side-1' } }] },
      ]}],
    };
    const sync = new JiraZohoLinkSync({
      jira: makeJiraMock([issueWith('DEV-1', adf)]),
      zohoStore: store,
    });
    // Normally the parser wouldn't accept our made-up "zoho-from-jira-side-1" (not 15+ digits)
    // so use a real-looking ID
    adf.content[0].content[0].marks[0].attrs.href = 'https://x/dv/1078812000000000999';

    await sync.run();
    const all = store.listLinksByJira('DEV-1');
    expect(all).toHaveLength(2);
    expect(all.map(l => l.source).sort()).toEqual(['customfield_11157', 'zoho_associated_jira']);
  });

  it('handles degraded mode when JIRA is not configured', async () => {
    const jira = { isConfigured: () => false, listIssuesWithZohoLinks: vi.fn() };
    const sync = new JiraZohoLinkSync({ jira, zohoStore: store });
    sync.start();
    // start() should no-op; no timer should be set
    expect(sync._timer).toBeNull();
    sync.stop();
  });

  it('records errors without crashing', async () => {
    const jira = {
      isConfigured: () => true,
      listIssuesWithZohoLinks: vi.fn(async () => { throw new Error('JIRA 500'); }),
    };
    const sync = new JiraZohoLinkSync({ jira, zohoStore: store });
    const results = await sync.run();
    expect(results.errors).toBe(1);
    expect(results.issuesScanned).toBe(0);
  });

  it('passes updatedSince to the JIRA query for incremental scans', async () => {
    const jira = makeJiraMock([]);
    const sync = new JiraZohoLinkSync({ jira, zohoStore: store });
    await sync.run({ updatedSince: '2026-04-22T00:00:00Z' });
    expect(jira.listIssuesWithZohoLinks).toHaveBeenCalledWith({
      updatedSince: '2026-04-22T00:00:00Z',
    });
  });
});
