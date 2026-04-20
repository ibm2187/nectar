const { getDb } = require('../db');

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
 * Compute per-person historical throughput separated by role (dev vs QA).
 *
 * Queries the jira_tickets table directly for performance — does not
 * depend on TicketStore.
 */
class PersonVelocity {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db || getDb();
  }

  /**
   * Count business days (Mon–Fri) between two ISO date strings (inclusive of start, exclusive of end).
   * @param {string} startDate - ISO date (YYYY-MM-DD)
   * @param {string} endDate   - ISO date (YYYY-MM-DD)
   * @returns {number}
   */
  _countBusinessDays(startDate, endDate) {
    let count = 0;
    const end = new Date(endDate + 'T00:00:00Z');
    const cursor = new Date(startDate + 'T00:00:00Z');
    while (cursor < end) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) count++;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
  }

  /**
   * Compute the lookback window dates.
   * @param {object} opts
   * @param {number} [opts.lookbackDays] - Calendar days to look back
   * @param {Date}   [opts.now]          - Override current date (for testing)
   * @returns {{ windowStart: string, windowEnd: string, businessDays: number }}
   */
  _getWindow(opts = {}) {
    const lookbackDays = opts.lookbackDays || DEFAULT_LOOKBACK_DAYS;
    const now = opts.now || new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const start = new Date(now);
    start.setDate(start.getDate() - lookbackDays);
    const windowStart = start.toISOString().slice(0, 10);

    const businessDays = this._countBusinessDays(windowStart, todayStr);

    return { windowStart, windowEnd: todayStr, businessDays };
  }

  /**
   * Check whether we should fall back to syncedAt because updatedInJira
   * is empty for >50% of Done tickets.
   * @returns {{ useSyncedAt: boolean }}
   */
  _checkDataQuality() {
    const totalDone = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets WHERE statusCategory = 'Done'
    `).get().n;

    if (totalDone === 0) return { useSyncedAt: false };

    const withUpdated = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets
      WHERE statusCategory = 'Done' AND updatedInJira IS NOT NULL AND updatedInJira != ''
    `).get().n;

    return { useSyncedAt: withUpdated < totalDone * 0.5 };
  }

  /**
   * Compute velocity for a single person in a role.
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
    const { useSyncedAt } = this._checkDataQuality();

    const dateColumn = useSyncedAt ? 'syncedAt' : 'updatedInJira';
    const personColumn = role === 'qa' ? 'qaAssignee' : 'assignee';

    // Build the exclusion list for status
    const excludePlaceholders = EXCLUDED_DONE_STATUSES.map(() => '?').join(',');

    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets
      WHERE ${personColumn} = ?
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
    `).get(
      name,
      ...EXCLUDED_DONE_STATUSES,
      windowStart,
      windowEnd + 'T23:59:59',
    );

    const completedInWindow = row?.n || 0;
    const ticketsPerDay = businessDays > 0 ? completedInWindow / businessDays : 0;

    return {
      ticketsPerDay: Math.round(ticketsPerDay * 1000) / 1000,
      completedInWindow,
      businessDays,
      window: { start: windowStart, end: windowEnd },
      dataQuality: useSyncedAt ? 'estimated' : 'accurate',
    };
  }

  /**
   * Compute velocities for all active people (anyone with a Done ticket in the window).
   *
   * @param {object} [opts]
   * @param {number} [opts.lookbackDays] - Calendar days to look back (default 28)
   * @param {Date}   [opts.now]          - Override current date (for testing)
   * @returns {Map<string, { dev: object|null, qa: object|null }>}
   */
  computeAll(opts = {}) {
    const { windowStart, windowEnd, businessDays } = this._getWindow(opts);
    const { useSyncedAt } = this._checkDataQuality();
    const dateColumn = useSyncedAt ? 'syncedAt' : 'updatedInJira';

    const excludePlaceholders = EXCLUDED_DONE_STATUSES.map(() => '?').join(',');

    // Gather all people who have any dev or QA activity
    const devRows = this.db.prepare(`
      SELECT assignee AS name, COUNT(*) AS n FROM jira_tickets
      WHERE assignee IS NOT NULL AND assignee != ''
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
      GROUP BY assignee
    `).all(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd + 'T23:59:59');

    const qaRows = this.db.prepare(`
      SELECT qaAssignee AS name, COUNT(*) AS n FROM jira_tickets
      WHERE qaAssignee IS NOT NULL AND qaAssignee != ''
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
      GROUP BY qaAssignee
    `).all(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd + 'T23:59:59');

    // Also include people who have open (non-Done) tickets assigned
    const activeDev = this.db.prepare(`
      SELECT DISTINCT assignee AS name FROM jira_tickets
      WHERE assignee IS NOT NULL AND assignee != ''
        AND statusCategory != 'Done'
    `).all();

    const activeQa = this.db.prepare(`
      SELECT DISTINCT qaAssignee AS name FROM jira_tickets
      WHERE qaAssignee IS NOT NULL AND qaAssignee != ''
        AND statusCategory != 'Done'
    `).all();

    const people = new Map();

    // Initialize all known people
    const allNames = new Set();
    for (const r of [...devRows, ...qaRows, ...activeDev, ...activeQa]) {
      if (r.name) allNames.add(r.name);
    }

    const devMap = new Map(devRows.map(r => [r.name, r.n]));
    const qaMap = new Map(qaRows.map(r => [r.name, r.n]));

    const dataQuality = useSyncedAt ? 'estimated' : 'accurate';

    for (const name of allNames) {
      const devCompleted = devMap.get(name) || 0;
      const qaCompleted = qaMap.get(name) || 0;

      people.set(name, {
        dev: devCompleted > 0 ? {
          ticketsPerDay: Math.round((devCompleted / businessDays) * 1000) / 1000,
          completedInWindow: devCompleted,
          businessDays,
          window: { start: windowStart, end: windowEnd },
          dataQuality,
        } : null,
        qa: qaCompleted > 0 ? {
          ticketsPerDay: Math.round((qaCompleted / businessDays) * 1000) / 1000,
          completedInWindow: qaCompleted,
          businessDays,
          window: { start: windowStart, end: windowEnd },
          dataQuality,
        } : null,
      });
    }

    return people;
  }

  /**
   * Team-wide average velocity for fallback when a person has no history.
   *
   * @param {object} [opts]
   * @param {number} [opts.lookbackDays] - Calendar days to look back (default 28)
   * @param {Date}   [opts.now]          - Override current date (for testing)
   * @returns {{ dev: number, qa: number, dataQuality: string }}
   */
  getTeamAverages(opts = {}) {
    const { windowStart, windowEnd, businessDays } = this._getWindow(opts);
    const { useSyncedAt } = this._checkDataQuality();
    const dateColumn = useSyncedAt ? 'syncedAt' : 'updatedInJira';

    const excludePlaceholders = EXCLUDED_DONE_STATUSES.map(() => '?').join(',');

    // Count unique dev completions
    const devRow = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets
      WHERE assignee IS NOT NULL AND assignee != ''
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd + 'T23:59:59');

    // Count unique people who completed dev work
    const devPeopleRow = this.db.prepare(`
      SELECT COUNT(DISTINCT assignee) AS n FROM jira_tickets
      WHERE assignee IS NOT NULL AND assignee != ''
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd + 'T23:59:59');

    // Count unique QA completions
    const qaRow = this.db.prepare(`
      SELECT COUNT(*) AS n FROM jira_tickets
      WHERE qaAssignee IS NOT NULL AND qaAssignee != ''
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd + 'T23:59:59');

    const qaPeopleRow = this.db.prepare(`
      SELECT COUNT(DISTINCT qaAssignee) AS n FROM jira_tickets
      WHERE qaAssignee IS NOT NULL AND qaAssignee != ''
        AND statusCategory = 'Done'
        AND status NOT IN (${excludePlaceholders})
        AND ${dateColumn} >= ?
        AND ${dateColumn} <= ?
    `).get(...EXCLUDED_DONE_STATUSES, windowStart, windowEnd + 'T23:59:59');

    const totalDev = devRow?.n || 0;
    const totalQa = qaRow?.n || 0;
    const devPeople = devPeopleRow?.n || 1;
    const qaPeople = qaPeopleRow?.n || 1;

    // Average = total completed / people / business days
    const devAvg = businessDays > 0 ? (totalDev / devPeople) / businessDays : 0;
    const qaAvg = businessDays > 0 ? (totalQa / qaPeople) / businessDays : 0;

    return {
      dev: Math.round(devAvg * 1000) / 1000,
      qa: Math.round(qaAvg * 1000) / 1000,
      dataQuality: useSyncedAt ? 'estimated' : 'accurate',
    };
  }
}

module.exports = PersonVelocity;
module.exports.REAL_DONE_STATUSES = REAL_DONE_STATUSES;
module.exports.EXCLUDED_DONE_STATUSES = EXCLUDED_DONE_STATUSES;
module.exports.DEFAULT_LOOKBACK_DAYS = DEFAULT_LOOKBACK_DAYS;
