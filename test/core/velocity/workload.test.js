import { describe, it, expect, beforeEach } from 'vitest';

const WorkloadBuilder = require('../../../src/core/velocity/workload');
const { createTestDb } = require('../../../src/core/db');

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

describe('WorkloadBuilder', () => {
  let db, wb;

  beforeEach(() => {
    db = createTestDb();
    wb = new WorkloadBuilder(db);
  });

  // ── Basic queue building ─────────────────────────────

  it('builds dev queue for assigned tickets', () => {
    // TESTING: Tickets assigned to a person appear in their dev queue
    //
    // SETUP:
    // - 2 in-progress tickets assigned to Alice in release 4.2.1
    //
    // EXPECTED RESULT:
    // - Alice has 2 tickets in her dev queue

    insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'In Progress', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-2', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'In Review', statusCategory: 'In Progress' });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    expect(result.people.has('Alice')).toBe(true);
    expect(result.people.get('Alice').devQueue).toHaveLength(2);
  });

  it('builds QA queue only for QA-relevant statuses', () => {
    // TESTING: QA queue only includes tickets in QA-relevant states
    //
    // SETUP:
    // - 1 ticket in "Ready For Testing" (QA-relevant) → in QA queue
    // - 1 ticket in "In Progress" (dev state) → NOT in QA queue
    // - Both have qaAssignee = Carol
    //
    // EXPECTED RESULT:
    // - Carol has 1 ticket in QA queue (only the Ready For Testing one)

    insertTicket(db, { key: 'DEV-1', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]', status: 'Ready For Testing', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-2', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]', status: 'In Progress', statusCategory: 'In Progress' });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    expect(result.people.get('Carol').qaQueue).toHaveLength(1);
    expect(result.people.get('Carol').qaQueue[0].key).toBe('DEV-1');
  });

  it('excludes Done tickets from queues', () => {
    // TESTING: Done tickets should not appear in any queue
    //
    // SETUP:
    // - 1 Done ticket and 1 In Progress ticket
    //
    // EXPECTED RESULT:
    // - Only the In Progress ticket appears in the dev queue

    insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'Done', statusCategory: 'Done' });
    insertTicket(db, { key: 'DEV-2', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'In Progress', statusCategory: 'In Progress' });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    expect(result.people.get('Alice').devQueue).toHaveLength(1);
    expect(result.people.get('Alice').devQueue[0].key).toBe('DEV-2');
  });

  // ── Queue ordering ───────────────────────────────────

  it('orders queue by release urgency (earliest deadline first)', () => {
    // TESTING: Tickets from earlier releases should come first in the queue
    //
    // SETUP:
    // - Ticket in release 4.2.0 (deadline May 1)
    // - Ticket in release 4.3.0 (deadline June 1)
    // - Both assigned to Alice, same status
    //
    // EXPECTED RESULT:
    // - 4.2.0 ticket comes before 4.3.0 ticket in the queue

    insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.3.0"]', status: 'In Progress', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-2', assignee: 'Alice', fixVersions: '["4.2.0"]', status: 'In Progress', statusCategory: 'In Progress' });

    const result = wb.buildQueues([
      { version: '4.2.0', jiraReleaseDate: '2026-05-01' },
      { version: '4.3.0', jiraReleaseDate: '2026-06-01' },
    ]);

    const devQueue = result.people.get('Alice').devQueue;
    expect(devQueue).toHaveLength(2);
    // Since urgency is set via _queryTicketsForVersions, let's verify by version
    // The one with earlier deadline should come first
    const versions = devQueue.map(t => t._releaseVersions[0]);
    expect(versions[0]).toBe('4.2.0');
    expect(versions[1]).toBe('4.3.0');
  });

  it('orders queue by state proximity within same release', () => {
    // TESTING: Tickets closer to done should come first in the queue
    //
    // SETUP:
    // - All tickets in the same release
    // - Statuses: In Testing (in-qa=1), Ready For Testing (ready-for-qa=2), In Progress (in-dev=4), To Do (not-started=5)
    //
    // EXPECTED RESULT:
    // - Queue ordered: In Testing, Ready For Testing, In Progress, To Do

    insertTicket(db, { key: 'DEV-1', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'To Do', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-2', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'In Testing', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-3', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'In Progress', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-4', assignee: 'Alice', fixVersions: '["4.2.1"]', status: 'Ready For Testing', statusCategory: 'In Progress' });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    const devQueue = result.people.get('Alice').devQueue;
    expect(devQueue).toHaveLength(4);
    expect(devQueue[0].status).toBe('In Testing');
    expect(devQueue[1].status).toBe('Ready For Testing');
    expect(devQueue[2].status).toBe('In Progress');
    expect(devQueue[3].status).toBe('To Do');
  });

  // ── Deduplication ────────────────────────────────────

  it('deduplicates tickets that appear in multiple releases', () => {
    // TESTING: A ticket in fixVersions for both releases should appear only once
    //
    // SETUP:
    // - DEV-1 has fixVersions ["4.2.0", "4.3.0"]
    // - Both releases are active
    //
    // EXPECTED RESULT:
    // - Alice's dev queue has 1 ticket (not 2)
    // - The ticket's _releaseVersions includes both versions

    insertTicket(db, {
      key: 'DEV-1',
      assignee: 'Alice',
      fixVersions: '["4.2.0", "4.3.0"]',
      status: 'In Progress',
      statusCategory: 'In Progress',
    });

    const result = wb.buildQueues([
      { version: '4.2.0', jiraReleaseDate: '2026-05-01' },
      { version: '4.3.0', jiraReleaseDate: '2026-06-01' },
    ]);

    const devQueue = result.people.get('Alice').devQueue;
    expect(devQueue).toHaveLength(1);
    expect(devQueue[0]._releaseVersions).toContain('4.2.0');
    expect(devQueue[0]._releaseVersions).toContain('4.3.0');
  });

  it('uses earliest deadline for tickets in multiple releases', () => {
    // TESTING: Ticket in multiple releases gets urgency from earliest deadline
    //
    // SETUP:
    // - DEV-1 in both 4.2.0 (May 1) and 4.3.0 (June 1)
    // - DEV-2 in only 4.3.0 (June 1)
    //
    // EXPECTED RESULT:
    // - DEV-1 (urgency May 1) sorts before DEV-2 (urgency June 1)

    insertTicket(db, {
      key: 'DEV-1',
      assignee: 'Alice',
      fixVersions: '["4.2.0", "4.3.0"]',
      status: 'In Progress',
      statusCategory: 'In Progress',
    });
    insertTicket(db, {
      key: 'DEV-2',
      assignee: 'Alice',
      fixVersions: '["4.3.0"]',
      status: 'In Progress',
      statusCategory: 'In Progress',
    });

    const result = wb.buildQueues([
      { version: '4.2.0', jiraReleaseDate: '2026-05-01' },
      { version: '4.3.0', jiraReleaseDate: '2026-06-01' },
    ]);

    const devQueue = result.people.get('Alice').devQueue;
    expect(devQueue).toHaveLength(2);
    // DEV-1 should come first (earlier urgency from 4.2.0)
    expect(devQueue[0].key).toBe('DEV-1');
    expect(devQueue[1].key).toBe('DEV-2');
  });

  // ── Unassigned tickets ───────────────────────────────

  it('collects unassigned tickets (no assignee)', () => {
    // TESTING: Tickets without a dev assignee should be in the unassigned list
    //
    // SETUP:
    // - DEV-1: no assignee
    // - DEV-2: has assignee
    //
    // EXPECTED RESULT:
    // - unassigned list contains DEV-1 with missingDev=true

    insertTicket(db, { key: 'DEV-1', assignee: null, qaAssignee: 'Carol', fixVersions: '["4.2.1"]', status: 'To Do', statusCategory: 'In Progress' });
    insertTicket(db, { key: 'DEV-2', assignee: 'Alice', qaAssignee: 'Carol', fixVersions: '["4.2.1"]', status: 'In Progress', statusCategory: 'In Progress' });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    const unassigned = result.unassigned;
    const devMissing = unassigned.filter(t => t.missingDev);
    expect(devMissing).toHaveLength(1);
    expect(devMissing[0].key).toBe('DEV-1');
  });

  it('collects tickets with no QA assignee', () => {
    // TESTING: Tickets without a QA assignee should be in the unassigned list
    //
    // SETUP:
    // - DEV-1: has assignee, no qaAssignee
    //
    // EXPECTED RESULT:
    // - unassigned list contains DEV-1 with missingQa=true

    insertTicket(db, { key: 'DEV-1', assignee: 'Alice', qaAssignee: null, fixVersions: '["4.2.1"]', status: 'In Progress', statusCategory: 'In Progress' });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    const unassigned = result.unassigned;
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].missingQa).toBe(true);
  });

  // ── Edge cases ───────────────────────────────────────

  it('returns empty queues for empty releases', () => {
    // TESTING: No tickets in releases → empty result
    //
    // EXPECTED RESULT:
    // - people map is empty, unassigned is empty

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    expect(result.people.size).toBe(0);
    expect(result.unassigned).toHaveLength(0);
  });

  it('returns empty queues when no releases provided', () => {
    // TESTING: No active releases → empty result
    //
    // EXPECTED RESULT:
    // - people map is empty, unassigned is empty

    const result = wb.buildQueues([]);

    expect(result.people.size).toBe(0);
    expect(result.unassigned).toHaveLength(0);
  });

  it('handles null releases gracefully', () => {
    // TESTING: Null releases input → empty result without crash
    //
    // EXPECTED RESULT: no crash, empty result

    const result = wb.buildQueues(null);

    expect(result.people.size).toBe(0);
    expect(result.unassigned).toHaveLength(0);
  });

  it('handles tickets found via targetFixVersions', () => {
    // TESTING: Tickets should be found via targetFixVersions as well as fixVersions
    //
    // SETUP:
    // - DEV-1 has fixVersions=[], targetFixVersions=["4.2.1"]
    //
    // EXPECTED RESULT:
    // - DEV-1 appears in Alice's dev queue

    insertTicket(db, {
      key: 'DEV-1',
      assignee: 'Alice',
      fixVersions: '[]',
      targetFixVersions: '["4.2.1"]',
      status: 'In Progress',
      statusCategory: 'In Progress',
    });

    const result = wb.buildQueues([{ version: '4.2.1', jiraReleaseDate: '2026-05-01' }]);

    expect(result.people.get('Alice').devQueue).toHaveLength(1);
  });
});
