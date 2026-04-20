import { describe, it, expect, beforeEach } from 'vitest';

const PrStore = require('../../src/core/pr-store');
const { createTestDb } = require('../../src/core/db');

function makePr(overrides = {}) {
  return {
    prNumber: 1000,
    repo: 'mavencare/webplatform',
    prTitle: 'DEV-123 Fix something',
    prAuthor: 'johndoe',
    prUrl: 'https://github.com/mavencare/webplatform/pull/1000',
    status: 'open',
    reviewDecision: null,
    baseBranch: 'master',
    headBranch: 'fix/something',
    prCreatedAt: '2026-04-15T10:00:00Z',
    prUpdatedAt: '2026-04-18T14:00:00Z',
    syncedAt: '2026-04-20T09:00:00Z',
    ...overrides,
  };
}

describe('PrStore — reviewDecision', () => {
  let db, store;

  beforeEach(() => {
    db = createTestDb();
    store = new PrStore({ db });
  });

  it('stores and retrieves reviewDecision on upsert', () => {
    const pr = makePr({ reviewDecision: 'APPROVED' });
    store.upsert(pr, ['DEV-123']);

    const fetched = store.get('mavencare/webplatform', 1000);
    expect(fetched.reviewDecision).toBe('APPROVED');
  });

  it('stores null reviewDecision when not set', () => {
    const pr = makePr({ reviewDecision: null });
    store.upsert(pr, ['DEV-123']);

    const fetched = store.get('mavencare/webplatform', 1000);
    expect(fetched.reviewDecision).toBeNull();
  });

  it('updates reviewDecision on re-upsert', () => {
    store.upsert(makePr({ reviewDecision: null }), ['DEV-123']);
    store.upsert(makePr({ reviewDecision: 'CHANGES_REQUESTED' }), ['DEV-123']);

    const fetched = store.get('mavencare/webplatform', 1000);
    expect(fetched.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  it('findByJiraKeysSlim includes reviewDecision and prAuthor', () => {
    store.upsert(makePr({ prNumber: 100, reviewDecision: 'APPROVED', prAuthor: 'alice' }), ['DEV-100']);
    store.upsert(makePr({ prNumber: 101, reviewDecision: 'CHANGES_REQUESTED', prAuthor: 'bob' }), ['DEV-101']);

    const result = store.findByJiraKeysSlim(['DEV-100', 'DEV-101']);
    expect(result.get('DEV-100')[0].reviewDecision).toBe('APPROVED');
    expect(result.get('DEV-100')[0].prAuthor).toBe('alice');
    expect(result.get('DEV-101')[0].reviewDecision).toBe('CHANGES_REQUESTED');
    expect(result.get('DEV-101')[0].prAuthor).toBe('bob');
  });

  describe('findOpenByAuthorAndReview', () => {
    beforeEach(() => {
      store.upsert(makePr({ prNumber: 1, prAuthor: 'alice', reviewDecision: 'APPROVED' }), []);
      store.upsert(makePr({ prNumber: 2, prAuthor: 'alice', reviewDecision: 'CHANGES_REQUESTED' }), []);
      store.upsert(makePr({ prNumber: 3, prAuthor: 'alice', reviewDecision: null }), []);
      store.upsert(makePr({ prNumber: 4, prAuthor: 'bob', reviewDecision: 'APPROVED' }), []);
      store.upsert(makePr({ prNumber: 5, prAuthor: 'alice', status: 'merged', reviewDecision: 'APPROVED' }), []);
    });

    it('finds approved PRs for alice', () => {
      const prs = store.findOpenByAuthorAndReview('alice', 'APPROVED');
      expect(prs).toHaveLength(1);
      expect(prs[0].prNumber).toBe(1);
    });

    it('finds changes-requested PRs for alice', () => {
      const prs = store.findOpenByAuthorAndReview('alice', 'CHANGES_REQUESTED');
      expect(prs).toHaveLength(1);
      expect(prs[0].prNumber).toBe(2);
    });

    it('does not return merged PRs', () => {
      const prs = store.findOpenByAuthorAndReview('alice', 'APPROVED');
      expect(prs.every(p => p.status === 'open')).toBe(true);
    });

    it('does not return other authors PRs', () => {
      const prs = store.findOpenByAuthorAndReview('alice', 'APPROVED');
      expect(prs.every(p => p.prAuthor === 'alice')).toBe(true);
    });
  });

  describe('getOpenPrReviewSummary', () => {
    beforeEach(() => {
      store.upsert(makePr({ prNumber: 10, prAuthor: 'dev1', reviewDecision: 'APPROVED' }), []);
      store.upsert(makePr({ prNumber: 11, prAuthor: 'dev1', reviewDecision: 'CHANGES_REQUESTED' }), []);
      store.upsert(makePr({ prNumber: 12, prAuthor: 'dev1', reviewDecision: null }), []);
      store.upsert(makePr({ prNumber: 13, prAuthor: 'dev1', reviewDecision: 'APPROVED' }), []);
      store.upsert(makePr({ prNumber: 14, prAuthor: 'dev1', status: 'merged', reviewDecision: 'APPROVED' }), []);
    });

    it('groups open PRs by review state', () => {
      const summary = store.getOpenPrReviewSummary('dev1');
      expect(summary.approved).toHaveLength(2);
      expect(summary.changesRequested).toHaveLength(1);
      expect(summary.pending).toHaveLength(1);
    });

    it('excludes merged/closed PRs', () => {
      const summary = store.getOpenPrReviewSummary('dev1');
      const all = [...summary.approved, ...summary.changesRequested, ...summary.pending];
      expect(all.every(p => p.status === 'open')).toBe(true);
    });

    it('returns empty arrays for unknown author', () => {
      const summary = store.getOpenPrReviewSummary('unknown');
      expect(summary.approved).toHaveLength(0);
      expect(summary.changesRequested).toHaveLength(0);
      expect(summary.pending).toHaveLength(0);
    });
  });
});
