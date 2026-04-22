const log = require('./log');
const { getDb } = require('./db');
const { getAllCapabilityIds } = require('./capabilities');
const { getBreakGlassEmails } = require('./authz');

const DEFAULT_NOTIFICATION_PREFS = {
  dailyDigest: true,
  buildFailures: true,
};

const ALL_NOTIFICATION_PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS);

/**
 * UserStore -- manages user records persisted in the `users` SQLite table.
 *
 * Every user who logs in via Google SSO gets recorded here. Admins can
 * then set each user's role and control which pages they can access.
 *
 * The NECTAR_ADMINS env var remains the primary admin source. The stored
 * role is a secondary mechanism so admins can promote other users from
 * the UI without restarting the server.
 *
 * Architecture: rows live in SQLite; an in-memory Map mirror is kept for
 * fast lookups and for backwards compatibility with tests that poke
 * `store.users` directly.
 */
class UserStore {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db] — inject a DB (tests)
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    this.users = new Map(); // email -> user record
    this._loadState();
  }

  /**
   * Create or update a user on login. Sets lastLoginAt every time.
   * New users get role 'user' and all permissions enabled.
   *
   * @param {string} email
   * @param {string} name
   * @param {string|null} picture
   * @returns {object} user record
   */
  upsertOnLogin(email, name, picture) {
    const key = email.toLowerCase();
    let existing = this.users.get(key);

    if (existing) {
      existing.name = name || existing.name;
      existing.picture = picture || existing.picture;
      existing.lastLoginAt = new Date().toISOString();
      this._upsertRow(existing);
      return existing;
    }

    const user = {
      email: key,
      name: name || key,
      picture: picture || null,
      role: 'user',
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    this.users.set(key, user);
    this._upsertRow(user);
    log.info(`New user recorded: ${key}`);
    return user;
  }

  /**
   * Get a user record by email.
   * @param {string} email
   * @returns {object|null}
   */
  getUser(email) {
    if (!email) return null;
    return this.users.get(email.toLowerCase()) || null;
  }

  /**
   * List all users, sorted by lastLoginAt descending.
   * @returns {Array<object>}
   */
  listUsers() {
    return Array.from(this.users.values())
      .sort((a, b) => (b.lastLoginAt || '').localeCompare(a.lastLoginAt || ''));
  }

  /**
   * Update a user's role and/or notification prefs.
   *
   * @param {string} email
   * @param {object} updates - { role?, notificationPrefs? }
   * @returns {object|null} updated user or null if not found
   */
  updateUser(email, updates) {
    const key = email.toLowerCase();
    const user = this.users.get(key);
    if (!user) return null;

    if (updates.role && (updates.role === 'admin' || updates.role === 'user')) {
      user.role = updates.role;
    }

    if (updates.notificationPrefs && typeof updates.notificationPrefs === 'object') {
      if (!user.notificationPrefs) user.notificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
      for (const nKey of ALL_NOTIFICATION_PREF_KEYS) {
        if (typeof updates.notificationPrefs[nKey] === 'boolean') {
          user.notificationPrefs[nKey] = updates.notificationPrefs[nKey];
        }
      }
    }

    this._upsertRow(user);
    return user;
  }

  /**
   * Get the effective role for an email.
   * Compatibility shim: returns 'admin' if the user holds any role with
   * 'user.admin' capability, otherwise 'user'. NECTAR_ADMINS env var is
   * the primary admin source.
   *
   * TODO: Remove once all consumers use capability checks.
   *
   * @param {string} email
   * @returns {'admin'|'user'}
   */
  getRole(email) {
    if (!email) return 'user';
    const caps = this.getCapabilities(email);
    return caps.includes('user.admin') ? 'admin' : 'user';
  }

  /**
   * Get the role IDs assigned to a user.
   * @param {string} email
   * @returns {string[]} array of role IDs (e.g. ['admin', 'viewer'])
   */
  getRoles(email) {
    if (!email) return [];
    const rows = this.db.prepare('SELECT roleId FROM user_roles WHERE email = ?')
      .all(email.toLowerCase());
    return rows.map(r => r.roleId);
  }

  /**
   * Get the resolved capabilities for a user (union of all assigned roles).
   * Break-glass users (NECTAR_ADMINS) get all capabilities regardless of DB state.
   *
   * @param {string} email
   * @returns {string[]} de-duplicated array of capability IDs
   */
  getCapabilities(email) {
    if (!email) return [];
    const key = email.toLowerCase();

    // Break-glass: NECTAR_ADMINS always get full capabilities
    const breakGlass = getBreakGlassEmails();
    if (breakGlass.size === 0) return getAllCapabilityIds(); // No admins = everyone gets all
    if (breakGlass.has(key)) return getAllCapabilityIds();

    // Resolve from DB: union of all assigned roles' capabilities
    const rows = this.db.prepare(`
      SELECT r.capabilities FROM user_roles ur
      JOIN roles r ON r.id = ur.roleId
      WHERE ur.email = ?
    `).all(key);

    const caps = new Set();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.capabilities);
        if (Array.isArray(parsed)) {
          for (const c of parsed) caps.add(c);
        }
      } catch { /* ignore malformed */ }
    }
    return Array.from(caps);
  }

  /**
   * Check if a user is an admin sourced from NECTAR_ADMINS env var
   * (not from stored role). Used to decide whether the UI should show
   * the edit button.
   *
   * @param {string} email
   * @returns {boolean}
   */
  isEnvAdmin(email) {
    if (!email) return false;
    const breakGlass = getBreakGlassEmails();
    if (breakGlass.size === 0) return true;
    return breakGlass.has(email.toLowerCase());
  }

  /**
   * No-op retained for backward compatibility. Writes are synchronous.
   */
  flush() { /* no-op with SQLite */ }

  // ── Internal ────────────────────────────────────────────

  _upsertRow(user) {
    this.db.prepare(`
      INSERT INTO users (email, name, picture, role, notificationPrefs, lastLoginAt, createdAt)
      VALUES (@email, @name, @picture, @role, @notificationPrefs, @lastLoginAt, @createdAt)
      ON CONFLICT(email) DO UPDATE SET
        name              = excluded.name,
        picture           = excluded.picture,
        role              = excluded.role,
        notificationPrefs = excluded.notificationPrefs,
        lastLoginAt       = excluded.lastLoginAt
    `).run({
      email: user.email,
      name: user.name ?? null,
      picture: user.picture ?? null,
      role: user.role || 'user',
      notificationPrefs: JSON.stringify(user.notificationPrefs || {}),
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
    });
  }

  _loadState() {
    try {
      const rows = this.db.prepare('SELECT * FROM users').all();
      for (const row of rows) {
        const notificationPrefs = safeParseObj(row.notificationPrefs, DEFAULT_NOTIFICATION_PREFS);
        for (const nKey of ALL_NOTIFICATION_PREF_KEYS) {
          if (typeof notificationPrefs[nKey] !== 'boolean') notificationPrefs[nKey] = DEFAULT_NOTIFICATION_PREFS[nKey];
        }

        this.users.set(row.email.toLowerCase(), {
          email: row.email,
          name: row.name,
          picture: row.picture,
          role: row.role,
          notificationPrefs,
          lastLoginAt: row.lastLoginAt,
          createdAt: row.createdAt,
        });
      }
      log.info(`Loaded ${this.users.size} users`);
    } catch (err) {
      log.error(`Failed to load users: ${err.message}`);
    }
  }
}

function safeParseObj(value, fallback) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

module.exports = UserStore;
