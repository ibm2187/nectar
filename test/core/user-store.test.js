import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-users.json');

// Must require after potential mocking
const UserStore = require('../../src/core/user-store');

describe('UserStore', () => {
  let store;
  let originalState;
  let originalEnv;

  beforeEach(() => {
    // Preserve original env
    originalEnv = { ...process.env };

    // Preserve any existing state file
    if (fs.existsSync(STATE_FILE)) {
      originalState = fs.readFileSync(STATE_FILE, 'utf8');
    }

    // Clear NECTAR_ADMINS so tests can set it explicitly
    delete process.env.NECTAR_ADMINS;

    store = new UserStore();
    store.users.clear();
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;

    // Restore original state file
    if (originalState) {
      fs.writeFileSync(STATE_FILE, originalState);
    } else if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
    originalState = undefined;
    vi.restoreAllMocks();
  });

  describe('upsertOnLogin', () => {
    it('creates a new user with correct defaults', () => {
      const user = store.upsertOnLogin('User@Test.com', 'Test User', 'https://pic.url/avatar.png');

      expect(user.email).toBe('user@test.com'); // lowercased
      expect(user.name).toBe('Test User');
      expect(user.picture).toBe('https://pic.url/avatar.png');
      expect(user.role).toBe('user');
      expect(user.lastLoginAt).toBeTruthy();
      expect(user.createdAt).toBeTruthy();
    });

    it('sets default permissions on new user (all pages enabled)', () => {
      const user = store.upsertOnLogin('new@test.com', 'New User', null);

      expect(user.permissions.releases).toBe(true);
      expect(user.permissions.roadmap).toBe(true);
      expect(user.permissions.tickets).toBe(true);
      expect(user.permissions.environments).toBe(true);
      expect(user.permissions.features).toBe(true);
      expect(user.permissions.integrations).toBe(true);
      expect(user.permissions.issues).toBe(true);
      expect(user.permissions.tasks).toBe(true);
    });

    it('updates existing user on subsequent login', () => {
      store.upsertOnLogin('user@test.com', 'Original Name', null);
      const firstCreatedAt = store.getUser('user@test.com').createdAt;

      const updated = store.upsertOnLogin('user@test.com', 'Updated Name', 'https://new.pic');

      expect(updated.name).toBe('Updated Name');
      expect(updated.picture).toBe('https://new.pic');
      // lastLoginAt is always updated (even if same ms, it was called)
      expect(updated.lastLoginAt).toBeTruthy();
      // createdAt should not change
      expect(updated.createdAt).toBe(firstCreatedAt);
      // Should still be same user record (1 user total)
      expect(store.listUsers()).toHaveLength(1);
    });

    it('preserves existing name if new name is empty', () => {
      store.upsertOnLogin('user@test.com', 'Good Name', null);
      store.upsertOnLogin('user@test.com', '', null);

      expect(store.getUser('user@test.com').name).toBe('Good Name');
    });

    it('preserves existing picture if new picture is null', () => {
      store.upsertOnLogin('user@test.com', 'User', 'https://pic.url');
      store.upsertOnLogin('user@test.com', 'User', null);

      expect(store.getUser('user@test.com').picture).toBe('https://pic.url');
    });

    it('normalizes email to lowercase', () => {
      store.upsertOnLogin('USER@TEST.COM', 'User', null);
      expect(store.getUser('user@test.com')).not.toBeNull();
      expect(store.getUser('USER@TEST.COM')).not.toBeNull();
    });

    it('uses email as name when name is not provided for new user', () => {
      const user = store.upsertOnLogin('noname@test.com', null, null);
      expect(user.name).toBe('noname@test.com');
    });
  });

  describe('getUser', () => {
    it('returns user by email', () => {
      store.upsertOnLogin('user@test.com', 'Test User', null);
      const user = store.getUser('user@test.com');

      expect(user).not.toBeNull();
      expect(user.email).toBe('user@test.com');
      expect(user.name).toBe('Test User');
    });

    it('returns null for unknown email', () => {
      expect(store.getUser('nonexistent@test.com')).toBeNull();
    });

    it('returns null for null/undefined email', () => {
      expect(store.getUser(null)).toBeNull();
      expect(store.getUser(undefined)).toBeNull();
    });

    it('is case-insensitive', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      expect(store.getUser('USER@TEST.COM')).not.toBeNull();
      expect(store.getUser('User@Test.Com')).not.toBeNull();
    });
  });

  describe('listUsers', () => {
    it('returns all users', () => {
      store.upsertOnLogin('alice@test.com', 'Alice', null);
      store.upsertOnLogin('bob@test.com', 'Bob', null);
      store.upsertOnLogin('charlie@test.com', 'Charlie', null);

      const users = store.listUsers();
      expect(users).toHaveLength(3);
    });

    it('returns users sorted by lastLoginAt descending', () => {
      store.upsertOnLogin('alice@test.com', 'Alice', null);
      // Manually set Alice's lastLoginAt to an older timestamp
      const alice = store.getUser('alice@test.com');
      alice.lastLoginAt = '2026-01-01T00:00:00.000Z';

      store.upsertOnLogin('bob@test.com', 'Bob', null);

      const users = store.listUsers();
      expect(users[0].email).toBe('bob@test.com');
      expect(users[1].email).toBe('alice@test.com');
    });

    it('returns empty array when no users', () => {
      expect(store.listUsers()).toEqual([]);
    });
  });

  describe('updateUser', () => {
    it('updates role to admin', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      const updated = store.updateUser('user@test.com', { role: 'admin' });

      expect(updated.role).toBe('admin');
    });

    it('updates role to user', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      store.updateUser('user@test.com', { role: 'admin' });
      const updated = store.updateUser('user@test.com', { role: 'user' });

      expect(updated.role).toBe('user');
    });

    it('ignores invalid role values', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      store.updateUser('user@test.com', { role: 'superadmin' });

      expect(store.getUser('user@test.com').role).toBe('user');
    });

    it('updates specific permissions', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      store.updateUser('user@test.com', {
        permissions: { releases: false, roadmap: false },
      });

      const user = store.getUser('user@test.com');
      expect(user.permissions.releases).toBe(false);
      expect(user.permissions.roadmap).toBe(false);
      // Unchanged permissions should remain true
      expect(user.permissions.tickets).toBe(true);
      expect(user.permissions.environments).toBe(true);
    });

    it('ignores unknown permission keys', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      store.updateUser('user@test.com', {
        permissions: { unknownPage: true },
      });

      const user = store.getUser('user@test.com');
      expect(user.permissions.unknownPage).toBeUndefined();
    });

    it('ignores non-boolean permission values', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      store.updateUser('user@test.com', {
        permissions: { releases: 'yes' },
      });

      // Should remain the default true
      expect(store.getUser('user@test.com').permissions.releases).toBe(true);
    });

    it('returns null for unknown user', () => {
      expect(store.updateUser('nonexistent@test.com', { role: 'admin' })).toBeNull();
    });

    it('is case-insensitive on email', () => {
      store.upsertOnLogin('user@test.com', 'Test', null);
      const updated = store.updateUser('USER@TEST.COM', { role: 'admin' });

      expect(updated).not.toBeNull();
      expect(updated.role).toBe('admin');
    });
  });

  describe('getRole', () => {
    it('returns admin when email is in NECTAR_ADMINS env var', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com, other@test.com';
      expect(store.getRole('admin@test.com')).toBe('admin');
    });

    it('returns admin for everyone when no NECTAR_ADMINS configured', () => {
      delete process.env.NECTAR_ADMINS;
      expect(store.getRole('anyone@test.com')).toBe('admin');
    });

    it('returns admin for everyone when NECTAR_ADMINS is empty string', () => {
      process.env.NECTAR_ADMINS = '';
      expect(store.getRole('anyone@test.com')).toBe('admin');
    });

    it('returns user role from stored record when not in env admins', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      store.upsertOnLogin('user@test.com', 'User', null);

      expect(store.getRole('user@test.com')).toBe('user');
    });

    it('returns admin from stored role even when not in NECTAR_ADMINS', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      store.upsertOnLogin('promoted@test.com', 'Promoted', null);
      store.updateUser('promoted@test.com', { role: 'admin' });

      expect(store.getRole('promoted@test.com')).toBe('admin');
    });

    it('defaults to user when not in env admins and no stored record', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      expect(store.getRole('unknown@test.com')).toBe('user');
    });

    it('returns user for null email', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      expect(store.getRole(null)).toBe('user');
    });

    it('is case-insensitive for env admin matching', () => {
      process.env.NECTAR_ADMINS = 'Admin@Test.Com';
      expect(store.getRole('admin@test.com')).toBe('admin');
      expect(store.getRole('ADMIN@TEST.COM')).toBe('admin');
    });
  });

  describe('getPermissions', () => {
    it('returns all permissions true for admins', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      const perms = store.getPermissions('admin@test.com');

      expect(perms.releases).toBe(true);
      expect(perms.roadmap).toBe(true);
      expect(perms.tickets).toBe(true);
      expect(perms.environments).toBe(true);
      expect(perms.features).toBe(true);
      expect(perms.integrations).toBe(true);
      expect(perms.issues).toBe(true);
      expect(perms.tasks).toBe(true);
    });

    it('returns stored permissions for regular users', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      store.upsertOnLogin('user@test.com', 'User', null);
      store.updateUser('user@test.com', {
        permissions: { releases: false, roadmap: false },
      });

      const perms = store.getPermissions('user@test.com');
      expect(perms.releases).toBe(false);
      expect(perms.roadmap).toBe(false);
      expect(perms.tickets).toBe(true); // default
    });

    it('returns default permissions for unknown users', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      const perms = store.getPermissions('unknown@test.com');

      // Unknown users get all defaults (all true)
      expect(perms.releases).toBe(true);
      expect(perms.roadmap).toBe(true);
    });

    it('fills in missing permission keys with defaults', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      store.upsertOnLogin('user@test.com', 'User', null);
      // Simulate a user with only some permissions stored
      const user = store.getUser('user@test.com');
      user.permissions = { releases: false }; // missing other keys

      const perms = store.getPermissions('user@test.com');
      expect(perms.releases).toBe(false);
      expect(perms.roadmap).toBe(true); // filled in as default
      expect(perms.tickets).toBe(true);
    });
  });

  describe('isEnvAdmin', () => {
    it('returns true when email is in NECTAR_ADMINS', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com, other@test.com';
      expect(store.isEnvAdmin('admin@test.com')).toBe(true);
      expect(store.isEnvAdmin('other@test.com')).toBe(true);
    });

    it('returns false when email is not in NECTAR_ADMINS', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      expect(store.isEnvAdmin('user@test.com')).toBe(false);
    });

    it('returns true for everyone when NECTAR_ADMINS is not set', () => {
      delete process.env.NECTAR_ADMINS;
      expect(store.isEnvAdmin('anyone@test.com')).toBe(true);
    });

    it('returns true for everyone when NECTAR_ADMINS is empty', () => {
      process.env.NECTAR_ADMINS = '';
      expect(store.isEnvAdmin('anyone@test.com')).toBe(true);
    });

    it('returns false for null email', () => {
      process.env.NECTAR_ADMINS = 'admin@test.com';
      expect(store.isEnvAdmin(null)).toBe(false);
    });

    it('is case-insensitive', () => {
      process.env.NECTAR_ADMINS = 'Admin@Test.Com';
      expect(store.isEnvAdmin('admin@test.com')).toBe(true);
      expect(store.isEnvAdmin('ADMIN@TEST.COM')).toBe(true);
    });

    it('handles spaces in comma-separated list', () => {
      process.env.NECTAR_ADMINS = ' admin@test.com , other@test.com ';
      expect(store.isEnvAdmin('admin@test.com')).toBe(true);
      expect(store.isEnvAdmin('other@test.com')).toBe(true);
    });
  });

  describe('notificationPrefs', () => {
    it('new users get default notification prefs', () => {
      const user = store.upsertOnLogin('new@test.com', 'New', null);
      expect(user.notificationPrefs).toEqual({
        dailyDigest: true,
        buildFailures: true,
      });
    });

    it('updateUser accepts notificationPrefs', () => {
      store.upsertOnLogin('user@test.com', 'User', null);
      const updated = store.updateUser('user@test.com', {
        notificationPrefs: { dailyDigest: false },
      });
      expect(updated.notificationPrefs.dailyDigest).toBe(false);
      expect(updated.notificationPrefs.buildFailures).toBe(true); // unchanged
    });

    it('ignores unknown notificationPrefs keys', () => {
      store.upsertOnLogin('user@test.com', 'User', null);
      const updated = store.updateUser('user@test.com', {
        notificationPrefs: { bogusPref: true },
      });
      expect(updated.notificationPrefs.bogusPref).toBeUndefined();
    });

    it('ignores non-boolean notificationPrefs values', () => {
      store.upsertOnLogin('user@test.com', 'User', null);
      const updated = store.updateUser('user@test.com', {
        notificationPrefs: { dailyDigest: 'yes' },
      });
      expect(updated.notificationPrefs.dailyDigest).toBe(true); // unchanged
    });

    it('backfills notificationPrefs on old user without it', () => {
      // Simulate an existing user missing the field, then update
      const legacyUser = {
        email: 'legacy@test.com',
        name: 'Legacy',
        picture: null,
        role: 'user',
        permissions: { releases: true, roadmap: true, tickets: true, environments: true, health: true, features: true, integrations: true, issues: true, tasks: true },
        lastLoginAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        // No notificationPrefs
      };
      store.users.set('legacy@test.com', legacyUser);

      const updated = store.updateUser('legacy@test.com', {
        notificationPrefs: { dailyDigest: false },
      });

      expect(updated.notificationPrefs).toBeDefined();
      expect(updated.notificationPrefs.dailyDigest).toBe(false);
      expect(updated.notificationPrefs.buildFailures).toBe(true); // backfilled default
    });

    it('role and notificationPrefs can be updated together', () => {
      store.upsertOnLogin('user@test.com', 'User', null);
      const updated = store.updateUser('user@test.com', {
        role: 'admin',
        notificationPrefs: { buildFailures: false },
      });
      expect(updated.role).toBe('admin');
      expect(updated.notificationPrefs.buildFailures).toBe(false);
    });
  });

  describe('persistence', () => {
    it('save/load round-trip preserves users', () => {
      store.upsertOnLogin('alice@test.com', 'Alice', 'https://alice.pic');
      store.upsertOnLogin('bob@test.com', 'Bob', null);
      store.updateUser('alice@test.com', {
        role: 'admin',
        permissions: { releases: false },
      });

      // Force save
      store._save();

      // Create a new store that loads from file
      const store2 = new UserStore();

      expect(store2.getUser('alice@test.com')).not.toBeNull();
      expect(store2.getUser('alice@test.com').name).toBe('Alice');
      expect(store2.getUser('alice@test.com').role).toBe('admin');
      expect(store2.getUser('alice@test.com').permissions.releases).toBe(false);
      expect(store2.getUser('bob@test.com')).not.toBeNull();
    });

    it('ensures all permission keys exist on loaded users', () => {
      // Simulate a state file with a user missing some permission keys
      const data = {
        users: [{
          email: 'old@test.com',
          name: 'Old User',
          picture: null,
          role: 'user',
          permissions: { releases: true },
          lastLoginAt: '2026-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
        }],
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data));

      const store2 = new UserStore();
      const user = store2.getUser('old@test.com');

      expect(user).not.toBeNull();
      expect(user.permissions.releases).toBe(true);
      // Missing keys should be filled with true
      expect(user.permissions.roadmap).toBe(true);
      expect(user.permissions.tickets).toBe(true);
      expect(user.permissions.environments).toBe(true);
    });

    it('backfills notificationPrefs on loaded users that lack it', () => {
      const data = {
        users: [{
          email: 'old@test.com',
          name: 'Old User',
          picture: null,
          role: 'user',
          permissions: { releases: true, roadmap: true, tickets: true, environments: true, health: true, features: true, integrations: true, issues: true, tasks: true },
          lastLoginAt: '2026-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          // no notificationPrefs field
        }],
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data));

      const store2 = new UserStore();
      const user = store2.getUser('old@test.com');

      expect(user.notificationPrefs).toBeDefined();
      expect(user.notificationPrefs.dailyDigest).toBe(true);
      expect(user.notificationPrefs.buildFailures).toBe(true);
    });

    it('handles missing state file gracefully', () => {
      // Delete the state file if it exists
      if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
      }

      // Creating a new store should not throw
      const store2 = new UserStore();
      expect(store2.listUsers()).toEqual([]);
    });

    it('handles corrupted state file gracefully', () => {
      fs.writeFileSync(STATE_FILE, '{invalid json!!!}');

      // Should not throw
      const store2 = new UserStore();
      expect(store2.listUsers()).toEqual([]);
    });

    it('flush calls _save', () => {
      store.upsertOnLogin('test@test.com', 'Test', null);
      const spy = vi.spyOn(store, '_save');
      store.flush();
      expect(spy).toHaveBeenCalled();
    });
  });
});
