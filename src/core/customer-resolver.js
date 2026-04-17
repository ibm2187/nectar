/**
 * Resolves which customers a release targets based on:
 *   1. JIRA version description override (`@customers:ck,tribute`)
 *   2. Version name suffix (`4.1.0.5-ck`, `4.2.0-cktribute`)
 *   3. Default: all customers (no suffix, e.g., `4.3.0`)
 *
 * Priority: description override > suffix parsing > default (all).
 */

const log = require('./log');

const DESCRIPTION_PATTERN = /@customers:\s*([a-z,\s]+)/i;

/**
 * Parse target customers from a JIRA version description.
 * Returns null if no @customers tag found (caller falls through to suffix parsing).
 *
 * @param {string|null} description - JIRA version description
 * @returns {string[]|null} - array of customer IDs, or null if no override
 */
function parseDescriptionOverride(description) {
  if (!description) return null;

  const match = description.match(DESCRIPTION_PATTERN);
  if (!match) return null;

  const raw = match[1];
  const customers = raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  return customers.length > 0 ? customers : null;
}

/**
 * Parse customer IDs from a version name suffix.
 * Splits compound suffixes like "cktribute" into ["ck", "tribute"]
 * using greedy matching against known customer IDs.
 *
 * @param {string} versionName - clean version (e.g., "4.1.0.5-ck", "4.2.0-cktribute")
 * @param {string[]} knownIds - known customer IDs sorted longest-first
 * @returns {string[]|null} - matched customers, or null if no suffix
 */
function parseSuffix(versionName, knownIds) {
  // Extract the suffix after the last hyphen in the version
  // Match: digits.digits.digits[.digits][-suffix]
  const suffixMatch = versionName.match(/^\d+(?:\.\d+)+-(.+)$/);
  if (!suffixMatch) return null;

  const suffix = suffixMatch[1].toLowerCase();
  const matched = [];
  let remaining = suffix;

  // Sort known IDs longest-first so "qualitycare" matches before "ck" in edge cases
  const sorted = [...knownIds].sort((a, b) => b.length - a.length);

  while (remaining.length > 0) {
    const found = sorted.find(id => remaining.startsWith(id));
    if (!found) {
      // Unrecognized suffix — not a customer suffix, bail out
      return null;
    }
    matched.push(found);
    remaining = remaining.slice(found.length);
  }

  return matched.length > 0 ? matched : null;
}

/**
 * Resolve target customers for a release version.
 *
 * @param {string} cleanVersion - version string (e.g., "4.1.0.5-ck")
 * @param {string|null} jiraDescription - JIRA version description
 * @param {string[]} knownCustomerIds - all known customer IDs
 * @returns {{ customers: string[], source: string }}
 *   customers: array of customer IDs (empty means "all")
 *   source: "description" | "suffix" | "default"
 */
function resolveTargetCustomers(cleanVersion, jiraDescription, knownCustomerIds) {
  // Rule 1: Description override wins
  const descOverride = parseDescriptionOverride(jiraDescription);
  if (descOverride) {
    // Validate against known customers
    const valid = descOverride.filter(id => knownCustomerIds.includes(id));
    const unknown = descOverride.filter(id => !knownCustomerIds.includes(id));
    if (unknown.length > 0) {
      log.warn(`@customers override for ${cleanVersion} contains unknown IDs: ${unknown.join(', ')}`);
    }
    if (valid.length > 0) {
      return { customers: valid, source: 'description' };
    }
  }

  // Rule 2: Parse suffix from version name
  const suffixCustomers = parseSuffix(cleanVersion, knownCustomerIds);
  if (suffixCustomers) {
    return { customers: suffixCustomers, source: 'suffix' };
  }

  // Rule 3: No suffix = all customers
  return { customers: [], source: 'default' };
}

module.exports = {
  resolveTargetCustomers,
  parseDescriptionOverride,
  parseSuffix,
};
