/**
 * Authorization engine — the single chokepoint for all authorization
 * decisions in nectar. Depends on db.js (to query user_roles, roles,
 * api_keys) and capabilities.js.
 */

const { getDb } = require('./db');
const { isValidCapability, getAllCapabilityIds } = require('./capabilities');
const { safeParseArray } = require('./json-utils');
const log = require('./log');

/**
 * Parse NECTAR_ADMINS env var into a lowercase email set.
 * @returns {Set<string>}
 */
function getBreakGlassEmails() {
  const raw = process.env.NECTAR_ADMINS || '';
  const emails = raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return new Set(emails);
}

/**
 * Check if dev mode is active (SSO disabled = open access).
 * @returns {boolean}
 */
function isDevMode() {
  return process.env.ENABLE_GOOGLE_SSO !== 'true';
}

/**
 * Authorize a principal for a given capability.
 *
 * @param {object} principal - { type: 'user'|'apikey', email?: string, keyId?: string }
 * @param {string} capability - capability ID (e.g. 'release.write')
 * @param {string} [resource] - extensibility seam for per-resource scoping (ignored in v1)
 * @param {object} [opts]
 * @param {import('better-sqlite3').Database} [opts.db] - injected DB (tests)
 * @param {object} [opts.audit] - Audit instance for logging denials
 * @returns {boolean}
 */
function authorize(principal, capability, resource, opts = {}) {
  const db = opts.db || getDb();

  // Dev-mode override: SSO disabled = everyone gets full access
  if (isDevMode()) return true;

  // Break-glass override: NECTAR_ADMINS env var emails always get full access
  const breakGlass = getBreakGlassEmails();
  if (breakGlass.size === 0) return true; // No admins configured = everyone is admin

  if (principal.type === 'user' && principal.email) {
    if (breakGlass.has(principal.email.toLowerCase())) return true;
  }

  // Resolve capabilities from DB
  const caps = resolvePrincipalCapabilities(principal, db);
  const allowed = caps.has(capability);

  // Audit denial on mutating capabilities
  if (!allowed && opts.audit) {
    try {
      opts.audit.record(null, 'authz:denied', {
        principal: principal.type === 'user' ? principal.email : `apikey:${principal.keyId}`,
        capability,
        resource: resource || null,
        outcome: 'deny',
      }, principal.email || null);
    } catch {
      // Don't let audit failures block authorization
    }
  }

  return allowed;
}

/**
 * Resolve the set of capabilities for a principal from the database.
 * @param {object} principal
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
function resolvePrincipalCapabilities(principal, db) {
  if (principal.type === 'user' && principal.email) {
    // Look up user's role IDs from user_roles, then union capabilities
    const rows = db.prepare(`
      SELECT r.capabilities FROM user_roles ur
      JOIN roles r ON r.id = ur.roleId
      WHERE ur.email = ?
    `).all(principal.email.toLowerCase());

    const caps = new Set();
    for (const row of rows) {
      const parsed = safeParseArray(row.capabilities, []);
      for (const cap of parsed) caps.add(cap);
    }
    return caps;
  }

  if (principal.type === 'apikey' && principal.keyId) {
    // Look up API key's role, then fetch that role's capabilities
    const keyRow = db.prepare('SELECT roleId FROM api_keys WHERE id = ?').get(principal.keyId);
    if (!keyRow || !keyRow.roleId) return new Set();

    const role = db.prepare('SELECT capabilities FROM roles WHERE id = ?').get(keyRow.roleId);
    if (!role) return new Set();

    return new Set(safeParseArray(role.capabilities, []));
  }

  return new Set();
}

/**
 * Express middleware factory — gates an endpoint behind a capability.
 *
 * @param {string} capability - required capability ID
 * @param {object} [opts]
 * @param {object} [opts.audit] - Audit instance for logging denials
 * @param {import('better-sqlite3').Database} [opts.db] - injected DB (tests)
 * @returns {function} Express middleware
 */
function requireCapability(capability, opts = {}) {
  return (req, res, next) => {
    const principal = extractPrincipal(req);
    if (!principal) {
      return res.status(401).json({ error: 'unauthenticated', message: 'Authentication required' });
    }

    const allowed = authorize(principal, capability, null, { audit: opts.audit, db: opts.db });
    if (!allowed) {
      return res.status(403).json({
        error: 'access_denied',
        message: `Missing required capability: ${capability}`,
        capability,
      });
    }

    next();
  };
}

/**
 * MCP tool authorization helper. Checks if the API key used to make
 * the MCP request holds the given capability.
 *
 * @param {object} req - MCP request context (must have apiKey info)
 * @param {string} capability
 * @param {object} [opts]
 * @param {import('better-sqlite3').Database} [opts.db]
 * @param {object} [opts.audit]
 * @throws {Error} with code -32603 on denial
 */
function authorizeMcpTool(req, capability, opts = {}) {
  const principal = extractPrincipal(req);
  if (!principal) {
    const err = new Error(`Authentication required for capability: ${capability}`);
    err.code = -32603;
    throw err;
  }

  const allowed = authorize(principal, capability, null, opts);
  if (!allowed) {
    const err = new Error(`Access denied: missing capability '${capability}'`);
    err.code = -32603;
    throw err;
  }
}

/**
 * Extract a principal from an Express request.
 * @param {object} req
 * @returns {object|null} - { type, email?, keyId? }
 */
function extractPrincipal(req) {
  if (req.apiKey) {
    return { type: 'apikey', keyId: req.apiKey.keyId || req.apiKey.id };
  }
  if (req.user && req.user.email) {
    return { type: 'user', email: req.user.email };
  }
  // Dev mode: no auth means we treat as an unidentified user with full access
  // (handled by the isDevMode() check in authorize())
  if (isDevMode()) {
    return { type: 'user', email: 'dev-mode' };
  }
  return null;
}

/**
 * Count the number of principals that currently hold a given capability.
 * Used by the final-admin guard.
 *
 * @param {string} capability
 * @param {object} [opts]
 * @param {import('better-sqlite3').Database} [opts.db]
 * @returns {number}
 */
function countPrincipalsWithCapability(capability, opts = {}) {
  const db = opts.db || getDb();

  // Find all roles that grant this capability
  const roles = db.prepare('SELECT id, capabilities FROM roles').all();
  const grantingRoleIds = new Set();
  for (const role of roles) {
    const caps = safeParseArray(role.capabilities, []);
    if (caps.includes(capability)) {
      grantingRoleIds.add(role.id);
    }
  }

  if (grantingRoleIds.size === 0) return 0;

  const placeholders = Array.from(grantingRoleIds).map(() => '?').join(',');

  // Count distinct users with at least one granting role
  const userCount = db.prepare(`
    SELECT COUNT(DISTINCT email) AS n FROM user_roles
    WHERE roleId IN (${placeholders})
  `).get(...grantingRoleIds).n;

  // Count API keys with a granting role
  const keyCount = db.prepare(`
    SELECT COUNT(*) AS n FROM api_keys
    WHERE roleId IN (${placeholders})
  `).get(...grantingRoleIds).n;

  return userCount + keyCount;
}

module.exports = {
  authorize,
  requireCapability,
  authorizeMcpTool,
  extractPrincipal,
  countPrincipalsWithCapability,
  // Exported for testing
  resolvePrincipalCapabilities,
  getBreakGlassEmails,
  isDevMode,
};
