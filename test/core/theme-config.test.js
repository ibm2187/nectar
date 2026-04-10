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

  it('autoGenerate creates themes grouped by prefix', () => {
    tc.autoGenerate(['RCM - Billing', 'RCM - Payroll', 'Ascend - Billing', 'Portal - Dashboard']);
    expect(tc.themes.length).toBeGreaterThan(0);
    // Groups by prefix: "RCM" should contain both RCM components
    const rcm = tc.themes.find(t => t.name === 'RCM');
    expect(rcm).toBeDefined();
    expect(rcm.components).toContain('RCM - Billing');
    expect(rcm.components).toContain('RCM - Payroll');
    // Ascend is its own group
    const ascend = tc.themes.find(t => t.name === 'Ascend');
    expect(ascend).toBeDefined();
    expect(ascend.components).toContain('Ascend - Billing');
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

  describe('suggestThemes (static)', () => {
    const ThemeConfig = require('../../src/core/theme-config');

    it('groups by prefix before dash separator', () => {
      const suggestions = ThemeConfig.suggestThemes([
        'RCM - Billing', 'RCM - Payroll', 'Ascend - Invoices',
      ]);
      expect(suggestions.find(t => t.name === 'RCM')).toBeDefined();
      expect(suggestions.find(t => t.name === 'RCM').components).toHaveLength(2);
      expect(suggestions.find(t => t.name === 'Ascend')).toBeDefined();
    });

    it('merges bare components into matching prefix group', () => {
      const suggestions = ThemeConfig.suggestThemes([
        'Messages', 'Messages - Chat', 'Messages - SMS',
      ]);
      const msgs = suggestions.find(t => t.name === 'Messages');
      expect(msgs).toBeDefined();
      expect(msgs.components).toHaveLength(3);
      expect(msgs.components).toContain('Messages');
    });

    it('groups by first word for non-dash components', () => {
      const suggestions = ThemeConfig.suggestThemes([
        'AI Agents', 'AI CoPilot', 'AI Forms',
      ]);
      const ai = suggestions.find(t => t.name === 'AI');
      expect(ai).toBeDefined();
      expect(ai.components).toHaveLength(3);
    });

    it('puts true singletons in General', () => {
      const suggestions = ThemeConfig.suggestThemes([
        'Compliance', 'DevOps', 'OVM',
      ]);
      const general = suggestions.find(t => t.name === 'General');
      expect(general).toBeDefined();
      expect(general.components).toContain('Compliance');
    });

    it('excludes already-mapped components', () => {
      const existing = [{ name: 'RCM', components: ['RCM - Billing'], icon: null }];
      const suggestions = ThemeConfig.suggestThemes(
        ['RCM - Billing', 'RCM - Payroll', 'Ascend - Invoices'],
        existing,
      );
      // RCM - Billing is already mapped, so only RCM - Payroll should appear
      const rcm = suggestions.find(t => t.name === 'RCM');
      expect(rcm).toBeDefined();
      expect(rcm.components).toEqual(['RCM - Payroll']);
      expect(rcm.components).not.toContain('RCM - Billing');
    });

    it('returns empty when all components are mapped', () => {
      const existing = [{ name: 'All', components: ['A', 'B'], icon: null }];
      expect(ThemeConfig.suggestThemes(['A', 'B'], existing)).toEqual([]);
    });
  });
});
