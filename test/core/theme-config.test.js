import { describe, it, expect, beforeEach, vi } from 'vitest';

const ThemeConfig = require('../../src/core/theme-config');

describe('ThemeConfig', () => {
  let tc;

  beforeEach(() => {
    tc = new ThemeConfig();
    // Reset to clean state regardless of what was loaded from disk
    tc.themes = [];
    tc.unmappedLabel = 'Other';
    tc.updatedAt = null;
  });

  it('starts with defaults after reset', () => {
    expect(tc.themes).toEqual([]);
    expect(tc.unmappedLabel).toBe('Other');
  });

  it('resolveComponent returns unmappedLabel for null', () => {
    expect(tc.resolveComponent(null)).toBe('Other');
    expect(tc.resolveComponent(undefined)).toBe('Other');
  });

  it('resolveComponent returns unmappedLabel for unknown component', () => {
    tc.themes = [{ name: 'Billing', components: ['RCM - Billing'], icon: null }];
    expect(tc.resolveComponent('Unknown Component')).toBe('Other');
  });

  it('resolveComponent matches case-insensitively', () => {
    tc.themes = [{ name: 'EVV', components: ['Ascend - EVV'], icon: null }];
    expect(tc.resolveComponent('ascend - evv')).toBe('EVV');
    expect(tc.resolveComponent('ASCEND - EVV')).toBe('EVV');
  });

  it('resolveComponent returns first matching theme', () => {
    tc.themes = [
      { name: 'A', components: ['comp1'], icon: null },
      { name: 'B', components: ['comp1'], icon: null },
    ];
    expect(tc.resolveComponent('comp1')).toBe('A');
  });

  it('autoGenerate creates themes from components', () => {
    tc.autoGenerate(['RCM - Billing', 'Ascend - Billing', 'Portal - Dashboard']);
    expect(tc.themes.length).toBeGreaterThan(0);
    // "Billing" should group RCM and Ascend
    const billing = tc.themes.find(t => t.name === 'Billing');
    expect(billing).toBeDefined();
    expect(billing.components).toContain('RCM - Billing');
    expect(billing.components).toContain('Ascend - Billing');
  });

  it('autoGenerate does not overwrite existing config', () => {
    tc.themes = [{ name: 'Existing', components: ['x'], icon: null }];
    tc.autoGenerate(['RCM - New']);
    expect(tc.themes).toHaveLength(1);
    expect(tc.themes[0].name).toBe('Existing');
  });

  it('setConfig updates themes and unmappedLabel', () => {
    tc.setConfig({
      themes: [{ name: 'T1', components: ['c1'], icon: '🎯' }],
      unmappedLabel: 'Uncategorized',
    });
    expect(tc.themes).toHaveLength(1);
    expect(tc.unmappedLabel).toBe('Uncategorized');
    expect(tc.updatedAt).not.toBeNull();
  });

  it('getConfig returns current state', () => {
    tc.themes = [{ name: 'T', components: [], icon: null }];
    const cfg = tc.getConfig();
    expect(cfg.themes).toEqual(tc.themes);
    expect(cfg.unmappedLabel).toBe('Other');
  });

  it('autoGenerate persists to disk', () => {
    const fs = require('fs');
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

    tc.autoGenerate(['RCM - Billing']);
    expect(writeSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();
    // Verify tmp file pattern
    expect(writeSpy.mock.calls[0][0]).toMatch(/\.tmp$/);

    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });
});
