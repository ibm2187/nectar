import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const PrSync = require('../src/core/pr-sync');

function makeRelease(version, tickets = [], opts = {}) {
  return {
    repo: opts.repo || 'webplatform',
    version,
    state: opts.state || 'stabilizing',
    jiraArchived: false,
    tickets,
    prsByJiraKey: {},
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
    _debounceSave: vi.fn(),
    persist: vi.fn(),
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
  let releases, github, sync;

  beforeEach(() => {
    releases = makeMockReleases([
      makeRelease('4.3.0', [
        { key: 'DEV-100', source: 'jira' },
        { key: 'DEV-101', source: 'jira' },
      ]),
    ]);
  });

  it('matches PRs to JIRA keys in releases', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100 scheduling bug' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    const results = await sync.run();

    expect(results.prsFetched).toBeGreaterThan(0);
    expect(results.matched).toBe(1);

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.prsByJiraKey['DEV-100']).toHaveLength(1);
    expect(release.prsByJiraKey['DEV-100'][0].prNumber).toBe(25500);
    expect(release.prsByJiraKey['DEV-100'][0].status).toBe('open');
  });

  it('extracts JIRA keys from title and body', async () => {
    github = makeMockGithub([
      makeGitHubPr(25501, { title: 'Misc fixes', body: 'Fixes DEV-100 and DEV-101' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.prsByJiraKey['DEV-100']).toHaveLength(1);
    expect(release.prsByJiraKey['DEV-101']).toHaveLength(1);
  });

  it('detects merged PRs', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100', state: 'closed', merged_at: '2026-04-13T15:00:00Z' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.prsByJiraKey['DEV-100'][0].status).toBe('merged');
  });

  it('second run is incremental', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });

    await sync.run(); // full
    github._paginate.mockClear();

    const results = await sync.run(); // incremental
    expect(results.incremental).toBe(true);
    // Still matches from cache
    expect(results.matched).toBe(1);
  });

  it('ignores PRs without JIRA keys', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Update README', body: 'Just docs' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    const results = await sync.run();

    expect(results.matched).toBe(0);
  });

  it('ignores PRs for JIRA keys not in any active release', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-999' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    const results = await sync.run();

    // DEV-999 is not in any active release, so it gets evicted from cache
    expect(results.jiraKeysFound).toBe(0);
    expect(results.cacheEvicted).toBe(1);
    expect(results.matched).toBe(0);
  });

  it('handles multiple PRs for the same JIRA key', async () => {
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100' }),
      makeGitHubPr(25501, { title: 'CHERRY_PICK [DEV-100] to 4.3.0', base: 'releases/4.3.0' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    const release = releases.releases.get('webplatform:4.3.0');
    expect(release.prsByJiraKey['DEV-100']).toHaveLength(2);
  });

  it('clears stale PR data', async () => {
    const rel = makeRelease('4.3.0', [{ key: 'DEV-100', source: 'jira' }]);
    rel.prsByJiraKey = { 'DEV-100': [{ prNumber: 99999 }] };
    releases = makeMockReleases([rel]);

    github = makeMockGithub([]); // no PRs
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    expect(rel.prsByJiraKey).toEqual({});
  });

  it('emits sync:completed', async () => {
    github = makeMockGithub([]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
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
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    const p1 = sync.run();
    const p2 = sync.run();
    await Promise.all([p1, p2]);
    // Only one run's worth of API calls
    expect(github._paginate.mock.calls.length).toBeLessThanOrEqual(2); // open + closed
  });

  it('indexes PRs by head branch for findPRByBranch lookup', async () => {
    const openPr = makeGitHubPr(25600, { title: 'Fix DEV-100' });
    openPr.head = { ref: 'eric/foo' };
    const mergedPr = makeGitHubPr(25601, {
      title: 'Release DEV-101',
      state: 'closed',
      merged_at: '2026-04-13T15:00:00Z',
    });
    mergedPr.head = { ref: 'releases/4.2.0' };

    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async (path) => {
        if (path.includes('state=open')) return [openPr];
        if (path.includes('state=closed')) return [mergedPr];
        return [];
      }),
    };
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    const found = sync.findPRByBranch('eric/foo');
    expect(found).not.toBeNull();
    expect(found.prNumber).toBe(25600);
    expect(found.prUrl).toBeTruthy();
    expect(found.status).toBe('open');
    expect(found.headBranch).toBe('eric/foo');

    const mergedFound = sync.findPRByBranch('releases/4.2.0');
    expect(mergedFound).not.toBeNull();
    expect(mergedFound.status).toBe('merged');
    expect(mergedFound.headBranch).toBe('releases/4.2.0');

    expect(sync.findPRByBranch('unknown')).toBeNull();
    expect(sync.findPRByBranch(null)).toBeNull();
    expect(sync.findPRByBranch(undefined)).toBeNull();
  });

  it('indexes PRs without JIRA keys by head branch', async () => {
    const pr = makeGitHubPr(25700, { title: 'Update README', body: 'Just docs' });
    pr.head = { ref: 'chore/docs' };
    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async (path) => {
        if (path.includes('state=open')) return [pr];
        return [];
      }),
    };
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    const found = sync.findPRByBranch('chore/docs');
    expect(found).not.toBeNull();
    expect(found.prNumber).toBe(25700);
    expect(found.prUrl).toBeTruthy();
    expect(found.status).toBe('open');
    expect(found.headBranch).toBe('chore/docs');
  });

  it('prefers open PR over closed PR when sharing a head branch', async () => {
    const closedPr = makeGitHubPr(50, {
      title: 'DEV-300 old',
      state: 'closed',
      merged_at: null,
    });
    closedPr.head = { ref: 'eric/shared' };
    const openPr = makeGitHubPr(60, { title: 'DEV-301 new' });
    openPr.head = { ref: 'eric/shared' };

    github = {
      isConfigured: () => true,
      _paginate: vi.fn(async (path) => {
        if (path.includes('state=open')) return [openPr];
        // Closed PRs come from the closed-state fetch after the open ones
        if (path.includes('state=closed')) return [closedPr];
        return [];
      }),
    };
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();

    const found = sync.findPRByBranch('eric/shared');
    expect(found).not.toBeNull();
    expect(found.prNumber).toBe(60);
    expect(found.status).toBe('open');
  });

  it('prunes cache entries not in any active release', async () => {
    // First run: fetch PRs for DEV-100 (in release) and DEV-999 (not in any release)
    github = makeMockGithub([
      makeGitHubPr(25500, { title: 'Fix DEV-100' }),
      makeGitHubPr(25501, { title: 'Fix DEV-999' }),
      makeGitHubPr(25502, { title: 'Fix DEV-888' }),
    ]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    const results = await sync.run();

    // Only DEV-100 should remain (it's in the release), DEV-999 and DEV-888 evicted
    expect(results.cacheEvicted).toBe(2);
    expect(results.jiraKeysFound).toBe(1);
    expect(sync._prCache.has('DEV-100')).toBe(true);
    expect(sync._prCache.has('DEV-999')).toBe(false);
    expect(sync._prCache.has('DEV-888')).toBe(false);
  });

  it('getStatus reports cache size', async () => {
    github = makeMockGithub([makeGitHubPr(25500, { title: 'Fix DEV-100' })]);
    sync = new PrSync(releases, github, { repos: [{ name: 'webplatform', github: 'mavencare/webplatform' }] });
    await sync.run();
    expect(sync.getStatus().cacheSize).toBe(1);
  });
});
