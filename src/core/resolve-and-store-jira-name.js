const log = require('./log');
const { resolveJiraName } = require('./jira-name-resolver');

/**
 * Resolve and persist a user's JIRA display name. No-op if already set or
 * if no ticketStore is available. Returns the matched name or null.
 *
 * Shared between SSO login (auth.js) and v15 migration backfill so the
 * "try to resolve, write if found, don't clobber" logic has one source.
 *
 * @param {object} params
 * @param {import('./user-store')} params.userStore
 * @param {{ getDistinctPeople: () => {name:string}[] } | null} params.ticketStore
 * @param {string} params.email
 * @returns {string|null}
 */
function resolveAndStoreJiraName({ userStore, ticketStore, email }) {
  if (!userStore || !ticketStore || !email) return null;
  const user = userStore.getUser(email);
  if (!user || user.jiraName) return null;

  try {
    const distinct = ticketStore.getDistinctPeople().map(p => p.name);
    const match = resolveJiraName(user.name, distinct);
    if (match) {
      userStore.setJiraName(email, match);
      return match;
    }
  } catch (err) {
    log.warn(`resolveAndStoreJiraName failed for ${email}: ${err.message}`);
  }
  return null;
}

module.exports = resolveAndStoreJiraName;
