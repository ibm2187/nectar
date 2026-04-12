const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./log');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-api-keys.json');
const KEY_PREFIX = 'nectar_';

/**
 * ApiKeyManager — create, validate, list, and revoke API keys.
 *
 * Keys are stored hashed (SHA-256) in .nectar-api-keys.json.
 * The raw key is only returned once at creation time.
 *
 * Key format: nectar_<base64url-encoded-32-bytes>
 */
class ApiKeyManager {
  constructor() {
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

    this.keys.set(id, entry);
    this._save();
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
    for (const entry of this.keys.values()) {
      if (entry.hash === hash) {
        // Update last used timestamp
        entry.lastUsedAt = new Date().toISOString();
        this._debounceSave();
        return { valid: true, keyId: entry.id, label: entry.label };
      }
    }

    return { valid: false, keyId: null, label: null };
  }

  /**
   * List all keys (without hashes).
   * @returns {Array<{ id, label, createdAt, createdBy, lastUsedAt }>}
   */
  list() {
    return Array.from(this.keys.values())
      .map(({ id, label, createdAt, createdBy, lastUsedAt }) => ({
        id, label, createdAt, createdBy, lastUsedAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Revoke (delete) an API key by ID.
   * @param {string} keyId
   * @returns {boolean} - true if the key was found and deleted
   */
  revoke(keyId) {
    const existed = this.keys.delete(keyId);
    if (existed) {
      this._save();
      log.info(`API key revoked: ${keyId}`);
    }
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
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (Array.isArray(data.keys)) {
          for (const entry of data.keys) {
            this.keys.set(entry.id, entry);
          }
        }
        log.info(`Loaded ${this.keys.size} API keys`);
      }
    } catch (err) {
      log.error(`Failed to load API keys: ${err.message}`);
    }
  }

  _save() {
    try {
      const data = { keys: Array.from(this.keys.values()) };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error(`Failed to save API keys: ${err.message}`);
    }
  }

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 5000);
  }
}

module.exports = ApiKeyManager;
