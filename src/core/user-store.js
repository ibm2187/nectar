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
      teamId: null,
      jiraName: null,
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
   * Upsert identity metadata for a user who may or may not have logged in yet.
   * Used by the Zoho agent sync and JIRA user reconciliation to populate
   * stable cross-system IDs (zohoAgentId, jiraAccountId) even before the
   * person's first Google login. Does NOT touch lastLoginAt.
   *
   * @param {object} updates
   *   email:           required, used as PK (normalized to lowercase)
   *   name?:           display name (used for rendering when displayNameZoho absent)
   *   zohoAgentId?:    stable Zoho ID
   *   jiraAccountId?:  stable Atlassian accountId
   *   displayNameZoho?: preferred display name ("First Last")
   *   isBot?:          true for automation accounts (hive@, etc.)
   * @returns {object} the updated (or newly created) user record
   */
  upsertIdentity(updates) {
    if (!updates || !updates.email) throw new Error('upsertIdentity requires email');
    const key = updates.email.toLowerCase();
    const now = new Date().toISOString();
    let user = this.users.get(key);
    if (!user) {
      user = {
        email: key,
        name: updates.name || key,
        picture: null,
        role: 'user',
        notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
        lastLoginAt: null,
        createdAt: now,
      };
    }
    if (updates.name && !user.name) user.name = updates.name;
    if (typeof updates.zohoAgentId !== 'undefined') user.zohoAgentId = updates.zohoAgentId;
    if (typeof updates.jiraAccountId !== 'undefined') user.jiraAccountId = updates.jiraAccountId;
    if (typeof updates.displayNameZoho !== 'undefined') user.displayNameZoho = updates.displayNameZoho;
    if (typeof updates.isBot === 'boolean') user.isBot = updates.isBot;

    this.users.set(key, user);
    this._upsertIdentityRow(user);
    return user;
  }

  /** Lookup a user by Zoho agent ID. Returns null if no such mapping. */
  findByZohoAgentId(zohoAgentId) {
    if (!zohoAgentId) return null;
    const row = this.db.prepare('SELECT * FROM users WHERE zohoAgentId = ?').get(zohoAgentId);
    return row ? this.users.get(row.email.toLowerCase()) || null : null;
  }

  /** Lookup a user by JIRA accountId. Returns null if no such mapping. */
  findByJiraAccountId(jiraAccountId) {
    if (!jiraAccountId) return null;
    const row = this.db.prepare('SELECT * FROM users WHERE jiraAccountId = ?').get(jiraAccountId);
    return row ? this.users.get(row.email.toLowerCase()) || null : null;
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
   * Assign (or clear) the user's team. Pass null to remove.
   * @param {string} email
   * @param {string|null} teamId
   * @returns {object} updated user
   */
  setTeam(email, teamId) {
    const key = email.toLowerCase();
    const user = this.users.get(key);
    if (!user) throw new Error(`User ${email} not found`);
    const next = { ...user, teamId: teamId ?? null };
    this.users.set(key, next);
    this.db.prepare('UPDATE users SET teamId = ? WHERE email = ?').run(next.teamId, key);
    return next;
  }

  /**
   * Set (or clear) the user's JIRA display name used to match standup people.
   * @param {string} email
   * @param {string|null} jiraName
   * @returns {object} updated user
   */
  setJiraName(email, jiraName) {
    const key = email.toLowerCase();
    const user = this.users.get(key);
    if (!user) throw new Error(`User ${email} not found`);
    const next = { ...user, jiraName: jiraName ?? null };
    this.users.set(key, next);
    this.db.prepare('UPDATE users SET jiraName = ? WHERE email = ?').run(next.jiraName, key);
    return next;
  }

  /**
   * Users who can appear in standup — those with a non-empty jiraName.
   * @returns {Array<{email:string, name:string, teamId:string|null, jiraName:string}>}
   */
  listForStandup() {
    return this.db.prepare(`SELECT email, name, teamId, jiraName
      FROM users WHERE jiraName IS NOT NULL AND jiraName != ''`).all();
  }

  /**
   * No-op retained for backward compatibility. Writes are synchronous.
   */
  flush() { /* no-op with SQLite */ }

  /**
   * Re-read every user row from the DB into the in-memory Map.
   *
   * Needed in the split-process deployment: the sync worker populates
   * identity columns (zohoAgentId, jiraAccountId) while the web process
   * already holds a stale Map. Called periodically by the change-detection
   * poll in web-server.js.
   */
  reload() {
    this.users.clear();
    this._loadState();
  }

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

  _upsertIdentityRow(user) {
    this.db.prepare(`
      INSERT INTO users (
        email, name, picture, role, notificationPrefs, lastLoginAt, createdAt,
        zohoAgentId, jiraAccountId, displayNameZoho, isBot
      ) VALUES (
        @email, @name, @picture, @role, @notificationPrefs, @lastLoginAt, @createdAt,
        @zohoAgentId, @jiraAccountId, @displayNameZoho, @isBot
      )
      ON CONFLICT(email) DO UPDATE SET
        name            = COALESCE(excluded.name, name),
        zohoAgentId     = COALESCE(excluded.zohoAgentId, zohoAgentId),
        jiraAccountId   = COALESCE(excluded.jiraAccountId, jiraAccountId),
        displayNameZoho = COALESCE(excluded.displayNameZoho, displayNameZoho),
        isBot           = excluded.isBot
    `).run({
      email: user.email,
      name: user.name ?? null,
      picture: user.picture ?? null,
      role: user.role || 'user',
      notificationPrefs: JSON.stringify(user.notificationPrefs || {}),
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      zohoAgentId: user.zohoAgentId ?? null,
      jiraAccountId: user.jiraAccountId ?? null,
      displayNameZoho: user.displayNameZoho ?? null,
      isBot: user.isBot ? 1 : 0,
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
          teamId: row.teamId ?? null,
          jiraName: row.jiraName ?? null,
          zohoAgentId: row.zohoAgentId ?? null,
          jiraAccountId: row.jiraAccountId ?? null,
          displayNameZoho: row.displayNameZoho ?? null,
          isBot: row.isBot === 1,
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
