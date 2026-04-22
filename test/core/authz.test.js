import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const {
  authorize,
  requireCapability,
  authorizeMcpTool,
  countPrincipalsWithCapability,
  resolvePrincipalCapabilities,
} = require('../../src/core/authz');

/**
 * Helper: add the access-control tables to a test DB (these will be added
 * to applySchema in Phase 2; for now we create them manually in tests).
 */
function addAccessTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      description  TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      system       INTEGER NOT NULL DEFAULT 0,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      email     TEXT NOT NULL,
      roleId    TEXT NOT NULL,
      grantedBy TEXT,
      grantedAt TEXT NOT NULL,
      PRIMARY KEY (email, roleId)
    );
    CREATE INDEX IF NOT EXISTS idx_ur_email ON user_roles(email);
    CREATE INDEX IF NOT EXISTS idx_ur_role ON user_roles(roleId);
  `);

  // Add roleId column to api_keys if not present
  const cols = db.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
  if (!cols.includes('roleId')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN roleId TEXT').run();
  }
}

function seedRoles(db) {
  const now = new Date().toISOString();
  const allCaps = JSON.stringify([
    'config.write', 'release.write', 'environment.write',
    'sync.trigger', 'task.write', 'notify.send', 'user.admin', 'system.admin',
  ]);

  db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
    VALUES ('admin', 'Admin', 'Full system access', ?, 1, ?, ?)`).run(allCaps, now, now);

  db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
    VALUES ('viewer', 'Viewer', 'Read-only access', '[]', 1, ?, ?)`).run(now, now);
}

function assignRole(db, email, roleId) {
  db.prepare(`INSERT OR IGNORE INTO user_roles (email, roleId, grantedBy, grantedAt)
    VALUES (?, ?, 'test', ?)`).run(email, roleId, new Date().toISOString());
}

function createApiKey(db, keyId, roleId) {
  db.prepare(`INSERT OR IGNORE INTO api_keys (id, label, hash, roleId, createdAt)
    VALUES (?, 'test-key', ?, ?, ?)`).run(keyId, `hash-${keyId}`, roleId, new Date().toISOString());
}

describe('authz', () => {
  let db;
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ENABLE_GOOGLE_SSO = 'true';
    process.env.NECTAR_ADMINS = 'superadmin@viv.com';

    db = createTestDb();
    addAccessTables(db);
    seedRoles(db);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('authorize', () => {
    it('grants admin user all capabilities', () => {
      assignRole(db, 'admin@viv.com', 'admin');

      expect(authorize({ type: 'user', email: 'admin@viv.com' }, 'release.write', null, { db })).toBe(true);
      expect(authorize({ type: 'user', email: 'admin@viv.com' }, 'user.admin', null, { db })).toBe(true);
      expect(authorize({ type: 'user', email: 'admin@viv.com' }, 'system.admin', null, { db })).toBe(true);
      expect(authorize({ type: 'user', email: 'admin@viv.com' }, 'config.write', null, { db })).toBe(true);
    });

    it('viewer user gets no capabilities', () => {
      assignRole(db, 'viewer@viv.com', 'viewer');

      expect(authorize({ type: 'user', email: 'viewer@viv.com' }, 'config.write', null, { db })).toBe(false);
      expect(authorize({ type: 'user', email: 'viewer@viv.com' }, 'release.write', null, { db })).toBe(false);
      expect(authorize({ type: 'user', email: 'viewer@viv.com' }, 'user.admin', null, { db })).toBe(false);
    });

    it('multi-role user gets union of capabilities', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, capabilities, system, createdAt, updatedAt)
        VALUES ('release_lead', 'Release Lead', '["release.write","notify.send"]', 0, ?, ?)`).run(now, now);

      assignRole(db, 'multi@viv.com', 'viewer');
      assignRole(db, 'multi@viv.com', 'release_lead');

      expect(authorize({ type: 'user', email: 'multi@viv.com' }, 'release.write', null, { db })).toBe(true);
      expect(authorize({ type: 'user', email: 'multi@viv.com' }, 'notify.send', null, { db })).toBe(true);
      expect(authorize({ type: 'user', email: 'multi@viv.com' }, 'user.admin', null, { db })).toBe(false);
    });

    it('API key with admin role gets all capabilities', () => {
      createApiKey(db, 'key-1', 'admin');

      expect(authorize({ type: 'apikey', keyId: 'key-1' }, 'release.write', null, { db })).toBe(true);
      expect(authorize({ type: 'apikey', keyId: 'key-1' }, 'system.admin', null, { db })).toBe(true);
    });

    it('API key with viewer role gets no capabilities', () => {
      createApiKey(db, 'key-2', 'viewer');

      expect(authorize({ type: 'apikey', keyId: 'key-2' }, 'config.write', null, { db })).toBe(false);
      expect(authorize({ type: 'apikey', keyId: 'key-2' }, 'release.write', null, { db })).toBe(false);
    });

    it('API key without roleId gets no capabilities', () => {
      db.prepare(`INSERT INTO api_keys (id, label, hash, createdAt) VALUES ('key-3', 'old-key', 'hash-key3', ?)`).run(new Date().toISOString());

      expect(authorize({ type: 'apikey', keyId: 'key-3' }, 'config.write', null, { db })).toBe(false);
    });

    it('break-glass email always gets full access regardless of DB state', () => {
      expect(authorize({ type: 'user', email: 'superadmin@viv.com' }, 'system.admin', null, { db })).toBe(true);
      expect(authorize({ type: 'user', email: 'superadmin@viv.com' }, 'user.admin', null, { db })).toBe(true);
    });

    it('break-glass is case-insensitive', () => {
      expect(authorize({ type: 'user', email: 'SUPERADMIN@VIV.COM' }, 'system.admin', null, { db })).toBe(true);
    });

    it('dev-mode (ENABLE_GOOGLE_SSO unset) grants all capabilities', () => {
      delete process.env.ENABLE_GOOGLE_SSO;

      expect(authorize({ type: 'user', email: 'anyone@test.com' }, 'system.admin', null, { db })).toBe(true);
      expect(authorize({ type: 'apikey', keyId: 'nonexistent' }, 'user.admin', null, { db })).toBe(true);
    });

    it('no NECTAR_ADMINS configured means everyone is admin', () => {
      process.env.NECTAR_ADMINS = '';

      expect(authorize({ type: 'user', email: 'nobody@test.com' }, 'system.admin', null, { db })).toBe(true);
    });

    it('unknown capability returns false for non-break-glass user', () => {
      assignRole(db, 'user@viv.com', 'admin');

      expect(authorize({ type: 'user', email: 'user@viv.com' }, 'nonexistent.cap', null, { db })).toBe(false);
    });

    it('resource parameter is accepted and ignored', () => {
      assignRole(db, 'admin@viv.com', 'admin');

      expect(authorize({ type: 'user', email: 'admin@viv.com' }, 'release.write', 'some-resource', { db })).toBe(true);
    });
  });

  describe('requireCapability middleware', () => {
    function mockReq(overrides = {}) {
      return { user: null, apiKey: null, ...overrides };
    }

    function mockRes() {
      const res = { statusCode: null, body: null };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => { res.body = body; return res; };
      return res;
    }

    it('returns 401 for unauthenticated request (SSO enabled)', () => {
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      requireCapability('release.write', { db })(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('unauthenticated');
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 for user without required capability', () => {
      assignRole(db, 'viewer@viv.com', 'viewer');
      const req = mockReq({ user: { email: 'viewer@viv.com' } });
      const res = mockRes();
      const next = vi.fn();

      requireCapability('release.write', { db })(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('access_denied');
      expect(res.body.capability).toBe('release.write');
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for user with required capability', () => {
      assignRole(db, 'admin@viv.com', 'admin');
      const req = mockReq({ user: { email: 'admin@viv.com' } });
      const res = mockRes();
      const next = vi.fn();

      requireCapability('release.write', { db })(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('calls next() for API key with required capability', () => {
      createApiKey(db, 'key-admin', 'admin');
      const req = mockReq({ apiKey: { keyId: 'key-admin' } });
      const res = mockRes();
      const next = vi.fn();

      requireCapability('system.admin', { db })(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returns 403 for API key without required capability', () => {
      createApiKey(db, 'key-viewer', 'viewer');
      const req = mockReq({ apiKey: { keyId: 'key-viewer' } });
      const res = mockRes();
      const next = vi.fn();

      requireCapability('release.write', { db })(req, res, next);

      expect(res.statusCode).toBe(403);
    });

    it('allows everything in dev mode', () => {
      delete process.env.ENABLE_GOOGLE_SSO;
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      requireCapability('system.admin', { db })(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('authorizeMcpTool', () => {
    it('allows API key with correct capability', () => {
      createApiKey(db, 'mcp-key', 'admin');
      const req = { apiKey: { keyId: 'mcp-key' } };

      expect(() => authorizeMcpTool(req, 'task.write', { db })).not.toThrow();
    });

    it('throws for API key without capability', () => {
      createApiKey(db, 'mcp-viewer', 'viewer');
      const req = { apiKey: { keyId: 'mcp-viewer' } };

      expect(() => authorizeMcpTool(req, 'task.write', { db })).toThrow(/Access denied/);
    });

    it('throws with code -32603', () => {
      createApiKey(db, 'mcp-viewer2', 'viewer');
      const req = { apiKey: { keyId: 'mcp-viewer2' } };

      try {
        authorizeMcpTool(req, 'task.write', { db });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.code).toBe(-32603);
      }
    });

    it('allows everything in dev mode', () => {
      delete process.env.ENABLE_GOOGLE_SSO;
      const req = {};

      expect(() => authorizeMcpTool(req, 'system.admin', { db })).not.toThrow();
    });

    it('throws for unauthenticated request when SSO is enabled', () => {
      const req = {};

      expect(() => authorizeMcpTool(req, 'task.write', { db })).toThrow(/Authentication required/);
    });
  });

  describe('countPrincipalsWithCapability', () => {
    it('counts users and keys with user.admin', () => {
      assignRole(db, 'admin1@viv.com', 'admin');
      assignRole(db, 'admin2@viv.com', 'admin');
      createApiKey(db, 'admin-key', 'admin');

      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(3);
    });

    it('does not count viewer users for user.admin', () => {
      assignRole(db, 'viewer@viv.com', 'viewer');
      assignRole(db, 'admin@viv.com', 'admin');

      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(1);
    });

    it('counts across custom roles that grant the capability', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, capabilities, system, createdAt, updatedAt)
        VALUES ('custom_admin', 'Custom Admin', '["user.admin","config.write"]', 0, ?, ?)`).run(now, now);

      assignRole(db, 'admin@viv.com', 'admin');
      assignRole(db, 'custom@viv.com', 'custom_admin');

      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(2);
    });

    it('returns 0 when no roles grant the capability', () => {
      expect(countPrincipalsWithCapability('nonexistent.cap', { db })).toBe(0);
    });

    it('does not double-count a user with multiple granting roles', () => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO roles (id, name, capabilities, system, createdAt, updatedAt)
        VALUES ('custom_admin', 'Custom Admin', '["user.admin"]', 0, ?, ?)`).run(now, now);

      assignRole(db, 'admin@viv.com', 'admin');
      assignRole(db, 'admin@viv.com', 'custom_admin');

      expect(countPrincipalsWithCapability('user.admin', { db })).toBe(1);
    });
  });

  describe('truth table: seeded roles x all capabilities', () => {
    const ALL_CAPS = [
      'config.write', 'release.write', 'environment.write',
      'sync.trigger', 'task.write', 'notify.send', 'user.admin', 'system.admin',
    ];

    it('admin role grants all 8 capabilities', () => {
      assignRole(db, 'test@viv.com', 'admin');
      for (const cap of ALL_CAPS) {
        expect(authorize({ type: 'user', email: 'test@viv.com' }, cap, null, { db })).toBe(true);
      }
    });

    it('viewer role grants no capabilities', () => {
      assignRole(db, 'test@viv.com', 'viewer');
      for (const cap of ALL_CAPS) {
        expect(authorize({ type: 'user', email: 'test@viv.com' }, cap, null, { db })).toBe(false);
      }
    });

    it('admin API key grants all 8 capabilities', () => {
      createApiKey(db, 'key-admin', 'admin');
      for (const cap of ALL_CAPS) {
        expect(authorize({ type: 'apikey', keyId: 'key-admin' }, cap, null, { db })).toBe(true);
      }
    });

    it('viewer API key grants no capabilities', () => {
      createApiKey(db, 'key-viewer', 'viewer');
      for (const cap of ALL_CAPS) {
        expect(authorize({ type: 'apikey', keyId: 'key-viewer' }, cap, null, { db })).toBe(false);
      }
    });
  });
});
