import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const JiraSync = require('../src/core/jira-sync');

describe('JiraSync — stale shared ticket migration', () => {
  function makeRelease(repo, version, tickets = []) {
    return { repo, version, tickets, state: 'planning', jiraArchived: false };
  }

  function makeMockReleases(releaseList) {
    const map = new Map();
    for (const r of releaseList) {
      map.set(`${r.repo}:${r.version}`, r);
    }
    return {
      list: () => releaseList,
      get: (version, repo) => map.get(`${repo}:${version}`) || null,
      releases: map,
      _key: (repo, version) => `${repo}:${version}`,
      _debounceSave: vi.fn(),
      addTicket: vi.fn(),
      create: vi.fn(),
    };
  }

  it('removes jira-synced tickets from bluesummit when sharesVersionsWith is removed', () => {
    const releases = makeMockReleases([
      makeRelease('webplatform', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },
        { key: 'DEV-101', source: 'jira' },
      ]),
      makeRelease('bluesummit', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },  // copied from webplatform
        { key: 'DEV-101', source: 'jira' },  // copied from webplatform
        { key: 'DEV-200', source: 'git' },   // bluesummit's own git-discovered ticket
      ]),
    ]);

    const config = {
      repos: [
        { name: 'webplatform' },
        { name: 'bluesummit' }, // no sharesVersionsWith anymore
      ],
    };

    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);
    sync._migrateStaleSharedTickets();

    // webplatform tickets untouched
    const wp = releases.releases.get('webplatform:4.2.1');
    expect(wp.tickets).toHaveLength(2);

    // bluesummit: jira-synced tickets removed, git ticket kept
    const bs = releases.releases.get('bluesummit:4.2.1');
    expect(bs.tickets).toHaveLength(1);
    expect(bs.tickets[0].key).toBe('DEV-200');
    expect(bs.tickets[0].source).toBe('git');
  });

  it('does not remove tickets if sharesVersionsWith is still active', () => {
    const releases = makeMockReleases([
      makeRelease('bluesummit', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },
      ]),
    ]);

    const config = {
      repos: [
        { name: 'bluesummit', sharesVersionsWith: 'webplatform' }, // still active
      ],
    };

    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);
    sync._migrateStaleSharedTickets();

    const bs = releases.releases.get('bluesummit:4.2.1');
    expect(bs.tickets).toHaveLength(1); // untouched
  });

  it('only runs once', () => {
    const releases = makeMockReleases([
      makeRelease('bluesummit', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },
      ]),
    ]);

    const config = { repos: [{ name: 'bluesummit' }] };
    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);

    sync._migrateStaleSharedTickets();
    expect(releases.releases.get('bluesummit:4.2.1').tickets).toHaveLength(0);

    // Add a ticket back and run again — should NOT clean it
    releases.releases.get('bluesummit:4.2.1').tickets.push({ key: 'DEV-999', source: 'jira' });
    sync._migrateStaleSharedTickets();
    expect(releases.releases.get('bluesummit:4.2.1').tickets).toHaveLength(1); // not cleaned again
  });

  it('calls debounceSave when tickets are cleaned', () => {
    const releases = makeMockReleases([
      makeRelease('bluesummit', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },
      ]),
    ]);

    const config = { repos: [{ name: 'bluesummit' }] };
    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);

    sync._migrateStaleSharedTickets();
    expect(releases._debounceSave).toHaveBeenCalled();
  });

  it('does not call debounceSave when nothing to clean', () => {
    const releases = makeMockReleases([
      makeRelease('bluesummit', '4.2.1', []), // no tickets
    ]);

    const config = { repos: [{ name: 'bluesummit' }] };
    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);

    sync._migrateStaleSharedTickets();
    expect(releases._debounceSave).not.toHaveBeenCalled();
  });
});
