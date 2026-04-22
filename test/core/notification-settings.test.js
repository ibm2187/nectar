import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const NotificationSettings = require('../../src/core/notification-settings');

/**
 * Helper: create a fresh NotificationSettings with an in-memory DB
 * and a controlled NODE_ENV.
 */
function freshSettings(nodeEnv, db) {
  const orig = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return new NotificationSettings({ db });
  } finally {
    process.env.NODE_ENV = orig;
  }
}

describe('NotificationSettings (grouped model)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ok */ }
  });

  // ── Production defaults ──────────────────────────────

  describe('production defaults', () => {
    it('master toggle defaults to true', () => {
      const s = freshSettings('production', db);
      expect(s.enabled).toBe(true);
    });

    it('all groups default to enabled', () => {
      const s = freshSettings('production', db);
      const all = s.getAll();
      for (const groupKey of Object.keys(all.groups)) {
        expect(all.groups[groupKey].enabled).toBe(true);
      }
    });

    it('all notifications default to enabled', () => {
      const s = freshSettings('production', db);
      expect(s.get('transitions')).toBe(true);
      expect(s.get('deploys')).toBe(true);
      expect(s.get('dateChanges')).toBe(true);
      expect(s.get('envDeployments')).toBe(true);
      expect(s.get('releaseStatus')).toBe(true);
      expect(s.get('ticketChanges')).toBe(true);
      expect(s.get('dailyDigest')).toBe(true);
      expect(s.get('buildFailures')).toBe(true);
      expect(s.get('cherryPickConflicts')).toBe(true);
      // Environment alerts group (added 2026-04-22)
      expect(s.get('envUnhealthy')).toBe(true);
      expect(s.get('envRecovered')).toBe(true);
      expect(s.get('envSustained')).toBe(true);
    });

    it('environmentAlerts group is present in schema', () => {
      const s = freshSettings('production', db);
      const schema = s.getSchema();
      expect(schema.environmentAlerts).toBeDefined();
      expect(schema.environmentAlerts.notifications.envUnhealthy).toBeDefined();
      expect(schema.environmentAlerts.notifications.envRecovered).toBeDefined();
      expect(schema.environmentAlerts.notifications.envSustained).toBeDefined();
    });

    it('disabling environmentAlerts group hides all env alert toggles', () => {
      const s = freshSettings('production', db);
      s.setGroup('environmentAlerts', false);
      expect(s.get('envUnhealthy')).toBe(false);
      expect(s.get('envRecovered')).toBe(false);
      expect(s.get('envSustained')).toBe(false);
    });

    it('redirect fields default to null', () => {
      const s = freshSettings('production', db);
      const all = s.getAll();
      expect(all.redirectChannel).toBeNull();
      expect(all.redirectDM).toBeNull();
    });
  });

  // ── Non-production defaults ──────────────────────────

  describe('non-production defaults', () => {
    it('master toggle still defaults to true', () => {
      const s = freshSettings('development', db);
      expect(s.enabled).toBe(true);
    });

    it('all groups default to disabled', () => {
      const s = freshSettings('development', db);
      const all = s.getAll();
      for (const groupKey of Object.keys(all.groups)) {
        expect(all.groups[groupKey].enabled).toBe(false);
      }
    });

    it('all notifications default to disabled', () => {
      const s = freshSettings('development', db);
      expect(s.get('transitions')).toBe(false);
      expect(s.get('deploys')).toBe(false);
      expect(s.get('dailyDigest')).toBe(false);
      expect(s.get('buildFailures')).toBe(false);
      expect(s.get('cherryPickConflicts')).toBe(false);
    });
  });

  // ── Group parent toggles ─────────────────────────────

  describe('group parent toggles', () => {
    it('disabling a group makes all its children return false via get()', () => {
      const s = freshSettings('production', db);
      s.setGroup('releaseChannel', false);
      expect(s.get('transitions')).toBe(false);
      expect(s.get('deploys')).toBe(false);
      expect(s.get('dateChanges')).toBe(false);
      expect(s.get('envDeployments')).toBe(false);
    });

    it('does not affect other groups', () => {
      const s = freshSettings('production', db);
      s.setGroup('releaseChannel', false);
      expect(s.get('dailyDigest')).toBe(true);
      expect(s.get('buildFailures')).toBe(true);
    });

    it('re-enabling group restores child states', () => {
      const s = freshSettings('production', db);
      s.set('transitions', false);       // disable one child
      s.setGroup('releaseChannel', false); // disable group
      expect(s.get('transitions')).toBe(false);
      s.setGroup('releaseChannel', true);  // re-enable group
      expect(s.get('transitions')).toBe(false); // child still off
      expect(s.get('deploys')).toBe(true);       // other child still on
    });
  });

  // ── Master toggle ────────────────────────────────────

  describe('master toggle', () => {
    it('disables everything when off', () => {
      const s = freshSettings('production', db);
      s.update({ enabled: false });
      expect(s.get('transitions')).toBe(false);
      expect(s.get('dailyDigest')).toBe(false);
      expect(s.get('buildFailures')).toBe(false);
    });

    it('re-enabling restores per-group and per-child state', () => {
      const s = freshSettings('production', db);
      s.set('deploys', false);
      s.setGroup('developerAlerts', false);
      s.update({ enabled: false });
      expect(s.get('transitions')).toBe(false);
      s.update({ enabled: true });
      expect(s.get('transitions')).toBe(true);
      expect(s.get('deploys')).toBe(false);      // child explicitly off
      expect(s.get('dailyDigest')).toBe(false);   // group off
    });
  });

  // ── set / get ────────────────────────────────────────

  describe('set / get', () => {
    it('toggles individual children', () => {
      const s = freshSettings('production', db);
      s.set('deploys', false);
      expect(s.get('deploys')).toBe(false);
      s.set('deploys', true);
      expect(s.get('deploys')).toBe(true);
    });

    it('unknown keys return false', () => {
      const s = freshSettings('production', db);
      expect(s.get('unknownKey')).toBe(false);
    });
  });

  // ── Redirect overrides ───────────────────────────────

  describe('redirect overrides', () => {
    it('stores and returns redirectChannel', () => {
      const s = freshSettings('production', db);
      s.update({ redirectChannel: '#test-notifications' });
      expect(s.getAll().redirectChannel).toBe('#test-notifications');
    });

    it('stores and returns redirectDM', () => {
      const s = freshSettings('production', db);
      s.update({ redirectDM: 'U12345678' });
      expect(s.getAll().redirectDM).toBe('U12345678');
    });

    it('clears with null', () => {
      const s = freshSettings('production', db);
      s.update({ redirectChannel: '#test' });
      s.update({ redirectChannel: null });
      expect(s.getAll().redirectChannel).toBeNull();
    });

    it('coerces empty string to null', () => {
      const s = freshSettings('production', db);
      s.update({ redirectChannel: '' });
      expect(s.getAll().redirectChannel).toBeNull();
    });
  });

  // ── getAll ───────────────────────────────────────────

  describe('getAll', () => {
    it('returns full grouped structure', () => {
      const s = freshSettings('production', db);
      const all = s.getAll();
      expect(all).toHaveProperty('enabled');
      expect(all).toHaveProperty('redirectChannel');
      expect(all).toHaveProperty('redirectDM');
      expect(all).toHaveProperty('groups');
      expect(all.groups).toHaveProperty('releaseChannel');
      expect(all.groups).toHaveProperty('scheduledReports');
      expect(all.groups).toHaveProperty('developerAlerts');
    });

    it('returns a deep copy', () => {
      const s = freshSettings('production', db);
      const all = s.getAll();
      all.groups.releaseChannel.enabled = false;
      expect(s.getAll().groups.releaseChannel.enabled).toBe(true);
    });
  });

  // ── getSchema ────────────────────────────────────────

  describe('getSchema', () => {
    it('returns GROUP_SCHEMA with labels and descriptions', () => {
      const s = freshSettings('production', db);
      const schema = s.getSchema();
      expect(schema).toHaveProperty('releaseChannel');
      expect(schema.releaseChannel.label).toBe('Release Channel');
      expect(schema.releaseChannel.notifications).toHaveProperty('transitions');
      expect(schema.releaseChannel.notifications.transitions.label).toBeTruthy();
    });

    it('schema is frozen (immutable)', () => {
      const s = freshSettings('production', db);
      const schema = s.getSchema();
      expect(() => { schema.releaseChannel.label = 'MODIFIED'; }).toThrow();
    });
  });

  // ── update (bulk) ────────────────────────────────────

  describe('update', () => {
    it('bulk updates groups and children', () => {
      const s = freshSettings('production', db);
      s.update({
        groups: {
          releaseChannel: {
            enabled: false,
            notifications: { transitions: false },
          },
          developerAlerts: {
            notifications: { buildFailures: false },
          },
        },
      });
      expect(s.getAll().groups.releaseChannel.enabled).toBe(false);
      expect(s.getAll().groups.releaseChannel.notifications.transitions).toBe(false);
      expect(s.getAll().groups.developerAlerts.notifications.buildFailures).toBe(false);
      // Unchanged
      expect(s.getAll().groups.developerAlerts.enabled).toBe(true);
      expect(s.getAll().groups.developerAlerts.notifications.dailyDigest).toBe(true);
    });
  });

  // ── Persistence (SQLite) ─────────────────────────────

  describe('persistence', () => {
    it('saves to DB on update', () => {
      const s = freshSettings('production', db);
      s.update({ enabled: false });
      const row = db.prepare('SELECT * FROM notification_settings WHERE id = 1').get();
      expect(row).toBeTruthy();
      expect(row.enabled).toBe(0);
    });

    it('loads state on new construction with same DB', () => {
      const s1 = freshSettings('production', db);
      s1.set('transitions', false);
      s1.update({ redirectChannel: '#test-redirect' });

      const s2 = freshSettings('production', db);
      expect(s2.get('transitions')).toBe(false);
      expect(s2.getAll().redirectChannel).toBe('#test-redirect');
    });

    it('handles empty DB gracefully (no row = defaults)', () => {
      const s = freshSettings('production', db);
      expect(s.enabled).toBe(true);
      expect(s.get('transitions')).toBe(true);
    });

    it('non-production loads persisted state (new behavior)', () => {
      // Save non-default state with production env
      const s1 = freshSettings('production', db);
      s1.set('dailyDigest', false);  // override production default (true → false)

      // Load with development env — should load persisted state, not dev defaults
      const s2 = freshSettings('development', db);
      // dailyDigest was explicitly set to false; dev default is also false,
      // but the group enabled state was persisted as true (production default)
      expect(s2.getAll().groups.developerAlerts.enabled).toBe(true);
      expect(s2.getAll().groups.developerAlerts.notifications.dailyDigest).toBe(false);
    });
  });
});
