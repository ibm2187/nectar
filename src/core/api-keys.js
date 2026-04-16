const crypto = require('crypto');
const log = require('./log');
const { getDb } = require('./db');

const KEY_PREFIX = 'nectar_';

/**
 * ApiKeyManager — create, validate, list, and revoke API keys.
 *
 * Keys are stored hashed (SHA-256) in the `api_keys` table.
 * The raw key is only returned once at creation time.
 *
 * Key format: nectar_<base64url-encoded-32-bytes>
 */
class ApiKeyManager {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db] — inject a DB (tests)
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    // In-memory mirror for backwards compat with tests that poke `.keys`.
    this.keys = new Map(); // id → { id, label, hash, createdAt, createdBy, lastUsedAt }
    this._loadState();
  }

  /**
   * Create a new API key.
   * @param {string} label - Human-readable label for the key
   * @param {string|null} createdBy - Email or identifier of the creator
   * @returns {{ id: string, rawKey: string, label: string, createdAt: string }}
   */
  create(label, createdBy = null) {
    if (!label || !label.trim()) {
      throw new Error('Label is required');
    }

    const id = `key-${crypto.randomBytes(8).toString('hex')}`;
    const rawBytes = crypto.randomBytes(32);
    const rawKey = KEY_PREFIX + rawBytes.toString('base64url');
    const hash = this._hash(rawKey);

    const entry = {
      id,
      label: label.trim(),
      hash,
      createdAt: new Date().toISOString(),
      createdBy,
      lastUsedAt: null,
    };

    this.db.prepare(`
      INSERT INTO api_keys (id, label, hash, createdAt, createdBy, lastUsedAt)
      VALUES (@id, @label, @hash, @createdAt, @createdBy, @lastUsedAt)
    `).run(entry);
    this.keys.set(id, entry);
    log.info(`API key created: ${id} (${label})`);

    return {
      id,
      rawKey,
      label: entry.label,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
    };
  }

  /**
   * Validate a raw API key.
   * @param {string} rawKey - The full key string including prefix
   * @returns {{ valid: boolean, keyId: string|null, label: string|null }}
   */
  validate(rawKey) {
    if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) {
      return { valid: false, keyId: null, label: null };
    }

    const hash = this._hash(rawKey);
    const row = this.db.prepare('SELECT id, label FROM api_keys WHERE hash = ?').get(hash);
    if (!row) return { valid: false, keyId: null, label: null };

    const now = new Date().toISOString();
    this.db.prepare('UPDATE api_keys SET lastUsedAt = ? WHERE id = ?').run(now, row.id);
    const mirrored = this.keys.get(row.id);
    if (mirrored) mirrored.lastUsedAt = now;

    return { valid: true, keyId: row.id, label: row.label };
  }

  /**
   * List all keys (without hashes).
   * @returns {Array<{ id, label, createdAt, createdBy, lastUsedAt }>}
   */
  list() {
    return this.db.prepare(`
      SELECT id, label, createdAt, createdBy, lastUsedAt
      FROM api_keys
      ORDER BY createdAt DESC
    `).all();
  }

  /**
   * Revoke (delete) an API key by ID.
   * @param {string} keyId
   * @returns {boolean} - true if the key was found and deleted
   */
  revoke(keyId) {
    const result = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyId);
    const existed = result.changes > 0;
    this.keys.delete(keyId);
    if (existed) log.info(`API key revoked: ${keyId}`);
    return existed;
  }

  /**
   * Express middleware that validates API keys from the Authorization header.
   * Sets req.apiKey = { keyId, label } if valid.
   */
  middleware() {
    return (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) return next();

      const token = auth.slice(7);
      if (!token.startsWith(KEY_PREFIX)) return next();

      const result = this.validate(token);
      if (result.valid) {
        req.apiKey = { keyId: result.keyId, label: result.label };
        req.authenticated = true;
      }
      next();
    };
  }

  // ── Internal ────────────────────────────────────────────

  _hash(rawKey) {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
  }

  _loadState() {
    try {
      const rows = this.db.prepare('SELECT id, label, hash, createdAt, createdBy, lastUsedAt FROM api_keys').all();
      for (const row of rows) this.keys.set(row.id, row);
      log.info(`Loaded ${this.keys.size} API keys`);
    } catch (err) {
      log.error(`Failed to load API keys: ${err.message}`);
    }
  }
}

module.exports = ApiKeyManager;
