const { Router } = require('express');
const crypto = require('crypto');
const log = require('../core/log');
const { getCapabilities, isValidCapability } = require('../core/capabilities');
const { requireCapability, countPrincipalsWithCapability } = require('../core/authz');
const { safeParseArray } = require('../core/json-utils');
const { getDb } = require('../core/db');

const KEY_PREFIX = 'nectar_';

/**
 * Access control REST API.
 * All routes require 'user.admin' capability.
 *
 * @param {object} services
 * @param {object} [opts]
 * @param {function} [opts.broadcastTo] - targeted WS broadcast
 * @param {object} [opts.audit] - Audit instance
 * @returns {Router}
 */
function createAccessRoutes(services, opts = {}) {
  const { userStore } = services;
  const { broadcastTo, audit } = opts;
  const router = Router();
  const db = services.db || getDb();

  // All access routes require user.admin
  router.use(requireCapability('user.admin', { audit }));

  // ── Capabilities ────────────────────────────────────────

  router.get('/access/capabilities', (req, res) => {
    res.json(getCapabilities());
  });

  // ── Roles CRUD ──────────────────────────────────────────

  router.get('/access/roles', (req, res) => {
    const rows = db.prepare('SELECT * FROM roles ORDER BY system DESC, name ASC').all();
    const roles = rows.map(r => ({
      ...r,
      capabilities: safeParseArray(r.capabilities, []),
      system: !!r.system,
    }));
    res.json(roles);
  });

  router.post('/access/roles', (req, res) => {
    const { id, name, description, capabilities } = req.body || {};

    // Validate id
    if (!id || typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id)) {
      return res.status(400).json({ error: 'invalid_role_id', message: 'Role ID must be a non-empty slug (lowercase alphanumeric + underscores)' });
    }

    // Validate name
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'invalid_role_name', message: 'Role name is required' });
    }

    // Validate capabilities
    if (!Array.isArray(capabilities)) {
      return res.status(400).json({ error: 'invalid_capabilities', message: 'capabilities must be an array' });
    }
    for (const cap of capabilities) {
      if (!isValidCapability(cap)) {
        return res.status(400).json({ error: 'invalid_capability', message: `Unknown capability: ${cap}` });
      }
    }

    // Check for conflicts
    const existing = db.prepare('SELECT id FROM roles WHERE id = ?').get(id);
    if (existing) {
      return res.status(409).json({ error: 'role_id_conflict', message: `Role with ID '${id}' already exists` });
    }

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 0, ?, ?)`).run(id, name.trim(), description || null, JSON.stringify(capabilities), now, now);

    if (audit) {
      audit.record(null, 'role:created', { name, capabilities }, getActorEmail(req));
    }

    const role = { id, name: name.trim(), description: description || null, capabilities, system: false, createdAt: now, updatedAt: now };
    res.status(201).json(role);
  });

  router.patch('/access/roles/:id', (req, res) => {
    const roleId = req.params.id;
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return res.status(404).json({ error: 'not_found', message: 'Role not found' });

    const updates = req.body || {};

    // System roles: reject id/name changes
    if (role.system && (updates.id || updates.name)) {
      return res.status(409).json({ error: 'system_role_protected', message: 'Cannot rename system roles' });
    }

    // Validate capabilities if provided
    if (updates.capabilities) {
      if (!Array.isArray(updates.capabilities)) {
        return res.status(400).json({ error: 'invalid_capabilities', message: 'capabilities must be an array' });
      }
      for (const cap of updates.capabilities) {
        if (!isValidCapability(cap)) {
          return res.status(400).json({ error: 'invalid_capability', message: `Unknown capability: ${cap}` });
        }
      }

      // Final-admin guard: if removing user.admin from this role
      const oldCaps = safeParseArray(role.capabilities, []);
      const hadUserAdmin = oldCaps.includes('user.admin');
      const hasUserAdmin = updates.capabilities.includes('user.admin');

      if (hadUserAdmin && !hasUserAdmin) {
        // Simulate the change: count remaining principals with user.admin after this role loses it
        const currentCount = countPrincipalsWithCapability('user.admin', { db });
        // Count how many principals ONLY have user.admin through this role
        const assignees = db.prepare('SELECT DISTINCT email FROM user_roles WHERE roleId = ?').all(roleId);
        const keyAssignees = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE roleId = ?').get(roleId).n;

        // For each user assigned to this role, check if they have user.admin through another role
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
        // Keys assigned to this role lose user.admin entirely
        wouldLose += keyAssignees;

        if (currentCount - wouldLose <= 0) {
          return res.status(409).json({ error: 'final_admin_guard', message: 'Cannot remove user.admin — would leave zero admin principals' });
        }
      }
    }

    const now = new Date().toISOString();
    const newName = (!role.system && updates.name) ? updates.name.trim() : role.name;
    const newDesc = updates.description !== undefined ? updates.description : role.description;
    const newCaps = updates.capabilities ? JSON.stringify(updates.capabilities) : role.capabilities;

    db.prepare('UPDATE roles SET name = ?, description = ?, capabilities = ?, updatedAt = ? WHERE id = ?')
      .run(newName, newDesc, newCaps, now, roleId);

    if (audit) {
      audit.record(null, 'role:updated', { capabilities: updates.capabilities || safeParseArray(role.capabilities, []), changedBy: getActorEmail(req) }, getActorEmail(req));
    }

    // Broadcast role:updated to affected users + admins
    if (broadcastTo) {
      const affectedEmails = db.prepare('SELECT email FROM user_roles WHERE roleId = ?').all(roleId).map(r => r.email);
      const adminEmails = getAdminEmails(db);
      const allTargets = [...new Set([...affectedEmails, ...adminEmails])];
      broadcastTo(allTargets, { type: 'role:updated', roleId, capabilities: safeParseArray(newCaps, []) });
    }

    const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    res.json({ ...updated, capabilities: safeParseArray(updated.capabilities, []), system: !!updated.system });
  });

  router.delete('/access/roles/:id', (req, res) => {
    const roleId = req.params.id;
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    if (!role) return res.status(404).json({ error: 'not_found', message: 'Role not found' });

    if (role.system) {
      return res.status(409).json({ error: 'system_role_protected', message: 'Cannot delete system roles' });
    }

    // Check if role is in use
    const userAssignees = db.prepare('SELECT email FROM user_roles WHERE roleId = ?').all(roleId).map(r => r.email);
    const keyAssignees = db.prepare('SELECT id, label FROM api_keys WHERE roleId = ?').all(roleId);
    if (userAssignees.length > 0 || keyAssignees.length > 0) {
      return res.status(409).json({
        error: 'role_in_use',
        message: 'Cannot delete a role that is still assigned',
        assignees: [...userAssignees, ...keyAssignees.map(k => `key:${k.label}`)],
      });
    }

    // Final-admin guard: if this role grants user.admin
    const caps = safeParseArray(role.capabilities, []);
    if (caps.includes('user.admin')) {
      const guard = guardFinalAdmin(db, 'delete');
      if (!guard.allowed) return res.status(409).json(guard.response);
    }

    db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);

    if (audit) {
      audit.record(null, 'role:deleted', { name: role.name, deletedBy: getActorEmail(req) }, getActorEmail(req));
    }

    res.json({ ok: true });
  });

  // ── User Role Management ──────────────────────────────────

  router.get('/access/users', (req, res) => {
    const users = userStore ? userStore.listUsers() : [];

    // Single JOIN query instead of per-user lookups
    const allUserRoles = db.prepare(`
      SELECT ur.email, ur.roleId, r.capabilities
      FROM user_roles ur JOIN roles r ON r.id = ur.roleId
    `).all();

    // Group by email
    const rolesByEmail = new Map();
    for (const row of allUserRoles) {
      const email = row.email;
      if (!rolesByEmail.has(email)) {
        rolesByEmail.set(email, { roleIds: [], caps: new Set() });
      }
      const entry = rolesByEmail.get(email);
      entry.roleIds.push(row.roleId);
      for (const c of safeParseArray(row.capabilities, [])) entry.caps.add(c);
    }

    const result = users.map(u => {
      const entry = rolesByEmail.get(u.email) || { roleIds: [], caps: new Set() };
      return {
        email: u.email,
        name: u.name,
        picture: u.picture,
        roleIds: entry.roleIds,
        capabilities: Array.from(entry.caps),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      };
    });
    res.json(result);
  });

  router.put('/access/users/:email/roles', (req, res) => {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const { roleIds } = req.body || {};

    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ error: 'invalid_role_ids', message: 'roleIds must be an array' });
    }

    // Validate each roleId exists
    for (const rid of roleIds) {
      const exists = db.prepare('SELECT id FROM roles WHERE id = ?').get(rid);
      if (!exists) {
        return res.status(400).json({ error: 'invalid_role_id', message: `Role '${rid}' does not exist` });
      }
    }

    // Final-admin guard: check if this change would leave zero user.admin principals
    const currentRoles = db.prepare('SELECT roleId FROM user_roles WHERE email = ?').all(email).map(r => r.roleId);
    const hadAdmin = currentRoles.some(rid => {
      const role = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get(rid);
      return role && safeParseArray(role.capabilities, []).includes('user.admin');
    });
    const willHaveAdmin = roleIds.some(rid => {
      const role = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get(rid);
      return role && safeParseArray(role.capabilities, []).includes('user.admin');
    });

    if (hadAdmin && !willHaveAdmin) {
      const guard = guardFinalAdmin(db, 'remove admin role');
      if (!guard.allowed) return res.status(409).json(guard.response);
    }

    // Replace role set in a transaction
    db.transaction(() => {
      db.prepare('DELETE FROM user_roles WHERE email = ?').run(email);
      const stmt = db.prepare('INSERT INTO user_roles (email, roleId, grantedBy, grantedAt) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      for (const rid of roleIds) {
        stmt.run(email, rid, getActorEmail(req), now);
      }
    })();

    if (audit) {
      audit.record(null, 'user:roles-updated', { roleIds, changedBy: getActorEmail(req) }, getActorEmail(req));
    }

    // Broadcast to affected user + admins
    if (broadcastTo) {
      const adminEmails = getAdminEmails(db);
      const targets = [...new Set([email, ...adminEmails])];
      broadcastTo(targets, { type: 'user:roles-updated', email, roleIds });
    }

    res.json({ email, roleIds });
  });

  // ── API Key Management ──────────────────────────────────

  router.get('/access/keys', (req, res) => {
    const rows = db.prepare(`
      SELECT k.id, k.label, k.roleId, k.createdAt, k.createdBy, k.lastUsedAt, r.name as roleName
      FROM api_keys k
      LEFT JOIN roles r ON r.id = k.roleId
      ORDER BY k.createdAt DESC
    `).all();
    res.json(rows);
  });

  router.post('/access/keys', (req, res) => {
    const { label, roleId } = req.body || {};

    if (!label || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'invalid_label', message: 'Label is required' });
    }
    if (!roleId) {
      return res.status(400).json({ error: 'invalid_role_id', message: 'roleId is required' });
    }

    const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId);
    if (!role) {
      return res.status(400).json({ error: 'invalid_role_id', message: `Role '${roleId}' does not exist` });
    }

    const id = `key-${crypto.randomBytes(8).toString('hex')}`;
    const rawBytes = crypto.randomBytes(32);
    const rawKey = KEY_PREFIX + rawBytes.toString('base64url');
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const now = new Date().toISOString();
    const createdBy = getActorEmail(req);

    db.prepare(`INSERT INTO api_keys (id, label, hash, roleId, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, label.trim(), hash, roleId, now, createdBy);

    if (audit) {
      audit.record(null, 'key:created', { label: label.trim(), roleId, createdBy }, createdBy);
    }

    res.status(201).json({ id, rawKey, label: label.trim(), roleId, createdAt: now, createdBy });
  });

  router.patch('/access/keys/:id', (req, res) => {
    const keyId = req.params.id;
    const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
    if (!key) return res.status(404).json({ error: 'not_found', message: 'API key not found' });

    const { roleId } = req.body || {};
    if (!roleId) {
      return res.status(400).json({ error: 'invalid_role_id', message: 'roleId is required' });
    }

    const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId);
    if (!role) {
      return res.status(400).json({ error: 'invalid_role_id', message: `Role '${roleId}' does not exist` });
    }

    // Final-admin guard: if this key currently has user.admin and new role doesn't
    if (key.roleId) {
      const oldRole = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get(key.roleId);
      const hadAdmin = oldRole && safeParseArray(oldRole.capabilities, []).includes('user.admin');
      const newRoleRow = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get(roleId);
      const willHaveAdmin = newRoleRow && safeParseArray(newRoleRow.capabilities, []).includes('user.admin');

      if (hadAdmin && !willHaveAdmin) {
        const guard = guardFinalAdmin(db, 'change role');
        if (!guard.allowed) return res.status(409).json(guard.response);
      }
    }

    const oldRoleId = key.roleId;
    db.prepare('UPDATE api_keys SET roleId = ? WHERE id = ?').run(roleId, keyId);

    if (audit) {
      audit.record(null, 'key:role-updated', { oldRoleId, newRoleId: roleId, changedBy: getActorEmail(req) }, getActorEmail(req));
    }

    res.json({ id: keyId, roleId });
  });

  router.delete('/access/keys/:id', (req, res) => {
    const keyId = req.params.id;
    const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
    if (!key) return res.status(404).json({ error: 'not_found', message: 'API key not found' });

    // Final-admin guard
    if (key.roleId) {
      const role = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get(key.roleId);
      if (role && safeParseArray(role.capabilities, []).includes('user.admin')) {
        const guard = guardFinalAdmin(db, 'revoke');
        if (!guard.allowed) return res.status(409).json(guard.response);
      }
    }

    db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);

    if (audit) {
      audit.record(null, 'key:revoked', { label: key.label, revokedBy: getActorEmail(req) }, getActorEmail(req));
    }

    // Broadcast key:revoked to admins
    if (broadcastTo) {
      const adminEmails = getAdminEmails(db);
      broadcastTo(adminEmails, { type: 'key:revoked', keyId });
    }

    res.json({ ok: true });
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────

function getActorEmail(req) {
  if (req.user && req.user.email) return req.user.email;
  if (req.apiKey) return `apikey:${req.apiKey.keyId || req.apiKey.id}`;
  return null;
}

function getAdminEmails(db) {
  // Find all users who have user.admin capability via any role
  const roles = db.prepare('SELECT id, capabilities FROM roles').all();
  const adminRoleIds = roles
    .filter(r => safeParseArray(r.capabilities, []).includes('user.admin'))
    .map(r => r.id);

  if (adminRoleIds.length === 0) return [];

  const placeholders = adminRoleIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT DISTINCT email FROM user_roles WHERE roleId IN (${placeholders})`).all(...adminRoleIds);
  return rows.map(r => r.email);
}

/**
 * Final-admin guard: ensures at least one principal retains 'user.admin'
 * capability after the proposed change. Call before any mutation that could
 * remove admin access.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} description - human-readable context for the error message
 * @returns {{ allowed: true } | { allowed: false, response: { error: string, message: string } }}
 */
function guardFinalAdmin(db, description) {
  const count = countPrincipalsWithCapability('user.admin', { db });
  if (count - 1 <= 0) {
    return {
      allowed: false,
      response: { error: 'final_admin_guard', message: `Cannot ${description} — would leave zero admin principals` },
    };
  }
  return { allowed: true };
}

module.exports = { createAccessRoutes, guardFinalAdmin };
