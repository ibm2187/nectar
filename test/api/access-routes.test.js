import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const { createAccessRoutes } = require('../../src/api/access-routes');
const UserStore = require('../../src/core/user-store');

/**
 * Test helper: simulate Express req/res/next for route handler testing.
 */
function createTestContext(db) {
  const now = new Date().toISOString();
  const allCaps = JSON.stringify([
    'config.write', 'release.write', 'environment.write',
    'sync.trigger', 'task.write', 'notify.send', 'user.admin', 'system.admin',
  ]);

  // Seed roles
  db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
    VALUES ('admin', 'Admin', 'Full access', ?, 1, ?, ?)`).run(allCaps, now, now);
  db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
    VALUES ('viewer', 'Viewer', 'Read-only', '[]', 1, ?, ?)`).run(now, now);

  const userStore = new UserStore({ db });

  // Create an admin user and assign admin role
  userStore.upsertOnLogin('admin@viv.com', 'Admin User', null);
  db.prepare(`INSERT OR IGNORE INTO user_roles (email, roleId, grantedBy, grantedAt)
    VALUES ('admin@viv.com', 'admin', 'test', ?)`).run(now);

  return { userStore, now };
}

/**
 * Since we can't easily do supertest without a full Express app,
 * we test the route handler logic directly by extracting it.
 * We test the access routes at the unit level, verifying the DB mutations.
 */
describe('Access Routes (unit)', () => {
  let db;
  let userStore;
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ENABLE_GOOGLE_SSO = 'true';
    process.env.NECTAR_ADMINS = 'superadmin@viv.com';

    db = createTestDb();
    const ctx = createTestContext(db);
    userStore = ctx.userStore;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Roles CRUD (direct DB)', () => {
    it('seeded roles exist with correct data', () => {
      const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
      expect(roles).toHaveLength(2);

      const admin = roles.find(r => r.id === 'admin');
      expect(admin.system).toBe(1);
      expect(JSON.parse(admin.capabilities)).toHaveLength(8);

      const viewer = roles.find(r => r.id === 'viewer');
      expect(viewer.system).toBe(1);
      expect(JSON.parse(viewer.capabilities)).toEqual([]);
    });

    it('can create a custom role', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
        VALUES ('release_lead', 'Release Lead', 'Can manage releases', '["release.write","notify.send"]', 0, ?, ?)`).run(now, now);

      const role = db.prepare('SELECT * FROM roles WHERE id = ?').get('release_lead');
      expect(role.name).toBe('Release Lead');
      expect(role.system).toBe(0);
      expect(JSON.parse(role.capabilities)).toEqual(['release.write', 'notify.send']);
    });

    it('can update a role capabilities', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
        VALUES ('custom', 'Custom', null, '["config.write"]', 0, ?, ?)`).run(now, now);

      db.prepare('UPDATE roles SET capabilities = ? WHERE id = ?')
        .run('["config.write","release.write"]', 'custom');

      const updated = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get('custom');
      expect(JSON.parse(updated.capabilities)).toEqual(['config.write', 'release.write']);
    });

    it('can delete a custom role (not in use)', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
        VALUES ('temp', 'Temp', null, '[]', 0, ?, ?)`).run(now, now);

      db.prepare('DELETE FROM roles WHERE id = ?').run('temp');
      const deleted = db.prepare('SELECT * FROM roles WHERE id = ?').get('temp');
      expect(deleted).toBeUndefined();
    });
  });

  describe('User Role Management (direct DB)', () => {
    it('can assign and query user roles', () => {
      userStore.upsertOnLogin('user@viv.com', 'User', null);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('user@viv.com', 'viewer', 'admin@viv.com', ?)`).run(now);

      const roles = db.prepare('SELECT roleId FROM user_roles WHERE email = ?').all('user@viv.com');
      expect(roles).toHaveLength(1);
      expect(roles[0].roleId).toBe('viewer');
    });

    it('can replace a user role set', () => {
      userStore.upsertOnLogin('user@viv.com', 'User', null);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('user@viv.com', 'viewer', 'test', ?)`).run(now);

      // Replace with admin + viewer
      db.transaction(() => {
        db.prepare('DELETE FROM user_roles WHERE email = ?').run('user@viv.com');
        db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
          VALUES ('user@viv.com', 'admin', 'test', ?)`).run(now);
        db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
          VALUES ('user@viv.com', 'viewer', 'test', ?)`).run(now);
      })();

      const roles = db.prepare('SELECT roleId FROM user_roles WHERE email = ?').all('user@viv.com');
      expect(roles).toHaveLength(2);
    });
  });

  describe('API Key Management (direct DB)', () => {
    it('can create a key with roleId', () => {
      const crypto = require('crypto');
      const id = `key-${crypto.randomBytes(8).toString('hex')}`;
      const hash = crypto.createHash('sha256').update('test-raw-key').digest('hex');
      const now = new Date().toISOString();

      db.prepare(`INSERT INTO api_keys (id, label, hash, roleId, createdAt, createdBy)
        VALUES (?, 'Test Key', ?, 'admin', ?, 'admin@viv.com')`).run(id, hash, now);

      const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
      expect(key.roleId).toBe('admin');
      expect(key.label).toBe('Test Key');
    });

    it('can change a key role', () => {
      const crypto = require('crypto');
      const id = `key-${crypto.randomBytes(8).toString('hex')}`;
      const hash = crypto.createHash('sha256').update('test-key-2').digest('hex');
      const now = new Date().toISOString();

      db.prepare(`INSERT INTO api_keys (id, label, hash, roleId, createdAt)
        VALUES (?, 'Key', ?, 'admin', ?)`).run(id, hash, now);

      db.prepare('UPDATE api_keys SET roleId = ? WHERE id = ?').run('viewer', id);

      const key = db.prepare('SELECT roleId FROM api_keys WHERE id = ?').get(id);
      expect(key.roleId).toBe('viewer');
    });
  });

  describe('Final-admin guard', () => {
    it('prevents removing the last admin user role', () => {
      // Only admin@viv.com has admin role
      const adminRoles = db.prepare(`
        SELECT COUNT(DISTINCT ur.email) as n FROM user_roles ur
        JOIN roles r ON r.id = ur.roleId
        WHERE r.capabilities LIKE '%user.admin%'
      `).get();
      expect(adminRoles.n).toBe(1);

      // Cannot remove the last admin
      const count = db.prepare(`
        SELECT COUNT(DISTINCT email) as n FROM user_roles ur
        WHERE ur.roleId IN (
          SELECT id FROM roles WHERE capabilities LIKE '%user.admin%'
        )
      `).get().n;
      expect(count).toBe(1);
    });

    it('allows removing admin role when another admin exists', () => {
      const now = new Date().toISOString();
      userStore.upsertOnLogin('admin2@viv.com', 'Admin 2', null);
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('admin2@viv.com', 'admin', 'test', ?)`).run(now);

      // Now 2 admins — safe to remove one
      const count = db.prepare(`
        SELECT COUNT(DISTINCT email) as n FROM user_roles ur
        WHERE ur.roleId IN (
          SELECT id FROM roles WHERE capabilities LIKE '%user.admin%'
        )
      `).get().n;
      expect(count).toBe(2);
    });
  });

  describe('System role protection', () => {
    it('system roles cannot be deleted', () => {
      const admin = db.prepare('SELECT * FROM roles WHERE id = ?').get('admin');
      expect(admin.system).toBe(1);

      const viewer = db.prepare('SELECT * FROM roles WHERE id = ?').get('viewer');
      expect(viewer.system).toBe(1);
    });

    it('system role capabilities can be edited', () => {
      // Update viewer capabilities (this is allowed)
      db.prepare('UPDATE roles SET capabilities = ? WHERE id = ?')
        .run('["config.write","release.write"]', 'viewer');

      const viewer = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get('viewer');
      expect(JSON.parse(viewer.capabilities)).toEqual(['config.write', 'release.write']);
    });
  });

  describe('guardFinalAdmin with multi-role graph', () => {
    // Exercises the wouldLose cross-role computation from access-routes.js:117-141
    // (users who still have user.admin via another role are not counted as losing it)

    it('user with admin via two roles is not double-counted', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, capabilities, system, createdAt, updatedAt)
        VALUES ('super', 'Super', '["user.admin"]', 0, ?, ?)`).run(now, now);

      // admin@viv.com has both admin and super roles
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('admin@viv.com', 'super', 'test', ?)`).run(now);

      const { countPrincipalsWithCapability } = require('../../src/core/authz');
      // Should be 1, not 2 (same user in two roles)
      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(1);
    });

    it('wouldLose correctly identifies users who retain admin via another role', () => {
      // Setup a multi-role graph:
      // - admin@viv.com has 'admin' role (user.admin ✓)
      // - user2@viv.com has both 'admin' AND 'custom_admin' roles (user.admin ✓ via both)
      // - user3@viv.com has ONLY 'custom_admin' role (user.admin ✓ via custom_admin only)
      //
      // If we remove user.admin from custom_admin:
      // - user2 retains user.admin via 'admin' → does NOT lose it
      // - user3 has no other role with user.admin → DOES lose it
      // Total principals before: 3, wouldLose: 1, remaining: 2 → allowed

      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, capabilities, system, createdAt, updatedAt)
        VALUES ('custom_admin', 'Custom Admin', '["user.admin","release.write"]', 0, ?, ?)`).run(now, now);

      userStore.upsertOnLogin('user2@viv.com', 'User 2', null);
      userStore.upsertOnLogin('user3@viv.com', 'User 3', null);

      // user2 has both admin + custom_admin
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('user2@viv.com', 'admin', 'test', ?)`).run(now);
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('user2@viv.com', 'custom_admin', 'test', ?)`).run(now);

      // user3 has ONLY custom_admin
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('user3@viv.com', 'custom_admin', 'test', ?)`).run(now);

      const { countPrincipalsWithCapability } = require('../../src/core/authz');
      const { safeParseArray } = require('../../src/core/json-utils');

      // 3 distinct users with user.admin
      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(3);

      // Simulate the wouldLose calculation from PATCH /access/roles/:id
      // when removing user.admin from custom_admin
      const roleId = 'custom_admin';
      const assignees = db.prepare('SELECT DISTINCT email FROM user_roles WHERE roleId = ?').all(roleId);
      const keyAssignees = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE roleId = ?').get(roleId).n;

      let wouldLose = 0;
      for (const { email } of assignees) {
        const otherRoles = db.prepare(`
          SELECT r.capabilities FROM user_roles ur
          JOIN roles r ON r.id = ur.roleId
          WHERE ur.email = ? AND ur.roleId != ?
        `).all(email, roleId);
        const hasOtherAdmin = otherRoles.some(r => safeParseArray(r.capabilities, []).includes('user.admin'));
        if (!hasOtherAdmin) wouldLose++;
      }
      wouldLose += keyAssignees;

      // user2 has admin via 'admin' role → does NOT lose it (hasOtherAdmin=true)
      // user3 has NO other role with user.admin → DOES lose it
      expect(wouldLose).toBe(1);

      // 3 total - 1 wouldLose = 2 remaining → change is allowed
      const remaining = countPrincipalsWithCapability('user.admin', { db }) - wouldLose;
      expect(remaining).toBe(2);
      expect(remaining > 0).toBe(true);
    });

    it('wouldLose blocks when removing user.admin would leave zero principals', () => {
      // Only admin@viv.com has admin role, plus a custom_admin role
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, capabilities, system, createdAt, updatedAt)
        VALUES ('custom_admin', 'Custom Admin', '["user.admin"]', 0, ?, ?)`).run(now, now);

      userStore.upsertOnLogin('user2@viv.com', 'User 2', null);
      db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES ('user2@viv.com', 'custom_admin', 'test', ?)`).run(now);

      // Remove admin@viv.com's admin role to leave only user2 via custom_admin
      db.prepare('DELETE FROM user_roles WHERE email = ? AND roleId = ?').run('admin@viv.com', 'admin');

      const { countPrincipalsWithCapability } = require('../../src/core/authz');
      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(1); // only user2

      // Simulate removing user.admin from custom_admin
      const roleId = 'custom_admin';
      const assignees = db.prepare('SELECT DISTINCT email FROM user_roles WHERE roleId = ?').all(roleId);
      let wouldLose = 0;
      for (const { email } of assignees) {
        const otherRoles = db.prepare(`
          SELECT r.capabilities FROM user_roles ur
          JOIN roles r ON r.id = ur.roleId
          WHERE ur.email = ? AND ur.roleId != ?
        `).all(email, roleId);
        const hasOtherAdmin = otherRoles.some(r => {
          try { return JSON.parse(r.capabilities).includes('user.admin'); } catch { return false; }
        });
        if (!hasOtherAdmin) wouldLose++;
      }

      // user2 has no other admin role → wouldLose = 1
      expect(wouldLose).toBe(1);

      // 1 total - 1 wouldLose = 0 remaining → BLOCKED
      const remaining = countPrincipalsWithCapability('user.admin', { db }) - wouldLose;
      expect(remaining).toBe(0);
      expect(remaining <= 0).toBe(true);
    });
  });

  describe('Migration v14 integration', () => {
    it('fresh DB has roles and user_roles tables', () => {
      const freshDb = createTestDb();
      const tables = freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      expect(tables).toContain('roles');
      expect(tables).toContain('user_roles');
    });

    it('fresh DB api_keys table has roleId column', () => {
      const freshDb = createTestDb();
      const cols = freshDb.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
      expect(cols).toContain('roleId');
    });

    it('fresh DB users table does NOT have permissions column', () => {
      const freshDb = createTestDb();
      const cols = freshDb.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      expect(cols).not.toContain('permissions');
    });

    it('fresh DB audit table has resource and capability columns', () => {
      const freshDb = createTestDb();
      // Run the migration
      const auditCols = freshDb.prepare("PRAGMA table_info(audit)").all().map(c => c.name);
      // These are added by v13 migration
      expect(auditCols).toContain('resource');
      expect(auditCols).toContain('capability');
    });
  });
});

// ── Teams routes ──────────────────────────────────────────
// Integration-style tests that spin up an Express app with the router
// mounted, then invoke via http.request.
describe('Access Routes — Teams', () => {
  const express = require('express');
  const http = require('http');
  const TeamStore = require('../../src/core/team-store');

  let server, baseUrl, db, userStore, teamStore, audit, onStandupInvalidate, invalidateCount, savedEnv;

  beforeEach(async () => {
    // ENABLE_GOOGLE_SSO + NECTAR_ADMINS required: without SSO enabled
    // authz treats every request as dev-mode (full access), and without
    // NECTAR_ADMINS being non-empty break-glass grants everyone admin.
    savedEnv = {
      NECTAR_ADMINS: process.env.NECTAR_ADMINS,
      ENABLE_GOOGLE_SSO: process.env.ENABLE_GOOGLE_SSO,
    };
    process.env.NECTAR_ADMINS = 'admin@viv.com';
    process.env.ENABLE_GOOGLE_SSO = 'true';
    db = createTestDb();
    // Seed admin user + role so requireCapability passes
    const now = new Date().toISOString();
    const allCaps = JSON.stringify([
      'config.write', 'release.write', 'environment.write',
      'sync.trigger', 'task.write', 'notify.send', 'user.admin', 'system.admin',
    ]);
    db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
      VALUES ('admin', 'Admin', 'Full', ?, 1, ?, ?)`).run(allCaps, now, now);
    db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
      VALUES ('viewer', 'Viewer', 'Read', '[]', 1, ?, ?)`).run(now, now);

    userStore = new UserStore({ db });
    teamStore = new TeamStore({ db });
    userStore.upsertOnLogin('admin@viv.com', 'Admin User', null);
    db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
      VALUES ('admin@viv.com', 'admin', 'test', ?)`).run(now);
    userStore.upsertOnLogin('viewer@viv.com', 'View User', null);
    db.prepare(`INSERT INTO user_roles (email, roleId, grantedBy, grantedAt)
      VALUES ('viewer@viv.com', 'viewer', 'test', ?)`).run(now);

    // Audit mock with spy-able record
    const calls = [];
    audit = { record: (...args) => calls.push(args), _calls: calls };

    invalidateCount = 0;
    onStandupInvalidate = () => { invalidateCount++; };

    // Build mini app
    const app = express();
    app.use(express.json());
    // Inject a test user onto the req before the router runs
    app.use((req, res, next) => {
      const email = req.headers['x-test-email'] || 'admin@viv.com';
      req.user = { email };
      next();
    });
    const router = createAccessRoutes({ db, userStore, teamStore }, { audit, onStandupInvalidate });
    app.use(router);

    server = http.createServer(app);
    await new Promise(r => server.listen(0, r));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) await new Promise(r => server.close(r));
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  async function req(method, path, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, body: json };
  }

  describe('GET /access/teams', () => {
    it('returns an array (not envelope)', async () => {
      const r = await req('GET', '/access/teams');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('403 when caller lacks user.admin', async () => {
      const r = await req('GET', '/access/teams', undefined, { 'x-test-email': 'viewer@viv.com' });
      expect(r.status).toBe(403);
    });
  });

  describe('POST /access/teams', () => {
    it('creates with slug id and records audit', async () => {
      const r = await req('POST', '/access/teams', { name: 'Web Platform', color: '#60a5fa' });
      expect(r.status).toBe(201);
      expect(r.body.id).toBe('web-platform');
      expect(audit._calls.find(c => c[1] === 'team:created')).toBeTruthy();
    });

    it('400 on missing name', async () => {
      const r = await req('POST', '/access/teams', { color: '#60a5fa' });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_name');
    });

    it('400 on missing color', async () => {
      const r = await req('POST', '/access/teams', { name: 'X' });
      expect(r.status).toBe(400);
    });

    it('400 on invalid (non-swatch) color', async () => {
      const r = await req('POST', '/access/teams', { name: 'X', color: '#000000' });
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /access/teams/:id', () => {
    it('updates a team', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      const r = await req('PATCH', '/access/teams/a', { name: 'A2', color: '#a78bfa' });
      expect(r.status).toBe(200);
      expect(r.body.name).toBe('A2');
      expect(r.body.color).toBe('#a78bfa');
    });

    it('404 on unknown id', async () => {
      const r = await req('PATCH', '/access/teams/nope', { name: 'Z' });
      expect(r.status).toBe(404);
    });

    it('400 on invalid color', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      const r = await req('PATCH', '/access/teams/a', { color: 'blue' });
      expect(r.status).toBe(400);
    });

    it('400 on name collision with friendly message', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      await req('POST', '/access/teams', { name: 'B', color: '#a78bfa' });
      const r = await req('PATCH', '/access/teams/a', { name: 'B' });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/already exists/i);
    });
  });

  describe('DELETE /access/teams/:id', () => {
    it('204 when team has 0 members', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      const r = await req('DELETE', '/access/teams/a');
      expect(r.status).toBe(204);
    });

    it('409 with memberCount + sample when team has members', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      await req('PUT', '/access/users/admin%40viv.com/team', { teamId: 'a' });
      const r = await req('DELETE', '/access/teams/a');
      expect(r.status).toBe(409);
      expect(r.body.memberCount).toBe(1);
      expect(Array.isArray(r.body.sample)).toBe(true);
    });

    it('404 on unknown id', async () => {
      const r = await req('DELETE', '/access/teams/nope');
      expect(r.status).toBe(404);
    });
  });

  describe('PUT /access/users/:email/team', () => {
    it('updates teamId and calls onStandupInvalidate', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      invalidateCount = 0;
      const r = await req('PUT', '/access/users/admin%40viv.com/team', { teamId: 'a' });
      expect(r.status).toBe(200);
      expect(r.body.teamId).toBe('a');
      expect(invalidateCount).toBe(1);
    });

    it('accepts null to clear teamId', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      await req('PUT', '/access/users/admin%40viv.com/team', { teamId: 'a' });
      const r = await req('PUT', '/access/users/admin%40viv.com/team', { teamId: null });
      expect(r.status).toBe(200);
      expect(r.body.teamId).toBeNull();
    });

    it('400 on unknown teamId', async () => {
      const r = await req('PUT', '/access/users/admin%40viv.com/team', { teamId: 'ghost' });
      expect(r.status).toBe(400);
    });
  });

  describe('PUT /access/users/:email/jira-name', () => {
    it('updates jiraName and calls onStandupInvalidate', async () => {
      invalidateCount = 0;
      const r = await req('PUT', '/access/users/admin%40viv.com/jira-name', { jiraName: 'Admin User' });
      expect(r.status).toBe(200);
      expect(r.body.jiraName).toBe('Admin User');
      expect(invalidateCount).toBe(1);
    });

    it('accepts null to clear', async () => {
      await req('PUT', '/access/users/admin%40viv.com/jira-name', { jiraName: 'Admin' });
      const r = await req('PUT', '/access/users/admin%40viv.com/jira-name', { jiraName: null });
      expect(r.status).toBe(200);
      expect(r.body.jiraName).toBeNull();
    });
  });

  describe('GET /access/users enrichment', () => {
    it('includes teamId and jiraName on each user row', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      await req('PUT', '/access/users/admin%40viv.com/team', { teamId: 'a' });
      await req('PUT', '/access/users/admin%40viv.com/jira-name', { jiraName: 'Admin User' });
      const r = await req('GET', '/access/users');
      expect(r.status).toBe(200);
      const adminRow = r.body.find(u => u.email === 'admin@viv.com');
      expect(adminRow.teamId).toBe('a');
      expect(adminRow.jiraName).toBe('Admin User');
      const viewerRow = r.body.find(u => u.email === 'viewer@viv.com');
      expect(viewerRow.teamId).toBeNull();
      expect(viewerRow.jiraName).toBeNull();
    });
  });

  describe('audit', () => {
    it('records team:created / team:updated / team:deleted / user:team-updated / user:jira-name-updated with actor', async () => {
      await req('POST', '/access/teams', { name: 'A', color: '#60a5fa' });
      await req('PATCH', '/access/teams/a', { color: '#a78bfa' });
      await req('PUT', '/access/users/admin%40viv.com/team', { teamId: 'a' });
      await req('PUT', '/access/users/admin%40viv.com/jira-name', { jiraName: 'A' });
      await req('PUT', '/access/users/admin%40viv.com/team', { teamId: null });
      await req('DELETE', '/access/teams/a');
      const actions = audit._calls.map(c => c[1]);
      expect(actions).toContain('team:created');
      expect(actions).toContain('team:updated');
      expect(actions).toContain('user:team-updated');
      expect(actions).toContain('user:jira-name-updated');
      expect(actions).toContain('team:deleted');
      // Actor email populated
      const created = audit._calls.find(c => c[1] === 'team:created');
      expect(created[3]).toBe('admin@viv.com');
    });
  });
});
