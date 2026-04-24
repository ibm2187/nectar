const log = require('./log');
const { resolveJiraName } = require('./jira-name-resolver');

/**
 * Populate users.jiraName by fuzzy-matching user.name against distinct JIRA
 * people. Skips users that already have a non-null jiraName. Per-user errors
 * are caught so one bad row cannot abort the enclosing transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ matched: number, unmatched: number }}
 */
function backfillJiraNames(db) {
  const ticketNames = db.prepare(
    `SELECT DISTINCT name FROM (
       SELECT assignee AS name FROM jira_tickets WHERE assignee IS NOT NULL AND assignee != ''
       UNION
       SELECT qaAssignee FROM jira_tickets WHERE qaAssignee IS NOT NULL AND qaAssignee != ''
       UNION
       SELECT productAssignee FROM jira_tickets WHERE productAssignee IS NOT NULL AND productAssignee != ''
     )`
  ).all().map(r => r.name);

  if (ticketNames.length === 0) return { matched: 0, unmatched: 0 };

  const users = db.prepare('SELECT email, name FROM users WHERE jiraName IS NULL').all();
  const upd = db.prepare('UPDATE users SET jiraName = ? WHERE email = ?');

  let matched = 0;
  let unmatched = 0;
  for (const u of users) {
    try {
      const match = resolveJiraName(u.name, ticketNames);
      if (match) { upd.run(match, u.email); matched++; }
      else unmatched++;
    } catch (err) {
      log.warn(`backfillJiraNames: skipped ${u.email}: ${err.message}`);
      unmatched++;
    }
  }
  log.info(`v15 backfillJiraNames: matched=${matched} unmatched=${unmatched}`);
  return { matched, unmatched };
}

module.exports = backfillJiraNames;
