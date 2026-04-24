function normalize(name) {
  return (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a user's display name (from SSO) to a JIRA display name string
 * that appears in ticket assignee/reporter/qaAssignee fields.
 *
 * Ambiguity policy: if two or more candidates match at the same strategy
 * tier, return null rather than guess. A wrong match silently binds a
 * user to the wrong JIRA identity — admin override is safer.
 *
 * @param {string} candidate - user.name from SSO
 * @param {string[]} jiraNames - distinct names from ticketStore.getDistinctPeople()
 * @returns {string|null}
 */
function resolveJiraName(candidate, jiraNames) {
  if (!candidate || !Array.isArray(jiraNames) || jiraNames.length === 0) return null;

  const query = normalize(candidate);
  if (!query) return null;

  // Strategy 1: exact normalized match
  const exact = jiraNames.filter(jn => normalize(jn) === query);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const qTokens = query.split(/\s+/).filter(Boolean);
  if (qTokens.length < 2) return null; // "Eric" alone is too ambiguous

  const qFirst = qTokens[0];
  const qLast  = qTokens[qTokens.length - 1];

  // Strategy 2: first + last initial
  const tier2 = jiraNames.filter(jn => {
    const n = normalize(jn).split(/\s+/).filter(Boolean);
    return n.length >= 2 && n[0] === qFirst && n[n.length - 1][0] === qLast[0];
  });
  if (tier2.length === 1) return tier2[0];
  if (tier2.length > 1) return null;

  // Strategy 3: exact last name + first initial
  const tier3 = jiraNames.filter(jn => {
    const n = normalize(jn).split(/\s+/).filter(Boolean);
    return n.length >= 2 && n[n.length - 1] === qLast && n[0][0] === qFirst[0];
  });
  if (tier3.length === 1) return tier3[0];

  return null;
}

module.exports = { resolveJiraName, _normalize: normalize };
