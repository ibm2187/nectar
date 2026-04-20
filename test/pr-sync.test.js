import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const PrSync = require('../src/core/pr-sync');
const PrStore = require('../src/core/pr-store');
const { createTestDb } = require('../src/core/db');

function makeRelease(version, tickets = [], opts = {}) {
  return {
    repo: opts.repo || 'webplatform',
    version,
    state: opts.state || 'stabilizing',
    jiraArchived: false,
    tickets,
    ...opts,
  };
}

function makeMockReleases(releaseList) {
  const map = new Map();
  for (const r of releaseList) map.set(`${r.repo}:${r.version}`, r);
  return {
    list: () => releaseList,
    releases: map,
    _key: (repo, version) => `${repo}:${version}`,
  };
}

function makeGitHubPr(number, opts = {}) {
  return {
    number,
    title: opts.title || `Fix DEV-${number}`,
    body: opts.body || '',
    state: opts.state || 'open',
    merged_at: opts.merged_at || null,
    html_url: `https://github.com/mavencare/webplatform/pull/${number}`,
    created_at: opts.created_at || '2026-04-13T10:00:00Z',
    updated_at: opts.updated_at || '2026-04-13T18:00:00Z',
    user: { login: opts.author || 'nukul' },
    base: { ref: opts.base || 'master' },
    head: opts.head || undefined,
    labels: [],
  };
}

function makeMockGithub(prsToReturn = []) {
  return {
    isConfigured: () => true,
    _paginate: vi.fn(async (path) => {
      if (path.includes('state=open') || path.includes('state=all')) {
        return prsToReturn;
      }
      if (path.includes('state=closed')) {
        return prsToReturn.filter(p => p.state === 'closed' || p.merged_at);
      }
      return [];
    }),
  };
}

describe('PrSync', () => {
  let releases, github, sync, prStore, db;

  beforeEach(() => {
    db = createTestDb();
    // Seed singleton rows
    db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();
    prStore = new PrStore({ db });

    releases = makeMockReleases([
      makeRelease('4.3.0', [
        { key: 'DEV-100', source: 'jira' },
        { key: 'DEV-101', source: 'jira' },
      ]),
    ]);
  });

  function createSync(gh) {
    const s = new PrSync(releases, gh, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    s.setPrStore(prStore);
    return s;
  }

  it('persists PRs with JIRA keys to PrStore', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100 scheduling bug' }),
    ]);
    sync = createSync(github);
    await sync.run();

    expect(prStore.count()).toBe(1);
    const prs = prStore.findByJiraKey('DEV-100');
    expect(prs).toHaveLength(1);
    expect(prs[0].prNumber).toBe(25500);
    expect(prs[0].status).toBe('open');
  });

  it('extracts JIRA keys from title and body', async () => {
    github = makeMockGithub([
      makeGitHubPr(25501, { title: 'Misc fixes', body: 'Fixes DEV-100 and DEV-101' }),
    ]);
    sync = createSync(github);
    await sync.run();

    expect(prStore.findByJiraKey('DEV-100')).toHaveLength(1);
    expect(prStore.findByJiraKey('DEV-101')).toHaveLength(1);
  });

  it('detects merged PRs', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100', state: 'closed', merged_at: '2026-04-13T15:00:00Z' }),
    ]);
    sync = createSync(github);
    await sync.run();

    const prs = prStore.findByJiraKey('DEV-100');
    expect(prs[0].status).toBe('merged');
  });

  it('second run is incremental', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100' }),
    ]);
    sync = createSync(github);

    await sync.run(); // full
    github._paginate.mockClear();

    const results = await sync.run(); // incremental
    expect(results.incremental).toBe(true);
    // PR is still in PrStore
    expect(prStore.findByJiraKey('DEV-100')).toHaveLength(1);
  });

  it('tracks JIRA key count correctly', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Update README', body: 'Just docs' }),
    ]);
    sync = createSync(github);
    const results = await sync.run();

    expect(results.jiraKeysFound).toBe(0);
  });

  it('persists PRs for JIRA keys not in any active release', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-999' }),
    ]);
    sync = createSync(github);
    const results = await sync.run();

    expect(results.jiraKeysFound).toBe(1);
    // PR is persisted even if no matching release
    expect(prStore.findByJiraKey('DEV-999')).toHaveLength(1);
  });

  it('handles multiple PRs for the same JIRA key', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100' }),
      makeGitHubPr(25501, { title: 'CHERRY_PICK [DEV-100] to 4.3.0', base: 'releases/4.3.0' }),
    ]);
    sync = createSync(github);
    await sync.run();

    expect(prStore.findByJiraKey('DEV-100')).toHaveLength(2);
  });

  it('emits sync:completed', async () => {
    github = makeMockGithub([]);
    sync = createSync(github);
    const handler = vi.fn();
    sync.on('sync:completed', handler);
    await sync.run();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ incremental: false }));
  });

  it('prevents concurrent runs', async () => {
    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async () => { await new Promise(r => setTimeout(r, 100)); return []; }),
    };
    sync = createSync(github);
    const p1 = sync.run();
    const p2 = sync.run();
    await Promise.all([p1, p2]);
    expect(github._paginate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('indexes PRs by head branch for findPRByBranch lookup', async () => {
    const openPr = makeGitHubPr(25600, { title: 'Fix DEV-100', head: { ref: 'eric/foo' } });
    const mergedPr = makeGitHubPr(25601, {
      title: 'Release DEV-101',
      state: 'closed',
      merged_at: '2026-04-13T15:00:00Z',
      head: { ref: 'releases/4.2.0' },
    });

    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async (path) => {
        if (path.includes('state=open')) return [openPr];
        if (path.includes('state=closed')) return [mergedPr];
        return [];
      }),
    };
    sync = createSync(github);
    await sync.run();

    const found = sync.findPRByBranch('eric/foo');
    expect(found).not.toBeNull();
    expect(found.prNumber).toBe(25600);
    expect(found.status).toBe('open');

    const mergedFound = sync.findPRByBranch('releases/4.2.0');
    expect(mergedFound).not.toBeNull();
    expect(mergedFound.status).toBe('merged');

    expect(sync.findPRByBranch('unknown')).toBeNull();
    expect(sync.findPRByBranch(null)).toBeNull();
    expect(sync.findPRByBranch(undefined)).toBeNull();
  });

  it('indexes PRs without JIRA keys by head branch', async () => {
    const pr = makeGitHubPr(25700, { title: 'Update README', body: 'Just docs', head: { ref: 'chore/docs' } });
    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async (path) => {
        if (path.includes('state=open')) return [pr];
        return [];
      }),
    };
    sync = createSync(github);
    await sync.run();

    const found = sync.findPRByBranch('chore/docs');
    expect(found).not.toBeNull();
    expect(found.prNumber).toBe(25700);
    expect(found.status).toBe('open');
  });

  it('prefers open PR over closed PR when sharing a head branch', async () => {
    const closedPr = makeGitHubPr(50, { title: 'DEV-300 old', state: 'closed', head: { ref: 'eric/shared' } });
    const openPr = makeGitHubPr(60, { title: 'DEV-301 new', head: { ref: 'eric/shared' } });

    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async (path) => {
        if (path.includes('state=open')) return [openPr];
        if (path.includes('state=closed')) return [closedPr];
        return [];
      }),
    };
    sync = createSync(github);
    await sync.run();

    const found = sync.findPRByBranch('eric/shared');
    expect(found).not.toBeNull();
    expect(found.prNumber).toBe(60);
    expect(found.status).toBe('open');
  });

  it('getStatus reports PrStore stats', async () => {
    github = makeMockGithub([makeGitHubPr(25500, { title: 'Fix DEV-100' })]);
    sync = createSync(github);
    await sync.run();
    const status = sync.getStatus();
    expect(status.prStore.totalPrs).toBe(1);
  });
});
