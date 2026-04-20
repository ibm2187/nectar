import { describe, it, expect, beforeEach } from 'vitest';

const PersonVelocity = require('../../../src/core/velocity/person');
const { createTestDb } = require('../../../src/core/db');

/**
 * Helper: insert a JIRA ticket into the test database.
 */
function insertTicket(db, overrides = {}) {
  const ticket = {
    key: 'DEV-1001',
    summary: 'Test ticket',
    status: 'Done',
    statusCategory: 'Done',
    state: 'done',
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

describe('PersonVelocity', () => {
  let db, pv;

  beforeEach(() => {
    db = createTestDb();
    pv = new PersonVelocity(db);
  });

  // ── _countBusinessDays ────────────────────────────────

  describe('_countBusinessDays', () => {
    it('counts weekdays correctly for a full week', () => {
      // TESTING: Business day counting — Mon 2026-04-06 through Sun 2026-04-12
      //
      // SETUP: 7 calendar days (Monday through Sunday)
      //
      // EXPECTED RESULT: 5 business days (Mon-Fri)
      const count = pv._countBusinessDays('2026-04-06', '2026-04-13');
      expect(count).toBe(5);
    });

    it('counts business days in a 28-day window correctly (~20 business days)', () => {
      // TESTING: 28 calendar days should yield ~20 business days
      //
      // SETUP: 4 full weeks = 28 calendar days
      //
      // EXPECTED RESULT: 20 business days
      const count = pv._countBusinessDays('2026-03-21', '2026-04-18');
      expect(count).toBe(20);
    });

    it('returns 0 for a weekend-only range', () => {
      // TESTING: A Sat-Sun range has 0 business days
      //
      // EXPECTED RESULT: 0
      const count = pv._countBusinessDays('2026-04-11', '2026-04-13'); // Sat-Sun
      expect(count).toBe(0);
    });

    it('returns 0 for same start and end', () => {
      // TESTING: Zero-length range
      //
      // EXPECTED RESULT: 0
      const count = pv._countBusinessDays('2026-04-10', '2026-04-10');
      expect(count).toBe(0);
    });
  });

  // ── computeForPerson ──────────────────────────────────

  describe('computeForPerson', () => {
    it('computes correct dev velocity for a person with Done tickets', () => {
      // TESTING: Dev velocity calculation from completed tickets
      //
      // SETUP:
      // - 5 tickets completed by Alice as assignee within the lookback window
      // - updatedInJira dates all within the 28-day window before 2026-04-18
      // - All are Done status, not in exclusion list
      //
      // EXPECTED RESULT:
      // - completedInWindow = 5
      // - businessDays = 20 (28 calendar days)
      // - ticketsPerDay = 5 / 20 = 0.25

      for (let i = 1; i <= 5; i++) {
        insertTicket(db, {
          key: `DEV-${i}`,
          assignee: 'Alice',
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(5 + i).padStart(2, '0')}T10:00:00.000Z`,
        });
      }

      const result = pv.computeForPerson('Alice', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.completedInWindow).toBe(5);
      expect(result.businessDays).toBe(20);
      expect(result.ticketsPerDay).toBe(0.25);
      expect(result.dataQuality).toBe('accurate');
    });

    it('computes correct QA velocity separately from dev velocity', () => {
      // TESTING: QA velocity uses qaAssignee field, not assignee
      //
      // SETUP:
      // - 3 tickets where Carol is qaAssignee (Done)
      // - 2 tickets where Carol is assignee (Done) — should NOT count for QA velocity
      //
      // EXPECTED RESULT:
      // - QA completedInWindow = 3 (only qaAssignee matches)

      for (let i = 1; i <= 3; i++) {
        insertTicket(db, {
          key: `DEV-${i}`,
          assignee: 'Alice',
          qaAssignee: 'Carol',
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
        });
      }
      // Tickets where Carol is dev assignee — not QA
      for (let i = 4; i <= 5; i++) {
        insertTicket(db, {
          key: `DEV-${i}`,
          assignee: 'Carol',
          qaAssignee: 'Bob',
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
        });
      }

      const qaResult = pv.computeForPerson('Carol', 'qa', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(qaResult.completedInWindow).toBe(3);
    });

    it('returns 0 velocity for a person with no activity', () => {
      // TESTING: Person exists in the system but has no completed tickets
      //
      // SETUP: No tickets for "Dave"
      //
      // EXPECTED RESULT: ticketsPerDay = 0, completedInWindow = 0

      const result = pv.computeForPerson('Dave', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.ticketsPerDay).toBe(0);
      expect(result.completedInWindow).toBe(0);
    });

    it('excludes Resolved Without Code and Canceled tickets', () => {
      // TESTING: Pseudo-done statuses should not count as velocity
      //
      // SETUP:
      // - 2 real Done tickets
      // - 1 "Resolved Without Code" ticket
      // - 1 "Canceled" ticket
      //
      // EXPECTED RESULT: completedInWindow = 2 (excludes the pseudo-done)

      insertTicket(db, {
        key: 'DEV-1',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: '2026-04-10T10:00:00.000Z',
      });
      insertTicket(db, {
        key: 'DEV-2',
        assignee: 'Alice',
        status: 'QA Certified',
        statusCategory: 'Done',
        updatedInJira: '2026-04-11T10:00:00.000Z',
      });
      insertTicket(db, {
        key: 'DEV-3',
        assignee: 'Alice',
        status: 'Resolved Without Code',
        statusCategory: 'Done',
        updatedInJira: '2026-04-12T10:00:00.000Z',
      });
      insertTicket(db, {
        key: 'DEV-4',
        assignee: 'Alice',
        status: 'Canceled',
        statusCategory: 'Done',
        updatedInJira: '2026-04-13T10:00:00.000Z',
      });

      const result = pv.computeForPerson('Alice', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.completedInWindow).toBe(2);
    });

    it('excludes Declined and Duplicate tickets', () => {
      // TESTING: More pseudo-done exclusions
      //
      // SETUP:
      // - 1 "Declined" ticket, 1 "Duplicate" ticket
      //
      // EXPECTED RESULT: completedInWindow = 0

      insertTicket(db, {
        key: 'DEV-1',
        assignee: 'Alice',
        status: 'Declined',
        statusCategory: 'Done',
        updatedInJira: '2026-04-10T10:00:00.000Z',
      });
      insertTicket(db, {
        key: 'DEV-2',
        assignee: 'Alice',
        status: 'Duplicate',
        statusCategory: 'Done',
        updatedInJira: '2026-04-11T10:00:00.000Z',
      });

      const result = pv.computeForPerson('Alice', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.completedInWindow).toBe(0);
    });

    it('does not count tickets outside the lookback window', () => {
      // TESTING: Tickets completed before the window should not be counted
      //
      // SETUP:
      // - 1 ticket updated 60 days ago (outside 28-day window)
      // - 1 ticket updated 10 days ago (inside window)
      //
      // EXPECTED RESULT: completedInWindow = 1

      insertTicket(db, {
        key: 'DEV-1',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: '2026-02-15T10:00:00.000Z', // ~62 days before 2026-04-18
      });
      insertTicket(db, {
        key: 'DEV-2',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: '2026-04-08T10:00:00.000Z', // 10 days before 2026-04-18
      });

      const result = pv.computeForPerson('Alice', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.completedInWindow).toBe(1);
    });

    it('falls back to syncedAt when updatedInJira is empty for >50% of Done tickets', () => {
      // TESTING: Data quality fallback to syncedAt
      //
      // SETUP:
      // - 3 Done tickets: 1 has updatedInJira, 2 have null updatedInJira
      // - All have syncedAt within the window
      // - Since >50% (2/3) are missing updatedInJira, should use syncedAt
      //
      // EXPECTED RESULT:
      // - dataQuality = 'estimated'
      // - completedInWindow = 3 (all found via syncedAt)

      insertTicket(db, {
        key: 'DEV-1',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: '2026-04-10T10:00:00.000Z',
        syncedAt: '2026-04-10T15:00:00.000Z',
      });
      insertTicket(db, {
        key: 'DEV-2',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: null,
        syncedAt: '2026-04-11T15:00:00.000Z',
      });
      insertTicket(db, {
        key: 'DEV-3',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: null,
        syncedAt: '2026-04-12T15:00:00.000Z',
      });

      const result = pv.computeForPerson('Alice', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.dataQuality).toBe('estimated');
      expect(result.completedInWindow).toBe(3);
    });

    it('uses updatedInJira when most Done tickets have it populated', () => {
      // TESTING: Normal data quality — updatedInJira is available
      //
      // SETUP:
      // - 3 Done tickets: all have updatedInJira
      //
      // EXPECTED RESULT: dataQuality = 'accurate'

      for (let i = 1; i <= 3; i++) {
        insertTicket(db, {
          key: `DEV-${i}`,
          assignee: 'Alice',
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
          syncedAt: `2026-04-${String(10 + i).padStart(2, '0')}T15:00:00.000Z`,
        });
      }

      const result = pv.computeForPerson('Alice', 'dev', {
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.dataQuality).toBe('accurate');
    });

    it('uses custom lookback window when specified', () => {
      // TESTING: Custom lookback window overrides default 28 days
      //
      // SETUP:
      // - 1 ticket updated 20 days ago
      // - Custom lookback of 14 days
      //
      // EXPECTED RESULT:
      // - With 14-day lookback, ticket at 20 days is outside window
      // - completedInWindow = 0

      insertTicket(db, {
        key: 'DEV-1',
        assignee: 'Alice',
        status: 'Done',
        statusCategory: 'Done',
        updatedInJira: '2026-03-28T10:00:00.000Z', // ~21 days before Apr 18
      });

      const result = pv.computeForPerson('Alice', 'dev', {
        lookbackDays: 14,
        now: new Date('2026-04-18T12:00:00Z'),
      });

      expect(result.completedInWindow).toBe(0);
    });
  });

  // ── computeAll ────────────────────────────────────────

  describe('computeAll', () => {
    it('returns velocities for all people with activity', () => {
      // TESTING: computeAll discovers all people with tickets
      //
      // SETUP:
      // - Alice: 3 done tickets as assignee
      // - Bob: 2 done tickets as qaAssignee
      // - Carol: 1 in-progress ticket (no done)
      //
      // EXPECTED RESULT:
      // - Map includes Alice (dev velocity > 0), Bob (qa velocity > 0), Carol (null velocities)

      for (let i = 1; i <= 3; i++) {
        insertTicket(db, {
          key: `DEV-${i}`,
          assignee: 'Alice',
          qaAssignee: 'Bob',
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
        });
      }
      insertTicket(db, {
        key: 'DEV-100',
        assignee: 'Carol',
        status: 'In Progress',
        statusCategory: 'In Progress',
        updatedInJira: '2026-04-15T10:00:00.000Z',
      });

      const all = pv.computeAll({ now: new Date('2026-04-18T12:00:00Z') });

      expect(all.has('Alice')).toBe(true);
      expect(all.get('Alice').dev.ticketsPerDay).toBeGreaterThan(0);
      expect(all.get('Alice').dev.completedInWindow).toBe(3);

      expect(all.has('Bob')).toBe(true);
      expect(all.get('Bob').qa.ticketsPerDay).toBeGreaterThan(0);
      expect(all.get('Bob').qa.completedInWindow).toBe(3);

      expect(all.has('Carol')).toBe(true);
      expect(all.get('Carol').dev).toBeNull();
      expect(all.get('Carol').qa).toBeNull();
    });

    it('returns empty map when no tickets exist', () => {
      // TESTING: No tickets → empty map
      //
      // EXPECTED RESULT: empty Map

      const all = pv.computeAll({ now: new Date('2026-04-18T12:00:00Z') });
      expect(all.size).toBe(0);
    });
  });

  // ── getTeamAverages ───────────────────────────────────

  describe('getTeamAverages', () => {
    it('computes team average velocity across all people', () => {
      // TESTING: Team averages reflect per-person average velocity
      //
      // SETUP:
      // - Alice: 4 tickets done (dev)
      // - Bob: 6 tickets done (dev)
      // - 20 business days in window
      // - Average = (4/20 + 6/20) / 2 = (0.2 + 0.3) / 2 = 0.25
      //
      // EXPECTED RESULT: dev avg = 0.25

      for (let i = 1; i <= 4; i++) {
        insertTicket(db, {
          key: `DEV-A${i}`,
          assignee: 'Alice',
          qaAssignee: null,
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
        });
      }
      for (let i = 1; i <= 6; i++) {
        insertTicket(db, {
          key: `DEV-B${i}`,
          assignee: 'Bob',
          qaAssignee: null,
          status: 'Done',
          statusCategory: 'Done',
          updatedInJira: `2026-04-${String(5 + i).padStart(2, '0')}T10:00:00.000Z`,
        });
      }

      const avg = pv.getTeamAverages({ now: new Date('2026-04-18T12:00:00Z') });

      // Total dev tickets = 10, 2 people, 20 business days
      // Average per person = (10/2) / 20 = 0.25
      expect(avg.dev).toBe(0.25);
      expect(avg.dataQuality).toBe('accurate');
    });

    it('returns 0 when no completed tickets exist', () => {
      // TESTING: No data → 0 averages
      //
      // EXPECTED RESULT: dev = 0, qa = 0

      const avg = pv.getTeamAverages({ now: new Date('2026-04-18T12:00:00Z') });
      expect(avg.dev).toBe(0);
      expect(avg.qa).toBe(0);
    });
  });
});
