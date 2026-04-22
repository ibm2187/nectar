import { describe, it, expect } from 'vitest';

const { getCapabilities, isValidCapability, getAllCapabilityIds } = require('../../src/core/capabilities');

describe('capabilities', () => {
  describe('getCapabilities', () => {
    it('returns all 8 capabilities', () => {
      const caps = getCapabilities();
      expect(caps).toHaveLength(8);
    });

    it('each capability has required fields', () => {
      for (const cap of getCapabilities()) {
        expect(cap.id).toBeTruthy();
        expect(cap.name).toBeTruthy();
        expect(cap.description).toBeTruthy();
        expect(cap.namespace).toBeTruthy();
      }
    });

    it('capability namespaces match id prefix', () => {
      for (const cap of getCapabilities()) {
        const prefix = cap.id.split('.')[0];
        expect(cap.namespace).toBe(prefix);
      }
    });

    it('capability ids are unique', () => {
      const ids = getCapabilities().map(c => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('contains the expected capability ids', () => {
      const ids = getCapabilities().map(c => c.id);
      expect(ids).not.toContain('config.read');
      expect(ids).toContain('config.write');
      expect(ids).toContain('release.write');
      expect(ids).toContain('environment.write');
      expect(ids).toContain('sync.trigger');
      expect(ids).toContain('task.write');
      expect(ids).toContain('notify.send');
      expect(ids).toContain('user.admin');
      expect(ids).toContain('system.admin');
    });
  });

  describe('isValidCapability', () => {
    it('returns true for valid capability ids', () => {
      expect(isValidCapability('config.write')).toBe(true);
      expect(isValidCapability('release.write')).toBe(true);
      expect(isValidCapability('user.admin')).toBe(true);
    });

    it('returns false for invalid capability ids', () => {
      expect(isValidCapability('nonexistent')).toBe(false);
      expect(isValidCapability('')).toBe(false);
      expect(isValidCapability('config.read')).toBe(false);
    });
  });

  describe('getAllCapabilityIds', () => {
    it('returns array of all capability id strings', () => {
      const ids = getAllCapabilityIds();
      expect(ids).toHaveLength(8);
      expect(ids).not.toContain('config.read');
      expect(ids).toContain('system.admin');
    });
  });
});
