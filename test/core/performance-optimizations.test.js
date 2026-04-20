import { describe, it, expect, beforeEach } from 'vitest';

const TicketStore = require('../../src/core/ticket-store');
const PrStore = require('../../src/core/pr-store');
const { createTestDb } = require('../../src/core/db');

// ── Helpers ───────────────────────────────────────────────

function insertTicket(db, key, overrides = {}) {
  const defaults = {
    key,
    summary: `Test ${key}`,
    status: 'In Progress',
    statusCategory: 'In Progress',
    state: 'in-progress',
    type: 'Story',
    assignee: null,
    reporter: null,
    qaAssignee: null,
    productAssignee: null,
    component: null,
    module: null,
    product: '[]',
    projects: '[]',
    priority: null,
    riskLevel: null,
    customerPriority: null,
    fixVersions: '["4.2.0"]',
    targetFixVersions: '[]',
    customerTags: '[]',
    deployedEnvironments: '[]',
    labels: '[]',
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: '2026-04-01',
    updatedInJira: '2026-04-01',
    syncedAt: new Date().toISOString(),
  };
  db.prepare(`
    INSERT OR REPLACE INTO jira_tickets (
      key, summary, status, statusCategory, state, type,
      assignee, reporter, qaAssignee, productAssignee,
      component, module, product, projects,
      priority, riskLevel, customerPriority,
      fixVersions, targetFixVersions, customerTags,
      deployedEnvironments, labels, zohoRef,
      submitterName, submitterEmail,
      created, updatedInJira, syncedAt
    ) VALUES (
      @key, @summary, @status, @statusCategory, @state, @type,
      @assignee, @reporter, @qaAssignee, @productAssignee,
      @component, @module, @product, @projects,
      @priority, @riskLevel, @customerPriority,
      @fixVersions, @targetFixVersions, @customerTags,
      @deployedEnvironments, @labels, @zohoRef,
      @submitterName, @submitterEmail,
      @created, @updatedInJira, @syncedAt
    )
  `).run({ ...defaults, ...overrides });
}

function insertPr(db, repo, prNumber, overrides = {}) {
  const defaults = {
    repo,
    prNumber,
    prTitle: `PR #${prNumber}`,
    prAuthor: 'dev',
    prUrl: `https://github.com/${repo}/pull/${prNumber}`,
    status: 'open',
    baseBranch: 'master',
    headBranch: `feature-${prNumber}`,
    prCreatedAt: '2026-04-01T00:00:00Z',
    prUpdatedAt: '2026-04-01T00:00:00Z',
    syncedAt: new Date().toISOString(),
  };
  db.prepare(`
    INSERT OR REPLACE INTO github_prs (
      repo, prNumber, prTitle, prAuthor, prUrl, status,
      baseBranch, headBranch, prCreatedAt, prUpdatedAt, syncedAt
    ) VALUES (
      @repo, @prNumber, @prTitle, @prAuthor, @prUrl, @status,
      @baseBranch, @headBranch, @prCreatedAt, @prUpdatedAt, @syncedAt
    )
  `).run({ ...defaults, ...overrides });
}

function linkPrToJira(db, repo, prNumber, jiraKey) {
  db.prepare(`
    INSERT OR IGNORE INTO pr_jira_keys (repo, prNumber, jiraKey)
    VALUES (?, ?, ?)
  `).run(repo, prNumber, jiraKey);
}

function insertTruth(db, jiraKey, version, overrides = {}) {
  const defaults = {
    jiraKey,
    repo: 'webplatform',
    version,
    health: 'on-branch',
    healthCategory: 'good',
    healthMessage: 'On branch',
    onBranch: 1,
    prNumber: null,
    prUrl: null,
    stage: null,
    inTarget: 0,
    inFixVersion: 1,
    computedAt: new Date().toISOString(),
  };
  db.prepare(`
    INSERT OR REPLACE INTO ticket_truth (
      jiraKey, repo, version, health, healthCategory, healthMessage,
      onBranch, prNumber, prUrl, stage, inTarget, inFixVersion, computedAt
    ) VALUES (
      @jiraKey, @repo, @version, @health, @healthCategory, @healthMessage,
      @onBranch, @prNumber, @prUrl, @stage, @inTarget, @inFixVersion, @computedAt
    )
  `).run({ ...defaults, ...overrides });
}

// ── Tests ────────────────────────────────────────────────

describe('PrStore.findByJiraKeysSlim', () => {
  let db, prStore;

  beforeEach(() => {
    db = createTestDb();
    prStore = new PrStore({ db });
  });

  it('returns slim PR objects with expected fields', () => {
    insertPr(db, 'mavencare/webplatform', 100, { status: 'merged', baseBranch: 'master' });
    linkPrToJira(db, 'mavencare/webplatform', 100, 'DEV-1');

    const result = prStore.findByJiraKeysSlim(['DEV-1']);
    expect(result.size).toBe(1);
    const prs = result.get('DEV-1');
    expect(prs).toHaveLength(1);

    const pr = prs[0];
    expect(Object.keys(pr).sort()).toEqual(['baseBranch', 'prAuthor', 'prNumber', 'prUrl', 'repo', 'reviewDecision', 'status']);
    expect(pr.prNumber).toBe(100);
    expect(pr.status).toBe('merged');
    expect(pr.baseBranch).toBe('master');
  });

  it('batches correctly for many jira keys', () => {
    // Insert 10 PRs linked to 10 different JIRA keys
    for (let i = 1; i <= 10; i++) {
      insertPr(db, 'mavencare/webplatform', i);
      linkPrToJira(db, 'mavencare/webplatform', i, `DEV-${i}`);
    }

    const keys = Array.from({ length: 10 }, (_, i) => `DEV-${i + 1}`);
    const result = prStore.findByJiraKeysSlim(keys);
    expect(result.size).toBe(10);
  });

  it('groups multiple PRs under same jira key', () => {
    insertPr(db, 'mavencare/webplatform', 1, { baseBranch: 'master' });
    insertPr(db, 'mavencare/webplatform', 2, { baseBranch: 'releases/4.2.0' });
    linkPrToJira(db, 'mavencare/webplatform', 1, 'DEV-1');
    linkPrToJira(db, 'mavencare/webplatform', 2, 'DEV-1');

    const result = prStore.findByJiraKeysSlim(['DEV-1']);
    expect(result.get('DEV-1')).toHaveLength(2);
  });

  it('returns empty map for empty input', () => {
    const result = prStore.findByJiraKeysSlim([]);
    expect(result.size).toBe(0);
  });

  it('returns same jira keys as full findByJiraKeys', () => {
    for (let i = 1; i <= 5; i++) {
      insertPr(db, 'mavencare/webplatform', i);
      linkPrToJira(db, 'mavencare/webplatform', i, `DEV-${i}`);
    }

    const keys = ['DEV-1', 'DEV-2', 'DEV-3', 'DEV-4', 'DEV-5'];
    const slim = prStore.findByJiraKeysSlim(keys);
    const full = prStore.findByJiraKeys(keys);

    // Same keys present
    expect([...slim.keys()].sort()).toEqual([...full.keys()].sort());

    // Same PR numbers per key
    for (const key of keys) {
      const slimPrs = (slim.get(key) || []).map(p => p.prNumber);
      const fullPrs = (full.get(key) || []).map(p => p.prNumber);
      expect(slimPrs).toEqual(fullPrs);
    }
  });
});

describe('TicketStore.getTruthForTicketsSlim', () => {
  let db, ticketStore;

  beforeEach(() => {
    db = createTestDb();
    ticketStore = new TicketStore({ db });
  });

  it('returns only health, healthCategory, version fields', () => {
    insertTicket(db, 'DEV-1');
    insertTruth(db, 'DEV-1', '4.2.0', { health: 'on-branch', healthCategory: 'good' });

    const result = ticketStore.getTruthForTicketsSlim(['DEV-1']);
    expect(result.size).toBe(1);
    const truths = result.get('DEV-1');
    expect(truths).toHaveLength(1);

    const t = truths[0];
    expect(Object.keys(t).sort()).toEqual(['health', 'healthCategory', 'version']);
    expect(t.health).toBe('on-branch');
    expect(t.healthCategory).toBe('good');
    expect(t.version).toBe('4.2.0');
  });

  it('returns multiple truth entries per ticket', () => {
    insertTicket(db, 'DEV-1');
    insertTruth(db, 'DEV-1', '4.2.0', { health: 'on-branch', healthCategory: 'good' });
    insertTruth(db, 'DEV-1', '4.3.0', { health: 'missing', healthCategory: 'attention' });

    const result = ticketStore.getTruthForTicketsSlim(['DEV-1']);
    expect(result.get('DEV-1')).toHaveLength(2);
    expect(result.get('DEV-1')[0].version).toBe('4.2.0');
    expect(result.get('DEV-1')[1].version).toBe('4.3.0');
  });

  it('returns empty map for empty input', () => {
    const result = ticketStore.getTruthForTicketsSlim([]);
    expect(result.size).toBe(0);
  });

  it('returns same keys as full getTruthForTickets', () => {
    for (let i = 1; i <= 5; i++) {
      insertTicket(db, `DEV-${i}`);
      insertTruth(db, `DEV-${i}`, '4.2.0');
    }

    const keys = ['DEV-1', 'DEV-2', 'DEV-3', 'DEV-4', 'DEV-5'];
    const slim = ticketStore.getTruthForTicketsSlim(keys);
    const full = ticketStore.getTruthForTickets(keys);

    expect([...slim.keys()].sort()).toEqual([...full.keys()].sort());

    for (const key of keys) {
      const slimTruths = slim.get(key) || [];
      const fullTruths = full.get(key) || [];
      expect(slimTruths.length).toBe(fullTruths.length);
      // Slim contains the essential fields from full
      for (let j = 0; j < slimTruths.length; j++) {
        expect(slimTruths[j].health).toBe(fullTruths[j].health);
        expect(slimTruths[j].healthCategory).toBe(fullTruths[j].healthCategory);
        expect(slimTruths[j].version).toBe(fullTruths[j].version);
      }
    }
  });

  it('handles 500+ keys across chunked batches', () => {
    for (let i = 1; i <= 600; i++) {
      insertTicket(db, `DEV-${i}`);
      insertTruth(db, `DEV-${i}`, '4.2.0');
    }

    const keys = Array.from({ length: 600 }, (_, i) => `DEV-${i + 1}`);
    const result = ticketStore.getTruthForTicketsSlim(keys);
    expect(result.size).toBe(600);
  });
});

describe('Home response cache', () => {
  // Test the caching logic in isolation (extracted from routes.js pattern)
  let cache;
  const TTL = 100; // 100ms for fast tests

  function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
  }

  function setCached(key, data) {
    cache.set(key, { data, expiresAt: Date.now() + TTL });
  }

  beforeEach(() => {
    cache = new Map();
  });

  it('returns null for cache miss', () => {
    expect(getCached('key')).toBeNull();
  });

  it('returns cached data within TTL', () => {
    setCached('key', { releases: [1, 2, 3] });
    expect(getCached('key')).toEqual({ releases: [1, 2, 3] });
  });

  it('returns null after TTL expires', async () => {
    setCached('key', { releases: [1] });
    await new Promise(r => setTimeout(r, TTL + 50));
    expect(getCached('key')).toBeNull();
  });

  it('caches different keys independently', () => {
    setCached('a', { data: 'a' });
    setCached('b', { data: 'b' });
    expect(getCached('a')).toEqual({ data: 'a' });
    expect(getCached('b')).toEqual({ data: 'b' });
  });

  it('invalidation clears all entries', () => {
    setCached('a', { data: 'a' });
    setCached('b', { data: 'b' });
    cache.clear(); // simulates release event invalidation
    expect(getCached('a')).toBeNull();
    expect(getCached('b')).toBeNull();
  });
});
