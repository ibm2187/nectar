import { describe, it, expect } from 'vitest';

const { STATUS_CATEGORIES, DONE_STATUSES, isDone } = require('../../src/core/status-categories');

describe('STATUS_CATEGORIES', () => {
  it('exposes the three Jira category constants', () => {
    expect(STATUS_CATEGORIES.TODO).toBe('To Do');
    expect(STATUS_CATEGORIES.IN_PROGRESS).toBe('In Progress');
    expect(STATUS_CATEGORIES.DONE).toBe('Done');
  });
});

describe('isDone', () => {
  it('returns true for tickets in the Done category', () => {
    expect(isDone({ statusCategory: 'Done' })).toBe(true);
  });

  it('returns false for In Progress and To Do', () => {
    expect(isDone({ statusCategory: 'In Progress' })).toBe(false);
    expect(isDone({ statusCategory: 'To Do' })).toBe(false);
  });

  it('is agnostic to status name — category is the authority', () => {
    // ISSUE-52 regression: "NO QA - Certified" used to be filtered by
    // matching a hand-rolled name list that had a casing typo.
    // Now driven by category; the name is irrelevant.
    expect(isDone({ jiraStatus: 'NO QA - Certified', statusCategory: 'Done' })).toBe(true);
    expect(isDone({ jiraStatus: 'Some New Status Nobody Listed', statusCategory: 'Done' })).toBe(true);
  });

  it('returns false for missing/nullish inputs', () => {
    expect(isDone(null)).toBe(false);
    expect(isDone(undefined)).toBe(false);
    expect(isDone({})).toBe(false);
    expect(isDone({ statusCategory: null })).toBe(false);
  });
});

describe('DONE_STATUSES', () => {
  it('uses the canonical "NO QA - Certified" casing (ISSUE-52)', () => {
    expect(DONE_STATUSES.has('NO QA - Certified')).toBe(true);
    expect(DONE_STATUSES.has('No QA - Certified')).toBe(false);
  });
});
