import { describe, it, expect, beforeEach } from 'vitest';

const TicketStore = require('../../src/core/ticket-store');
const { createTestDb } = require('../../src/core/db');

/**
 * Helper: create a ticket object with sensible defaults and optional overrides.
 */
function makeTicket(overrides = {}) {
  return {
    key: 'DEV-1001',
    summary: 'Fix login timeout',
    status: 'In Review',
    statusCategory: 'In Progress',
    state: 'in-progress',
    type: 'Bug',
    assignee: 'Alice',
    reporter: 'Bob',
    qaAssignee: 'Carol',
    productAssignee: null,
    component: 'Auth',
    module: null,
    product: [],
    projects: [],
    priority: 'High',
    riskLevel: null,
    customerPriority: null,
    fixVersions: ['4.2.1'],
    targetFixVersions: ['4.2.1'],
    customerTags: [],
    deployedEnvironments: [],
    labels: [],
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: '2026-04-01T10:00:00.000Z',
    updatedInJira: '2026-04-16T14:00:00.000Z',
    syncedAt: '2026-04-16T15:00:00.000Z',
    ...overrides,
  };
}

/**
 * Helper: insert a release row into the releases table.
 */
function insertRelease(db, { version, repo = 'webplatform', state = 'stabilizing', jiraReleaseDate = null, createdAt = null }) {
  const now = createdAt || new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO releases (key, id, repo, version, state, branch, createdAt, updatedAt, jiraReleaseDate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${repo}:${version}`,
    `${repo}:${version}`,
    repo,
    version,
    state,
    `releases/${version}`,
    now,
    now,
    jiraReleaseDate
  );
}

describe('TicketStore.getDeliveryForecast', () => {
  let db, store;

  beforeEach(() => {
    db = createTestDb();
    db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();
    store = new TicketStore({ db });
  });

  it('returns risk "low" when all tickets are done', () => {
    // TESTING: Forecast for a release with zero remaining tickets
    //
    // SETUP:
    // - Release 4.2.1 with a future release date
    // - 3 tickets, all with "Done" status and statusCategory = 'Done'
    //
    // EXPECTED RESULT:
    // - remaining = 0, risk = 'low', message says "All tickets done"

    insertRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-05-01' });
    store.upsertBatch([
      makeTicket({ key: 'DEV-1', status: 'Done', statusCategory: 'Done', state: 'done' }),
      makeTicket({ key: 'DEV-2', status: 'QA Certified', statusCategory: 'Done', state: 'done' }),
      makeTicket({ key: 'DEV-3', status: 'Closed', statusCategory: 'Done', state: 'done' }),
    ]);

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.version).toBe('4.2.1');
    expect(forecast.total).toBe(3);
    expect(forecast.done).toBe(3);
    expect(forecast.remaining).toBe(0);
    expect(forecast.risk).toBe('low');
    expect(forecast.riskMessage).toContain('All tickets done');
  });

  it('returns risk "low" when velocity is well ahead of schedule', () => {
    // TESTING: Forecast when team velocity greatly exceeds required velocity
    //
    // SETUP:
    // - Release 4.2.1 with release date 20 days out
    // - 10 tickets total: 8 done (recently completed), 2 remaining
    // - The 8 done tickets have updatedInJira within the 14-day window
    // - Required: 2 tickets in ~18 days (0.11/day), actual: 8/14 = 0.57/day
    //
    // EXPECTED RESULT:
    // - risk = 'low' because required velocity << actual velocity * 0.8

    insertRelease(db, {
      version: '4.2.1',
      jiraReleaseDate: '2026-05-08',
      createdAt: '2026-04-01T10:00:00.000Z',
    });

    const tickets = [];
    for (let i = 1; i <= 8; i++) {
      tickets.push(makeTicket({
        key: `DEV-${i}`,
        status: 'Done',
        statusCategory: 'Done',
        state: 'done',
        updatedInJira: '2026-04-15T10:00:00.000Z',
      }));
    }
    // 2 remaining tickets
    tickets.push(makeTicket({ key: 'DEV-9', status: 'In Review', statusCategory: 'In Progress' }));
    tickets.push(makeTicket({ key: 'DEV-10', status: 'In Testing', statusCategory: 'In Progress' }));
    store.upsertBatch(tickets);

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.total).toBe(10);
    expect(forecast.done).toBe(8);
    expect(forecast.remaining).toBe(2);
    expect(forecast.risk).toBe('low');
    expect(forecast.riskMessage).toContain('On track');
    expect(forecast.velocity.actual).toBeGreaterThan(0);
    expect(forecast.projectedDate).toBeTruthy();
  });

  it('returns risk "high" when velocity is poor compared to remaining work', () => {
    // TESTING: Forecast when team velocity is far below what is needed
    //
    // SETUP:
    // - Release 4.2.1 with release date 5 days out
    // - 10 tickets total: 1 done (recently), 9 remaining
    // - Required: 9 tickets in 3 days (3.0/day), actual: 1/14 = 0.07/day
    //
    // EXPECTED RESULT:
    // - risk = 'high' because required velocity > actual velocity * 1.5

    insertRelease(db, {
      version: '4.2.1',
      jiraReleaseDate: '2026-04-23',
      createdAt: '2026-04-01T10:00:00.000Z',
    });

    const tickets = [];
    tickets.push(makeTicket({
      key: 'DEV-1',
      status: 'Done',
      statusCategory: 'Done',
      state: 'done',
      updatedInJira: '2026-04-15T10:00:00.000Z',
    }));
    for (let i = 2; i <= 10; i++) {
      tickets.push(makeTicket({
        key: `DEV-${i}`,
        status: 'In Review',
        statusCategory: 'In Progress',
      }));
    }
    store.upsertBatch(tickets);

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.total).toBe(10);
    expect(forecast.done).toBe(1);
    expect(forecast.remaining).toBe(9);
    expect(forecast.risk).toBe('high');
    expect(forecast.riskMessage).toContain('Behind');
  });

  it('falls back to global velocity when no version-specific data exists', () => {
    // TESTING: Velocity fallback chain when updatedInJira has no recent completions
    //
    // SETUP:
    // - Release 4.3.0 with release date in the future
    // - All tickets are still in progress (none done)
    // - But there ARE other done tickets in other versions (global velocity)
    //
    // EXPECTED RESULT:
    // - Should use global velocity as fallback
    // - velocity.source should be 'global'

    insertRelease(db, {
      version: '4.3.0',
      jiraReleaseDate: '2026-05-15',
      createdAt: '2026-04-01T10:00:00.000Z',
    });

    // Tickets in our target version — all in progress
    store.upsertBatch([
      makeTicket({ key: 'DEV-1', fixVersions: ['4.3.0'], targetFixVersions: ['4.3.0'], status: 'In Review', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-2', fixVersions: ['4.3.0'], targetFixVersions: ['4.3.0'], status: 'In Testing', statusCategory: 'In Progress' }),
    ]);

    // Other version tickets that are done (to provide global velocity)
    insertRelease(db, { version: '4.2.0', jiraReleaseDate: '2026-04-10' });
    store.upsertBatch([
      makeTicket({ key: 'DEV-10', fixVersions: ['4.2.0'], targetFixVersions: ['4.2.0'], status: 'Done', statusCategory: 'Done', updatedInJira: '2026-04-15T10:00:00.000Z' }),
      makeTicket({ key: 'DEV-11', fixVersions: ['4.2.0'], targetFixVersions: ['4.2.0'], status: 'Done', statusCategory: 'Done', updatedInJira: '2026-04-14T10:00:00.000Z' }),
      makeTicket({ key: 'DEV-12', fixVersions: ['4.2.0'], targetFixVersions: ['4.2.0'], status: 'Done', statusCategory: 'Done', updatedInJira: '2026-04-13T10:00:00.000Z' }),
    ]);

    const forecast = store.getDeliveryForecast('4.3.0', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.remaining).toBe(2);
    expect(forecast.velocity.source).toBe('global');
    expect(forecast.velocity.actual).toBeGreaterThan(0);
  });

  it('returns risk "critical" for overdue releases', () => {
    // TESTING: Forecast for a release that has passed its deadline
    //
    // SETUP:
    // - Release 4.2.1 with release date 3 days ago
    // - 5 tickets remaining (not done)
    //
    // EXPECTED RESULT:
    // - risk = 'critical', daysLeft <= 0

    insertRelease(db, {
      version: '4.2.1',
      jiraReleaseDate: '2026-04-15',
      createdAt: '2026-04-01T10:00:00.000Z',
    });

    store.upsertBatch([
      makeTicket({ key: 'DEV-1', status: 'In Review', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-2', status: 'In Testing', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-3', status: 'Blocked', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-4', status: 'To Do', statusCategory: 'To Do' }),
      makeTicket({ key: 'DEV-5', status: 'Done', statusCategory: 'Done', state: 'done', updatedInJira: '2026-04-14T10:00:00.000Z' }),
    ]);

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.remaining).toBe(4);
    expect(forecast.daysLeft).toBeLessThanOrEqual(0);
    expect(forecast.risk).toBe('critical');
    expect(forecast.riskMessage).toContain('Overdue');
  });

  it('correctly computes breakdown counts', () => {
    // TESTING: Status breakdown of remaining tickets
    //
    // SETUP:
    // - Release with tickets in various status groups
    // - 1 Done, 1 In Progress, 1 Blocked, 1 Ready For Testing, 1 In Testing, 1 To Do
    //
    // EXPECTED RESULT:
    // - breakdown counts match the status group assignments

    insertRelease(db, {
      version: '4.2.1',
      jiraReleaseDate: '2026-05-01',
      createdAt: '2026-04-01T10:00:00.000Z',
    });

    store.upsertBatch([
      makeTicket({ key: 'DEV-1', status: 'Done', statusCategory: 'Done', state: 'done' }),
      makeTicket({ key: 'DEV-2', status: 'Development In Progress', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-3', status: 'Blocked', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-4', status: 'Ready For Testing', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-5', status: 'In Testing', statusCategory: 'In Progress' }),
      makeTicket({ key: 'DEV-6', status: 'To Do', statusCategory: 'To Do' }),
      makeTicket({ key: 'DEV-7', status: 'Cherry Picked', statusCategory: 'In Progress' }),
    ]);

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.total).toBe(7);
    expect(forecast.done).toBe(1);
    expect(forecast.remaining).toBe(6);
    expect(forecast.breakdown.inDev).toBe(1);     // Development In Progress
    expect(forecast.breakdown.blocked).toBe(1);    // Blocked
    expect(forecast.breakdown.readyForQa).toBe(1); // Ready For Testing
    expect(forecast.breakdown.inQa).toBe(1);       // In Testing
    expect(forecast.breakdown.notStarted).toBe(1); // To Do
    expect(forecast.breakdown.awaitingCp).toBe(1); // Cherry Picked

    // Verify breakdown sums to remaining
    const { notStarted, inDev, blocked, readyForQa, inQa, awaitingCp } = forecast.breakdown;
    expect(notStarted + inDev + blocked + readyForQa + inQa + awaitingCp).toBe(forecast.remaining);
  });

  it('returns risk "unknown" with no velocity data and no release date', () => {
    // TESTING: Forecast when there is no velocity data and no release date
    //
    // SETUP:
    // - Release with no jiraReleaseDate
    // - Tickets with no updatedInJira, no global velocity
    //
    // EXPECTED RESULT:
    // - risk = 'unknown', no projected date

    insertRelease(db, {
      version: '4.3.0',
      jiraReleaseDate: null,
      createdAt: '2026-04-18T10:00:00.000Z',
    });

    store.upsertBatch([
      makeTicket({ key: 'DEV-1', fixVersions: ['4.3.0'], targetFixVersions: ['4.3.0'], status: 'To Do', statusCategory: 'To Do', updatedInJira: null }),
    ]);

    const forecast = store.getDeliveryForecast('4.3.0', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.remaining).toBe(1);
    expect(forecast.releaseDate).toBeNull();
    expect(forecast.daysLeft).toBeNull();
    // With no velocity and no date, should be 'unknown' (no deadline to measure against)
    expect(forecast.risk).toBe('unknown');
  });

  it('uses the buffer to compute deadline date', () => {
    // TESTING: Deadline = release date minus buffer days
    //
    // SETUP:
    // - Release date is 2026-05-10
    // - Default buffer = 2 days
    //
    // EXPECTED RESULT:
    // - deadlineDate = 2026-05-08

    insertRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-05-10' });
    store.upsert(makeTicket({ key: 'DEV-1', status: 'Done', statusCategory: 'Done' }));

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.releaseDate).toBe('2026-05-10');
    expect(forecast.deadlineDate).toBe('2026-05-08');
  });

  it('handles empty release with no tickets', () => {
    // TESTING: Forecast for a release with zero tickets
    //
    // SETUP:
    // - Release exists but has no tickets assigned
    //
    // EXPECTED RESULT:
    // - total = 0, remaining = 0, risk = 'low'

    insertRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-05-01' });

    const forecast = store.getDeliveryForecast('4.2.1', {
      now: new Date('2026-04-18T12:00:00Z'),
    });

    expect(forecast.total).toBe(0);
    expect(forecast.remaining).toBe(0);
    expect(forecast.done).toBe(0);
    expect(forecast.risk).toBe('low');
  });
});
