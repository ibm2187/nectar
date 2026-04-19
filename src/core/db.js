const Database = require('better-sqlite3');
const path = require('path');
const log = require('./log');

/**
 * Shared SQLite database layer for Nectar.
 *
 * All persistent stores (UserStore, CustomerStore, ReleaseManager, etc.)
 * use a single SQLite database file instead of individual JSON files.
 *
 * Usage:
 *   const { getDb } = require('./db');
 *   const db = getDb();                    // app-wide singleton
 *
 *   const { createTestDb } = require('./db');
 *   const db = createTestDb();             // in-memory, per-test
 *
 * The schema is idempotent (CREATE TABLE IF NOT EXISTS) and applied on
 * every connection open. Column additions for new features should be
 * handled via one-time ALTER TABLE calls in applyMigrations().
 */

const DEFAULT_DB_PATH = path.join(process.cwd(), '.nectar.db');

let sharedDb = null;
let sharedDbPath = null;

/**
 * Get (or lazily create) the shared app-wide database.
 * Respects NECTAR_DB_PATH env var.
 */
function getDb() {
  if (!sharedDb) {
    const dbPath = process.env.NECTAR_DB_PATH || DEFAULT_DB_PATH;
    sharedDb = openDb(dbPath);
    sharedDbPath = dbPath;
    log.info(`SQLite DB opened: ${dbPath}`);
  }
  return sharedDb;
}

/**
 * Close the shared DB (for tests / clean shutdown).
 */
function closeDb() {
  if (sharedDb) {
    try { sharedDb.close(); } catch { /* ok */ }
    sharedDb = null;
    sharedDbPath = null;
  }
}

/**
 * Create a fresh in-memory database for tests.
 * Each test that wants isolation should call this in beforeEach.
 */
function createTestDb() {
  return openDb(':memory:');
}

/**
 * Open a database file with pragmas and schema applied.
 */
function openDb(dbPath) {
  const db = new Database(dbPath);

  // Durability + performance settings
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  applySchema(db);
  applyMigrations(db);
  return db;
}

/**
 * Create every table if missing. Safe to call repeatedly.
 *
 * Column naming: camelCase to match the JS field names so row → object
 * mapping is a direct assignment (no translation layer needed).
 * JSON columns hold nested objects/arrays as TEXT (JSON1 supported
 * natively by SQLite but we keep it simple and round-trip via
 * JSON.parse / JSON.stringify in the store classes).
 */
function applySchema(db) {
  db.exec(`
    -- ── users ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      email              TEXT PRIMARY KEY,
      name               TEXT,
      picture            TEXT,
      role               TEXT NOT NULL DEFAULT 'user',
      permissions        TEXT NOT NULL DEFAULT '{}',  -- JSON
      notificationPrefs  TEXT NOT NULL DEFAULT '{}',  -- JSON
      lastLoginAt        TEXT,
      createdAt          TEXT NOT NULL
    );

    -- ── api_keys ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      hash         TEXT NOT NULL UNIQUE,
      createdAt    TEXT NOT NULL,
      createdBy    TEXT,
      lastUsedAt   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);

    -- ── themes (singleton row) ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS theme_config (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      themes          TEXT NOT NULL DEFAULT '[]',   -- JSON array
      unmappedLabel   TEXT NOT NULL DEFAULT 'Other',
      updatedAt       TEXT
    );

    -- ── tasks ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL,
      input         TEXT NOT NULL DEFAULT '{}',  -- JSON
      output        TEXT,                         -- JSON, nullable
      requestedBy   TEXT,
      slackUserId   TEXT,
      createdAt     TEXT NOT NULL,
      startedAt     TEXT,
      completedAt   TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_type    ON tasks(type);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(createdAt DESC);

    -- ── customers ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS customers (
      id             TEXT PRIMARY KEY,
      name           TEXT,
      domain         TEXT,
      domainPrefix   TEXT,
      integrations   TEXT,       -- JSON
      hasFranchises  INTEGER,    -- 0/1
      active         INTEGER,    -- 0/1
      syncedFrom     TEXT,
      lastSyncedAt   TEXT,
      notes          TEXT,
      extra          TEXT,       -- JSON catch-all for future fields
      createdAt      TEXT,
      updatedAt      TEXT
    );

    -- ── environments ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS environments (
      id                          TEXT PRIMARY KEY,
      customerId                  TEXT,
      name                        TEXT,
      tier                        TEXT,
      franchise                   INTEGER,   -- 0/1
      currentVersion              TEXT,
      currentBranch               TEXT,
      reachable                   INTEGER,   -- 0/1
      lastChecked                 TEXT,
      lastError                   TEXT,
      health                      TEXT,      -- JSON
      features                    TEXT,      -- JSON
      integrations                TEXT,      -- JSON
      upgrades                    TEXT,      -- JSON
      lastHealthCheckedAt         TEXT,
      lastFeaturesCheckedAt       TEXT,
      lastIntegrationsCheckedAt   TEXT,
      lastUpgradesCheckedAt       TEXT,
      disabled                    INTEGER,   -- 0/1
      notes                       TEXT,
      versionSetManually          INTEGER,   -- 0/1
      versionSetBy                TEXT,
      versionSetAt                TEXT,
      extra                       TEXT,      -- JSON catch-all
      createdAt                   TEXT,
      updatedAt                   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_environments_customerId ON environments(customerId);
    CREATE INDEX IF NOT EXISTS idx_environments_tier       ON environments(tier);

    -- ── deployments ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS deployments (
      id                TEXT PRIMARY KEY,
      environmentId     TEXT NOT NULL,
      customerId        TEXT,
      version           TEXT,
      branch            TEXT,
      previousVersion   TEXT,
      detectedAt        TEXT NOT NULL,
      endedAt           TEXT,
      source            TEXT,
      datadogImpact     TEXT       -- JSON
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_envId      ON deployments(environmentId);
    CREATE INDEX IF NOT EXISTS idx_deployments_customerId ON deployments(customerId);
    CREATE INDEX IF NOT EXISTS idx_deployments_detectedAt ON deployments(detectedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_deployments_active     ON deployments(endedAt) WHERE endedAt IS NULL;

    -- ── mobile ──────────────────────────────────────────────────
    -- Mobile releases have an evolving shape; store the full record as JSON.
    CREATE TABLE IF NOT EXISTS mobile (
      id          TEXT PRIMARY KEY,
      data        TEXT NOT NULL,   -- JSON
      updatedAt   TEXT
    );

    -- ── releases ────────────────────────────────────────────────
    -- Primary key is the composite "repo:version" (or just "version" for legacy).
    CREATE TABLE IF NOT EXISTS releases (
      key               TEXT PRIMARY KEY,
      id                TEXT NOT NULL,
      repo              TEXT,
      version           TEXT NOT NULL,
      state             TEXT NOT NULL,
      branch            TEXT,
      cutFrom           TEXT,
      cutAt             TEXT,
      cutBy             TEXT,
      tickets           TEXT NOT NULL DEFAULT '[]',   -- DEPRECATED: tickets now live in jira_tickets table. Column retained for SQLite compat (no DROP COLUMN before 3.35).
      cherryPicks       TEXT NOT NULL DEFAULT '[]',   -- JSON
      ci                TEXT NOT NULL DEFAULT '{}',   -- JSON
      risk              TEXT NOT NULL DEFAULT '{}',   -- JSON
      comments          TEXT NOT NULL DEFAULT '[]',   -- JSON
      deployments       TEXT NOT NULL DEFAULT '[]',   -- JSON
      approvals         TEXT NOT NULL DEFAULT '[]',   -- JSON
      notes             TEXT,
      presentationUrl   TEXT,
      jiraVersionId     TEXT,
      jiraVersionName   TEXT,
      jiraReleased      INTEGER,
      jiraReleaseDate   TEXT,
      jiraArchived      INTEGER,
      extra             TEXT,   -- JSON catch-all
      createdAt         TEXT NOT NULL,
      updatedAt         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_releases_version    ON releases(version);
    CREATE INDEX IF NOT EXISTS idx_releases_repo       ON releases(repo);
    CREATE INDEX IF NOT EXISTS idx_releases_state      ON releases(state);
    CREATE INDEX IF NOT EXISTS idx_releases_createdAt  ON releases(createdAt DESC);

    -- ── audit ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit (
      id          TEXT PRIMARY KEY,
      version     TEXT,
      action      TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '{}',  -- JSON
      user        TEXT,
      at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_version ON audit(version);
    CREATE INDEX IF NOT EXISTS idx_audit_at      ON audit(at DESC);

    -- ── build_cards (pipeline sync) ────────────────────────────
    CREATE TABLE IF NOT EXISTS build_cards (
      projectName     TEXT PRIMARY KEY,
      account         TEXT,
      imageTag        TEXT,
      latestStatus    TEXT,
      latestStartTime TEXT,
      data            TEXT NOT NULL,    -- full card JSON
      updatedAt       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_build_cards_status ON build_cards(latestStatus);
    CREATE INDEX IF NOT EXISTS idx_build_cards_tag    ON build_cards(imageTag);

    -- ── deploy_states (pipeline sync) ──────────────────────────
    CREATE TABLE IF NOT EXISTS deploy_states (
      pipelineName  TEXT PRIMARY KEY,
      imageTag      TEXT,
      customer      TEXT,
      env           TEXT,
      account       TEXT,
      status        TEXT,
      data          TEXT NOT NULL,    -- full state JSON
      updatedAt     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_states_tag ON deploy_states(imageTag);

    -- ── jira_tickets (normalized ticket database) ──────────
    CREATE TABLE IF NOT EXISTS jira_tickets (
      key                  TEXT PRIMARY KEY,
      summary              TEXT NOT NULL DEFAULT '',
      status               TEXT,
      statusCategory       TEXT,
      state                TEXT,              -- Nectar-mapped state (pending|in-progress|ready-for-testing|cherry-picked|done)
      type                 TEXT,
      assignee             TEXT,
      reporter             TEXT,
      qaAssignee           TEXT,
      productAssignee      TEXT,
      component            TEXT,
      module               TEXT,              -- Viv Module (customfield_11124)
      product              TEXT NOT NULL DEFAULT '[]',   -- Viv Product JSON array (customfield_11123)
      projects             TEXT NOT NULL DEFAULT '[]',   -- Projects JSON array (customfield_11122)
      priority             TEXT,
      riskLevel            TEXT,
      customerPriority     TEXT,
      fixVersions          TEXT NOT NULL DEFAULT '[]',   -- JSON array
      targetFixVersions    TEXT NOT NULL DEFAULT '[]',   -- JSON array
      customerTags         TEXT NOT NULL DEFAULT '[]',   -- JSON array
      deployedEnvironments TEXT NOT NULL DEFAULT '[]',   -- JSON array
      labels               TEXT NOT NULL DEFAULT '[]',   -- JSON array
      zohoRef              TEXT,                          -- JSON object
      submitterName        TEXT,
      submitterEmail       TEXT,
      created              TEXT,
      updatedInJira        TEXT,
      syncedAt             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jt_statusCategory ON jira_tickets(statusCategory);
    CREATE INDEX IF NOT EXISTS idx_jt_status         ON jira_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_jt_assignee       ON jira_tickets(assignee);
    CREATE INDEX IF NOT EXISTS idx_jt_created        ON jira_tickets(created);
    CREATE INDEX IF NOT EXISTS idx_jt_module         ON jira_tickets(module);
    CREATE INDEX IF NOT EXISTS idx_jt_component      ON jira_tickets(component);

    -- ── github_prs (normalized PR database) ────────────────
    CREATE TABLE IF NOT EXISTS github_prs (
      prNumber      INTEGER NOT NULL,
      repo          TEXT NOT NULL,
      prTitle       TEXT,
      prAuthor      TEXT,
      prUrl         TEXT,
      status        TEXT NOT NULL,           -- 'open', 'merged', 'closed'
      baseBranch    TEXT,
      headBranch    TEXT,
      prCreatedAt   TEXT,
      prUpdatedAt   TEXT,
      syncedAt      TEXT NOT NULL,
      PRIMARY KEY (repo, prNumber)
    );
    CREATE INDEX IF NOT EXISTS idx_gpr_status     ON github_prs(status);
    CREATE INDEX IF NOT EXISTS idx_gpr_headBranch ON github_prs(headBranch);
    CREATE INDEX IF NOT EXISTS idx_gpr_updatedAt  ON github_prs(prUpdatedAt);

    -- ── pr_jira_keys (PR ↔ JIRA ticket junction) ──────────
    CREATE TABLE IF NOT EXISTS pr_jira_keys (
      repo       TEXT NOT NULL,
      prNumber   INTEGER NOT NULL,
      jiraKey    TEXT NOT NULL,
      PRIMARY KEY (repo, prNumber, jiraKey),
      FOREIGN KEY (repo, prNumber) REFERENCES github_prs(repo, prNumber) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prjk_jiraKey ON pr_jira_keys(jiraKey);

    -- ── pr_sync_meta (singleton — tracks PR sync state) ───
    CREATE TABLE IF NOT EXISTS pr_sync_meta (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      lastSyncTime        TEXT,
      totalPrsSynced      INTEGER NOT NULL DEFAULT 0,
      lastSyncDurationMs  INTEGER,
      lastSyncError       TEXT,
      updatedAt           TEXT
    );

    -- ── jira_sync_meta (singleton — tracks ticket sync state) ─
    CREATE TABLE IF NOT EXISTS jira_sync_meta (
      id                   INTEGER PRIMARY KEY CHECK (id = 1),
      lastTicketSyncTime   TEXT,
      totalTicketsSynced   INTEGER NOT NULL DEFAULT 0,
      lastSyncDurationMs   INTEGER,
      lastSyncError        TEXT,
      updatedAt            TEXT
    );

    -- ── git_commits (persisted commit data per branch) ──────
    CREATE TABLE IF NOT EXISTS git_commits (
      sha          TEXT NOT NULL,
      repo         TEXT NOT NULL,
      branch       TEXT NOT NULL,
      message      TEXT,
      author       TEXT,
      authorDate   TEXT,
      isPostCut    INTEGER DEFAULT 0,
      syncedAt     TEXT NOT NULL,
      PRIMARY KEY (repo, sha, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_gc_branch ON git_commits(repo, branch);
    CREATE INDEX IF NOT EXISTS idx_gc_repo_sha ON git_commits(repo, sha);

    -- ── commit_jira_keys (commit ↔ JIRA key junction) ───────
    CREATE TABLE IF NOT EXISTS commit_jira_keys (
      repo    TEXT NOT NULL,
      sha     TEXT NOT NULL,
      jiraKey TEXT NOT NULL,
      PRIMARY KEY (repo, sha, jiraKey)
    );
    CREATE INDEX IF NOT EXISTS idx_cjk_jiraKey ON commit_jira_keys(jiraKey);

    -- ── ticket_truth (per-ticket per-release truth) ─────────
    CREATE TABLE IF NOT EXISTS ticket_truth (
      jiraKey        TEXT NOT NULL,
      repo           TEXT NOT NULL,
      version        TEXT NOT NULL,
      health         TEXT NOT NULL,
      healthCategory TEXT NOT NULL,
      healthMessage  TEXT,
      onBranch       INTEGER DEFAULT 0,
      prNumber       INTEGER,
      prUrl          TEXT,
      stage          TEXT,
      inTarget       INTEGER DEFAULT 0,
      inFixVersion   INTEGER DEFAULT 0,
      computedAt     TEXT NOT NULL,
      PRIMARY KEY (jiraKey, repo, version)
    );
    CREATE INDEX IF NOT EXISTS idx_tt_version ON ticket_truth(repo, version);
    CREATE INDEX IF NOT EXISTS idx_tt_health ON ticket_truth(healthCategory);
  `);
}

/**
 * One-off migrations for schema changes after rows have been inserted.
 * Uses PRAGMA user_version. Each migration is a pure function on db.
 */
function applyMigrations(db) {
  const current = db.pragma('user_version', { simple: true });

  const migrations = [
    // v1: Add customerColors column to theme_config
    (db) => {
      db.prepare(`ALTER TABLE theme_config ADD COLUMN customerColors TEXT NOT NULL DEFAULT '{}'`).run();
    },
    // v2: Add customer display fields — shortName, color, hidden, sortOrder
    (db) => {
      db.prepare(`ALTER TABLE customers ADD COLUMN shortName TEXT`).run();
      db.prepare(`ALTER TABLE customers ADD COLUMN color TEXT`).run();
      db.prepare(`ALTER TABLE customers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`).run();
      db.prepare(`ALTER TABLE customers ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0`).run();
      // Seed defaults for known customers
      const defaults = [
        { id: 'bayada',      shortName: 'Bayada',       color: '#E31A38', sortOrder: 1 },
        { id: 'ck',          shortName: 'CK',           color: '#0054A6', sortOrder: 2 },
        { id: 'tribute',     shortName: 'Tribute',      color: '#FF671F', sortOrder: 3 },
        { id: 'lumen',       shortName: 'Lumen',        color: '#6D1D68', sortOrder: 4 },
        { id: 'qualitycare', shortName: 'Quality Care', color: '#8B2323', sortOrder: 5 },
        { id: 'viv',         shortName: 'Viv',          color: '#22c55e', sortOrder: 6 },
        { id: 'haven',       shortName: 'Haven',        color: '#64748b', sortOrder: 7, hidden: 1 },
      ];
      const stmt = db.prepare(
        `UPDATE customers SET shortName = @shortName, color = @color, sortOrder = @sortOrder, hidden = COALESCE(@hidden, 0) WHERE id = @id`
      );
      for (const d of defaults) {
        stmt.run({ shortName: d.shortName, color: d.color, sortOrder: d.sortOrder, hidden: d.hidden || 0, id: d.id });
      }
    },
    // v3: Seed jira_sync_meta singleton row
    (db) => {
      db.prepare('INSERT OR IGNORE INTO jira_sync_meta (id, totalTicketsSynced) VALUES (1, 0)').run();
    },
    // v4: Seed pr_sync_meta singleton row
    (db) => {
      db.prepare('INSERT OR IGNORE INTO pr_sync_meta (id, totalPrsSynced) VALUES (1, 0)').run();
    },
    // v5: Add product taxonomy columns to jira_tickets (module, product, projects)
    // and indexes for roadmap queries. Fresh installs already have these in CREATE TABLE.
    // Also purge bulk ticket:added audit entries — these were generated by the old
    // per-release sync that wrote an audit row for every ticket on every cycle.
    // With tickets now in jira_tickets, these entries are noise (~484K rows, ~140MB).
    // Manual ticket:added entries (from API) are rare and get recreated naturally.
    (db) => {
      const cols = db.prepare("PRAGMA table_info(jira_tickets)").all().map(c => c.name);
      if (!cols.includes('module')) {
        db.prepare(`ALTER TABLE jira_tickets ADD COLUMN module TEXT`).run();
      }
      if (!cols.includes('product')) {
        db.prepare(`ALTER TABLE jira_tickets ADD COLUMN product TEXT NOT NULL DEFAULT '[]'`).run();
      }
      if (!cols.includes('projects')) {
        db.prepare(`ALTER TABLE jira_tickets ADD COLUMN projects TEXT NOT NULL DEFAULT '[]'`).run();
      }
      db.prepare('CREATE INDEX IF NOT EXISTS idx_jt_module ON jira_tickets(module)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_jt_component ON jira_tickets(component)').run();
      // Force a full re-sync so existing tickets get the new fields populated
      db.prepare("UPDATE jira_sync_meta SET lastTicketSyncTime = NULL WHERE id = 1").run();
    },
    // v6: Purge bulk ticket:added/removed audit entries.
    // These were generated by the old per-release sync (~484K rows, ~140MB).
    // With tickets now in jira_tickets table, these are noise.
    (db) => {
      const deleted = db.prepare("DELETE FROM audit WHERE action IN ('ticket:added', 'ticket:removed')").run();
      if (deleted.changes > 0) {
        log.info(`DB migration v6: purged ${deleted.changes} bulk audit entries`);
      }
    },
    // v7: Add git_commits, commit_jira_keys, and ticket_truth tables.
    // Fresh installs already have these via CREATE TABLE IF NOT EXISTS in applySchema.
    // This migration is a no-op for fresh installs (tables already exist).
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS git_commits (
          sha          TEXT NOT NULL,
          repo         TEXT NOT NULL,
          branch       TEXT NOT NULL,
          message      TEXT,
          author       TEXT,
          authorDate   TEXT,
          isPostCut    INTEGER DEFAULT 0,
          syncedAt     TEXT NOT NULL,
          PRIMARY KEY (repo, sha, branch)
        );
        CREATE INDEX IF NOT EXISTS idx_gc_branch ON git_commits(repo, branch);
        CREATE INDEX IF NOT EXISTS idx_gc_repo_sha ON git_commits(repo, sha);

        CREATE TABLE IF NOT EXISTS commit_jira_keys (
          repo    TEXT NOT NULL,
          sha     TEXT NOT NULL,
          jiraKey TEXT NOT NULL,
          PRIMARY KEY (repo, sha, jiraKey)
        );
        CREATE INDEX IF NOT EXISTS idx_cjk_jiraKey ON commit_jira_keys(jiraKey);

        CREATE TABLE IF NOT EXISTS ticket_truth (
          jiraKey        TEXT NOT NULL,
          repo           TEXT NOT NULL,
          version        TEXT NOT NULL,
          health         TEXT NOT NULL,
          healthCategory TEXT NOT NULL,
          healthMessage  TEXT,
          onBranch       INTEGER DEFAULT 0,
          prNumber       INTEGER,
          prUrl          TEXT,
          stage          TEXT,
          inTarget       INTEGER DEFAULT 0,
          inFixVersion   INTEGER DEFAULT 0,
          computedAt     TEXT NOT NULL,
          PRIMARY KEY (jiraKey, repo, version)
        );
        CREATE INDEX IF NOT EXISTS idx_tt_version ON ticket_truth(repo, version);
        CREATE INDEX IF NOT EXISTS idx_tt_health ON ticket_truth(healthCategory);
      `);
    },
  ];

  let ranMigration = false;
  for (let v = current; v < migrations.length; v++) {
    const fn = migrations[v];
    db.transaction(() => {
      fn(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
    log.info(`DB migration applied: v${v + 1}`);
    ranMigration = true;
  }

  // VACUUM outside transaction to reclaim space after large deletes (e.g., audit purge)
  if (ranMigration) {
    try { db.prepare('VACUUM').run(); } catch { /* VACUUM may fail in test DBs — ok */ }
  }
}

/**
 * Helper to count rows in a table. Used by the JSON → SQLite migration
 * to decide whether a table is already populated.
 */
function rowCount(db, table) {
  // Table name is not parameterizable — but we control the whitelist.
  if (!/^[a-z_]+$/i.test(table)) throw new Error(`Invalid table: ${table}`);
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

module.exports = {
  getDb,
  closeDb,
  createTestDb,
  openDb,
  rowCount,
  DEFAULT_DB_PATH,
};
