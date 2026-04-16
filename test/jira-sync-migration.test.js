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
    // Stub the better-sqlite3 prepare/run chain so jira-sync's direct DB
    // delete call succeeds in the unit test without spinning up a real DB.
    const dbRunSpy = vi.fn();
    const db = { prepare: () => ({ run: dbRunSpy }) };
    return {
      list: () => Array.from(map.values()),
      get: (version, repo) => map.get(`${repo}:${version}`) || null,
      releases: map,
      _key: (repo, version) => `${repo}:${version}`,
      db,
      dbRunSpy, // expose for assertions
      persist: vi.fn(),
      addTicket: vi.fn(),
      create: vi.fn(),
    };
  }

  it('deletes all bluesummit releases when sharesVersionsWith is removed', () => {
    const releases = makeMockReleases([
      makeRelease('webplatform', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },
      ]),
      makeRelease('bluesummit', '4.2.1', [
        { key: 'DEV-100', source: 'jira' },
        { key: 'DEV-200', source: 'git' },
      ]),
      makeRelease('bluesummit', '4.1.0', [
        { key: 'DEV-300', source: 'jira' },
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

    // webplatform untouched
    expect(releases.releases.get('webplatform:4.2.1')).toBeTruthy();

    // bluesummit releases deleted entirely
    expect(releases.releases.get('bluesummit:4.2.1')).toBeUndefined();
    expect(releases.releases.get('bluesummit:4.1.0')).toBeUndefined();
    // Each deleted release should have hit the DB
    expect(releases.dbRunSpy).toHaveBeenCalled();
  });

  it('does not delete if sharesVersionsWith is still active', () => {
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

    expect(releases.releases.get('bluesummit:4.2.1')).toBeTruthy();
  });

  it('only runs once', () => {
    const releases = makeMockReleases([
      makeRelease('bluesummit', '4.2.1', [{ key: 'DEV-100', source: 'jira' }]),
    ]);

    const config = { repos: [{ name: 'bluesummit' }] };
    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);

    sync._migrateStaleSharedTickets();
    expect(releases.releases.has('bluesummit:4.2.1')).toBe(false);

    // Re-add and run again — should NOT delete (migration already ran)
    releases.releases.set('bluesummit:4.2.1', makeRelease('bluesummit', '4.2.1'));
    sync._migrateStaleSharedTickets();
    expect(releases.releases.has('bluesummit:4.2.1')).toBe(true);
  });

  it('does not touch the DB when nothing to clean', () => {
    const releases = makeMockReleases([
      makeRelease('webplatform', '4.2.1', []),
    ]);

    const config = { repos: [{ name: 'webplatform' }] };
    const jira = { isConfigured: () => false };
    const sync = new JiraSync(releases, jira, config);

    sync._migrateStaleSharedTickets();
    expect(releases.dbRunSpy).not.toHaveBeenCalled();
  });
});
