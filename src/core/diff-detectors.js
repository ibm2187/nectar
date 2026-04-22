/**
 * Pure-function diff detectors for the alerting system.
 *
 * Each function compares "previous" and "current" snapshots from
 * /api/status/* endpoints (as stored on environments in CustomerStore)
 * and returns a list of discrete change events ready to feed into
 * AlertRouter.handleTrigger.
 *
 * These are the detection layer for tier-2 triggers:
 *   - diffFeatureFlags      → 'feature-flag-changed'
 *   - diffIntegrations      → 'integration-config-changed'
 *   - diffFailedUpgrades    → 'upgrade-failed'
 *
 * All functions are stateless — they just compare two objects and
 * return diffs. Persistence of "have we alerted on this" lives in
 * AlertRouter (via subjectKey dedup on IncidentStore).
 */

/**
 * Compare feature flag state between two env.features snapshots.
 *
 * The shape (per environment-poller writes):
 *   features: {
 *     dbFeatureFlags: [{ key, enabled, isMobileFeature }],
 *     configFeatures: { portalFeatureFlag: {..}, mobileFeatureFlag: {..}, workflow: {..} },
 *     toggles: { <key>: boolean },
 *   }
 *
 * Returns an array of:
 *   { source, key, from, to }
 * where source ∈ { 'db', 'portal', 'mobile', 'workflow', 'toggle' }.
 *
 * The first poll (prev === null) returns [] — we treat the first
 * observation as baseline, not a change.
 */
function diffFeatureFlags(prev, curr) {
  if (!prev || !curr) return [];
  const out = [];

  // DB feature flags — keyed by `key` field, compares `enabled`
  const prevDb = new Map((prev.dbFeatureFlags || []).map(f => [f.key, !!f.enabled]));
  const currDb = new Map((curr.dbFeatureFlags || []).map(f => [f.key, !!f.enabled]));
  for (const [key, currVal] of currDb) {
    if (!prevDb.has(key)) continue; // brand-new flag — skip to avoid noise on baseline expansion
    const prevVal = prevDb.get(key);
    if (prevVal !== currVal) out.push({ source: 'db', key, from: prevVal, to: currVal });
  }
  for (const [key, prevVal] of prevDb) {
    if (!currDb.has(key)) {
      // Flag was removed — unusual but worth tracking
      out.push({ source: 'db', key, from: prevVal, to: null });
    }
  }

  // Config-based flags — three separate maps with primitive values
  const configGroups = ['portalFeatureFlag', 'mobileFeatureFlag', 'workflow'];
  const labels = { portalFeatureFlag: 'portal', mobileFeatureFlag: 'mobile', workflow: 'workflow' };
  for (const group of configGroups) {
    const prevMap = (prev.configFeatures || {})[group] || {};
    const currMap = (curr.configFeatures || {})[group] || {};
    diffShallowMap(prevMap, currMap, labels[group], out);
  }

  // Top-level toggles map
  diffShallowMap(prev.toggles || {}, curr.toggles || {}, 'toggle', out);

  return out;
}

/**
 * Compare integration config between two env.integrations snapshots.
 *
 * The shape:
 *   integrations: {
 *     disableOutgoingCommunication: boolean,
 *     dbIntegrations: { <name>: { enabled, configured } },
 *     configIntegrations: { <name>: { enabled, syncAllData? } },
 *     dataPublishing: { <name>: boolean },
 *     sqsQueues: { ... },   // not diffed — too noisy
 *   }
 *
 * Returns:
 *   { source, key, from, to }
 * source ∈ { 'outgoing-comm', 'db', 'config', 'data-publishing' }.
 */
function diffIntegrations(prev, curr) {
  if (!prev || !curr) return [];
  const out = [];

  // disableOutgoingCommunication (top-level boolean)
  if (!!prev.disableOutgoingCommunication !== !!curr.disableOutgoingCommunication) {
    out.push({
      source: 'outgoing-comm',
      key: 'disableOutgoingCommunication',
      from: !!prev.disableOutgoingCommunication,
      to: !!curr.disableOutgoingCommunication,
    });
  }

  // dbIntegrations — each entry has { enabled, configured }. Diff on `enabled`.
  diffNestedEnabledMap(prev.dbIntegrations || {}, curr.dbIntegrations || {}, 'db', out);

  // configIntegrations — same shape (we only care about `enabled`)
  diffNestedEnabledMap(prev.configIntegrations || {}, curr.configIntegrations || {}, 'config', out);

  // dataPublishing — flat booleans
  diffShallowMap(prev.dataPublishing || {}, curr.dataPublishing || {}, 'data-publishing', out);

  return out;
}

/**
 * Given two env.upgrades snapshots, return the *newly* failed upgrades
 * — items whose history.verificationStatus went from non-FAILED to
 * 'FAILED' (or appeared for the first time as FAILED).
 *
 * Also returns upgrades that transitioned FAILED → SUCCESS so the
 * caller can resolve their incidents.
 *
 *   upgrades: {
 *     environment: string,
 *     totalInPool: number,
 *     items: [{ upgradeName, history: { verificationStatus, completedAt, ... } | null }],
 *   }
 *
 * Returns { newFailures: string[], recovered: string[] }.
 */
function diffFailedUpgrades(prev, curr) {
  if (!curr || !Array.isArray(curr.items)) {
    return { newFailures: [], recovered: [] };
  }

  const statusOf = (upgrade) => upgrade?.history?.verificationStatus || null;
  const currFailedSet = new Set();
  const currStatusMap = new Map();
  for (const u of curr.items) {
    const s = statusOf(u);
    currStatusMap.set(u.upgradeName, s);
    if (s === 'FAILED') currFailedSet.add(u.upgradeName);
  }

  const prevFailedSet = new Set();
  if (prev && Array.isArray(prev.items)) {
    for (const u of prev.items) {
      if (statusOf(u) === 'FAILED') prevFailedSet.add(u.upgradeName);
    }
  }

  const newFailures = [...currFailedSet].filter(name => !prevFailedSet.has(name));
  const recovered = [...prevFailedSet].filter(name => {
    // Was failing, now not failing — either SUCCESS or no longer in the list
    const curr = currStatusMap.get(name);
    return curr !== 'FAILED';
  });

  return { newFailures, recovered };
}

// ── Helpers ──────────────────────────────────────────────

function diffShallowMap(prevMap, currMap, source, out) {
  for (const [key, currVal] of Object.entries(currMap)) {
    // Skip non-primitives — we only diff top-level booleans/strings
    if (typeof currVal === 'object' && currVal !== null) continue;
    if (!(key in prevMap)) continue; // new key — not a change
    const prevVal = prevMap[key];
    if (prevVal !== currVal) out.push({ source, key, from: prevVal, to: currVal });
  }
  for (const [key, prevVal] of Object.entries(prevMap)) {
    if (typeof prevVal === 'object' && prevVal !== null) continue;
    if (!(key in currMap)) {
      out.push({ source, key, from: prevVal, to: null });
    }
  }
}

function diffNestedEnabledMap(prevMap, currMap, source, out) {
  for (const [key, curr] of Object.entries(currMap)) {
    if (!prevMap[key]) continue; // new integration — skip baseline noise
    const prevEnabled = !!prevMap[key].enabled;
    const currEnabled = !!curr.enabled;
    if (prevEnabled !== currEnabled) {
      out.push({ source, key, from: prevEnabled, to: currEnabled });
    }
  }
  for (const [key, prev] of Object.entries(prevMap)) {
    if (!currMap[key]) {
      out.push({ source, key, from: !!prev.enabled, to: null });
    }
  }
}

module.exports = {
  diffFeatureFlags,
  diffIntegrations,
  diffFailedUpgrades,
};
