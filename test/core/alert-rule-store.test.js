import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createTestDb } = require('../../src/core/db');
const AlertRuleStore = require('../../src/core/alert-rule-store');
const { filterMatches, normalizeChannels } = AlertRuleStore;

describe('AlertRuleStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createTestDb();
    store = new AlertRuleStore({ db });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // ── Creation ───────────────────────────────────────────

  describe('create', () => {
    it('creates a valid rule with all required fields', () => {
      const rule = store.create({
        name: 'Prod health',
        triggerType: 'env-unhealthy',
        channels: ['#alerts-prod'],
        filter: { envTier: ['production'] },
      });

      expect(rule.id).toMatch(/^alrt-/);
      expect(rule.name).toBe('Prod health');
      expect(rule.triggerType).toBe('env-unhealthy');
      expect(rule.channels).toEqual(['#alerts-prod']);
      expect(rule.filter.envTier).toEqual(['production']);
      expect(rule.severity).toBe('critical');
      expect(rule.enabled).toBe(true);
      expect(rule.createdAt).toBeTruthy();
    });

    it('defaults severity to the trigger default', () => {
      const recovered = store.create({
        name: 'recovery',
        triggerType: 'env-recovered',
        channels: ['#a'],
      });
      expect(recovered.severity).toBe('info');

      const flag = store.create({
        name: 'flag',
        triggerType: 'feature-flag-changed',
        channels: ['#a'],
      });
      expect(flag.severity).toBe('warning');
    });

    it('normalizes bare channel names by adding #', () => {
      const rule = store.create({
        name: 'test',
        triggerType: 'env-unhealthy',
        channels: ['alerts-prod', 'bayada-alerts'],
      });
      expect(rule.channels).toEqual(['#alerts-prod', '#bayada-alerts']);
    });

    it('accepts channel IDs without prefixing', () => {
      const rule = store.create({
        name: 'test',
        triggerType: 'env-unhealthy',
        channels: ['#keep-hash'],
      });
      expect(rule.channels).toEqual(['#keep-hash']);
    });

    it('rejects unknown trigger types', () => {
      expect(() => store.create({
        name: 'x',
        triggerType: 'bogus',
        channels: ['#a'],
      })).toThrow(/unknown triggerType/);
    });

    it('rejects empty name', () => {
      expect(() => store.create({
        name: '',
        triggerType: 'env-unhealthy',
        channels: ['#a'],
      })).toThrow(/name is required/);
    });

    it('rejects empty channels', () => {
      expect(() => store.create({
        name: 'x',
        triggerType: 'env-unhealthy',
        channels: [],
      })).toThrow(/at least one channel/);
    });

    it('strips unknown filter keys', () => {
      const rule = store.create({
        name: 'x',
        triggerType: 'env-unhealthy',
        channels: ['#a'],
        filter: {
          customerIds: ['bayada'],
          bogusField: 'nope',
          sustainedMinutes: 30, // not valid for env-unhealthy
        },
      });
      expect(rule.filter.customerIds).toEqual(['bayada']);
      expect(rule.filter.bogusField).toBeUndefined();
      expect(rule.filter.sustainedMinutes).toBeUndefined();
    });

    it('coerces invalid severity to trigger default', () => {
      const rule = store.create({
        name: 'x',
        triggerType: 'env-unhealthy',
        channels: ['#a'],
        severity: 'nonsense',
      });
      expect(rule.severity).toBe('critical');
    });
  });

  // ── Retrieval ──────────────────────────────────────────

  describe('get / list', () => {
    it('retrieves a rule by id', () => {
      const created = store.create({
        name: 'x', triggerType: 'env-unhealthy', channels: ['#a'],
      });
      const got = store.get(created.id);
      expect(got).toEqual(created);
    });

    it('returns null for unknown id', () => {
      expect(store.get('bogus')).toBeNull();
      expect(store.get(null)).toBeNull();
    });

    it('lists all rules', () => {
      store.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
      store.create({ name: 'b', triggerType: 'env-recovered', channels: ['#b'] });
      expect(store.list()).toHaveLength(2);
    });

    it('filters by triggerType', () => {
      store.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
      store.create({ name: 'b', triggerType: 'env-recovered', channels: ['#b'] });
      const unhealthy = store.list({ triggerType: 'env-unhealthy' });
      expect(unhealthy).toHaveLength(1);
      expect(unhealthy[0].name).toBe('a');
    });

    it('filters by enabled state', () => {
      store.create({ name: 'on', triggerType: 'env-unhealthy', channels: ['#a'], enabled: true });
      store.create({ name: 'off', triggerType: 'env-unhealthy', channels: ['#b'], enabled: false });
      expect(store.list({ enabled: true })).toHaveLength(1);
      expect(store.list({ enabled: false })).toHaveLength(1);
    });
  });

  // ── Updates ────────────────────────────────────────────

  describe('update', () => {
    it('updates name only', () => {
      const r = store.create({ name: 'old', triggerType: 'env-unhealthy', channels: ['#a'] });
      const updated = store.update(r.id, { name: 'new' });
      expect(updated.name).toBe('new');
      expect(updated.channels).toEqual(['#a']);
    });

    it('updates filter', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      const updated = store.update(r.id, {
        filter: { customerIds: ['bayada', 'ck'], envTier: ['production'] },
      });
      expect(updated.filter.customerIds).toEqual(['bayada', 'ck']);
      expect(updated.filter.envTier).toEqual(['production']);
    });

    it('toggles enabled', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      const off = store.update(r.id, { enabled: false });
      expect(off.enabled).toBe(false);
    });

    it('preserves existing fields on partial patch', () => {
      const r = store.create({
        name: 'x',
        triggerType: 'env-unhealthy',
        channels: ['#a'],
        filter: { envTier: ['production'] },
        severity: 'warning',
      });
      const updated = store.update(r.id, { name: 'renamed' });
      expect(updated.name).toBe('renamed');
      expect(updated.channels).toEqual(['#a']);
      expect(updated.filter.envTier).toEqual(['production']);
      expect(updated.severity).toBe('warning');
    });

    it('returns null for unknown id', () => {
      expect(store.update('missing', { name: 'x' })).toBeNull();
    });

    it('rejects update to invalid trigger type', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      expect(() => store.update(r.id, { triggerType: 'bogus' })).toThrow(/unknown triggerType/);
    });

    it('rejects update that would clear channels (zero-channel rule cannot post anywhere)', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      expect(() => store.update(r.id, { channels: [] })).toThrow(/at least one channel/);
      // Ensure the original was not modified
      expect(store.get(r.id).channels).toEqual(['#a']);
    });

    it('rejects update with explicit empty-string channels (normalize drops them)', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      expect(() => store.update(r.id, { channels: ['', null, '   '] })).toThrow(/at least one channel/);
    });
  });

  // ── Delete ─────────────────────────────────────────────

  describe('delete', () => {
    it('deletes an existing rule', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      expect(store.delete(r.id)).toBe(true);
      expect(store.get(r.id)).toBeNull();
    });

    it('returns false for unknown id', () => {
      expect(store.delete('missing')).toBe(false);
    });
  });

  // ── Firing record ──────────────────────────────────────

  describe('recordFired', () => {
    it('sets lastFiredAt', () => {
      const r = store.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
      expect(r.lastFiredAt).toBeNull();
      store.recordFired(r.id, '2026-04-22T12:00:00Z');
      const fresh = store.get(r.id);
      expect(fresh.lastFiredAt).toBe('2026-04-22T12:00:00Z');
    });
  });

  // ── Matching ───────────────────────────────────────────

  describe('findMatching', () => {
    it('returns rules matching the triggerType', () => {
      store.create({ name: 'unh', triggerType: 'env-unhealthy', channels: ['#a'] });
      store.create({ name: 'rec', triggerType: 'env-recovered', channels: ['#b'] });
      const matches = store.findMatching('env-unhealthy', {});
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('unh');
    });

    it('respects customer filter', () => {
      store.create({
        name: 'bayada-only',
        triggerType: 'env-unhealthy',
        channels: ['#a'],
        filter: { customerIds: ['bayada'] },
      });
      store.create({
        name: 'all',
        triggerType: 'env-unhealthy',
        channels: ['#b'],
      });
      const bayadaEvent = store.findMatching('env-unhealthy', { customerId: 'bayada' });
      expect(bayadaEvent.map(r => r.name).sort()).toEqual(['all', 'bayada-only']);

      const ckEvent = store.findMatching('env-unhealthy', { customerId: 'ck' });
      expect(ckEvent.map(r => r.name)).toEqual(['all']);
    });

    it('excludes disabled rules', () => {
      store.create({
        name: 'on',
        triggerType: 'env-unhealthy',
        channels: ['#a'],
        enabled: true,
      });
      store.create({
        name: 'off',
        triggerType: 'env-unhealthy',
        channels: ['#b'],
        enabled: false,
      });
      const matches = store.findMatching('env-unhealthy', {});
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('on');
    });
  });
});

describe('filterMatches (pure)', () => {
  it('empty filter matches any context', () => {
    expect(filterMatches({}, { customerId: 'bayada' })).toBe(true);
    expect(filterMatches({}, {})).toBe(true);
  });

  it('customerIds — requires match when set', () => {
    const f = { customerIds: ['bayada', 'ck'] };
    expect(filterMatches(f, { customerId: 'bayada' })).toBe(true);
    expect(filterMatches(f, { customerId: 'ck' })).toBe(true);
    expect(filterMatches(f, { customerId: 'tribute' })).toBe(false);
    expect(filterMatches(f, {})).toBe(false);
  });

  it('envIds — requires match when set', () => {
    const f = { envIds: ['env-1'] };
    expect(filterMatches(f, { envId: 'env-1' })).toBe(true);
    expect(filterMatches(f, { envId: 'env-2' })).toBe(false);
  });

  it('envTier — accepts any listed tier', () => {
    const f = { envTier: ['production', 'staging'] };
    expect(filterMatches(f, { envTier: 'production' })).toBe(true);
    expect(filterMatches(f, { envTier: 'staging' })).toBe(true);
    expect(filterMatches(f, { envTier: 'dev' })).toBe(false);
  });

  it('components — requires intersection', () => {
    const f = { components: ['Cache', 'Database'] };
    expect(filterMatches(f, { components: ['Cache'] })).toBe(true);
    expect(filterMatches(f, { components: ['Cache', 'Messaging'] })).toBe(true);
    expect(filterMatches(f, { components: ['Messaging'] })).toBe(false);
    expect(filterMatches(f, { components: [] })).toBe(false);
    expect(filterMatches(f, {})).toBe(false);
  });

  it('sustainedMinutes — requires durationMinutes >= filter', () => {
    const f = { sustainedMinutes: 15 };
    expect(filterMatches(f, { durationMinutes: 15 })).toBe(true);
    expect(filterMatches(f, { durationMinutes: 30 })).toBe(true);
    expect(filterMatches(f, { durationMinutes: 14 })).toBe(false);
    expect(filterMatches(f, {})).toBe(false);
  });

  it('ANDs all conditions together', () => {
    const f = {
      customerIds: ['bayada'],
      envTier: ['production'],
      components: ['Cache'],
    };
    expect(filterMatches(f, {
      customerId: 'bayada', envTier: 'production', components: ['Cache'],
    })).toBe(true);

    // Missing one filter → reject
    expect(filterMatches(f, {
      customerId: 'bayada', envTier: 'production', components: ['Database'],
    })).toBe(false);
  });
});

describe('normalizeChannels (pure)', () => {
  it('prefixes bare names with #', () => {
    expect(normalizeChannels('alerts-prod')).toEqual(['#alerts-prod']);
    expect(normalizeChannels(['alerts-prod', '#already'])).toEqual(['#alerts-prod', '#already']);
  });

  it('drops empty entries', () => {
    expect(normalizeChannels(['', null, 'valid'])).toEqual(['#valid']);
  });

  it('leaves @-prefixed channels alone (user mentions)', () => {
    expect(normalizeChannels(['@user'])).toEqual(['@user']);
  });

  it('handles empty input', () => {
    expect(normalizeChannels([])).toEqual([]);
    expect(normalizeChannels(null)).toEqual([]);
    expect(normalizeChannels(undefined)).toEqual([]);
  });
});
