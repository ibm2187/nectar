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
    -- Viv-internal people. Email is the bootstrap join key; stable IDs
    -- (zohoAgentId, jiraAccountId) are populated as agents/JIRA users are
    -- discovered so email changes don't break downstream joins.
    CREATE TABLE IF NOT EXISTS users (
      email              TEXT PRIMARY KEY,
      name               TEXT,
      picture            TEXT,
      role               TEXT NOT NULL DEFAULT 'user',
      notificationPrefs  TEXT NOT NULL DEFAULT '{}',  -- JSON
      lastLoginAt        TEXT,
      createdAt          TEXT NOT NULL,
      -- Teams + JIRA name (v15)
      teamId             TEXT,
      jiraName           TEXT,
      -- Identity reconciliation columns (v16+)
      zohoAgentId        TEXT,
      jiraAccountId      TEXT,
      displayNameZoho    TEXT,           -- Zoho's formatted "First Last" — preferred for rendering
      isBot              INTEGER NOT NULL DEFAULT 0
    );
    -- Indexes for teamId (v15) / zohoAgentId + jiraAccountId (v16) created in migrations.

    -- ── api_keys ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      hash         TEXT NOT NULL UNIQUE,
      roleId       TEXT,
      createdAt    TEXT NOT NULL,
      createdBy    TEXT,
      lastUsedAt   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);

    -- ── roles (access control) ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS roles (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      description  TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      system       INTEGER NOT NULL DEFAULT 0,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    -- ── user_roles (access control) ──────────��─────────────────
    CREATE TABLE IF NOT EXISTS user_roles (
      email     TEXT NOT NULL,
      roleId    TEXT NOT NULL,
      grantedBy TEXT,
      grantedAt TEXT NOT NULL,
      PRIMARY KEY (email, roleId)
    );
    CREATE INDEX IF NOT EXISTS idx_ur_email ON user_roles(email);
    CREATE INDEX IF NOT EXISTS idx_ur_role ON user_roles(roleId);

    -- ── teams ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS teams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      color       TEXT NOT NULL,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

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

    -- ── notification_settings (singleton row) ────────────────
    CREATE TABLE IF NOT EXISTS notification_settings (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      enabled         INTEGER NOT NULL DEFAULT 1,
      redirectChannel TEXT,
      redirectDM      TEXT,
      groups          TEXT NOT NULL DEFAULT '{}',
      updatedAt       TEXT
    );

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

    -- ── release_templates (configurable process milestones) ────
    CREATE TABLE IF NOT EXISTS release_templates (
      key             TEXT PRIMARY KEY,
      label           TEXT NOT NULL,
      shipDay         TEXT,              -- "wednesday", "tuesday", etc. or null
      bufferDay       TEXT,              -- delay buffer day
      skipWeekends    INTEGER NOT NULL DEFAULT 1,
      milestones      TEXT NOT NULL DEFAULT '[]',  -- JSON array of milestone definitions
      version         INTEGER NOT NULL DEFAULT 1,
      updatedAt       TEXT NOT NULL,
      updatedBy       TEXT
    );

    -- ── release_scorecards (post-ship process metrics) ────────
    CREATE TABLE IF NOT EXISTS release_scorecards (
      releaseKey        TEXT PRIMARY KEY,
      gateHitRate       REAL,
      onTimeShip        INTEGER,
      scopeChanges      INTEGER,
      postFreezeChanges INTEGER,
      qaBugsFound       INTEGER,
      qaSlaViolations   INTEGER,
      migrationCount    INTEGER,
      rcaFiledAt        TEXT,
      cycleTimeDays     INTEGER,
      detail            TEXT NOT NULL DEFAULT '{}',  -- JSON full scorecard
      computedAt        TEXT NOT NULL
    );

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
      platforms            TEXT NOT NULL DEFAULT '[]',   -- JSON array: 'ios' | 'android' | 'web'
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
      prNumber        INTEGER NOT NULL,
      repo            TEXT NOT NULL,
      prTitle         TEXT,
      prAuthor        TEXT,
      prUrl           TEXT,
      status          TEXT NOT NULL,           -- 'open', 'merged', 'closed'
      reviewDecision  TEXT,                    -- 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', or NULL
      baseBranch      TEXT,
      headBranch      TEXT,
      prCreatedAt     TEXT,
      prUpdatedAt     TEXT,
      syncedAt        TEXT NOT NULL,
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

    -- ── alert_rules (configurable Slack alert routing) ─────
    CREATE TABLE IF NOT EXISTS alert_rules (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      triggerType  TEXT NOT NULL,
      filter       TEXT NOT NULL DEFAULT '{}',     -- JSON: { customerIds?, envIds?, envTier?, components?, sustainedMinutes? }
      channels     TEXT NOT NULL DEFAULT '[]',     -- JSON array of channel names
      mention      TEXT,                            -- '@here' | '<!subteam^S123>' | '<@U123>' | null
      severity     TEXT NOT NULL DEFAULT 'critical',
      enabled      INTEGER NOT NULL DEFAULT 1,
      lastFiredAt  TEXT,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rules_trigger ON alert_rules(triggerType);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);

    -- ── alert_state (transition detection + dedup) ─────────
    CREATE TABLE IF NOT EXISTS alert_state (
      key                TEXT PRIMARY KEY,            -- e.g. "env-health:<envId>"
      status             TEXT,                         -- 'healthy' | 'degraded' | 'unhealthy' | etc.
      failingComponents  TEXT NOT NULL DEFAULT '[]',   -- JSON array
      firstFailedAt      TEXT,                         -- ISO, for sustained detection
      lastAlertedAt      TEXT,                         -- ISO, for dedup window
      consecutiveCount   INTEGER NOT NULL DEFAULT 0,   -- consecutive polls in current state (flap guard)
      incidentId         TEXT,                         -- FK to current open incident
      escalated          INTEGER NOT NULL DEFAULT 0,   -- 1 once sustained-degraded has fired for this streak
      updatedAt          TEXT NOT NULL
    );

    -- ── alert_incidents (first-class tracked incident) ─────
    CREATE TABLE IF NOT EXISTS alert_incidents (
      id                 TEXT PRIMARY KEY,
      ruleId             TEXT,                         -- null for manual incidents
      triggerType        TEXT NOT NULL,                -- or 'manual'
      source             TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'manual'
      subjectKey         TEXT,                         -- e.g. "<envId>:Cache"
      customerId         TEXT,                         -- denormalized for filtering
      envId              TEXT,                         -- denormalized for filtering

      summary            TEXT NOT NULL,
      description        TEXT,
      severity           TEXT NOT NULL DEFAULT 'critical',

      status             TEXT NOT NULL DEFAULT 'open', -- 'open' | 'acknowledged' | 'resolved' | 'reopened'
      assigneeUserId     TEXT,
      assigneeSlackId    TEXT,

      openedAt           TEXT NOT NULL,
      acknowledgedAt     TEXT,
      acknowledgedBy     TEXT,
      resolvedAt         TEXT,
      resolvedBy         TEXT,
      resolution         TEXT,                         -- 'auto' | 'manual' | null

      slackChannel       TEXT,
      slackTs            TEXT,
      slackPosts         TEXT NOT NULL DEFAULT '[]',   -- JSON: [{channel, ts}] — all channels the incident was posted to
      payloadJson        TEXT NOT NULL DEFAULT '{}',   -- snapshot at open-time

      createdAt          TEXT NOT NULL,
      updatedAt          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_status     ON alert_incidents(status);
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_customerId ON alert_incidents(customerId);
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_envId      ON alert_incidents(envId);
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_openedAt   ON alert_incidents(openedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_severity   ON alert_incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_alert_incidents_assignee   ON alert_incidents(assigneeUserId);

    -- ── incident_events (audit trail for incident lifecycle) ─
    CREATE TABLE IF NOT EXISTS incident_events (
      id            TEXT PRIMARY KEY,
      incidentId    TEXT NOT NULL,
      type          TEXT NOT NULL,                -- 'opened' | 'acknowledged' | 'resolved' | 'reopened' | 'note' | 'assigned' | 'severity-changed' | 'recovery-detected' | 'sustained' | 'dedup-suppressed'
      actorUserId   TEXT,                          -- null = system
      actorName     TEXT,                          -- denormalized
      payloadJson   TEXT NOT NULL DEFAULT '{}',
      at            TEXT NOT NULL,
      FOREIGN KEY (incidentId) REFERENCES alert_incidents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_incident_events_incidentId ON incident_events(incidentId);
    CREATE INDEX IF NOT EXISTS idx_incident_events_at         ON incident_events(at DESC);

    -- ── zoho_accounts (customer entities from Zoho Desk) ───────
    CREATE TABLE IF NOT EXISTS zoho_accounts (
      id             TEXT PRIMARY KEY,         -- Zoho 19-digit account ID
      name           TEXT,                      -- e.g. "Comfort Keepers - 157", "Bayada Home Health Care"
      departmentId   TEXT,
      rawPayload     TEXT,                      -- full Zoho response JSON
      lastSyncedAt   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_zoho_accounts_dept ON zoho_accounts(departmentId);

    -- ── zoho_contacts (customer-side people) ───────────────────
    CREATE TABLE IF NOT EXISTS zoho_contacts (
      id             TEXT PRIMARY KEY,         -- Zoho 19-digit contact ID
      accountId      TEXT,
      email          TEXT,                      -- normalized lowercase
      name           TEXT,
      phone          TEXT,
      rawPayload     TEXT,
      lastSyncedAt   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_zoho_contacts_email   ON zoho_contacts(email);
    CREATE INDEX IF NOT EXISTS idx_zoho_contacts_account ON zoho_contacts(accountId);

    -- ── zoho_tickets (mirrored ticket rows) ────────────────────
    CREATE TABLE IF NOT EXISTS zoho_tickets (
      id                   TEXT PRIMARY KEY,    -- Zoho 19-digit ticket ID
      ticketNumber         TEXT NOT NULL,       -- e.g. "VHC-4165", "BYD-3123"
      deptPrefix           TEXT,                 -- "VHC" | "BYD" | "THC" | "VIV"
      departmentId         TEXT,
      accountId            TEXT,
      contactId            TEXT,
      assigneeEmail        TEXT,                 -- normalized lowercase, join to users.email
      assigneeZohoAgentId  TEXT,                 -- raw Zoho assignee id (for reverse-lookup)
      subject              TEXT,
      status               TEXT,                 -- e.g. "Investigating", "Waiting for Viv Response"
      statusType           TEXT,                 -- "Open" | "Closed" | "On Hold"
      priority             TEXT,                 -- "Urgent" | "High" | "Medium" | "Low" | NULL
      category             TEXT,
      subCategory          TEXT,
      channel              TEXT,
      sentiment            TEXT,
      commentCount         INTEGER NOT NULL DEFAULT 0,
      threadCount          INTEGER NOT NULL DEFAULT 0,
      createdAt            TEXT,                 -- Zoho createdTime
      modifiedAt           TEXT,                 -- Zoho modifiedTime (drives incremental cursor)
      closedAt             TEXT,
      onHoldAt             TEXT,
      customerResponseAt   TEXT,
      webUrl               TEXT,
      rawPayload           TEXT,                 -- full Zoho response JSON (forward-compat)
      lastSyncedAt         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_assignee  ON zoho_tickets(assigneeEmail, status);
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_account   ON zoho_tickets(accountId, status);
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_modified  ON zoho_tickets(modifiedAt);
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_status    ON zoho_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_statusType ON zoho_tickets(statusType);
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_number    ON zoho_tickets(ticketNumber);
    CREATE INDEX IF NOT EXISTS idx_zoho_tickets_dept      ON zoho_tickets(deptPrefix);

    -- ── zoho_ticket_history (status/assignee/priority transitions) ─
    -- Powers "Days on Dashboard" and the aging dashboard.
    CREATE TABLE IF NOT EXISTS zoho_ticket_history (
      id              TEXT PRIMARY KEY,          -- synthetic: ticketId + ':' + eventTime + ':' + fieldName
      ticketId        TEXT NOT NULL,
      changedAt       TEXT NOT NULL,
      changedByEmail  TEXT,
      fieldName       TEXT NOT NULL,              -- 'status' | 'assignee' | 'priority' | ...
      fromValue       TEXT,
      toValue         TEXT,
      rawPayload      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_zth_ticket         ON zoho_ticket_history(ticketId, changedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_zth_ticket_status  ON zoho_ticket_history(ticketId, fieldName, changedAt DESC);

    -- ── jira_zoho_links (junction: JIRA key ↔ Zoho ticket ID) ──
    -- Populated from customfield_11157 on the JIRA side (primary).
    -- Can also be populated from Zoho-side "Associated Jira Issues" field.
    CREATE TABLE IF NOT EXISTS jira_zoho_links (
      jiraKey         TEXT NOT NULL,
      zohoTicketId    TEXT NOT NULL,
      source          TEXT NOT NULL,              -- 'customfield_11157' | 'zoho_associated_jira' | 'derived'
      firstSeenAt     TEXT NOT NULL,
      lastSeenAt      TEXT NOT NULL,
      PRIMARY KEY (jiraKey, zohoTicketId)
    );
    CREATE INDEX IF NOT EXISTS idx_jzl_jira ON jira_zoho_links(jiraKey);
    CREATE INDEX IF NOT EXISTS idx_jzl_zoho ON jira_zoho_links(zohoTicketId);

    -- ── zoho_sync_meta (singleton — cursor + worker lock + backfill state) ─
    CREATE TABLE IF NOT EXISTS zoho_sync_meta (
      id                   INTEGER PRIMARY KEY CHECK (id = 1),
      lastModifiedCursor   TEXT,                  -- max(modifiedTime) seen by incremental sync
      lastRunAt            TEXT,
      lastBackfillAt       TEXT,
      backfillStatus       TEXT,                  -- 'pending' | 'in_progress' | 'done' | 'failed'
      backfillProgress     INTEGER NOT NULL DEFAULT 0,
      backfillTotal        INTEGER NOT NULL DEFAULT 0,
      workerLockUntil      TEXT,                  -- TTL for singleton worker
      lastSyncError        TEXT,
      lastSyncDurationMs   INTEGER,
      updatedAt            TEXT
    );

    -- ── mcp_oauth_clients (v17) ────────────────────────────────
    -- OAuth 2.1 client registrations for the Streamable HTTP MCP at
    -- /mcp-oauth. Created via Dynamic Client Registration (RFC 7591)
    -- when an MCP client (e.g. Claude Desktop) first connects. PKCE
    -- public clients leave clientSecretHash null.
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      clientId               TEXT PRIMARY KEY,
      clientSecretHash       TEXT,                 -- nullable for public/PKCE clients
      clientName             TEXT NOT NULL,
      redirectUris           TEXT NOT NULL,        -- JSON array
      tokenEndpointAuthMethod TEXT NOT NULL DEFAULT 'none',
      grantTypes             TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
      responseTypes          TEXT NOT NULL DEFAULT '["code"]',
      scope                  TEXT NOT NULL DEFAULT 'mcp',
      registeredByEmail      TEXT,                 -- null when registered via DCR (anonymous)
      createdAt              TEXT NOT NULL,
      lastUsedAt             TEXT
    );

    -- ── mcp_oauth_codes (v17) ──────────────────────────────────
    -- One-time-use authorization codes. 5-minute TTL. PKCE challenge
    -- captured at /authorize, verified at /token.
    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code                 TEXT PRIMARY KEY,
      clientId             TEXT NOT NULL,
      userEmail            TEXT NOT NULL,
      redirectUri          TEXT NOT NULL,
      codeChallenge        TEXT NOT NULL,
      codeChallengeMethod  TEXT NOT NULL DEFAULT 'S256',
      scope                TEXT,
      expiresAt            TEXT NOT NULL,
      usedAt               TEXT,                   -- nullable; set on first redemption
      createdAt            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires ON mcp_oauth_codes(expiresAt);

    -- ── mcp_oauth_tokens (v17) ─────────────────────────────────
    -- Access + refresh tokens. tokenHash is the SHA-256 of the opaque
    -- token string the client holds — we never store the token itself.
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      tokenHash       TEXT PRIMARY KEY,
      tokenType       TEXT NOT NULL,              -- 'access' | 'refresh'
      clientId        TEXT NOT NULL,
      userEmail       TEXT NOT NULL,
      scope           TEXT,
      expiresAt       TEXT NOT NULL,
      revokedAt       TEXT,                        -- nullable; user/admin can revoke
      parentTokenHash TEXT,                        -- access→refresh chain (for revoke cascade)
      createdAt       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user    ON mcp_oauth_tokens(userEmail);
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client  ON mcp_oauth_tokens(clientId);
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires ON mcp_oauth_tokens(expiresAt);

    -- ── issue_pr_notifications (Nectar Issues — PR-linked DM dedup) ──
    -- One row per (issueNumber, prNumber) we've already DM'd the reporter
    -- about. Prevents re-notifying when the PR body is edited or the
    -- server restarts mid-session.
    CREATE TABLE IF NOT EXISTS issue_pr_notifications (
      issueNumber  INTEGER NOT NULL,
      prNumber     INTEGER NOT NULL,
      notifiedAt   TEXT NOT NULL,
      PRIMARY KEY (issueNumber, prNumber)
    );
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
    // v8: Normalize prefixed version names in fixVersions/targetFixVersions.
    // JIRA stores "iOS 2026.4.0" but releases use "2026.4.0". normalizeIssue
    // now strips prefixes at write time; this cleans up existing data.
    (db) => {
      const prefixes = [
        { pattern: '"iOS ', prefix: 'iOS ' },
        { pattern: '"Android ', prefix: 'Android ' },
      ];
      let cleaned = 0;
      for (const { pattern, prefix } of prefixes) {
        const rows = db.prepare(`
          SELECT key, fixVersions, targetFixVersions FROM jira_tickets
          WHERE fixVersions LIKE ? OR targetFixVersions LIKE ?
        `).all(`%${pattern}%`, `%${pattern}%`);
        for (const row of rows) {
          let fix = JSON.parse(row.fixVersions || '[]');
          let target = JSON.parse(row.targetFixVersions || '[]');
          fix = fix.map(v => v.startsWith(prefix) ? v.substring(prefix.length).trim() : v);
          target = target.map(v => v.startsWith(prefix) ? v.substring(prefix.length).trim() : v);
          db.prepare('UPDATE jira_tickets SET fixVersions = ?, targetFixVersions = ? WHERE key = ?')
            .run(JSON.stringify(fix), JSON.stringify(target), row.key);
          cleaned++;
        }
      }
      if (cleaned > 0) log.info(`DB migration v8: normalized ${cleaned} tickets with prefixed version names`);
      // Force full re-sync so all tickets get re-normalized
      db.prepare("UPDATE jira_sync_meta SET lastTicketSyncTime = NULL WHERE id = 1").run();
    },
    // v9: Add reviewDecision column to github_prs for PR review state tracking.
    // Values: 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', or NULL.
    (db) => {
      const cols = db.prepare("PRAGMA table_info(github_prs)").all().map(c => c.name);
      if (!cols.includes('reviewDecision')) {
        db.prepare(`ALTER TABLE github_prs ADD COLUMN reviewDecision TEXT`).run();
      }
    },
    // v10: Add release train process columns to releases table.
    // releaseType, shipDate, milestones (JSON), templateVersion.
    // Also creates release_templates and release_scorecards tables (idempotent).
    (db) => {
      const cols = db.prepare("PRAGMA table_info(releases)").all().map(c => c.name);
      if (!cols.includes('releaseType')) {
        db.prepare(`ALTER TABLE releases ADD COLUMN releaseType TEXT`).run();
      }
      if (!cols.includes('shipDate')) {
        db.prepare(`ALTER TABLE releases ADD COLUMN shipDate TEXT`).run();
      }
      if (!cols.includes('milestones')) {
        db.prepare(`ALTER TABLE releases ADD COLUMN milestones TEXT NOT NULL DEFAULT '[]'`).run();
      }
      if (!cols.includes('templateVersion')) {
        db.prepare(`ALTER TABLE releases ADD COLUMN templateVersion INTEGER`).run();
      }
      // Ensure release_templates + release_scorecards tables exist (may already from schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS release_templates (
          key             TEXT PRIMARY KEY,
          label           TEXT NOT NULL,
          shipDay         TEXT,
          bufferDay       TEXT,
          skipWeekends    INTEGER NOT NULL DEFAULT 1,
          milestones      TEXT NOT NULL DEFAULT '[]',
          version         INTEGER NOT NULL DEFAULT 1,
          updatedAt       TEXT NOT NULL,
          updatedBy       TEXT
        );
        CREATE TABLE IF NOT EXISTS release_scorecards (
          releaseKey        TEXT PRIMARY KEY,
          gateHitRate       REAL,
          onTimeShip        INTEGER,
          scopeChanges      INTEGER,
          postFreezeChanges INTEGER,
          qaBugsFound       INTEGER,
          qaSlaViolations   INTEGER,
          migrationCount    INTEGER,
          rcaFiledAt        TEXT,
          cycleTimeDays     INTEGER,
          detail            TEXT NOT NULL DEFAULT '{}',
          computedAt        TEXT NOT NULL
        );
      `);
    },
    // v11: Add shippedAt to releases — immutable timestamp set when release
    // transitions to 'done'. Avoids deriving on-time ship from mutable updatedAt.
    (db) => {
      const cols = db.prepare("PRAGMA table_info(releases)").all().map(c => c.name);
      if (!cols.includes('shippedAt')) {
        db.prepare(`ALTER TABLE releases ADD COLUMN shippedAt TEXT`).run();
      }
      // Backfill existing 'done' releases — best-effort, uses updatedAt as approximation.
      // Only backfills where shippedAt is NULL so future transitions set the real value.
      db.prepare(`UPDATE releases SET shippedAt = updatedAt WHERE state = 'done' AND shippedAt IS NULL`).run();
    },
    // v12: Add platforms JSON column to jira_tickets. Disambiguates shared version
    // numbers across iOS/Android/web. Backfill uses the labels array as a proxy;
    // next full ticket sync rewrites from JIRA truth.
    (db) => {
      const cols = db.prepare("PRAGMA table_info(jira_tickets)").all().map(c => c.name);
      if (!cols.includes('platforms')) {
        db.prepare(`ALTER TABLE jira_tickets ADD COLUMN platforms TEXT NOT NULL DEFAULT '[]'`).run();
      }
      db.prepare(`
        UPDATE jira_tickets
        SET platforms = CASE
          WHEN labels LIKE '%"iOS"%'     AND labels LIKE '%"Android"%' THEN '["ios","android"]'
          WHEN labels LIKE '%"iOS"%'                                   THEN '["ios"]'
          WHEN labels LIKE '%"Android"%'                               THEN '["android"]'
          ELSE                                                              '["web"]'
        END
        WHERE platforms = '[]'
      `).run();
      // Force a full ticket re-sync on next worker pass — platform array will
      // be authoritative, computed from raw JIRA fixVersion names.
      db.prepare(`UPDATE jira_sync_meta SET lastTicketSyncTime = NULL WHERE id = 1`).run();
    },
    // v13: Add alerting system tables — alert_rules, alert_state,
    // alert_incidents, incident_events. Fresh installs already have these
    // via CREATE TABLE IF NOT EXISTS in applySchema; this migration is a
    // no-op on fresh DBs but creates them for existing installs.
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS alert_rules (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          triggerType  TEXT NOT NULL,
          filter       TEXT NOT NULL DEFAULT '{}',
          channels     TEXT NOT NULL DEFAULT '[]',
          mention      TEXT,
          severity     TEXT NOT NULL DEFAULT 'critical',
          enabled      INTEGER NOT NULL DEFAULT 1,
          lastFiredAt  TEXT,
          createdAt    TEXT NOT NULL,
          updatedAt    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alert_rules_trigger ON alert_rules(triggerType);
        CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);

        CREATE TABLE IF NOT EXISTS alert_state (
          key                TEXT PRIMARY KEY,
          status             TEXT,
          failingComponents  TEXT NOT NULL DEFAULT '[]',
          firstFailedAt      TEXT,
          lastAlertedAt      TEXT,
          consecutiveCount   INTEGER NOT NULL DEFAULT 0,
          incidentId         TEXT,
          escalated          INTEGER NOT NULL DEFAULT 0,
          updatedAt          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alert_incidents (
          id                 TEXT PRIMARY KEY,
          ruleId             TEXT,
          triggerType        TEXT NOT NULL,
          source             TEXT NOT NULL DEFAULT 'auto',
          subjectKey         TEXT,
          customerId         TEXT,
          envId              TEXT,

          summary            TEXT NOT NULL,
          description        TEXT,
          severity           TEXT NOT NULL DEFAULT 'critical',

          status             TEXT NOT NULL DEFAULT 'open',
          assigneeUserId     TEXT,
          assigneeSlackId    TEXT,

          openedAt           TEXT NOT NULL,
          acknowledgedAt     TEXT,
          acknowledgedBy     TEXT,
          resolvedAt         TEXT,
          resolvedBy         TEXT,
          resolution         TEXT,

          slackChannel       TEXT,
          slackTs            TEXT,
          slackPosts         TEXT NOT NULL DEFAULT '[]',
          payloadJson        TEXT NOT NULL DEFAULT '{}',

          createdAt          TEXT NOT NULL,
          updatedAt          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alert_incidents_status     ON alert_incidents(status);
        CREATE INDEX IF NOT EXISTS idx_alert_incidents_customerId ON alert_incidents(customerId);
        CREATE INDEX IF NOT EXISTS idx_alert_incidents_envId      ON alert_incidents(envId);
        CREATE INDEX IF NOT EXISTS idx_alert_incidents_openedAt   ON alert_incidents(openedAt DESC);
        CREATE INDEX IF NOT EXISTS idx_alert_incidents_severity   ON alert_incidents(severity);
        CREATE INDEX IF NOT EXISTS idx_alert_incidents_assignee   ON alert_incidents(assigneeUserId);

        CREATE TABLE IF NOT EXISTS incident_events (
          id            TEXT PRIMARY KEY,
          incidentId    TEXT NOT NULL,
          type          TEXT NOT NULL,
          actorUserId   TEXT,
          actorName     TEXT,
          payloadJson   TEXT NOT NULL DEFAULT '{}',
          at            TEXT NOT NULL,
          FOREIGN KEY (incidentId) REFERENCES alert_incidents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_incident_events_incidentId ON incident_events(incidentId);
        CREATE INDEX IF NOT EXISTS idx_incident_events_at         ON incident_events(at DESC);
      `);
    },
    // v14: Access control engine — roles, user_roles, API key roles, audit extension
    (db) => {
      const now = new Date().toISOString();

      // 1. Ensure roles and user_roles tables exist (fresh installs get them from schema)
      db.prepare(`CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]', system INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )`).run();
      db.prepare(`CREATE TABLE IF NOT EXISTS user_roles (
        email TEXT NOT NULL, roleId TEXT NOT NULL, grantedBy TEXT, grantedAt TEXT NOT NULL,
        PRIMARY KEY (email, roleId)
      )`).run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_ur_email ON user_roles(email)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_ur_role ON user_roles(roleId)').run();

      // 2. Add roleId column to api_keys if it doesn't exist
      const apiKeyCols = db.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
      if (!apiKeyCols.includes('roleId')) {
        db.prepare('ALTER TABLE api_keys ADD COLUMN roleId TEXT').run();
      }

      // 3. Seed the two system roles
      const allCaps = JSON.stringify([
        'config.write', 'release.write', 'environment.write',
        'sync.trigger', 'task.write', 'notify.send', 'user.admin', 'system.admin',
      ]);
      db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
        VALUES ('admin', 'Admin', 'Full system access', ?, 1, ?, ?)`).run(allCaps, now, now);
      db.prepare(`INSERT OR IGNORE INTO roles (id, name, description, capabilities, system, createdAt, updatedAt)
        VALUES ('viewer', 'Viewer', 'Read-only access', '[]', 1, ?, ?)`).run(now, now);

      // 4. Assign ALL existing users the admin role so day-one behavior is
      // identical to pre-migration (all write endpoints were open or
      // admin-only, and most users could hit them). Admins can then
      // restrict access by assigning viewer/custom roles post-migration.
      const users = db.prepare('SELECT email FROM users').all();
      const assignStmt = db.prepare(`INSERT OR IGNORE INTO user_roles (email, roleId, grantedBy, grantedAt)
        VALUES (?, 'admin', 'migration', ?)`);
      for (const user of users) {
        assignStmt.run(user.email, now);
      }

      // 5. Assign all existing API keys the admin role
      db.prepare("UPDATE api_keys SET roleId = 'admin' WHERE roleId IS NULL").run();

      // 6. Drop the permissions column from users (SQLite 3.35+ native support)
      const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      if (userCols.includes('permissions')) {
        db.prepare('ALTER TABLE users DROP COLUMN permissions').run();
      }

      // 7. Extend the audit table with resource and capability columns
      const auditCols = db.prepare("PRAGMA table_info(audit)").all().map(c => c.name);
      if (!auditCols.includes('resource')) {
        db.prepare('ALTER TABLE audit ADD COLUMN resource TEXT').run();
      }
      if (!auditCols.includes('capability')) {
        db.prepare('ALTER TABLE audit ADD COLUMN capability TEXT').run();
      }
      db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit(resource)').run();
    },
    // v15: Teams — new teams table + teamId/jiraName columns on users
    (db) => {
      db.prepare(`CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        color TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )`).run();

      const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
      if (!userCols.includes('teamId'))   db.prepare('ALTER TABLE users ADD COLUMN teamId TEXT').run();
      if (!userCols.includes('jiraName')) db.prepare('ALTER TABLE users ADD COLUMN jiraName TEXT').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_users_teamId ON users(teamId)').run();

      // Populate jiraName for existing users by fuzzy-matching their SSO name
      // against distinct JIRA assignees. Fresh installs with no jira_tickets
      // rows are a no-op.
      const backfillJiraNames = require('./backfill-jira-names');
      backfillJiraNames(db);
    },
    // v16: Zoho mirror tables + identity reconciliation columns on users.
    // Fresh installs get everything via applySchema; this handles existing DBs.
    (db) => {
      // Add identity columns to users
      const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      if (!userCols.includes('zohoAgentId')) {
        db.prepare('ALTER TABLE users ADD COLUMN zohoAgentId TEXT').run();
      }
      if (!userCols.includes('jiraAccountId')) {
        db.prepare('ALTER TABLE users ADD COLUMN jiraAccountId TEXT').run();
      }
      if (!userCols.includes('displayNameZoho')) {
        db.prepare('ALTER TABLE users ADD COLUMN displayNameZoho TEXT').run();
      }
      if (!userCols.includes('isBot')) {
        db.prepare('ALTER TABLE users ADD COLUMN isBot INTEGER NOT NULL DEFAULT 0').run();
      }
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_zohoAgent ON users(zohoAgentId) WHERE zohoAgentId IS NOT NULL').run();
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_jiraAccount ON users(jiraAccountId) WHERE jiraAccountId IS NOT NULL').run();

      // New Zoho mirror tables (idempotent — fresh installs already have them)
      db.exec(`
        CREATE TABLE IF NOT EXISTS zoho_accounts (
          id             TEXT PRIMARY KEY,
          name           TEXT,
          departmentId   TEXT,
          rawPayload     TEXT,
          lastSyncedAt   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_zoho_accounts_dept ON zoho_accounts(departmentId);

        CREATE TABLE IF NOT EXISTS zoho_contacts (
          id             TEXT PRIMARY KEY,
          accountId      TEXT,
          email          TEXT,
          name           TEXT,
          phone          TEXT,
          rawPayload     TEXT,
          lastSyncedAt   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_zoho_contacts_email   ON zoho_contacts(email);
        CREATE INDEX IF NOT EXISTS idx_zoho_contacts_account ON zoho_contacts(accountId);

        CREATE TABLE IF NOT EXISTS zoho_tickets (
          id                   TEXT PRIMARY KEY,
          ticketNumber         TEXT NOT NULL,
          deptPrefix           TEXT,
          departmentId         TEXT,
          accountId            TEXT,
          contactId            TEXT,
          assigneeEmail        TEXT,
          assigneeZohoAgentId  TEXT,
          subject              TEXT,
          status               TEXT,
          statusType           TEXT,
          priority             TEXT,
          category             TEXT,
          subCategory          TEXT,
          channel              TEXT,
          sentiment            TEXT,
          commentCount         INTEGER NOT NULL DEFAULT 0,
          threadCount          INTEGER NOT NULL DEFAULT 0,
          createdAt            TEXT,
          modifiedAt           TEXT,
          closedAt             TEXT,
          onHoldAt             TEXT,
          customerResponseAt   TEXT,
          webUrl               TEXT,
          rawPayload           TEXT,
          lastSyncedAt         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_assignee   ON zoho_tickets(assigneeEmail, status);
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_account    ON zoho_tickets(accountId, status);
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_modified   ON zoho_tickets(modifiedAt);
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_status     ON zoho_tickets(status);
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_statusType ON zoho_tickets(statusType);
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_number     ON zoho_tickets(ticketNumber);
        CREATE INDEX IF NOT EXISTS idx_zoho_tickets_dept       ON zoho_tickets(deptPrefix);

        CREATE TABLE IF NOT EXISTS zoho_ticket_history (
          id              TEXT PRIMARY KEY,
          ticketId        TEXT NOT NULL,
          changedAt       TEXT NOT NULL,
          changedByEmail  TEXT,
          fieldName       TEXT NOT NULL,
          fromValue       TEXT,
          toValue         TEXT,
          rawPayload      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_zth_ticket        ON zoho_ticket_history(ticketId, changedAt DESC);
        CREATE INDEX IF NOT EXISTS idx_zth_ticket_status ON zoho_ticket_history(ticketId, fieldName, changedAt DESC);

        CREATE TABLE IF NOT EXISTS jira_zoho_links (
          jiraKey         TEXT NOT NULL,
          zohoTicketId    TEXT NOT NULL,
          source          TEXT NOT NULL,
          firstSeenAt     TEXT NOT NULL,
          lastSeenAt      TEXT NOT NULL,
          PRIMARY KEY (jiraKey, zohoTicketId)
        );
        CREATE INDEX IF NOT EXISTS idx_jzl_jira ON jira_zoho_links(jiraKey);
        CREATE INDEX IF NOT EXISTS idx_jzl_zoho ON jira_zoho_links(zohoTicketId);

        CREATE TABLE IF NOT EXISTS zoho_sync_meta (
          id                   INTEGER PRIMARY KEY CHECK (id = 1),
          lastModifiedCursor   TEXT,
          lastRunAt            TEXT,
          lastBackfillAt       TEXT,
          backfillStatus       TEXT,
          backfillProgress     INTEGER NOT NULL DEFAULT 0,
          backfillTotal        INTEGER NOT NULL DEFAULT 0,
          workerLockUntil      TEXT,
          lastSyncError        TEXT,
          lastSyncDurationMs   INTEGER,
          updatedAt            TEXT
        );
      `);
      db.prepare('INSERT OR IGNORE INTO zoho_sync_meta (id, backfillStatus, backfillProgress, backfillTotal) VALUES (1, \'pending\', 0, 0)').run();
    },
    // v17: MCP OAuth tables — clients, codes, tokens. Powers the new
    // /mcp-oauth Streamable HTTP MCP for Claude Desktop's custom
    // connector. Fresh installs already have these via applySchema.
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
          clientId               TEXT PRIMARY KEY,
          clientSecretHash       TEXT,
          clientName             TEXT NOT NULL,
          redirectUris           TEXT NOT NULL,
          tokenEndpointAuthMethod TEXT NOT NULL DEFAULT 'none',
          grantTypes             TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
          responseTypes          TEXT NOT NULL DEFAULT '["code"]',
          scope                  TEXT NOT NULL DEFAULT 'mcp',
          registeredByEmail      TEXT,
          createdAt              TEXT NOT NULL,
          lastUsedAt             TEXT
        );
        CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
          code                 TEXT PRIMARY KEY,
          clientId             TEXT NOT NULL,
          userEmail            TEXT NOT NULL,
          redirectUri          TEXT NOT NULL,
          codeChallenge        TEXT NOT NULL,
          codeChallengeMethod  TEXT NOT NULL DEFAULT 'S256',
          scope                TEXT,
          expiresAt            TEXT NOT NULL,
          usedAt               TEXT,
          createdAt            TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires ON mcp_oauth_codes(expiresAt);
        CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
          tokenHash       TEXT PRIMARY KEY,
          tokenType       TEXT NOT NULL,
          clientId        TEXT NOT NULL,
          userEmail       TEXT NOT NULL,
          scope           TEXT,
          expiresAt       TEXT NOT NULL,
          revokedAt       TEXT,
          parentTokenHash TEXT,
          createdAt       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user    ON mcp_oauth_tokens(userEmail);
        CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client  ON mcp_oauth_tokens(clientId);
        CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires ON mcp_oauth_tokens(expiresAt);
      `);
    },
    // v18: issue_pr_notifications — dedup PR-linked DMs sent to issue reporters
    // when a PR references their issue (Closes #N). Composite PK prevents
    // re-notifying on PR body edits or server restarts. Fresh installs already
    // have it via applySchema.
    (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS issue_pr_notifications (
          issueNumber  INTEGER NOT NULL,
          prNumber     INTEGER NOT NULL,
          notifiedAt   TEXT NOT NULL,
          PRIMARY KEY (issueNumber, prNumber)
        )
      `).run();
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
