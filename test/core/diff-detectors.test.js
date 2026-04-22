import { describe, it, expect } from 'vitest';
const {
  diffFeatureFlags,
  diffIntegrations,
  diffFailedUpgrades,
} = require('../../src/core/diff-detectors');

// ══════════════════════════════════════════════════════════════
// diffFeatureFlags
// ══════════════════════════════════════════════════════════════

describe('diffFeatureFlags', () => {
  it('returns [] when prev is null (baseline)', () => {
    const curr = {
      dbFeatureFlags: [{ key: 'flagA', enabled: true }],
      configFeatures: { portalFeatureFlag: { a: true } },
      toggles: {},
    };
    expect(diffFeatureFlags(null, curr)).toEqual([]);
  });

  it('returns [] when curr is null', () => {
    expect(diffFeatureFlags({}, null)).toEqual([]);
  });

  it('detects DB flag toggled from enabled to disabled', () => {
    const prev = { dbFeatureFlags: [{ key: 'flagA', enabled: true }] };
    const curr = { dbFeatureFlags: [{ key: 'flagA', enabled: false }] };
    expect(diffFeatureFlags(prev, curr)).toEqual([
      { source: 'db', key: 'flagA', from: true, to: false },
    ]);
  });

  it('detects DB flag toggled from disabled to enabled', () => {
    const prev = { dbFeatureFlags: [{ key: 'flagA', enabled: false }] };
    const curr = { dbFeatureFlags: [{ key: 'flagA', enabled: true }] };
    expect(diffFeatureFlags(prev, curr)).toContainEqual(
      { source: 'db', key: 'flagA', from: false, to: true }
    );
  });

  it('skips new flags (prev did not have them — baseline expansion)', () => {
    const prev = { dbFeatureFlags: [{ key: 'existing', enabled: true }] };
    const curr = {
      dbFeatureFlags: [
        { key: 'existing', enabled: true },
        { key: 'new-flag', enabled: true },
      ],
    };
    expect(diffFeatureFlags(prev, curr)).toEqual([]);
  });

  it('detects flag removal (present in prev, absent in curr)', () => {
    const prev = { dbFeatureFlags: [{ key: 'flagA', enabled: true }] };
    const curr = { dbFeatureFlags: [] };
    expect(diffFeatureFlags(prev, curr)).toContainEqual(
      { source: 'db', key: 'flagA', from: true, to: null }
    );
  });

  it('detects portal config flag change', () => {
    const prev = { configFeatures: { portalFeatureFlag: { newUi: false } } };
    const curr = { configFeatures: { portalFeatureFlag: { newUi: true } } };
    expect(diffFeatureFlags(prev, curr)).toEqual([
      { source: 'portal', key: 'newUi', from: false, to: true },
    ]);
  });

  it('detects mobile config flag change', () => {
    const prev = { configFeatures: { mobileFeatureFlag: { offline: false } } };
    const curr = { configFeatures: { mobileFeatureFlag: { offline: true } } };
    expect(diffFeatureFlags(prev, curr)).toEqual([
      { source: 'mobile', key: 'offline', from: false, to: true },
    ]);
  });

  it('detects workflow config change', () => {
    const prev = { configFeatures: { workflow: { autoApprove: true } } };
    const curr = { configFeatures: { workflow: { autoApprove: false } } };
    expect(diffFeatureFlags(prev, curr)).toEqual([
      { source: 'workflow', key: 'autoApprove', from: true, to: false },
    ]);
  });

  it('detects toggle map change', () => {
    const prev = { toggles: { darkMode: true } };
    const curr = { toggles: { darkMode: false } };
    expect(diffFeatureFlags(prev, curr)).toEqual([
      { source: 'toggle', key: 'darkMode', from: true, to: false },
    ]);
  });

  it('returns empty when nothing changed', () => {
    const snapshot = {
      dbFeatureFlags: [{ key: 'a', enabled: true }],
      configFeatures: { portalFeatureFlag: { x: 1 } },
      toggles: { y: true },
    };
    expect(diffFeatureFlags(snapshot, snapshot)).toEqual([]);
  });

  it('handles multiple simultaneous changes', () => {
    const prev = {
      dbFeatureFlags: [{ key: 'flagA', enabled: true }, { key: 'flagB', enabled: false }],
      configFeatures: { portalFeatureFlag: { ui: false } },
    };
    const curr = {
      dbFeatureFlags: [{ key: 'flagA', enabled: false }, { key: 'flagB', enabled: true }],
      configFeatures: { portalFeatureFlag: { ui: true } },
    };
    const diffs = diffFeatureFlags(prev, curr);
    expect(diffs).toHaveLength(3);
    expect(diffs).toContainEqual({ source: 'db', key: 'flagA', from: true, to: false });
    expect(diffs).toContainEqual({ source: 'db', key: 'flagB', from: false, to: true });
    expect(diffs).toContainEqual({ source: 'portal', key: 'ui', from: false, to: true });
  });

  it('ignores non-primitive values (e.g. nested objects)', () => {
    const prev = { configFeatures: { portalFeatureFlag: { nested: { a: 1 } } } };
    const curr = { configFeatures: { portalFeatureFlag: { nested: { a: 2 } } } };
    expect(diffFeatureFlags(prev, curr)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// diffIntegrations
// ══════════════════════════════════════════════════════════════

describe('diffIntegrations', () => {
  it('returns [] when prev is null', () => {
    expect(diffIntegrations(null, { dbIntegrations: {} })).toEqual([]);
  });

  it('detects disableOutgoingCommunication flip', () => {
    const prev = { disableOutgoingCommunication: false };
    const curr = { disableOutgoingCommunication: true };
    expect(diffIntegrations(prev, curr)).toEqual([
      { source: 'outgoing-comm', key: 'disableOutgoingCommunication', from: false, to: true },
    ]);
  });

  it('detects DB integration enabled → disabled', () => {
    const prev = { dbIntegrations: { sso: { enabled: true, configured: true } } };
    const curr = { dbIntegrations: { sso: { enabled: false, configured: true } } };
    expect(diffIntegrations(prev, curr)).toEqual([
      { source: 'db', key: 'sso', from: true, to: false },
    ]);
  });

  it('detects config integration change', () => {
    const prev = { configIntegrations: { jira: { enabled: false } } };
    const curr = { configIntegrations: { jira: { enabled: true } } };
    expect(diffIntegrations(prev, curr)).toEqual([
      { source: 'config', key: 'jira', from: false, to: true },
    ]);
  });

  it('detects dataPublishing flag change', () => {
    const prev = { dataPublishing: { webhookA: true } };
    const curr = { dataPublishing: { webhookA: false } };
    expect(diffIntegrations(prev, curr)).toEqual([
      { source: 'data-publishing', key: 'webhookA', from: true, to: false },
    ]);
  });

  it('detects integration removal', () => {
    const prev = { dbIntegrations: { sso: { enabled: true } } };
    const curr = { dbIntegrations: {} };
    expect(diffIntegrations(prev, curr)).toContainEqual(
      { source: 'db', key: 'sso', from: true, to: null }
    );
  });

  it('ignores new integrations (baseline expansion)', () => {
    const prev = { dbIntegrations: { sso: { enabled: true } } };
    const curr = {
      dbIntegrations: {
        sso: { enabled: true },
        newThing: { enabled: false },
      },
    };
    expect(diffIntegrations(prev, curr)).toEqual([]);
  });

  it('ignores configured field (only enabled matters)', () => {
    const prev = { dbIntegrations: { sso: { enabled: true, configured: false } } };
    const curr = { dbIntegrations: { sso: { enabled: true, configured: true } } };
    expect(diffIntegrations(prev, curr)).toEqual([]);
  });

  it('handles multiple changes across sources', () => {
    const prev = {
      disableOutgoingCommunication: false,
      dbIntegrations: { sso: { enabled: true } },
      configIntegrations: { jira: { enabled: false } },
      dataPublishing: { hook: true },
    };
    const curr = {
      disableOutgoingCommunication: true,
      dbIntegrations: { sso: { enabled: false } },
      configIntegrations: { jira: { enabled: true } },
      dataPublishing: { hook: false },
    };
    const diffs = diffIntegrations(prev, curr);
    expect(diffs).toHaveLength(4);
  });
});

// ══════════════════════════════════════════════════════════════
// diffFailedUpgrades
// ══════════════════════════════════════════════════════════════

describe('diffFailedUpgrades', () => {
  function upgrade(name, status) {
    return { upgradeName: name, history: status ? { verificationStatus: status } : null };
  }

  it('returns empty sets on null curr', () => {
    expect(diffFailedUpgrades({}, null)).toEqual({ newFailures: [], recovered: [] });
  });

  it('detects new failures (prev had none)', () => {
    const prev = { items: [upgrade('m1', 'SUCCESS')] };
    const curr = { items: [upgrade('m1', 'FAILED')] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.newFailures).toEqual(['m1']);
    expect(diff.recovered).toEqual([]);
  });

  it('does not re-fire when upgrade is still failing', () => {
    const prev = { items: [upgrade('m1', 'FAILED')] };
    const curr = { items: [upgrade('m1', 'FAILED')] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.newFailures).toEqual([]);
    expect(diff.recovered).toEqual([]);
  });

  it('detects recovery (FAILED → SUCCESS)', () => {
    const prev = { items: [upgrade('m1', 'FAILED')] };
    const curr = { items: [upgrade('m1', 'SUCCESS')] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.newFailures).toEqual([]);
    expect(diff.recovered).toEqual(['m1']);
  });

  it('detects recovery when upgrade drops from list', () => {
    const prev = { items: [upgrade('m1', 'FAILED')] };
    const curr = { items: [] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.recovered).toEqual(['m1']);
  });

  it('handles multiple new failures', () => {
    const prev = { items: [upgrade('m1', 'SUCCESS'), upgrade('m2', 'SUCCESS')] };
    const curr = { items: [upgrade('m1', 'FAILED'), upgrade('m2', 'FAILED')] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.newFailures.sort()).toEqual(['m1', 'm2']);
  });

  it('mixed: some new failures, some recoveries', () => {
    const prev = { items: [upgrade('m1', 'FAILED'), upgrade('m2', 'SUCCESS')] };
    const curr = { items: [upgrade('m1', 'SUCCESS'), upgrade('m2', 'FAILED')] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.newFailures).toEqual(['m2']);
    expect(diff.recovered).toEqual(['m1']);
  });

  it('first poll (no prev) treats current failures as new', () => {
    // This is a slight gotcha — first run will alert on any pre-existing
    // failures. Acceptable behavior for v1 since it flags the state we
    // missed while Nectar was offline.
    const curr = { items: [upgrade('m1', 'FAILED')] };
    const diff = diffFailedUpgrades(null, curr);
    expect(diff.newFailures).toEqual(['m1']);
  });

  it('first poll: treats empty prev the same as null for new failures', () => {
    const diff = diffFailedUpgrades({ items: [] }, { items: [upgrade('m1', 'FAILED')] });
    expect(diff.newFailures).toEqual(['m1']);
  });

  it('ignores non-FAILED statuses (null history, IN_PROGRESS, etc)', () => {
    const prev = { items: [upgrade('m1', null)] };
    const curr = { items: [upgrade('m1', null)] };
    const diff = diffFailedUpgrades(prev, curr);
    expect(diff.newFailures).toEqual([]);
    expect(diff.recovered).toEqual([]);
  });
});
