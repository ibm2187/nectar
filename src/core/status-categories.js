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
 * Jira status names that roll up to the "Done" category. Kept as a Set for
 * callers that only have a status name and cannot rely on `statusCategory`
 * being populated. Prefer `isDone(ticket)` whenever the ticket is available.
 *
 * Mirrors the `done` bucket in ticket-store.js `STATUS_GROUPS`. Keep the two
 * lists in sync — if a new "Done" status is added in Jira, update both.
 */
const DONE_STATUSES = new Set([
  'QA Certified', 'NO QA - Certified', 'Done', 'Closed', 'Resolved', 'Resolved Without Code',
  'Completed', 'Released', 'Rollout', 'Approved', 'DQA Approved',
  'Test Passed', 'TEST DEFERRED', 'Design Complete', 'Integration Complete',
  'Release Night Activity', 'Canceled', 'Declined', 'Rejected',
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

module.exports = { STATUS_CATEGORIES, DONE_STATUSES, isDone };
