import { describe, it, expect } from 'vitest';
const {
  TRIGGERS,
  SEVERITIES,
  getTrigger,
  isValidTriggerType,
  isValidSeverity,
  sanitizeFilter,
  listTriggers,
} = require('../../src/core/alert-triggers');

describe('alert-triggers catalog', () => {
  it('defines tier-1 env triggers', () => {
    expect(isValidTriggerType('env-unhealthy')).toBe(true);
    expect(isValidTriggerType('env-recovered')).toBe(true);
    expect(isValidTriggerType('env-degraded-sustained')).toBe(true);
  });

  it('defines tier-2 triggers', () => {
    expect(isValidTriggerType('deploy-failed')).toBe(true);
    expect(isValidTriggerType('feature-flag-changed')).toBe(true);
    expect(isValidTriggerType('upgrade-failed')).toBe(true);
  });

  it('rejects unknown trigger types', () => {
    expect(isValidTriggerType('bogus-trigger')).toBe(false);
    expect(isValidTriggerType('')).toBe(false);
    expect(isValidTriggerType(null)).toBe(false);
  });

  it('returns trigger metadata for known types', () => {
    const t = getTrigger('env-unhealthy');
    expect(t).not.toBeNull();
    expect(t.label).toContain('unhealthy');
    expect(t.defaultSeverity).toBe('critical');
    expect(t.filterFields).toContain('customerIds');
    expect(t.filterFields).toContain('envTier');
  });

  it('returns null for unknown triggers', () => {
    expect(getTrigger('bogus')).toBeNull();
  });

  describe('severity validation', () => {
    it.each(SEVERITIES)('accepts %s', (sev) => {
      expect(isValidSeverity(sev)).toBe(true);
    });
    it('rejects unknown severities', () => {
      expect(isValidSeverity('fatal')).toBe(false);
      expect(isValidSeverity('')).toBe(false);
      expect(isValidSeverity(undefined)).toBe(false);
    });
  });

  describe('sanitizeFilter', () => {
    it('strips unknown keys', () => {
      const out = sanitizeFilter('env-unhealthy', {
        customerIds: ['bayada'],
        bogusField: 'nope',
      });
      expect(out.customerIds).toEqual(['bayada']);
      expect(out.bogusField).toBeUndefined();
    });

    it('normalizes string values to arrays for list fields', () => {
      const out = sanitizeFilter('env-unhealthy', {
        customerIds: 'bayada',
      });
      expect(out.customerIds).toEqual(['bayada']);
    });

    it('drops empty strings from array fields', () => {
      const out = sanitizeFilter('env-unhealthy', {
        customerIds: ['', 'bayada', null, 'ck'],
      });
      expect(out.customerIds).toEqual(['bayada', 'ck']);
    });

    it('coerces sustainedMinutes to number', () => {
      const out = sanitizeFilter('env-degraded-sustained', {
        sustainedMinutes: '30',
      });
      expect(out.sustainedMinutes).toBe(30);
    });

    it('drops non-numeric sustainedMinutes', () => {
      const out = sanitizeFilter('env-degraded-sustained', {
        sustainedMinutes: 'not-a-number',
      });
      expect(out.sustainedMinutes).toBeUndefined();
    });

    it('drops sustainedMinutes when trigger does not declare it', () => {
      const out = sanitizeFilter('env-unhealthy', {
        sustainedMinutes: 30,
      });
      expect(out.sustainedMinutes).toBeUndefined();
    });

    it('returns empty object for unknown triggers', () => {
      const out = sanitizeFilter('bogus-trigger', { customerIds: ['bayada'] });
      expect(out).toEqual({});
    });

    it('handles null/undefined raw filter', () => {
      expect(sanitizeFilter('env-unhealthy', null)).toEqual({});
      expect(sanitizeFilter('env-unhealthy', undefined)).toEqual({});
    });
  });

  describe('listTriggers', () => {
    it('returns one entry per trigger', () => {
      const list = listTriggers();
      expect(list.length).toBe(Object.keys(TRIGGERS).length);
    });

    it('includes full filter field specs with options where applicable', () => {
      const list = listTriggers();
      const envUnhealthy = list.find(t => t.key === 'env-unhealthy');
      expect(envUnhealthy).toBeDefined();
      const tierField = envUnhealthy.filterFields.find(f => f.key === 'envTier');
      expect(tierField).toBeDefined();
      expect(tierField.options).toContain('production');
      expect(tierField.type).toBe('tier-multi');
    });

    it('components field has the canonical options list', () => {
      const list = listTriggers();
      const envUnhealthy = list.find(t => t.key === 'env-unhealthy');
      const componentsField = envUnhealthy.filterFields.find(f => f.key === 'components');
      expect(componentsField).toBeDefined();
      expect(componentsField.options).toEqual(
        expect.arrayContaining(['Database', 'Cache', 'File Storage', 'Message Queue'])
      );
    });
  });
});
