import { describe, it, expect } from 'vitest';

const PrSync = require('../../src/core/pr-sync');

// Minimal stubs for PrSync constructor
function createPrSync() {
  const sync = new PrSync(
    { list: () => [] },
    { isConfigured: () => true, _paginate: async () => [] },
    { repos: [] }
  );
  return sync;
}

describe('PrSync — _deriveReviewDecision', () => {
  const sync = createPrSync();

  it('returns null for empty reviews', () => {
    expect(sync._deriveReviewDecision([])).toBeNull();
    expect(sync._deriveReviewDecision(null)).toBeNull();
  });

  it('returns null when only COMMENTED reviews exist', () => {
    const reviews = [
      { state: 'COMMENTED', user: { login: 'reviewer1' } },
      { state: 'COMMENTED', user: { login: 'reviewer2' } },
    ];
    expect(sync._deriveReviewDecision(reviews)).toBeNull();
  });

  it('returns APPROVED when all reviewers approved', () => {
    const reviews = [
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'APPROVED', user: { login: 'reviewer2' } },
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('APPROVED');
  });

  it('returns CHANGES_REQUESTED when any reviewer requested changes', () => {
    const reviews = [
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer2' } },
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('CHANGES_REQUESTED');
  });

  it('uses latest review per reviewer (approved supersedes changes_requested)', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
      { state: 'APPROVED', user: { login: 'reviewer1' } }, // later review
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('APPROVED');
  });

  it('uses latest review per reviewer (changes_requested supersedes approved)', () => {
    const reviews = [
      { state: 'APPROVED', user: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } }, // later review
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('CHANGES_REQUESTED');
  });

  it('handles mixed: one approved, one with changes requested', () => {
    const reviews = [
      { state: 'APPROVED', user: { login: 'alice' } },
      { state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
      { state: 'APPROVED', user: { login: 'charlie' } },
    ];
    // bob still has CHANGES_REQUESTED as latest
    expect(sync._deriveReviewDecision(reviews)).toBe('CHANGES_REQUESTED');
  });

  it('single APPROVED review returns APPROVED', () => {
    const reviews = [
      { state: 'APPROVED', user: { login: 'reviewer1' } },
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('APPROVED');
  });

  it('single CHANGES_REQUESTED review returns CHANGES_REQUESTED', () => {
    const reviews = [
      { state: 'CHANGES_REQUESTED', user: { login: 'reviewer1' } },
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('CHANGES_REQUESTED');
  });

  it('ignores reviews without user login', () => {
    const reviews = [
      { state: 'APPROVED', user: null },
      { state: 'APPROVED', user: { login: 'reviewer1' } },
    ];
    expect(sync._deriveReviewDecision(reviews)).toBe('APPROVED');
  });
});
