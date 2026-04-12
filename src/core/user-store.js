const fs = require('fs');
const path = require('path');
const log = require('./log');

const STATE_FILE = path.join(__dirname, '..', '..', '.nectar-users.json');

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
 * UserStore -- manages user records persisted in .nectar-users.json.
 *
 * Every user who logs in via Google SSO gets recorded here. Admins can
 * then set each user's role and control which pages they can access.
 *
 * The NECTAR_ADMINS env var remains the primary admin source. The stored
 * role is a secondary mechanism so admins can promote other users from
 * the UI without restarting the server.
 */
class UserStore {
  constructor() {
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
      this._save();
      return existing;
    }

    const user = {
      email: key,
      name: name || key,
      picture: picture || null,
      role: 'user',
      permissions: { ...DEFAULT_PERMISSIONS },
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    this.users.set(key, user);
    this._save();
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
   * Update a user's role and/or permissions.
   * Only 'role' and 'permissions' fields can be updated.
   *
   * @param {string} email
   * @param {object} updates - { role?, permissions? }
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

    this._save();
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
   * Flush state to disk (called on shutdown).
   */
  flush() {
    this._save();
  }

  // ── Internal ────────────────────────────────────────────

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (Array.isArray(data.users)) {
          for (const user of data.users) {
            // Ensure permissions object has all keys
            if (!user.permissions) user.permissions = { ...DEFAULT_PERMISSIONS };
            for (const pKey of ALL_PERMISSION_KEYS) {
              if (typeof user.permissions[pKey] !== 'boolean') {
                user.permissions[pKey] = true;
              }
            }
            this.users.set(user.email.toLowerCase(), user);
          }
        }
        log.info(`Loaded ${this.users.size} users`);
      }
    } catch (err) {
      log.error(`Failed to load users: ${err.message}`);
    }
  }

  _save() {
    try {
      const data = { users: Array.from(this.users.values()) };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error(`Failed to save users: ${err.message}`);
    }
  }
}

module.exports = UserStore;
