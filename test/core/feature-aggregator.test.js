import { describe, it, expect } from 'vitest';

const { aggregateFeatureFlags, aggregateIntegrations } = require('../../src/core/feature-aggregator');

/**
 * Helper — build a minimal environment object with feature flags.
 */
function makeEnv(id, customerId, tier, flags) {
  return {
    id,
    customerId,
    tier,
    name: id,
    features: {
      dbFeatureFlags: flags.map(([key, enabled]) => ({ key, enabled, isMobileFeature: false })),
    },
  };
}

describe('feature-aggregator', () => {
  describe('bucket classification', () => {
    it('classifies a flag as everywhere-on only when ALL customers have it enabled', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_A', true]]),
        makeEnv('tribute-prod', 'tribute', 'production', [['FLAG_A', true]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'FLAG_A');
      expect(flag.bucket).toBe('everywhere-on');
    });

    it('does NOT classify a flag as everywhere-on when some customers lack the flag', () => {
      // FLAG_A exists only in ck (enabled), but bayada and tribute have no data for it.
      // The aggregator should NOT call this "everywhere-on".
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', true], ['FLAG_B', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_B', true]]),
        makeEnv('tribute-prod', 'tribute', 'production', [['FLAG_B', false]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flagA = result.flags.find(f => f.key === 'FLAG_A');
      // FLAG_A is unknown for bayada and tribute — should NOT be everywhere-on
      expect(flagA.bucket).not.toBe('everywhere-on');
    });

    it('does NOT classify a flag as everywhere-on when only one customer has data', () => {
      // Regression: if 4 of 5 customers are unknown, filtering out unknowns
      // leaves just 1 customer with 'on' state, which should NOT be "everywhere".
      const envs = [
        makeEnv('lumen-prod', 'lumen', 'production', [['NICHE_FLAG', true]]),
        makeEnv('ck-prod', 'ck', 'production', [['OTHER', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['OTHER', true]]),
        makeEnv('tribute-prod', 'tribute', 'production', [['OTHER', true]]),
        makeEnv('qc-prod', 'qualitycare', 'production', [['OTHER', true]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'NICHE_FLAG');
      expect(flag.bucket).not.toBe('everywhere-on');
      // It should be mixed (on for one customer, unknown for the rest)
      expect(flag.bucket).toBe('mixed');
    });

    it('classifies a flag as everywhere-off only when ALL customers have it disabled', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', false]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_A', false]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'FLAG_A');
      expect(flag.bucket).toBe('everywhere-off');
    });

    it('does NOT classify a flag as everywhere-off when some customers lack the flag', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', false], ['FLAG_B', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_B', true]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flagA = result.flags.find(f => f.key === 'FLAG_A');
      // FLAG_A unknown for bayada — should NOT be everywhere-off
      expect(flagA.bucket).not.toBe('everywhere-off');
    });

    it('classifies as mixed when some customers are on and others off', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_A', false]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'FLAG_A');
      expect(flag.bucket).toBe('mixed');
    });

    it('classifies as dev-only when off in all prod but on in non-prod', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', false]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_A', false]]),
        makeEnv('ck-staging', 'ck', 'staging', [['FLAG_A', true]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'FLAG_A');
      expect(flag.bucket).toBe('dev-only');
    });

    it('classifies as mixed when flag is on in some envs within a customer (partial)', () => {
      const envs = [
        makeEnv('ck-100', 'ck', 'production', [['FLAG_A', true]]),
        makeEnv('ck-200', 'ck', 'production', [['FLAG_A', false]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_A', true]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'FLAG_A');
      // ck is partial, bayada is on → mixed
      expect(flag.bucket).toBe('mixed');
    });
  });

  describe('customer states', () => {
    it('marks customer as unknown when flag is not present in any of their envs', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['FLAG_A', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['FLAG_B', true]]),
      ];
      const result = aggregateFeatureFlags(envs);
      const flagA = result.flags.find(f => f.key === 'FLAG_A');
      expect(flagA.customerStates.bayada).toBe('unknown');
      expect(flagA.customerStates.ck).toBe('on');
    });

    it('marks customer as partial when flag is on in some envs but missing in others', () => {
      const envs = [
        makeEnv('ck-100', 'ck', 'production', [['FLAG_A', true]]),
        makeEnv('ck-200', 'ck', 'production', [['FLAG_B', true]]),  // FLAG_A absent
      ];
      const result = aggregateFeatureFlags(envs);
      const flag = result.flags.find(f => f.key === 'FLAG_A');
      // FLAG_A present+enabled in ck-100, absent in ck-200 → should not be 'on'
      expect(flag.customerStates.ck).not.toBe('on');
    });
  });

  describe('stats', () => {
    it('returns correct bucket counts', () => {
      const envs = [
        makeEnv('ck-prod', 'ck', 'production', [['ON_FLAG', true], ['OFF_FLAG', false], ['MIXED_FLAG', true]]),
        makeEnv('bayada-prod', 'bayada', 'production', [['ON_FLAG', true], ['OFF_FLAG', false], ['MIXED_FLAG', false]]),
      ];
      const result = aggregateFeatureFlags(envs);
      expect(result.stats.buckets['everywhere-on']).toBe(1);
      expect(result.stats.buckets['everywhere-off']).toBe(1);
      expect(result.stats.buckets['mixed']).toBe(1);
    });
  });
});

/**
 * Helper — build a minimal environment object with integrations.
 */
function makeIntEnv(id, customerId, tier, integrations) {
  const dbIntegrations = {};
  for (const [type, enabled, configured] of integrations) {
    dbIntegrations[type] = { enabled, configured: configured ?? false };
  }
  return {
    id,
    customerId,
    tier,
    name: id,
    integrations: { dbIntegrations },
  };
}

describe('aggregateIntegrations', () => {
  it('classifies as everywhere-on only when ALL customers have it enabled', () => {
    const envs = [
      makeIntEnv('ck-prod', 'ck', 'production', [['quickBooks', true, true]]),
      makeIntEnv('bayada-prod', 'bayada', 'production', [['quickBooks', true, false]]),
    ];
    const result = aggregateIntegrations(envs);
    const qb = result.integrations.find(i => i.type === 'quickBooks');
    expect(qb.bucket).toBe('everywhere-on');
  });

  it('does NOT classify as everywhere-on when some customers lack the integration', () => {
    const envs = [
      makeIntEnv('ck-prod', 'ck', 'production', [['quickBooks', true, true], ['salesforce', true, true]]),
      makeIntEnv('bayada-prod', 'bayada', 'production', [['salesforce', true, false]]),
    ];
    const result = aggregateIntegrations(envs);
    const qb = result.integrations.find(i => i.type === 'quickBooks');
    expect(qb.bucket).not.toBe('everywhere-on');
    expect(qb.bucket).toBe('mixed');
  });

  it('does NOT classify as everywhere-off when some customers lack the integration', () => {
    const envs = [
      makeIntEnv('ck-prod', 'ck', 'production', [['quickBooks', false, false], ['salesforce', true, true]]),
      makeIntEnv('bayada-prod', 'bayada', 'production', [['salesforce', true, false]]),
    ];
    const result = aggregateIntegrations(envs);
    const qb = result.integrations.find(i => i.type === 'quickBooks');
    expect(qb.bucket).not.toBe('everywhere-off');
    expect(qb.bucket).toBe('mixed');
  });

  it('classifies as mixed when some customers are on and others off', () => {
    const envs = [
      makeIntEnv('ck-prod', 'ck', 'production', [['quickBooks', true, true]]),
      makeIntEnv('bayada-prod', 'bayada', 'production', [['quickBooks', false, false]]),
    ];
    const result = aggregateIntegrations(envs);
    const qb = result.integrations.find(i => i.type === 'quickBooks');
    expect(qb.bucket).toBe('mixed');
  });
});
