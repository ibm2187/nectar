const log = require('./log');

/**
 * Determine the effective release status by cross-referencing against
 * what's actually running in production environments.
 *
 * JIRA fixVersion release state is often stale — the team marks things
 * as planned/unreleased even after the code has shipped. This module
 * uses environment polling data as ground truth: if a production env
 * is running version X, then X is shipped regardless of JIRA state.
 *
 * Returns one of:
 *   'shipped'     — confirmed shipped (JIRA says so OR prod env runs it OR newer version is in prod)
 *   'in-flight'   — not shipped, date is today or within 7 days, OR state is cutting/stabilizing/approved/deploying
 *   'upcoming'    — not shipped, date is in the future
 *   'overdue'     — not shipped, date has passed, no deployment signal
 *   'unknown'     — not shipped, no date
 *
 * Also returns `shippedSignals`: which signals confirmed the shipped status
 * (for UI display — "shipped per Bayada prod running 4.1.2").
 */

// Parse a semver-ish version like "4.1.2" into comparable parts.
// Handles brand suffixes like "4.1.2-ck" or "4.2.0-cktribute".
function parseVersion(v) {
  if (!v) return null;
  // Strip brand suffix
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3] || '0', 10),
    build: parseInt(m[4] || '0', 10),
  };
}

/**
 * Compare two version strings. Returns positive if a > b.
 * Ignores brand suffixes — we only compare the numeric parts.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return (
    (pa.major - pb.major) ||
    (pa.minor - pb.minor) ||
    (pa.patch - pb.patch) ||
    (pa.build - pb.build)
  );
}

/**
 * Extract brand suffix from a version. Returns null if no suffix.
 * e.g. "4.1.2-ck" → "ck", "4.2.0-cktribute" → "cktribute", "4.1.2" → null
 */
function getBrandSuffix(version) {
  if (!version) return null;
  const m = version.match(/^\d+\.\d+(?:\.\d+)?(?:\.\d+)?-([\w-]+)$/);
  return m ? m[1] : null;
}

/**
 * Compute the effective status of a release, given the current set of
 * production environments.
 *
 * @param {object} release — the release object from the store
 * @param {Array<object>} prodEnvs — production environments (with currentVersion)
 * @param {Date} [now] — for testing; defaults to new Date()
 * @returns {object} { status, shippedSignals, matchingEnvs }
 */
function computeReleaseStatus(release, prodEnvs = [], now = new Date()) {
  const signals = [];
  const matchingEnvs = [];

  // Signal 1: JIRA says released
  if (release.jiraReleased) {
    signals.push({ type: 'jira-released', detail: `JIRA fixVersion marked released` });
  }

  // Signal 2: Exact version match in a prod env
  const exactMatches = prodEnvs.filter(e => e.currentVersion === release.version);
  if (exactMatches.length > 0) {
    for (const env of exactMatches) {
      matchingEnvs.push({ id: env.id, customerId: env.customerId, currentVersion: env.currentVersion });
      signals.push({ type: 'running-in-prod', env: env.id, detail: `Running in ${env.id}` });
    }
  }

  // Signal 3: A newer version of the same brand variant is running somewhere.
  // This means OUR version must have shipped already (you can't be at 4.1.3
  // without 4.1.2 having gone out).
  //
  // Match by brand suffix: "4.1.2-ck" compares against other "*-ck" versions,
  // "4.1.2" (base) compares against other base versions only.
  const ourSuffix = getBrandSuffix(release.version);
  for (const env of prodEnvs) {
    if (!env.currentVersion || env.currentVersion === release.version) continue;
    const envSuffix = getBrandSuffix(env.currentVersion);
    if (envSuffix !== ourSuffix) continue; // different variant, skip
    if (compareVersions(env.currentVersion, release.version) > 0) {
      // Their version is newer than ours → ours shipped before theirs
      signals.push({
        type: 'superseded',
        env: env.id,
        envVersion: env.currentVersion,
        detail: `${env.id} runs ${env.currentVersion} (newer)`,
      });
      break; // one signal is enough
    }
  }

  // Signal 4: Release state is done
  if (release.state === 'done') {
    signals.push({ type: 'state-done', detail: 'Release state: done' });
  }

  // Decide: shipped or not?
  const shippedSignals = signals.filter(s =>
    s.type === 'jira-released' ||
    s.type === 'running-in-prod' ||
    s.type === 'superseded' ||
    s.type === 'state-done'
  );

  if (shippedSignals.length > 0) {
    return { status: 'shipped', shippedSignals, matchingEnvs };
  }

  // Not shipped — figure out if it's upcoming, in-flight, or overdue
  const releaseDate = release.jiraReleaseDate ? new Date(release.jiraReleaseDate) : null;

  // In-flight takes precedence: active release work
  const inFlightStates = new Set(['cutting', 'stabilizing', 'approved', 'deploying']);
  if (inFlightStates.has(release.state)) {
    return { status: 'in-flight', shippedSignals: [], matchingEnvs: [] };
  }

  if (!releaseDate || isNaN(releaseDate.getTime())) {
    return { status: 'unknown', shippedSignals: [], matchingEnvs: [] };
  }

  // Compare calendar days using Eastern Time (business timezone).
  // The server may run in UTC, but release dates are set in ET context.
  // Using a consistent timezone prevents releases from jumping buckets
  // at 8 PM EDT (midnight UTC).
  const etFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayET = etFormatter.format(now);                    // "2026-04-16"
  const relDayET = release.jiraReleaseDate.slice(0, 10);      // already "YYYY-MM-DD"
  const todayMs = new Date(todayET + 'T00:00:00Z').getTime();
  const relDayMs = new Date(relDayET + 'T00:00:00Z').getTime();
  const daysUntil = Math.round((relDayMs - todayMs) / (1000 * 60 * 60 * 24));

  if (daysUntil < 0) {
    return { status: 'overdue', shippedSignals: [], matchingEnvs: [], daysOverdue: -daysUntil };
  }
  if (daysUntil <= 7) {
    return { status: 'in-flight', shippedSignals: [], matchingEnvs: [], daysUntil };
  }
  return { status: 'upcoming', shippedSignals: [], matchingEnvs: [], daysUntil };
}

/**
 * Annotate all releases with their effective status in bulk.
 * More efficient than calling computeReleaseStatus() individually because
 * it pre-filters prod envs once.
 */
function annotateReleases(releases, environments, now = new Date()) {
  const prodEnvs = (environments || []).filter(e => e.tier === 'production' && e.currentVersion);
  const result = [];
  for (const release of releases) {
    const status = computeReleaseStatus(release, prodEnvs, now);
    result.push({ ...release, effectiveStatus: status });
  }
  return result;
}

module.exports = {
  computeReleaseStatus,
  annotateReleases,
  compareVersions,
  getBrandSuffix,
  parseVersion,
};
