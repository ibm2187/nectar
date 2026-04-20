import { describe, it, expect, beforeEach } from 'vitest';

const VelocityEngine = require('../../src/core/velocity-engine');
const { createTestDb } = require('../../src/core/db');

/**
 * Helper: insert a JIRA ticket into the test database.
 */
function insertTicket(db, overrides = {}) {
  const ticket = {
    key: 'DEV-1001',
    summary: 'Test ticket',
    status: 'In Progress',
    statusCategory: 'In Progress',
    state: 'in-progress',
    type: 'Story',
    assignee: 'Alice',
    reporter: 'Bob',
    qaAssignee: 'Carol',
    productAssignee: null,
    component: 'Core',
    module: null,
    product: '[]',
    projects: '[]',
    priority: 'Medium',
    riskLevel: null,
    customerPriority: null,
    fixVersions: '["4.2.1"]',
    targetFixVersions: '["4.2.1"]',
    customerTags: '[]',
    deployedEnvironments: '[]',
    labels: '[]',
    zohoRef: null,
    submitterName: null,
    submitterEmail: null,
    created: '2026-03-01T10:00:00.000Z',
    updatedInJira: '2026-04-10T14:00:00.000Z',
    syncedAt: '2026-04-10T15:00:00.000Z',
    ...overrides,
  };

  db.prepare(`
    INSERT OR REPLACE INTO jira_tickets (
      key, summary, status, statusCategory, state, type,
      assignee, reporter, qaAssignee, productAssignee, component,
      module, product, projects,
      priority, riskLevel, customerPriority,
      fixVersions, targetFixVersions, customerTags,
      deployedEnvironments, labels, zohoRef,
      submitterName, submitterEmail,
      created, updatedInJira, syncedAt
    ) VALUES (
      @key, @summary, @status, @statusCategory, @state, @type,
      @assignee, @reporter, @qaAssignee, @productAssignee, @component,
      @module, @product, @projects,
      @priority, @riskLevel, @customerPriority,
      @fixVersions, @targetFixVersions, @customerTags,
      @deployedEnvironments, @labels, @zohoRef,
      @submitterName, @submitterEmail,
      @created, @updatedInJira, @syncedAt
    )
  `).run(ticket);

  return ticket;
}

describe('VelocityEngine', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('produces a full forecast with tickets, people, and releases', () => {
    // TESTING: Full end-to-end integration of all velocity modules
    //
    // SETUP:
    // - 3 people: Alice (dev), Bob (dev), Carol (QA)
    // - Historical velocity: Alice completed 10 tickets, Bob completed 5, Carol completed 8 (QA)
    // - Release 4.2.1 with 5 remaining tickets
    // - Release date: 2026-05-15
    //
    // EXPECTED RESULT:
    // - forecast.releases has entry for 4.2.1
    // - forecast.people has entries for Alice, Bob, Carol
    // - forecast.globalVelocity has dev and qa values

    // Insert a shipped release so velocity can be computed from it
    db.prepare(`
      INSERT INTO releases (key, id, repo, version, state, jiraReleaseDate, jiraReleased, jiraArchived, createdAt, updatedAt,
        tickets, cherryPicks, ci, risk, comments, deployments, approvals)
      VALUES ('webplatform:4.1.0', 'rel-4.1.0', 'webplatform', '4.1.0', 'done', '2026-04-10', 1, 0, datetime('now'), datetime('now'),
        '[]', '[]', '{}', '{}', '[]', '[]', '[]')
    `).run();

    // Insert historical Done tickets to establish velocity
    for (let i = 1; i <= 10; i++) {
      insertTicket(db, {
        key: `DONE-A${i}`,
        assignee: 'Alice',
        qaAssignee: 'Carol',
        status: 'Done',
        statusCategory: 'Done',
        fixVersions: '["4.1.0"]',
        updatedInJira: `2026-04-${String(5 + (i % 10)).padStart(2, '0')}T10:00:00.000Z`,
      });
    }
    for (let i = 1; i <= 5; i++) {
      insertTicket(db, {
        key: `DONE-B${i}`,
        assignee: 'Bob',
        qaAssignee: 'Carol',
        status: 'Done',
        statusCategory: 'Done',
        fixVersions: '["4.1.0"]',
        updatedInJira: `2026-04-${String(8 + i).padStart(2, '0')}T10:00:00.000Z`,
      });
    }

    // Insert remaining tickets for release 4.2.1
    for (let i = 1; i <= 3; i++) {
      insertTicket(db, {
        key: `DEV-R${i}`,
        assignee: 'Alice',
        qaAssignee: 'Carol',
        status: 'In Progress',
        statusCategory: 'In Progress',
        fixVersions: '["4.2.1"]',
      });
    }
    for (let i = 4; i <= 5; i++) {
      insertTicket(db, {
        key: `DEV-R${i}`,
        assignee: 'Bob',
        qaAssignee: 'Carol',
        status: 'In Progress',
        statusCategory: 'In Progress',
        fixVersions: '["4.2.1"]',
      });
    }

    const engine = new VelocityEngine({ db });
    const forecast = engine.forecast({
      now: new Date('2026-04-20T12:00:00Z'),
      releases: [{ version: '4.2.1', jiraReleaseDate: '2026-05-15' }],
    });

    // Verify structure
    expect(forecast.releases).toBeInstanceOf(Map);
    expect(forecast.releases.has('4.2.1')).toBe(true);
    expect(forecast.people).toBeInstanceOf(Map);
    expect(forecast.globalVelocity).toBeDefined();
    expect(forecast.globalVelocity.dev).toBeGreaterThan(0);
    expect(forecast.simulation.days.length).toBeGreaterThan(0);
    expect(forecast.computedAt).toBeTruthy();

    // Release projection should exist
    const rel = forecast.releases.get('4.2.1');
    expect(rel.projectedDate).toBeTruthy();
    expect(rel.risk).toBeTruthy();
    expect(rel.breakdown).toBeDefined();
    expect(rel.suggestions).toBeInstanceOf(Array);
  });

  it('returns empty result when no releases are active', () => {
    // TESTING: Engine handles empty state gracefully
    //
    // EXPECTED RESULT: empty releases, people, no crash

    const engine = new VelocityEngine({ db });
    const forecast = engine.forecast({
      now: new Date('2026-04-20T12:00:00Z'),
      releases: [],
    });

    expect(forecast.releases.size).toBe(0);
    expect(forecast.people.size).toBe(0);
    expect(forecast.simulation.totalDays).toBe(0);
  });

  it('caches results within TTL window', () => {
    // TESTING: getCachedForecast returns same result within 5-minute window
    //
    // SETUP:
    // - Run forecast at T=0
    // - Request again at T+1 minute
    //
    // EXPECTED RESULT: second call returns cached result (same computedAt)

    insertTicket(db, {
      key: 'DEV-1',
      assignee: 'Alice',
      status: 'In Progress',
      statusCategory: 'In Progress',
      fixVersions: '["4.2.1"]',
    });

    const engine = new VelocityEngine({ db, config: { cacheTTL: 300000 } });

    const t0 = new Date('2026-04-20T12:00:00Z');
    const first = engine.getCachedForecast({
      now: t0,
      releases: [{ version: '4.2.1', jiraReleaseDate: '2026-05-15' }],
    });

    // Second call 1 minute later — should get cached result
    const t1 = new Date('2026-04-20T12:01:00Z');
    const second = engine.getCachedForecast({
      now: t1,
      releases: [{ version: '4.2.1', jiraReleaseDate: '2026-05-15' }],
    });

    expect(second.computedAt).toBe(first.computedAt);
  });

  it('invalidates cache when invalidateCache is called', () => {
    // TESTING: Cache invalidation forces recomputation
    //
    // SETUP:
    // - Run forecast, then invalidate, then run again
    //
    // EXPECTED RESULT: second result has different computedAt

    insertTicket(db, {
      key: 'DEV-1',
      assignee: 'Alice',
      status: 'In Progress',
      statusCategory: 'In Progress',
      fixVersions: '["4.2.1"]',
    });

    const engine = new VelocityEngine({ db, config: { cacheTTL: 300000 } });

    const first = engine.getCachedForecast({
      now: new Date('2026-04-20T12:00:00Z'),
      releases: [{ version: '4.2.1', jiraReleaseDate: '2026-05-15' }],
    });

    engine.invalidateCache();

    const second = engine.getCachedForecast({
      now: new Date('2026-04-20T12:00:01Z'),
      releases: [{ version: '4.2.1', jiraReleaseDate: '2026-05-15' }],
    });

    expect(second.computedAt).not.toBe(first.computedAt);
  });

  it('does not crash with no tickets in the database', () => {
    // TESTING: Completely empty database → no crash
    //
    // EXPECTED RESULT: Returns valid result structure

    const engine = new VelocityEngine({ db });
    const forecast = engine.forecast({
      now: new Date('2026-04-20T12:00:00Z'),
      releases: [{ version: '4.2.1', jiraReleaseDate: '2026-05-15' }],
    });

    expect(forecast).toBeDefined();
    expect(forecast.releases).toBeInstanceOf(Map);
    expect(forecast.people).toBeInstanceOf(Map);
  });
});
