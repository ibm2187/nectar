const log = require('./log');
const { getDb } = require('./db');

const DEFAULT_NOTIFICATION_PREFS = {
  dailyDigest: true,
  buildFailures: true,
};

const ALL_NOTIFICATION_PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS);

const DEFAULT_PERMISSIONS = {
  releases: true,
  roadmap: true,
  tickets: true,
  environments: true,
  health: true,
  features: true,
  integrations: true,
  issues: true,
  tasks: true,
};

const ALL_PERMISSION_KEYS = Object.keys(DEFAULT_PERMISSIONS);

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
      permissions: { ...DEFAULT_PERMISSIONS },
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
   * Update a user's role, permissions, and/or notification prefs.
   *
   * @param {string} email
   * @param {object} updates - { role?, permissions?, notificationPrefs? }
   * @returns {object|null} updated user or null if not found
   */
  updateUser(email, updates) {
    const key = email.toLowerCase();
    const user = this.users.get(key);
    if (!user) return null;

    if (updates.role && (updates.role === 'admin' || updates.role === 'user')) {
      user.role = updates.role;
    }

    if (updates.permissions && typeof updates.permissions === 'object') {
      for (const pKey of ALL_PERMISSION_KEYS) {
        if (typeof updates.permissions[pKey] === 'boolean') {
          user.permissions[pKey] = updates.permissions[pKey];
        }
      }
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
   * NECTAR_ADMINS env var is the primary admin source. If the email is
   * listed there, they are always 'admin'. Otherwise check stored role.
   * Default is 'user'.
   *
   * @param {string} email
   * @returns {'admin'|'user'}
   */
  getRole(email) {
    if (!email) return 'user';
    const key = email.toLowerCase();

    // Primary: NECTAR_ADMINS env var
    const envAdmins = (process.env.NECTAR_ADMINS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    if (envAdmins.length === 0) return 'admin'; // No admins configured = everyone is admin
    if (envAdmins.includes(key)) return 'admin';

    // Secondary: stored user role
    const user = this.users.get(key);
    if (user && user.role === 'admin') return 'admin';

    return 'user';
  }

  /**
   * Get effective permissions for an email.
   * Admins always get all permissions = true.
   *
   * @param {string} email
   * @returns {object} permissions object
   */
  getPermissions(email) {
    const role = this.getRole(email);
    if (role === 'admin') {
      // Admins get all permissions
      return { ...DEFAULT_PERMISSIONS };
    }

    const user = this.getUser(email);
    if (user && user.permissions) {
      // Fill in any missing permission keys with defaults
      const perms = { ...DEFAULT_PERMISSIONS };
      for (const pKey of ALL_PERMISSION_KEYS) {
        if (typeof user.permissions[pKey] === 'boolean') {
          perms[pKey] = user.permissions[pKey];
        }
      }
      return perms;
    }

    // No stored record -- default all true
    return { ...DEFAULT_PERMISSIONS };
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
    const envAdmins = (process.env.NECTAR_ADMINS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    if (envAdmins.length === 0) return true;
    return envAdmins.includes(email.toLowerCase());
  }

  /**
   * No-op retained for backward compatibility. Writes are synchronous.
   */
  flush() { /* no-op with SQLite */ }

  // ── Internal ────────────────────────────────────────────

  _upsertRow(user) {
    this.db.prepare(`
      INSERT INTO users (email, name, picture, role, permissions, notificationPrefs, lastLoginAt, createdAt)
      VALUES (@email, @name, @picture, @role, @permissions, @notificationPrefs, @lastLoginAt, @createdAt)
      ON CONFLICT(email) DO UPDATE SET
        name              = excluded.name,
        picture           = excluded.picture,
        role              = excluded.role,
        permissions       = excluded.permissions,
        notificationPrefs = excluded.notificationPrefs,
        lastLoginAt       = excluded.lastLoginAt
    `).run({
      email: user.email,
      name: user.name ?? null,
      picture: user.picture ?? null,
      role: user.role || 'user',
      permissions: JSON.stringify(user.permissions || {}),
      notificationPrefs: JSON.stringify(user.notificationPrefs || {}),
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
    });
  }

  _loadState() {
    try {
      const rows = this.db.prepare('SELECT * FROM users').all();
      for (const row of rows) {
        const permissions = safeParseObj(row.permissions, DEFAULT_PERMISSIONS);
        // Fill in any missing permission keys with default true
        for (const pKey of ALL_PERMISSION_KEYS) {
          if (typeof permissions[pKey] !== 'boolean') permissions[pKey] = true;
        }

        const notificationPrefs = safeParseObj(row.notificationPrefs, DEFAULT_NOTIFICATION_PREFS);
        for (const nKey of ALL_NOTIFICATION_PREF_KEYS) {
          if (typeof notificationPrefs[nKey] !== 'boolean') notificationPrefs[nKey] = DEFAULT_NOTIFICATION_PREFS[nKey];
        }

        this.users.set(row.email.toLowerCase(), {
          email: row.email,
          name: row.name,
          picture: row.picture,
          role: row.role,
          permissions,
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
