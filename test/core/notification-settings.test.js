import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-notification-settings.json');
const NotificationSettings = require('../../src/core/notification-settings');

describe('NotificationSettings', () => {
  let settings;
  let originalState;

  beforeEach(() => {
    if (fs.existsSync(STATE_FILE)) {
      originalState = fs.readFileSync(STATE_FILE, 'utf8');
      fs.unlinkSync(STATE_FILE);
    } else {
      originalState = null;
    }
    settings = new NotificationSettings();
  });

  afterEach(() => {
    if (originalState !== null) {
      fs.writeFileSync(STATE_FILE, originalState);
    } else if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  describe('defaults', () => {
    it('starts with master toggle enabled', () => {
      expect(settings.enabled).toBe(true);
    });

    it('starts with all channels enabled', () => {
      expect(settings.get('releases')).toBe(true);
      expect(settings.get('deploys')).toBe(true);
      expect(settings.get('releaseStatus')).toBe(true);
      expect(settings.get('buildFailures')).toBe(true);
      expect(settings.get('dailyDigest')).toBe(true);
    });

    it('returns true for unknown channel types (safe default)', () => {
      expect(settings.get('unknownType')).toBe(true);
    });
  });

  describe('master toggle', () => {
    it('disables all channels when master is off', () => {
      settings.update({ enabled: false });
      expect(settings.get('releases')).toBe(false);
      expect(settings.get('deploys')).toBe(false);
      expect(settings.get('buildFailures')).toBe(false);
    });

    it('master off overrides per-channel enabled state', () => {
      settings.set('releases', true);
      settings.update({ enabled: false });
      expect(settings.get('releases')).toBe(false);
    });

    it('re-enabling master restores per-channel state', () => {
      settings.set('deploys', false);
      settings.update({ enabled: false });
      expect(settings.get('deploys')).toBe(false);
      settings.update({ enabled: true });
      expect(settings.get('deploys')).toBe(false); // channel still explicitly off
      expect(settings.get('releases')).toBe(true);  // channel still on
    });
  });

  describe('set / get', () => {
    it('toggles a channel off', () => {
      settings.set('deploys', false);
      expect(settings.get('deploys')).toBe(false);
    });

    it('ignores unknown channel keys', () => {
      settings.set('bogus', false);
      expect(settings.channels.bogus).toBeUndefined();
    });
  });

  describe('update', () => {
    it('bulk updates channels', () => {
      settings.update({ channels: { releases: false, deploys: false } });
      expect(settings.get('releases')).toBe(false);
      expect(settings.get('deploys')).toBe(false);
      expect(settings.get('releaseStatus')).toBe(true); // unchanged
    });

    it('ignores non-boolean channel values', () => {
      settings.update({ channels: { releases: 'no' } });
      expect(settings.get('releases')).toBe(true); // unchanged
    });

    it('updates both master and channels together', () => {
      settings.update({ enabled: false, channels: { releases: false } });
      expect(settings.enabled).toBe(false);
      expect(settings.channels.releases).toBe(false);
    });
  });

  describe('getAll', () => {
    it('returns enabled flag plus all channels', () => {
      const all = settings.getAll();
      expect(all.enabled).toBe(true);
      expect(all.channels).toHaveProperty('releases');
      expect(all.channels).toHaveProperty('buildFailures');
      expect(all.channels).toHaveProperty('dailyDigest');
    });

    it('returns a copy, not a reference', () => {
      const all = settings.getAll();
      all.channels.releases = false;
      expect(settings.get('releases')).toBe(true); // original unchanged
    });
  });

  describe('persistence', () => {
    it('saves to disk on update', () => {
      settings.update({ enabled: false });
      expect(fs.existsSync(STATE_FILE)).toBe(true);
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      expect(data.enabled).toBe(false);
    });

    it('loads state on construction', () => {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        enabled: false,
        channels: { releases: false, deploys: true, releaseStatus: false },
      }));
      const fresh = new NotificationSettings();
      expect(fresh.enabled).toBe(false);
      expect(fresh.channels.releases).toBe(false);
      expect(fresh.channels.releaseStatus).toBe(false);
    });

    it('handles missing state file gracefully', () => {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
      const fresh = new NotificationSettings();
      expect(fresh.enabled).toBe(true);
    });

    it('handles corrupt state file gracefully', () => {
      fs.writeFileSync(STATE_FILE, 'not valid json');
      const fresh = new NotificationSettings();
      expect(fresh.enabled).toBe(true); // falls back to defaults
    });

    it('flush saves current state', () => {
      settings.enabled = false;
      settings.flush();
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      expect(data.enabled).toBe(false);
    });
  });
});
