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

function isDone(ticket) {
  return !!ticket && ticket.statusCategory === STATUS_CATEGORIES.DONE;
}

module.exports = { STATUS_CATEGORIES, isDone };
