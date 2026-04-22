/**
 * Jira status categories — the authoritative done/not-done signal.
 *
 * Every Jira status rolls up into exactly one of these three categories.
 * Prefer `isDone(ticket)` (or the category constants) over hand-rolled
 * status-name lists: the name list drifts as Jira workflows evolve, the
 * category stays stable.
 *
 * See: https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-statuses-priorities-and-resolutions/
 */

const STATUS_CATEGORIES = Object.freeze({
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  DONE: 'Done',
});

/**
 * Fine-grained status-name buckets. Mirrors client/src/lib/status-colors.ts.
 *
 * These are NOT the authoritative done-check (use `isDone` for that — it
 * reads `statusCategory`, which Jira maintains centrally). The name lists
 * here are useful for richer bucketing (in-dev vs in-qa vs blocked) and
 * as a fallback list for callers that have a status name but no category.
 *
 * Adding a new Jira status? Add it to the matching bucket AND make sure
 * the client mirror is updated.
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

const DONE_STATUSES = new Set(STATUS_GROUPS['done']);
const NOT_DONE_STATUSES = new Set([
  ...STATUS_GROUPS['in-dev'],
  ...STATUS_GROUPS['blocked'],
  ...STATUS_GROUPS['ready-for-qa'],
  ...STATUS_GROUPS['in-qa'],
]);

/**
 * True iff the ticket is in Jira's "Done" category.
 *
 * Contract: the ticket MUST carry a populated `statusCategory` field.
 * Internal tickets should flow through `ReleaseManager.getTickets()` or the
 * `TicketStore` read path — both populate it from the `jira_tickets` table.
 * There is no status-name fallback here, deliberately: fallbacks drift.
 *
 * @param {{statusCategory?: string}|null|undefined} ticket
 * @returns {boolean}
 */
function isDone(ticket) {
  return !!ticket && ticket.statusCategory === STATUS_CATEGORIES.DONE;
}

module.exports = {
  STATUS_CATEGORIES,
  STATUS_GROUPS,
  DONE_STATUSES,
  NOT_DONE_STATUSES,
  isDone,
};
