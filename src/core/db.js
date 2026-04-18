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
      tickets           TEXT NOT NULL DEFAULT '[]',   -- JSON
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
  ];

  for (let v = current; v < migrations.length; v++) {
    const fn = migrations[v];
    db.transaction(() => {
      fn(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
    log.info(`DB migration applied: v${v + 1}`);
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
