import { describe, it, expect } from 'vitest';

const RiskAssessor = require('../../../src/core/velocity/risk');

describe('RiskAssessor', () => {
  let assessor;

  beforeEach(() => {
    assessor = new RiskAssessor();
  });

  // ── Risk level assessment ────────────────────────────

  it('returns "on-track" when projected before deadline', () => {
    // TESTING: Release projected to complete before deadline
    //
    // SETUP:
    // - Projected date: 2026-04-22
    // - Deadline: 2026-04-28
    // - daysLate = -6 (6 days early)
    //
    // EXPECTED RESULT: risk = 'on-track'

    const projection = {
      remaining: 5,
      projectedDate: '2026-04-22',
      deadlineDate: '2026-04-28',
      daysLate: -6,
      bottleneck: null,
      breakdown: { notStarted: 1, inDev: 2, blocked: 0, readyForQa: 1, inQa: 1, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(result.risk).toBe('on-track');
    expect(result.riskMessage).toContain('On track');
  });

  it('returns "tight" when projected 1-2 days after deadline', () => {
    // TESTING: Release projected just barely after deadline
    //
    // SETUP:
    // - Projected date: 2026-04-30
    // - Deadline: 2026-04-28
    // - daysLate = 2
    //
    // EXPECTED RESULT: risk = 'tight'

    const projection = {
      remaining: 5,
      projectedDate: '2026-04-30',
      deadlineDate: '2026-04-28',
      daysLate: 2,
      bottleneck: null,
      breakdown: { notStarted: 1, inDev: 2, blocked: 0, readyForQa: 1, inQa: 1, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(result.risk).toBe('tight');
    expect(result.riskMessage).toContain('Tight');
  });

  it('returns "at-risk" when projected 3-7 days after deadline', () => {
    // TESTING: Release projected significantly after deadline
    //
    // SETUP:
    // - daysLate = 5
    //
    // EXPECTED RESULT: risk = 'at-risk'

    const projection = {
      remaining: 10,
      projectedDate: '2026-05-03',
      deadlineDate: '2026-04-28',
      daysLate: 5,
      bottleneck: null,
      breakdown: { notStarted: 3, inDev: 4, blocked: 1, readyForQa: 1, inQa: 1, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(result.risk).toBe('at-risk');
    expect(result.riskMessage).toContain('At risk');
  });

  it('returns "critical" when projected 7+ days after deadline', () => {
    // TESTING: Release severely behind schedule
    //
    // SETUP:
    // - daysLate = 10
    //
    // EXPECTED RESULT: risk = 'critical'

    const projection = {
      remaining: 20,
      projectedDate: '2026-05-08',
      deadlineDate: '2026-04-28',
      daysLate: 10,
      bottleneck: null,
      breakdown: { notStarted: 8, inDev: 6, blocked: 2, readyForQa: 2, inQa: 2, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(result.risk).toBe('critical');
    expect(result.riskMessage).toContain('Critical');
  });

  it('returns "critical" when deadline has already passed', () => {
    // TESTING: Deadline in the past with remaining tickets
    //
    // SETUP:
    // - Deadline: 2026-04-15 (3 days ago)
    // - Today: 2026-04-18
    // - 10 tickets remaining
    //
    // EXPECTED RESULT: risk = 'critical', message mentions passed deadline

    const projection = {
      remaining: 10,
      projectedDate: '2026-04-25',
      deadlineDate: '2026-04-15',
      daysLate: 10,
      bottleneck: null,
      breakdown: { notStarted: 3, inDev: 4, blocked: 1, readyForQa: 1, inQa: 1, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-15', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(result.risk).toBe('critical');
    expect(result.riskMessage).toContain('Deadline passed');
  });

  it('returns "on-track" when all tickets are done', () => {
    // TESTING: All tickets completed → on track
    //
    // EXPECTED RESULT: risk = 'on-track', message says "All tickets completed"

    const projection = {
      remaining: 0,
      projectedDate: '2026-04-18',
      deadlineDate: '2026-04-28',
      daysLate: -10,
      bottleneck: null,
      breakdown: { notStarted: 0, inDev: 0, blocked: 0, readyForQa: 0, inQa: 0, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28');

    expect(result.risk).toBe('on-track');
    expect(result.riskMessage).toContain('All tickets completed');
  });

  it('returns "unknown" when no projection data', () => {
    // TESTING: Null projection → unknown risk
    //
    // EXPECTED RESULT: risk = 'unknown'

    const result = assessor.assess(null, '2026-04-28');

    expect(result.risk).toBe('unknown');
  });

  it('returns "unknown" when no deadline set', () => {
    // TESTING: Tickets remaining but no deadline → unknown timing risk
    //
    // EXPECTED RESULT: risk = 'unknown', mentions remaining count

    const projection = {
      remaining: 5,
      projectedDate: '2026-04-25',
      deadlineDate: null,
      daysLate: 0,
      bottleneck: null,
      breakdown: { notStarted: 2, inDev: 2, blocked: 0, readyForQa: 1, inQa: 0, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, null);

    expect(result.risk).toBe('unknown');
    expect(result.riskMessage).toContain('5 tickets remaining');
  });

  // ── Suggestions ──────────────────────────────────────

  it('suggests QA bottleneck when QA is the constraint', () => {
    // TESTING: Suggestion generated for QA bottleneck
    //
    // SETUP:
    // - Bottleneck: Carol (QA), 15 tickets at 2/day
    //
    // EXPECTED RESULT: Suggestion mentions QA bottleneck with details

    const projection = {
      remaining: 20,
      projectedDate: '2026-05-05',
      deadlineDate: '2026-04-28',
      daysLate: 7,
      bottleneck: { person: 'Carol', role: 'qa', queueSize: 15, velocity: 2.0, projectedClear: 8 },
      breakdown: { notStarted: 0, inDev: 3, blocked: 0, readyForQa: 5, inQa: 10, awaitingCp: 2 },
    };

    const result = assessor.assess(projection, '2026-04-28');

    expect(result.suggestions.some(s => s.includes('QA is the bottleneck'))).toBe(true);
    expect(result.suggestions.some(s => s.includes('Carol'))).toBe(true);
  });

  it('suggests unblocking when tickets are blocked', () => {
    // TESTING: Suggestion generated for blocked tickets
    //
    // SETUP:
    // - 4 blocked tickets in breakdown
    //
    // EXPECTED RESULT: Suggestion mentions blocked count

    const projection = {
      remaining: 10,
      projectedDate: '2026-05-03',
      deadlineDate: '2026-04-28',
      daysLate: 5,
      bottleneck: null,
      breakdown: { notStarted: 2, inDev: 2, blocked: 4, readyForQa: 1, inQa: 1, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28');

    expect(result.suggestions.some(s => s.includes('4 tickets are blocked'))).toBe(true);
  });

  it('suggests assigning unassigned tickets', () => {
    // TESTING: Suggestion generated for tickets without assignees
    //
    // SETUP:
    // - 3 tickets missing dev assignee, 2 missing QA assignee
    //
    // EXPECTED RESULT: Suggestions mention missing assignees

    const projection = {
      remaining: 10,
      projectedDate: '2026-05-03',
      deadlineDate: '2026-04-28',
      daysLate: 5,
      bottleneck: null,
      breakdown: { notStarted: 4, inDev: 3, blocked: 0, readyForQa: 2, inQa: 1, awaitingCp: 0 },
    };

    const unassigned = [
      { key: 'DEV-1', missingDev: true, missingQa: false },
      { key: 'DEV-2', missingDev: true, missingQa: true },
      { key: 'DEV-3', missingDev: true, missingQa: false },
      { key: 'DEV-4', missingDev: false, missingQa: true },
    ];

    const result = assessor.assess(projection, '2026-04-28', { unassigned });

    expect(result.suggestions.some(s => s.includes('3 tickets have no dev assignee'))).toBe(true);
    expect(result.suggestions.some(s => s.includes('2 tickets have no QA assignee'))).toBe(true);
  });

  it('suggests redistribution for single-threaded bottleneck', () => {
    // TESTING: Suggestion when one person has a very long projected clear time
    //
    // SETUP:
    // - Bottleneck: Alice with projectedClear = 15 (> 10)
    //
    // EXPECTED RESULT: Suggestion to redistribute

    const projection = {
      remaining: 15,
      projectedDate: '2026-05-10',
      deadlineDate: '2026-04-28',
      daysLate: 12,
      bottleneck: { person: 'Alice', role: 'dev', queueSize: 15, velocity: 1.0, projectedClear: 15 },
      breakdown: { notStarted: 5, inDev: 5, blocked: 0, readyForQa: 3, inQa: 2, awaitingCp: 0 },
    };

    const result = assessor.assess(projection, '2026-04-28');

    expect(result.suggestions.some(s => s.includes('single-threaded bottleneck'))).toBe(true);
  });
});
