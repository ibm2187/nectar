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

/**
 * Helper: insert a shipped release into the test database.
 */
function insertShippedRelease(db, { version, repo = 'webplatform', jiraReleaseDate, state = 'done' }) {
  db.prepare(`
    INSERT OR REPLACE INTO releases (key, id, repo, version, state, jiraReleaseDate, jiraReleased, jiraArchived, createdAt, updatedAt,
      tickets, cherryPicks, ci, risk, comments, deployments, approvals)
    VALUES (@key, @id, @repo, @version, @state, @jiraReleaseDate, 1, 0, @createdAt, @updatedAt,
      '[]', '[]', '{}', '{}', '[]', '[]', '[]')
  `).run({
    key: `${repo}:${version}`,
    id: `rel-${version}`,
    repo,
    version,
    state,
    jiraReleaseDate,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('PersonVelocity', () => {
  let db, pv;
  // Fixed "now" for deterministic tests: Monday 2026-04-20
  const now = new Date('2026-04-20T12:00:00Z');

  beforeEach(() => {
    db = createTestDb();
    pv = new PersonVelocity(db);
  });

  describe('computeForPerson', () => {
    it('computes velocity from shipped releases', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-2', assignee: 'Alice', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-3', assignee: 'Alice', fixVersions: '["4.2.1"]' });

      const vel = pv.computeForPerson('Alice', 'dev', { now });
      expect(vel.completedInWindow).toBe(3);
      expect(vel.ticketsPerDay).toBeGreaterThan(0);
      expect(vel.dataQuality).toBe('accurate');
    });

    it('returns 0 velocity for person with no activity', () => {
      const vel = pv.computeForPerson('Nobody', 'dev', { now });
      expect(vel.completedInWindow).toBe(0);
      expect(vel.ticketsPerDay).toBe(0);
    });

    it('excludes Resolved Without Code and Canceled', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', status: 'QA Certified', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-2', assignee: 'Alice', status: 'Resolved Without Code', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-3', assignee: 'Alice', status: 'Canceled', fixVersions: '["4.2.1"]' });

      const vel = pv.computeForPerson('Alice', 'dev', { now });
      expect(vel.completedInWindow).toBe(1); // only QA Certified counts
    });

    it('computes QA velocity using qaAssignee', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-2', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });

      const vel = pv.computeForPerson('Carol', 'qa', { now });
      expect(vel.completedInWindow).toBe(2);
    });

    it('deduplicates tickets across multiple releases', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10' });
      insertShippedRelease(db, { version: '4.2.2', jiraReleaseDate: '2026-04-12' });
      // Same ticket in both releases
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1","4.2.2"]' });

      const vel = pv.computeForPerson('Alice', 'dev', { now });
      expect(vel.completedInWindow).toBe(1); // counted once, not twice
    });

    it('excludes releases outside the lookback window', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-02-01' }); // 2+ months ago
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]' });

      const vel = pv.computeForPerson('Alice', 'dev', { now });
      expect(vel.completedInWindow).toBe(0); // too old
    });

    it('excludes non-shipped releases', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10', state: 'planning' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]' });

      const vel = pv.computeForPerson('Alice', 'dev', { now });
      expect(vel.completedInWindow).toBe(0); // release not shipped
    });

    it('respects custom lookback window', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-18' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]' });

      const vel7 = pv.computeForPerson('Alice', 'dev', { now, lookbackDays: 7 });
      expect(vel7.completedInWindow).toBe(1);

      const vel1 = pv.computeForPerson('Alice', 'dev', { now, lookbackDays: 1 });
      expect(vel1.completedInWindow).toBe(0); // release shipped 2 days ago
    });
  });

  describe('computeAll', () => {
    it('returns velocities for all active people', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-2', assignee: 'Bob', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });

      const all = pv.computeAll({ now });
      expect(all.has('Alice')).toBe(true);
      expect(all.has('Bob')).toBe(true);
      expect(all.has('Carol')).toBe(true);
      expect(all.get('Alice').dev.completedInWindow).toBe(1);
      expect(all.get('Bob').dev.completedInWindow).toBe(1);
      expect(all.get('Carol').qa.completedInWindow).toBe(2);
    });

    it('returns empty map when no shipped releases', () => {
      const all = pv.computeAll({ now });
      expect(all.size).toBe(0);
    });
  });

  describe('getTeamAverages', () => {
    it('computes per-person averages', () => {
      insertShippedRelease(db, { version: '4.2.1', jiraReleaseDate: '2026-04-10' });
      insertTicket(db, { key: 'DEV-1', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-2', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });
      insertTicket(db, { key: 'DEV-3', assignee: 'Bob', qaAssignee: 'Carol', fixVersions: '["4.2.1"]' });

      const avg = pv.getTeamAverages({ now });
      // Alice: 2 tickets, Bob: 1 ticket. 2 dev people. Avg = 3/2/businessDays
      expect(avg.dev).toBeGreaterThan(0);
      expect(avg.qa).toBeGreaterThan(0);
      expect(avg.dataQuality).toBe('accurate');
    });

    it('returns 0 when no data', () => {
      const avg = pv.getTeamAverages({ now });
      expect(avg.dev).toBe(0);
      expect(avg.qa).toBe(0);
    });
  });
});
