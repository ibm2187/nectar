const { getDb } = require('../db');
const { STATUS_CATEGORIES } = require('../status-categories');

/**
 * Status groups — copied from ticket-store.js for module independence.
 */
const STATUS_GROUPS = {
  'in-dev': [
    'Development In Progress', 'In Progress', 'In Review', 'Development',
    'Waiting for Cherry Pick', 'Design In Progress', 'Design In Review', 'Design Review',
    'Implementing', 'Remediation in Progress', 'Defect Remediation in Progress',
    'Pending Dev Investigation', 'Pending Defect Remediation', 'Pending Configuration',
    'Pending Prioritization', 'Investigating Issue', 'Escalated',
    'Open', 'To Do', 'Backlog', 'Planning', 'Requirements', 'Needs Requirements',
    'Ready to Develop', 'Ready For Estimation', 'Reopened', 'Pending',
    'On Hold', 'Deprioritized', 'Future Development', 'Future Remediation',
  ],
  'blocked': ['Blocked', 'Testing Failed', 'Test Failed', 'Pending Bug Fix'],
  'ready-for-qa': ['Ready For Testing', 'Cherry Picked', 'Cherrypick is Building', 'Retest After Cherrypick', 'DQA Required'],
  'in-qa': ['In Testing', 'Testing in Branch', 'Testing', 'Re-verify Bug', 'Validating', 'Pending Customer QA/UAT'],
  'done': [
    'QA Certified', 'NO QA - Certified', 'Done', 'Closed', 'Resolved', 'Resolved Without Code',
    'Completed', 'Released', 'Rollout', 'Approved', 'DQA Approved',
    'Test Passed', 'TEST DEFERRED', 'Design Complete', 'Integration Complete',
    'Release Night Activity', 'Canceled', 'Declined', 'Rejected',
  ],
};

const DONE_SET = new Set(STATUS_GROUPS['done']);
const IN_QA_SET = new Set(STATUS_GROUPS['in-qa']);
const READY_FOR_QA_SET = new Set(STATUS_GROUPS['ready-for-qa']);
const BLOCKED_SET = new Set(STATUS_GROUPS['blocked']);
const IN_DEV_SET = new Set(STATUS_GROUPS['in-dev']);

/**
 * State proximity — lower = closer to done, higher priority in queue.
 */
const STATE_PROXIMITY = {
  'in-qa': 1,
  'ready-for-qa': 2,
  'blocked': 3,
  'in-dev': 4,
  'not-started': 5,
};

/**
 * Customer priority ordering — lower = more urgent.
 */
const CUSTOMER_PRIORITY_ORDER = {
  'URGENT': 1,
  'Urgent': 1,
  'High': 2,
  'Medium': 3,
  'Low': 4,
};

/**
 * Not-started statuses (subset of in-dev that haven't been worked on).
 */
const NOT_STARTED_STATUSES = new Set([
  'Open', 'To Do', 'Backlog', 'Planning', 'Requirements',
  'Needs Requirements', 'Ready to Develop', 'Ready For Estimation', 'Pending',
]);

/**
 * QA-relevant statuses — tickets that belong in a QA queue.
 */
const QA_QUEUE_STATUSES = new Set([
  ...STATUS_GROUPS['ready-for-qa'],
  ...STATUS_GROUPS['in-qa'],
]);

/**
 * Map a JIRA status to a state proximity value.
 */
function getStateProximity(status) {
  if (IN_QA_SET.has(status)) return STATE_PROXIMITY['in-qa'];
  if (READY_FOR_QA_SET.has(status)) return STATE_PROXIMITY['ready-for-qa'];
  if (BLOCKED_SET.has(status)) return STATE_PROXIMITY['blocked'];
  if (NOT_STARTED_STATUSES.has(status)) return STATE_PROXIMITY['not-started'];
  if (IN_DEV_SET.has(status)) return STATE_PROXIMITY['in-dev'];
  return STATE_PROXIMITY['not-started'];
}

/**
 * Builds ordered work queues per person from active releases.
 *
 * Queries jira_tickets directly for performance.
 */
class WorkloadBuilder {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db || getDb();
  }

  /**
   * Build work queues for all people across active releases.
   *
   * @param {Array<{ version: string, repo?: string, jiraReleaseDate?: string, state?: string }>} activeReleases
   * @returns {{ people: Map<string, { devQueue: object[], qaQueue: object[] }>, unassigned: object[] }}
   */
  buildQueues(activeReleases) {
    if (!activeReleases || activeReleases.length === 0) {
      return { people: new Map(), unassigned: [] };
    }

    // Build a version → deadline map
    const versionDeadlines = new Map();
    for (const rel of activeReleases) {
      versionDeadlines.set(rel.version, rel.jiraReleaseDate || '9999-12-31');
    }

    const versions = activeReleases.map(r => r.version);

    // Query all non-Done tickets in active releases
    // Tickets belong to releases via fixVersions or targetFixVersions JSON arrays
    const allTickets = this._queryTicketsForVersions(versions, versionDeadlines);

    // Deduplicate tickets by key — same ticket in multiple releases counted once
    const ticketMap = new Map(); // key → enriched ticket
    for (const t of allTickets) {
      if (DONE_SET.has(t.status)) continue;

      if (ticketMap.has(t.key)) {
        // Already seen — merge release info (use earliest deadline)
        const existing = ticketMap.get(t.key);
        for (const v of t._releaseVersions) {
          if (!existing._releaseVersions.includes(v)) {
            existing._releaseVersions.push(v);
          }
        }
        // Update urgency to earliest deadline
        const existingDeadline = existing._urgency;
        const newDeadline = t._urgency;
        if (newDeadline < existingDeadline) {
          existing._urgency = newDeadline;
        }
      } else {
        ticketMap.set(t.key, t);
      }
    }

    // Build per-person queues
    const people = new Map(); // name → { devQueue: [], qaQueue: [] }
    const unassigned = [];

    for (const ticket of ticketMap.values()) {
      let hasDevAssignee = false;
      let hasQaAssignee = false;

      // Dev queue: tickets assigned to this person, not Done
      if (ticket.assignee) {
        hasDevAssignee = true;
        if (!people.has(ticket.assignee)) {
          people.set(ticket.assignee, { devQueue: [], qaQueue: [] });
        }
        people.get(ticket.assignee).devQueue.push(ticket);
      }

      // QA queue: tickets where person is qaAssignee AND status is QA-relevant
      if (ticket.qaAssignee) {
        hasQaAssignee = true;
        if (!people.has(ticket.qaAssignee)) {
          people.set(ticket.qaAssignee, { devQueue: [], qaQueue: [] });
        }
        if (QA_QUEUE_STATUSES.has(ticket.status)) {
          people.get(ticket.qaAssignee).qaQueue.push(ticket);
        }
      }

      // Track unassigned
      if (!hasDevAssignee || !hasQaAssignee) {
        unassigned.push({
          ...ticket,
          missingDev: !hasDevAssignee,
          missingQa: !hasQaAssignee,
        });
      }
    }

    // Sort each person's queues
    for (const queues of people.values()) {
      this._sortQueue(queues.devQueue);
      this._sortQueue(queues.qaQueue);
    }

    return { people, unassigned };
  }

  /**
   * Query tickets from the database that belong to any of the given versions.
   * Uses the fixVersions and targetFixVersions JSON arrays.
   *
   * @param {string[]} versions
   * @returns {object[]}
   */
  _queryTicketsForVersions(versions, versionDeadlines) {
    if (versions.length === 0) return [];

    const results = [];

    for (const version of versions) {
      const pattern = `%"${version}"%`;
      const rows = this.db.prepare(`
        SELECT key, summary, status, statusCategory, state, type,
               assignee, qaAssignee, priority, customerPriority,
               fixVersions, targetFixVersions, customerTags
        FROM jira_tickets
        WHERE (fixVersions LIKE ? OR targetFixVersions LIKE ?)
          AND statusCategory != '${STATUS_CATEGORIES.DONE}'
      `).all(pattern, pattern);

      for (const row of rows) {
        // Parse JSON fields
        let fixVersions = [];
        let targetFixVersions = [];
        let customerTags = [];
        try { fixVersions = JSON.parse(row.fixVersions || '[]'); } catch { /* ok */ }
        try { targetFixVersions = JSON.parse(row.targetFixVersions || '[]'); } catch { /* ok */ }
        try { customerTags = JSON.parse(row.customerTags || '[]'); } catch { /* ok */ }

        results.push({
          key: row.key,
          summary: row.summary,
          status: row.status,
          statusCategory: row.statusCategory,
          state: row.state,
          type: row.type,
          assignee: row.assignee,
          qaAssignee: row.qaAssignee,
          priority: row.priority,
          customerPriority: row.customerPriority,
          fixVersions,
          targetFixVersions,
          customerTags,
          _releaseVersions: [version],
          _urgency: (versionDeadlines && versionDeadlines.get(version)) || '9999-12-31',
          _stateProximity: getStateProximity(row.status),
        });
      }
    }

    // Set urgency based on earliest release deadline
    // (This is done by the caller via dedup, but we set a default here)
    return results;
  }

  /**
   * Sort a queue by: release urgency ASC, state proximity ASC, customer priority ASC.
   * @param {object[]} queue
   */
  _sortQueue(queue) {
    queue.sort((a, b) => {
      // 1. Release urgency (earliest deadline first)
      if (a._urgency !== b._urgency) return a._urgency.localeCompare(b._urgency);
      // 2. State proximity (closer to done = lower number = first)
      if (a._stateProximity !== b._stateProximity) return a._stateProximity - b._stateProximity;
      // 3. Customer priority (URGENT first)
      const aPri = CUSTOMER_PRIORITY_ORDER[a.customerPriority] || 99;
      const bPri = CUSTOMER_PRIORITY_ORDER[b.customerPriority] || 99;
      return aPri - bPri;
    });
  }
}

module.exports = WorkloadBuilder;
module.exports.STATUS_GROUPS = STATUS_GROUPS;
module.exports.QA_QUEUE_STATUSES = QA_QUEUE_STATUSES;
module.exports.getStateProximity = getStateProximity;
