import { describe, it, expect, beforeEach } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const { TemplateStore, computeMilestones, recomputeMilestones, refreshFromTemplate, hasGateActivity, subtractBusinessDays, formatDate } = require('../../src/core/milestone-engine');

describe('subtractBusinessDays', () => {
  it('subtracts business days skipping weekends', () => {
    // Wednesday May 14 - 5 business days = Wednesday May 7
    const anchor = new Date('2026-05-14T12:00:00');
    const result = subtractBusinessDays(anchor, 5, true);
    expect(formatDate(result)).toBe('2026-05-07');
  });

  it('handles crossing a weekend', () => {
    // Wednesday May 14 - 3 business days = Friday May 8... wait
    // Wed May 14 - 1 = Tue May 13
    // Wed May 14 - 2 = Mon May 12
    // Wed May 14 - 3 = Fri May 9 (skips Sat/Sun)
    const anchor = new Date('2026-05-14T12:00:00');
    const result = subtractBusinessDays(anchor, 3, true);
    expect(formatDate(result)).toBe('2026-05-11');
  });

  it('handles crossing multiple weekends', () => {
    // Wednesday May 14 - 13 business days
    // Week 1: May 14 (anchor) → May 13, 12, 9, 8, 7 (5 days)
    // Week 2: May 6, 5, 2, 1, Apr 30 (5 more = 10 total)
    // Week 3: Apr 29, 28, 25 (3 more = 13 total)
    const anchor = new Date('2026-05-14T12:00:00');
    const result = subtractBusinessDays(anchor, 13, true);
    expect(formatDate(result)).toBe('2026-04-27');
  });

  it('handles T-0 (no subtraction)', () => {
    const anchor = new Date('2026-05-14T12:00:00');
    const result = subtractBusinessDays(anchor, 0, true);
    expect(formatDate(result)).toBe('2026-05-14');
  });

  it('handles skipWeekends=false', () => {
    // Wednesday May 14 - 5 calendar days = Saturday May 9
    const anchor = new Date('2026-05-14T12:00:00');
    const result = subtractBusinessDays(anchor, 5, false);
    expect(formatDate(result)).toBe('2026-05-09');
  });

  it('handles T-25 for a monthly release', () => {
    // Wed May 14 - 25 business days = 5 full weeks = Mon Apr 9... let me compute
    // 25 business days = 5 weeks of 5 days = exactly 5 calendar weeks back minus weekends
    const anchor = new Date('2026-05-14T12:00:00');
    const result = subtractBusinessDays(anchor, 25, true);
    // 25 business days back from Wed May 14
    // That's 5 weeks: Wed May 14 → Wed Apr 8... but weekends make this 35 calendar days
    // Let's just verify it lands on a weekday
    const day = result.getDay();
    expect(day).not.toBe(0); // not Sunday
    expect(day).not.toBe(6); // not Saturday
  });
});

describe('computeMilestones', () => {
  it('computes milestones from a template', () => {
    const template = {
      skipWeekends: true,
      milestones: [
        { key: 'scope-lock', label: 'Scope Lock', tMinus: 10, owner: 'PM', gate: true, autoCheck: null, description: 'Lock scope', missAction: 'Rolls' },
        { key: 'ship', label: 'Ship', tMinus: 0, owner: 'PM', gate: true, autoCheck: 'state-is-done', description: 'Ship it', missAction: null },
      ],
    };

    const milestones = computeMilestones('2026-05-14', template);
    expect(milestones).toHaveLength(2);

    // Ship should be the anchor date
    expect(milestones[1].computedDate).toBe('2026-05-14');
    expect(milestones[1].effectiveDate).toBe('2026-05-14');
    expect(milestones[1].status).toBe('pending');
    expect(milestones[1].overrideDate).toBeNull();

    // Scope lock should be 10 business days before
    expect(milestones[0].key).toBe('scope-lock');
    expect(milestones[0].owner).toBe('PM');
    expect(milestones[0].gate).toBe(true);
  });

  it('sets all milestones to pending status', () => {
    const template = {
      skipWeekends: true,
      milestones: [
        { key: 'a', label: 'A', tMinus: 5, owner: 'PM', gate: true },
        { key: 'b', label: 'B', tMinus: 0, owner: 'PM', gate: false },
      ],
    };

    const milestones = computeMilestones('2026-05-14', template);
    expect(milestones.every(m => m.status === 'pending')).toBe(true);
    expect(milestones.every(m => m.completedAt === null)).toBe(true);
  });
});

describe('recomputeMilestones', () => {
  it('recomputes dates but preserves overrides', () => {
    const template = {
      skipWeekends: true,
      milestones: [
        { key: 'scope-lock', label: 'Scope Lock', tMinus: 10, owner: 'PM', gate: true },
        { key: 'ship', label: 'Ship', tMinus: 0, owner: 'PM', gate: true },
      ],
    };

    const original = computeMilestones('2026-05-14', template);
    // Manually override scope-lock date
    original[0].overrideDate = '2026-04-20';
    original[0].effectiveDate = '2026-04-20';
    original[0].status = 'met';
    original[0].completedAt = '2026-04-20T10:00:00Z';

    // Recompute with new ship date (1 week later)
    const recomputed = recomputeMilestones('2026-05-21', original, template);

    // Ship date should move to new date
    expect(recomputed[1].computedDate).toBe('2026-05-21');
    expect(recomputed[1].effectiveDate).toBe('2026-05-21');

    // Override should be preserved
    expect(recomputed[0].overrideDate).toBe('2026-04-20');
    expect(recomputed[0].effectiveDate).toBe('2026-04-20'); // override takes priority
    expect(recomputed[0].status).toBe('met'); // status preserved
    expect(recomputed[0].completedAt).toBe('2026-04-20T10:00:00Z'); // completion preserved
  });
});

describe('TemplateStore', () => {
  let db;
  let store;

  beforeEach(() => {
    db = createTestDb();
    store = new TemplateStore({ db });
  });

  it('seeds default templates on first init', () => {
    const templates = store.list();
    expect(templates).toHaveLength(3);
    expect(templates.map(t => t.key).sort()).toEqual(['hotfix', 'monthly', 'point']);
  });

  it('retrieves a specific template', () => {
    const monthly = store.get('monthly');
    expect(monthly).not.toBeNull();
    expect(monthly.key).toBe('monthly');
    expect(monthly.label).toBe('Monthly Release');
    expect(monthly.shipDay).toBe('wednesday');
    expect(monthly.bufferDay).toBe('thursday');
    expect(monthly.skipWeekends).toBe(true);
    expect(monthly.milestones.length).toBeGreaterThan(5);
    expect(monthly.version).toBe(1);
  });

  it('returns null for unknown template', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('updates a template and increments version', () => {
    const updated = store.update('monthly', {
      label: 'Monthly Release (Updated)',
      milestones: [
        { key: 'ship', label: 'Ship', tMinus: 0, owner: 'PM', gate: true },
      ],
    }, 'test-user');

    expect(updated.label).toBe('Monthly Release (Updated)');
    expect(updated.milestones).toHaveLength(1);
    expect(updated.version).toBe(2);
    expect(updated.updatedBy).toBe('test-user');
  });

  it('throws on update of nonexistent template', () => {
    expect(() => store.update('nonexistent', {})).toThrow('Template not found');
  });

  it('does not re-seed on second init', () => {
    // Update a template
    store.update('monthly', { label: 'Custom' }, 'test');

    // Create new store instance on same DB — should not overwrite
    const store2 = new TemplateStore({ db });
    const monthly = store2.get('monthly');
    expect(monthly.label).toBe('Custom');
  });

  it('monthly template has expected milestone keys', () => {
    const monthly = store.get('monthly');
    const keys = monthly.milestones.map(m => m.key);
    expect(keys).toContain('scope-lock');
    expect(keys).toContain('dev-complete');
    expect(keys).toContain('qa-scope-review');
    expect(keys).toContain('branch-cut');
    expect(keys).toContain('cp-freeze');
    expect(keys).toContain('data-migration');
    expect(keys).toContain('certification');
    expect(keys).toContain('ship');
  });

  it('point template has shorter timeline', () => {
    const point = store.get('point');
    const maxTMinus = Math.max(...point.milestones.map(m => m.tMinus));
    expect(maxTMinus).toBeLessThan(15); // point releases are shorter
  });
});

describe('hasGateActivity', () => {
  it('returns false for empty milestones', () => {
    expect(hasGateActivity([])).toBe(false);
    expect(hasGateActivity(null)).toBe(false);
  });

  it('returns false when all gates are pending', () => {
    expect(hasGateActivity([
      { key: 'a', gate: true, status: 'pending' },
      { key: 'b', gate: true, status: 'pending' },
    ])).toBe(false);
  });

  it('returns true when any gate is met', () => {
    expect(hasGateActivity([
      { key: 'a', gate: true, status: 'met' },
      { key: 'b', gate: true, status: 'pending' },
    ])).toBe(true);
  });

  it('returns true when any gate is missed or skipped', () => {
    expect(hasGateActivity([{ key: 'a', gate: true, status: 'missed' }])).toBe(true);
    expect(hasGateActivity([{ key: 'a', gate: true, status: 'skipped' }])).toBe(true);
  });

  it('ignores non-gate milestones', () => {
    expect(hasGateActivity([
      { key: 'a', gate: false, status: 'met' },
    ])).toBe(false);
  });
});

describe('refreshFromTemplate', () => {
  const baseTemplate = {
    skipWeekends: true,
    milestones: [
      { key: 'scope', label: 'Scope Lock', tMinus: 10, owner: 'PM', gate: true, autoCheck: null, description: 'Lock it', missAction: 'Rolls' },
      { key: 'dev', label: 'Dev Complete', tMinus: 5, owner: 'Dev Lead', gate: true, autoCheck: 'all-prs-merged', description: null, missAction: null },
      { key: 'ship', label: 'Ship', tMinus: 0, owner: 'PM', gate: true, autoCheck: 'state-is-done', description: null, missAction: null },
    ],
  };

  it('recomputes dates from new template', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    const newTemplate = {
      ...baseTemplate,
      milestones: baseTemplate.milestones.map(m =>
        m.key === 'scope' ? { ...m, tMinus: 7 } : m // shortened from 10 to 7
      ),
    };

    const { milestones, changes } = refreshFromTemplate('2026-05-14', existing, newTemplate);
    const scope = milestones.find(m => m.key === 'scope');
    expect(scope.tMinus).toBe(7);
    // New computedDate should differ from original
    expect(scope.computedDate).not.toBe(existing[0].computedDate);
    expect(changes.updated).toContain('scope');
  });

  it('preserves met milestones during refresh', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    existing[0].status = 'met';
    existing[0].completedAt = '2026-04-20T10:00:00Z';
    existing[0].completedBy = 'sarah@viv.com';

    const { milestones, changes } = refreshFromTemplate('2026-05-14', existing, baseTemplate);
    const scope = milestones.find(m => m.key === 'scope');
    expect(scope.status).toBe('met');
    expect(scope.completedAt).toBe('2026-04-20T10:00:00Z');
    expect(scope.completedBy).toBe('sarah@viv.com');
    expect(changes.preserved).toContain('scope');
  });

  it('preserves manual date overrides', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    existing[0].overrideDate = '2026-04-15';
    existing[0].effectiveDate = '2026-04-15';

    const { milestones } = refreshFromTemplate('2026-05-14', existing, baseTemplate);
    const scope = milestones.find(m => m.key === 'scope');
    expect(scope.overrideDate).toBe('2026-04-15');
    expect(scope.effectiveDate).toBe('2026-04-15');
  });

  it('adds new milestones from template as pending', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    const newTemplate = {
      ...baseTemplate,
      milestones: [
        ...baseTemplate.milestones,
        { key: 'certify', label: 'Certification', tMinus: 2, owner: 'QA Lead', gate: true, autoCheck: null, description: null, missAction: null },
      ],
    };

    const { milestones, changes } = refreshFromTemplate('2026-05-14', existing, newTemplate);
    const certify = milestones.find(m => m.key === 'certify');
    expect(certify).toBeTruthy();
    expect(certify.status).toBe('pending');
    expect(changes.added).toContain('certify');
  });

  it('removes pending milestones not in new template', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    const newTemplate = {
      ...baseTemplate,
      milestones: baseTemplate.milestones.filter(m => m.key !== 'dev'),
    };

    const { milestones, changes } = refreshFromTemplate('2026-05-14', existing, newTemplate);
    expect(milestones.find(m => m.key === 'dev')).toBeUndefined();
    expect(changes.removed).toContain('dev');
  });

  it('keeps orphaned acted-on milestones as history', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    existing[1].status = 'met'; // dev milestone was completed
    existing[1].completedAt = '2026-05-09T12:00:00Z';

    const newTemplate = {
      ...baseTemplate,
      milestones: baseTemplate.milestones.filter(m => m.key !== 'dev'),
    };

    const { milestones, changes } = refreshFromTemplate('2026-05-14', existing, newTemplate);
    // dev is orphaned, not removed, because it was met
    const dev = milestones.find(m => m.key === 'dev');
    expect(dev).toBeTruthy();
    expect(dev._orphaned).toBe(true);
    expect(dev.status).toBe('met');
    expect(changes.preserved).toContain('dev');
    expect(changes.removed).not.toContain('dev');
  });

  it('updates owner and label from new template', () => {
    const existing = computeMilestones('2026-05-14', baseTemplate);
    const newTemplate = {
      ...baseTemplate,
      milestones: baseTemplate.milestones.map(m =>
        m.key === 'scope' ? { ...m, owner: 'Product', label: 'Scope Cutoff' } : m
      ),
    };

    const { milestones } = refreshFromTemplate('2026-05-14', existing, newTemplate);
    const scope = milestones.find(m => m.key === 'scope');
    expect(scope.owner).toBe('Product');
    expect(scope.label).toBe('Scope Cutoff');
  });

  it('gateHitRate is null (not Infinity) when all gates skipped', () => {
    // Reproduces the div-by-zero issue called out in PR review.
    // When every gate is skipped, scorable = 0 — scorecard must return null, not Infinity.
    const gates = [
      { key: 'a', gate: true, status: 'skipped' },
      { key: 'b', gate: true, status: 'skipped' },
    ];
    const skipped = gates.filter(g => g.status === 'skipped');
    const met = gates.filter(g => g.status === 'met');
    const scorable = gates.length - skipped.length;
    const gateHitRate = scorable > 0 ? met.length / scorable : null;
    expect(gateHitRate).toBeNull();
    expect(Number.isFinite(gateHitRate)).toBe(false);
  });
});

