const fs = require('fs');
const path = require('path');
const log = require('./log');
const { rowCount } = require('./db');

/**
 * One-shot migration: copy data from the legacy .nectar-*.json files
 * into the SQLite database. Idempotent — skips tables that already
 * contain rows, so restarting the server after migration is a no-op.
 *
 * Does NOT delete the JSON files. Leaves them in place for rollback.
 *
 * @param {Database} db                    — better-sqlite3 handle
 * @param {string}   [baseDir=process.cwd()] — directory where .nectar-*.json live
 * @returns {object} summary { users, apiKeys, themes, tasks, customers, environments, deployments, mobile, releases, audit }
 */
function migrateFromJson(db, baseDir = process.cwd()) {
  const summary = {
    users: 0, apiKeys: 0, themes: 0, tasks: 0,
    customers: 0, environments: 0, deployments: 0, mobile: 0,
    releases: 0, audit: 0,
  };

  db.transaction(() => {
    summary.users        = migrateUsers(db, baseDir);
    summary.apiKeys      = migrateApiKeys(db, baseDir);
    summary.themes       = migrateThemes(db, baseDir);
    summary.tasks        = migrateTasks(db, baseDir);
    const cust = migrateCustomers(db, baseDir);
    summary.customers    = cust.customers;
    summary.environments = cust.environments;
    summary.deployments  = cust.deployments;
    summary.mobile       = cust.mobile;
    const rel = migrateReleases(db, baseDir);
    summary.releases     = rel.releases;
    summary.audit        = rel.audit;
  })();

  const totalMoved = Object.values(summary).reduce((a, b) => a + b, 0);
  if (totalMoved > 0) {
    log.info(`JSON → SQLite migration complete: ${JSON.stringify(summary)}`);
  }
  return summary;
}

// ── Individual migrators ──────────────────────────────────────────────────

function readJsonMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.warn(`Migration: failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

function migrateUsers(db, baseDir) {
  if (rowCount(db, 'users') > 0) return 0;
  const data = readJsonMaybe(path.join(baseDir, '.nectar-users.json'));
  if (!data || !Array.isArray(data.users)) return 0;

  const stmt = db.prepare(`
    INSERT INTO users (email, name, picture, role, permissions, notificationPrefs, lastLoginAt, createdAt)
    VALUES (@email, @name, @picture, @role, @permissions, @notificationPrefs, @lastLoginAt, @createdAt)
  `);

  let n = 0;
  for (const u of data.users) {
    if (!u || !u.email) continue;
    stmt.run({
      email: u.email.toLowerCase(),
      name: u.name ?? null,
      picture: u.picture ?? null,
      role: u.role || 'user',
      permissions: JSON.stringify(u.permissions || {}),
      notificationPrefs: JSON.stringify(u.notificationPrefs || {}),
      lastLoginAt: u.lastLoginAt ?? null,
      createdAt: u.createdAt || new Date().toISOString(),
    });
    n++;
  }
  return n;
}

function migrateApiKeys(db, baseDir) {
  if (rowCount(db, 'api_keys') > 0) return 0;
  const data = readJsonMaybe(path.join(baseDir, '.nectar-api-keys.json'));
  if (!data || !Array.isArray(data.keys)) return 0;

  const stmt = db.prepare(`
    INSERT INTO api_keys (id, label, hash, createdAt, createdBy, lastUsedAt)
    VALUES (@id, @label, @hash, @createdAt, @createdBy, @lastUsedAt)
  `);

  let n = 0;
  for (const k of data.keys) {
    if (!k || !k.id || !k.hash) continue;
    stmt.run({
      id: k.id,
      label: k.label || '',
      hash: k.hash,
      createdAt: k.createdAt || new Date().toISOString(),
      createdBy: k.createdBy ?? null,
      lastUsedAt: k.lastUsedAt ?? null,
    });
    n++;
  }
  return n;
}

function migrateThemes(db, baseDir) {
  if (rowCount(db, 'theme_config') > 0) return 0;
  const data = readJsonMaybe(path.join(baseDir, '.nectar-themes.json'));
  if (!data) return 0;

  db.prepare(`
    INSERT INTO theme_config (id, themes, unmappedLabel, updatedAt)
    VALUES (1, @themes, @unmappedLabel, @updatedAt)
  `).run({
    themes: JSON.stringify(data.themes || []),
    unmappedLabel: data.unmappedLabel || 'Other',
    updatedAt: data.updatedAt || null,
  });
  return 1;
}

function migrateTasks(db, baseDir) {
  if (rowCount(db, 'tasks') > 0) return 0;
  const data = readJsonMaybe(path.join(baseDir, '.nectar-tasks.json'));
  if (!data || !Array.isArray(data.tasks)) return 0;

  const stmt = db.prepare(`
    INSERT INTO tasks (id, type, status, input, output, requestedBy, slackUserId, createdAt, startedAt, completedAt, error)
    VALUES (@id, @type, @status, @input, @output, @requestedBy, @slackUserId, @createdAt, @startedAt, @completedAt, @error)
  `);

  let n = 0;
  for (const t of data.tasks) {
    if (!t || !t.id) continue;
    stmt.run({
      id: t.id,
      type: t.type,
      status: t.status,
      input: JSON.stringify(t.input || {}),
      output: t.output == null ? null : JSON.stringify(t.output),
      requestedBy: t.requestedBy ?? null,
      slackUserId: t.slackUserId ?? null,
      createdAt: t.createdAt,
      startedAt: t.startedAt ?? null,
      completedAt: t.completedAt ?? null,
      error: t.error ?? null,
    });
    n++;
  }
  return n;
}

function migrateCustomers(db, baseDir) {
  const counts = { customers: 0, environments: 0, deployments: 0, mobile: 0 };
  const data = readJsonMaybe(path.join(baseDir, '.nectar-customers.json'));
  if (!data) return counts;

  // Customers
  if (rowCount(db, 'customers') === 0 && Array.isArray(data.customers)) {
    const stmt = db.prepare(`
      INSERT INTO customers (id, name, domain, domainPrefix, integrations, hasFranchises, active,
                             syncedFrom, lastSyncedAt, notes, extra, createdAt, updatedAt)
      VALUES (@id, @name, @domain, @domainPrefix, @integrations, @hasFranchises, @active,
              @syncedFrom, @lastSyncedAt, @notes, @extra, @createdAt, @updatedAt)
    `);
    for (const c of data.customers) {
      if (!c || !c.id) continue;
      // Whitelist known columns; stash everything else in `extra`
      const known = new Set(['id','name','domain','domainPrefix','integrations','hasFranchises','active',
                             'syncedFrom','lastSyncedAt','notes','createdAt','updatedAt']);
      const extra = {};
      for (const k of Object.keys(c)) if (!known.has(k)) extra[k] = c[k];
      stmt.run({
        id: c.id,
        name: c.name ?? null,
        domain: c.domain ?? null,
        domainPrefix: c.domainPrefix ?? null,
        integrations: c.integrations == null ? null : JSON.stringify(c.integrations),
        hasFranchises: c.hasFranchises == null ? null : (c.hasFranchises ? 1 : 0),
        active: c.active == null ? null : (c.active ? 1 : 0),
        syncedFrom: c.syncedFrom ?? null,
        lastSyncedAt: c.lastSyncedAt ?? null,
        notes: c.notes ?? null,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        createdAt: c.createdAt || new Date().toISOString(),
        updatedAt: c.updatedAt || c.createdAt || new Date().toISOString(),
      });
      counts.customers++;
    }
  }

  // Environments
  if (rowCount(db, 'environments') === 0 && Array.isArray(data.environments)) {
    const stmt = db.prepare(`
      INSERT INTO environments (
        id, customerId, name, tier, franchise, currentVersion, currentBranch, reachable,
        lastChecked, lastError, health, features, integrations, upgrades,
        lastHealthCheckedAt, lastFeaturesCheckedAt, lastIntegrationsCheckedAt, lastUpgradesCheckedAt,
        disabled, notes, versionSetManually, versionSetBy, versionSetAt,
        extra, createdAt, updatedAt
      ) VALUES (
        @id, @customerId, @name, @tier, @franchise, @currentVersion, @currentBranch, @reachable,
        @lastChecked, @lastError, @health, @features, @integrations, @upgrades,
        @lastHealthCheckedAt, @lastFeaturesCheckedAt, @lastIntegrationsCheckedAt, @lastUpgradesCheckedAt,
        @disabled, @notes, @versionSetManually, @versionSetBy, @versionSetAt,
        @extra, @createdAt, @updatedAt
      )
    `);
    const known = new Set([
      'id','customerId','name','tier','franchise','currentVersion','currentBranch','reachable',
      'lastChecked','lastError','health','features','integrations','upgrades',
      'lastHealthCheckedAt','lastFeaturesCheckedAt','lastIntegrationsCheckedAt','lastUpgradesCheckedAt',
      'disabled','notes','versionSetManually','versionSetBy','versionSetAt','createdAt','updatedAt',
    ]);
    for (const e of data.environments) {
      if (!e || !e.id) continue;
      const extra = {};
      for (const k of Object.keys(e)) if (!known.has(k)) extra[k] = e[k];
      stmt.run({
        id: e.id,
        customerId: e.customerId ?? null,
        name: e.name ?? null,
        tier: e.tier ?? null,
        franchise: e.franchise == null ? null : (e.franchise ? 1 : 0),
        currentVersion: e.currentVersion ?? null,
        currentBranch: e.currentBranch ?? null,
        reachable: e.reachable == null ? null : (e.reachable ? 1 : 0),
        lastChecked: e.lastChecked ?? null,
        lastError: e.lastError ?? null,
        health: e.health == null ? null : JSON.stringify(e.health),
        features: e.features == null ? null : JSON.stringify(e.features),
        integrations: e.integrations == null ? null : JSON.stringify(e.integrations),
        upgrades: e.upgrades == null ? null : JSON.stringify(e.upgrades),
        lastHealthCheckedAt: e.lastHealthCheckedAt ?? null,
        lastFeaturesCheckedAt: e.lastFeaturesCheckedAt ?? null,
        lastIntegrationsCheckedAt: e.lastIntegrationsCheckedAt ?? null,
        lastUpgradesCheckedAt: e.lastUpgradesCheckedAt ?? null,
        disabled: e.disabled == null ? null : (e.disabled ? 1 : 0),
        notes: e.notes ?? null,
        versionSetManually: e.versionSetManually == null ? null : (e.versionSetManually ? 1 : 0),
        versionSetBy: e.versionSetBy ?? null,
        versionSetAt: e.versionSetAt ?? null,
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        createdAt: e.createdAt || new Date().toISOString(),
        updatedAt: e.updatedAt || e.createdAt || new Date().toISOString(),
      });
      counts.environments++;
    }
  }

  // Deployments
  if (rowCount(db, 'deployments') === 0 && Array.isArray(data.deployments)) {
    const stmt = db.prepare(`
      INSERT INTO deployments (id, environmentId, customerId, version, branch, previousVersion,
                               detectedAt, endedAt, source, datadogImpact)
      VALUES (@id, @environmentId, @customerId, @version, @branch, @previousVersion,
              @detectedAt, @endedAt, @source, @datadogImpact)
    `);
    for (const d of data.deployments) {
      if (!d || !d.id) continue;
      stmt.run({
        id: d.id,
        environmentId: d.environmentId,
        customerId: d.customerId ?? null,
        version: d.version ?? null,
        branch: d.branch ?? null,
        previousVersion: d.previousVersion ?? null,
        detectedAt: d.detectedAt,
        endedAt: d.endedAt ?? null,
        source: d.source ?? null,
        datadogImpact: d.datadogImpact == null ? null : JSON.stringify(d.datadogImpact),
      });
      counts.deployments++;
    }
  }

  // Mobile
  if (rowCount(db, 'mobile') === 0 && Array.isArray(data.mobile)) {
    const stmt = db.prepare(`INSERT INTO mobile (id, data, updatedAt) VALUES (@id, @data, @updatedAt)`);
    for (const m of data.mobile) {
      if (!m || !m.id) continue;
      stmt.run({
        id: m.id,
        data: JSON.stringify(m),
        updatedAt: m.updatedAt ?? null,
      });
      counts.mobile++;
    }
  }

  return counts;
}

function migrateReleases(db, baseDir) {
  const counts = { releases: 0, audit: 0 };
  const data = readJsonMaybe(path.join(baseDir, '.nectar-state.json'));
  if (!data) return counts;

  // Releases
  if (rowCount(db, 'releases') === 0 && Array.isArray(data.releases)) {
    const stmt = db.prepare(`
      INSERT INTO releases (key, id, repo, version, state, branch, cutFrom, cutAt, cutBy,
                            tickets, cherryPicks, ci, risk, comments, deployments, approvals,
                            notes, presentationUrl,
                            jiraVersionId, jiraVersionName, jiraReleased, jiraReleaseDate, jiraArchived,
                            extra, createdAt, updatedAt)
      VALUES (@key, @id, @repo, @version, @state, @branch, @cutFrom, @cutAt, @cutBy,
              @tickets, @cherryPicks, @ci, @risk, @comments, @deployments, @approvals,
              @notes, @presentationUrl,
              @jiraVersionId, @jiraVersionName, @jiraReleased, @jiraReleaseDate, @jiraArchived,
              @extra, @createdAt, @updatedAt)
    `);
    const known = new Set([
      'id','repo','version','state','branch','cutFrom','cutAt','cutBy',
      'tickets','cherryPicks','ci','risk','comments','deployments','approvals',
      'notes','presentationUrl',
      'jiraVersionId','jiraVersionName','jiraReleased','jiraReleaseDate','jiraArchived',
      'createdAt','updatedAt',
    ]);
    for (const r of data.releases) {
      if (!r || !r.version) continue;
      const key = r.repo ? `${r.repo}:${r.version}` : r.version;
      const extra = {};
      for (const k of Object.keys(r)) if (!known.has(k)) extra[k] = r[k];
      stmt.run({
        key,
        id: r.id || `rel-${r.repo ? r.repo + '-' : ''}${r.version}`,
        repo: r.repo ?? null,
        version: r.version,
        state: r.state || 'planning',
        branch: r.branch ?? null,
        cutFrom: r.cutFrom ?? null,
        cutAt: r.cutAt ?? null,
        cutBy: r.cutBy ?? null,
        tickets: JSON.stringify(r.tickets || []),
        cherryPicks: JSON.stringify(r.cherryPicks || []),
        ci: JSON.stringify(r.ci || {}),
        risk: JSON.stringify(r.risk || {}),
        comments: JSON.stringify(r.comments || []),
        deployments: JSON.stringify(r.deployments || []),
        approvals: JSON.stringify(r.approvals || []),
        notes: r.notes ?? null,
        presentationUrl: r.presentationUrl ?? null,
        jiraVersionId: r.jiraVersionId ?? null,
        jiraVersionName: r.jiraVersionName ?? null,
        jiraReleased: r.jiraReleased == null ? null : (r.jiraReleased ? 1 : 0),
        jiraReleaseDate: r.jiraReleaseDate ?? null,
        jiraArchived: r.jiraArchived == null ? null : (r.jiraArchived ? 1 : 0),
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        createdAt: r.createdAt || new Date().toISOString(),
        updatedAt: r.updatedAt || r.createdAt || new Date().toISOString(),
      });
      counts.releases++;
    }
  }

  // Audit
  if (rowCount(db, 'audit') === 0 && Array.isArray(data.audit)) {
    const stmt = db.prepare(`
      INSERT INTO audit (id, version, action, detail, user, at)
      VALUES (@id, @version, @action, @detail, @user, @at)
    `);
    for (const a of data.audit) {
      if (!a || !a.id) continue;
      stmt.run({
        id: a.id,
        version: a.version ?? null,
        action: a.action,
        detail: JSON.stringify(a.detail || {}),
        user: a.user ?? null,
        at: a.at || new Date().toISOString(),
      });
      counts.audit++;
    }
  }

  return counts;
}

module.exports = { migrateFromJson };
