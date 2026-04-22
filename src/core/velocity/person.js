const { getDb } = require('../db');
const { STATUS_CATEGORIES } = require('../status-categories');

/**
 * Statuses that represent "real done" — ticket was actually completed.
 * Excludes pseudo-done statuses like Resolved Without Code, Canceled, etc.
 */
const REAL_DONE_STATUSES = [
  'QA Certified', 'NO QA - Certified', 'Test Passed', 'Done',
  'Released', 'Rollout', 'Completed', 'Approved', 'DQA Approved',
  'Design Complete', 'Integration Complete',
];

const EXCLUDED_DONE_STATUSES = [
  'Resolved Without Code', 'Canceled', 'Duplicate', 'Declined',
  'Rejected', 'TEST DEFERRED',
];

const DEFAULT_LOOKBACK_DAYS = 28;

/**
 * Computes per-person historical throughput separated by role (dev vs QA).
 *
 * Uses SHIPPED RELEASES as the ground truth for velocity:
 * - Find all releases shipped (state='done', jiraReleaseDate set) in the lookback window
 * - Count distinct Done tickets across those releases per person
 * - Deduplicate: a ticket in multiple releases counts once
 * - Divide by business days in the window
 */
class PersonVelocity {
  constructor(db) {
    this.db = db || getDb();
  }

  /**
   * Compute the lookback window in calendar and business days.
   */
  _getWindow(opts = {}) {
    const lookbackDays = opts.lookbackDays || DEFAULT_LOOKBACK_DAYS;
    const now = opts.now || new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const windowStartDate = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const windowStart = windowStartDate.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    // Count business days (Mon-Fri) in the window
    let businessDays = 0;
    const cursor = new Date(windowStartDate);
    while (cursor <= today) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) businessDays++;
      cursor.setDate(cursor.getDate() + 1);
    }

    return { windowStart, windowEnd: todayStr, businessDays };
  }

  /**
   * Compute velocity for a single person in a role.
   *
   * Uses shipped releases to determine which tickets were completed in the window.
   * Deduplicates: a ticket in multiple releases counts once.
   *
   * @param {string} name - Person name (as stored in assignee or qaAssignee)
   * @param {'dev'|'qa'} role - Which role to compute velocity for
   * @param {object} [opts]
   * @param {number} [opts.lookbackDays] - Calendar days to look back (default 28)
   * @param {Date}   [opts.now]          - Override current date (for testing)
   * @returns {{ ticketsPerDay: number, completedInWindow: number, businessDays: number, window: { start: string, end: string }, dataQuality: string }}
   */
  computeForPerson(name, role, opts = {}) {
    const { windowStart, windowEnd, businessDays } = this._getWindow(opts);
    const personColumn = role === 'qa' ? 'qaAssignee' : 'assignee';
    const excludePlaceholders = EXCLUDED_DONE_STATUSES.map(() => '?').join(',');

    // Count DISTINCT tickets completed by this person in shipped releases within the window
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      WHERE jt.${personColumn} = ?
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
    `).get(
      name,
      ...EXCLUDED_DONE_STATUSES,
      windowStart,
      windowEnd,
    );

    const completedInWindow = row?.n || 0;
    const ticketsPerDay = businessDays > 0 ? completedInWindow / businessDays : 0;

    return {
      ticketsPerDay: Math.round(ticketsPerDay * 1000) / 1000,
      completedInWindow,
      businessDays,
      window: { start: windowStart, end: windowEnd },
      dataQuality: 'accurate',
    };
  }

  /**
   * Compute velocities for all active people.
   * Returns Map<name, { dev: velocityObj|null, qa: velocityObj|null }>
   */
  computeAll(opts = {}) {
    const { windowStart, windowEnd, businessDays } = this._getWindow(opts);
    const excludePlaceholders = EXCLUDED_DONE_STATUSES.map(() => '?').join(',');

    const result = new Map();

    // Dev velocity: count distinct tickets per assignee in shipped releases
    const devRows = this.db.prepare(`
      SELECT jt.assignee AS name, COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      WHERE jt.assignee IS NOT NULL
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
      GROUP BY jt.assignee
    `).all(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd);

    for (const row of devRows) {
      if (!result.has(row.name)) result.set(row.name, { dev: null, qa: null });
      result.get(row.name).dev = {
        ticketsPerDay: businessDays > 0 ? Math.round((row.n / businessDays) * 1000) / 1000 : 0,
        completedInWindow: row.n,
        businessDays,
        window: { start: windowStart, end: windowEnd },
        dataQuality: 'accurate',
      };
    }

    // QA velocity: count distinct tickets per qaAssignee in shipped releases
    const qaRows = this.db.prepare(`
      SELECT jt.qaAssignee AS name, COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      WHERE jt.qaAssignee IS NOT NULL
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
      GROUP BY jt.qaAssignee
    `).all(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd);

    for (const row of qaRows) {
      if (!result.has(row.name)) result.set(row.name, { dev: null, qa: null });
      result.get(row.name).qa = {
        ticketsPerDay: businessDays > 0 ? Math.round((row.n / businessDays) * 1000) / 1000 : 0,
        completedInWindow: row.n,
        businessDays,
        window: { start: windowStart, end: windowEnd },
        dataQuality: 'accurate',
      };
    }

    return result;
  }

  /**
   * Team-wide average velocity for fallback when a person has no history.
   * Computed as total unique tickets / business days / active people.
   *
   * @returns {{ dev: number, qa: number, dataQuality: string }}
   */
  getTeamAverages(opts = {}) {
    const { windowStart, windowEnd, businessDays } = this._getWindow(opts);
    const excludePlaceholders = EXCLUDED_DONE_STATUSES.map(() => '?').join(',');

    // Total unique Done tickets in shipped releases (dev)
    const devTotal = this.db.prepare(`
      SELECT COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      WHERE jt.assignee IS NOT NULL
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd);

    const devPeople = this.db.prepare(`
      SELECT COUNT(DISTINCT jt.assignee) AS n FROM jira_tickets jt
      WHERE jt.assignee IS NOT NULL
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd);

    // QA totals
    const qaTotal = this.db.prepare(`
      SELECT COUNT(DISTINCT jt.key) AS n FROM jira_tickets jt
      WHERE jt.qaAssignee IS NOT NULL
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd);

    const qaPeople = this.db.prepare(`
      SELECT COUNT(DISTINCT jt.qaAssignee) AS n FROM jira_tickets jt
      WHERE jt.qaAssignee IS NOT NULL
        AND jt.statusCategory = '${STATUS_CATEGORIES.DONE}'
        AND jt.status NOT IN (${excludePlaceholders})
        AND EXISTS (
          SELECT 1 FROM json_each(jt.fixVersions) fv
          JOIN releases r ON r.version = fv.value
          WHERE r.state = 'done' AND r.jiraReleaseDate >= ? AND r.jiraReleaseDate <= ?
        )
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd);

    const devAvg = (devPeople?.n > 0 && businessDays > 0)
      ? (devTotal.n / devPeople.n / businessDays) : 0;
    const qaAvg = (qaPeople?.n > 0 && businessDays > 0)
      ? (qaTotal.n / qaPeople.n / businessDays) : 0;

    return {
      dev: Math.round(devAvg * 1000) / 1000,
      qa: Math.round(qaAvg * 1000) / 1000,
      dataQuality: 'accurate',
    };
  }
}

module.exports = PersonVelocity;
