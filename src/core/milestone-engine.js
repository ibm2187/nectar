/**
 * Milestone Engine — computes T-minus dates from a ship date and template.
 *
 * Given a ship date (always a specific day) and a template defining milestones
 * with T-minus offsets in business days, this engine computes the concrete
 * calendar date for each milestone.
 *
 * Business days = Monday–Friday. Weekends are skipped when skipWeekends is true.
 */

const { getDb } = require('./db');
const log = require('./log');

// ── Default templates ────────────────────────────────────────────────────────

const DEFAULT_TEMPLATES = {
  monthly: {
    key: 'monthly',
    label: 'Monthly Release',
    shipDay: 'wednesday',
    bufferDay: 'thursday',
    skipWeekends: true,
    milestones: [
      { key: 'scope-lock',        label: 'Scope Lock',                   tMinus: 25, owner: 'PM',          gate: true,  autoCheck: null,                          description: 'Customer Lead, PM, and Project Manager define scope. Must Haves only.', missAction: 'Un-scoped ticket cannot enter this release.' },
      { key: 'release-notes',     label: 'Release Notes to Customers',   tMinus: 14, owner: 'PM',          gate: false, autoCheck: null,                          description: 'Draft release notes shared with customers / customer success team.', missAction: null },
      { key: 'dev-complete',      label: 'Dev Complete',                  tMinus: 13, owner: 'Dev Lead',    gate: true,  autoCheck: 'all-prs-merged',              description: 'All PRs merged to master. Any ticket not merged is auto-deferred.', missAction: 'Un-merged work is out. Deferred to next version.' },
      { key: 'qa-scope-review',   label: 'QA Scope Review',              tMinus: 13, owner: 'QA Lead',     gate: true,  autoCheck: null,                          description: 'QA reviews every ticket. Confirms acceptance criteria are testable. Estimates effort.', missAction: 'QA cycle cannot begin. Untestable tickets deferred.' },
      { key: 'branch-cut',        label: 'Branch Cut / Code Freeze',     tMinus: 12, owner: 'PM',          gate: true,  autoCheck: 'branch-exists',               description: 'Release branch created. Master reopens for next version. Only cherry-picks land on release branch.', missAction: null },
      { key: 'cp-freeze',         label: 'Cherry-Pick Freeze',           tMinus: 6,  owner: 'PM',          gate: true,  autoCheck: 'time-based',                  description: 'No more cherry-picks without PM + CTO approval. Only P0/S1 fixes bypass.', missAction: 'Unapproved cherry-pick after freeze = revert + RCA.' },
      { key: 'mobile-submission', label: 'Mobile App Submission',        tMinus: 6,  owner: 'Mobile Lead', gate: true,  autoCheck: null,                          description: 'iOS App Store + Android Play Store submissions.', missAction: 'Mobile release delayed independently.' },
      { key: 'data-migration',    label: 'Data Migration Checkpoint',    tMinus: 2,  owner: 'DBA',         gate: true,  autoCheck: 'migrations-approved',         description: 'All migrations documented, staging-tested, rollback-planned, DBA-approved.', missAction: 'Unapproved migration blocks certification.' },
      { key: 'certification',     label: 'Certification',                tMinus: 2,  owner: 'QA Lead',     gate: true,  autoCheck: 'truth-all-certified',         description: 'QA signed off + Nectar green + migrations approved + release notes final.', missAction: 'Release delayed. CTO escalation. RCA required.' },
      { key: 'staging-smoke',     label: 'Staging Smoke + Go/No-Go',     tMinus: 1,  owner: 'PM',          gate: false, autoCheck: null,                          description: 'Staging deploy + smoke test. Go/no-go call (PM + Dev Lead + DBA).', missAction: null },
      { key: 'ship',              label: 'Ship',                         tMinus: 0,  owner: 'PM',          gate: true,  autoCheck: 'state-is-done',               description: 'Production deploy. JIRA version marked Released.', missAction: null },
    ],
  },
  point: {
    key: 'point',
    label: 'Point Release',
    shipDay: 'wednesday',
    bufferDay: 'thursday',
    skipWeekends: true,
    milestones: [
      { key: 'scope-cutoff',      label: 'Scope Cutoff',                 tMinus: 7,  owner: 'PM',          gate: true,  autoCheck: null,                          description: 'Customer Lead, PM, and Project Manager define scope. Must Haves only.', missAction: 'Ticket rolls to next release.' },
      { key: 'dev-complete',      label: 'Dev Complete',                  tMinus: 4,  owner: 'Dev Lead',    gate: true,  autoCheck: 'all-prs-merged',              description: 'All PRs merged to master. Cherry-pick PRs opened.', missAction: 'Un-merged work is out.' },
      { key: 'qa-scope-review',   label: 'QA Scope Review',              tMinus: 4,  owner: 'QA Lead',     gate: true,  autoCheck: null,                          description: 'QA reviews every ticket. Confirms acceptance criteria are testable.', missAction: 'QA cycle cannot begin.' },
      { key: 'data-migration',    label: 'Data Migration Checkpoint',    tMinus: 3,  owner: 'DBA',         gate: true,  autoCheck: 'migrations-approved',         description: 'All migrations documented, staging-tested, DBA-approved.', missAction: 'Unapproved migration blocks certification.' },
      { key: 'certification',     label: 'Certification',                tMinus: 2,  owner: 'QA Lead',     gate: true,  autoCheck: 'truth-all-certified',         description: 'QA signed off + Nectar green + migrations approved.', missAction: 'Release delayed. CTO escalation.' },
      { key: 'staging-smoke',     label: 'Staging Smoke + Go/No-Go',     tMinus: 1,  owner: 'PM',          gate: false, autoCheck: null,                          description: 'Staging deploy + smoke test. Go/no-go call.', missAction: null },
      { key: 'ship',              label: 'Ship',                         tMinus: 0,  owner: 'PM',          gate: true,  autoCheck: 'state-is-done',               description: 'Production deploy.', missAction: null },
    ],
  },
  hotfix: {
    key: 'hotfix',
    label: 'Hotfix',
    shipDay: null,
    bufferDay: null,
    skipWeekends: false,
    milestones: [
      { key: 'incident',          label: 'Incident Declared',            tMinus: 0, owner: 'CTO',          gate: true,  autoCheck: null,                          description: 'CTO/PM establish Hotfix Team. JIRA ticket with HOTFIX label.', missAction: null },
      { key: 'fix-on-master',     label: 'Fix on Master',                tMinus: 0, owner: 'Dev',          gate: true,  autoCheck: null,                          description: 'PR against master. Expedited review.', missAction: 'Evaluate rollback.' },
      { key: 'cherry-pick',       label: 'Cherry-pick to Release',       tMinus: 0, owner: 'Dev',          gate: true,  autoCheck: null,                          description: 'Merged to master, cherry-picked to release branch.', missAction: null },
      { key: 'qa-verify',         label: 'QA Targeted Verification',     tMinus: 0, owner: 'QA',           gate: true,  autoCheck: null,                          description: 'Test the specific fix + immediate regression area ONLY.', missAction: null },
      { key: 'deploy',            label: 'Deploy Decision',              tMinus: 0, owner: 'PM',           gate: true,  autoCheck: null,                          description: 'Deploy tonight or next morning. Verify in production.', missAction: null },
      { key: 'rca',               label: 'RCA Due',                      tMinus: 0, owner: 'PM',           gate: true,  autoCheck: null,                          description: 'Written Root Cause Analysis within 48h. Action items with owners.', missAction: 'CTO escalation. Non-negotiable.' },
    ],
  },
};

// ── Date computation ─────────────────────────────────────────────────────────

/**
 * Subtract `businessDays` business days from `date`.
 * When skipWeekends=true, weekends are skipped.
 * @param {Date} date - The anchor date
 * @param {number} businessDays - Number of business days to subtract
 * @param {boolean} skipWeekends - Whether to skip weekends
 * @returns {Date} The computed date
 */
function subtractBusinessDays(date, businessDays, skipWeekends = true) {
  const result = new Date(date);
  let remaining = businessDays;

  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    if (!skipWeekends || (result.getDay() !== 0 && result.getDay() !== 6)) {
      remaining--;
    }
  }

  return result;
}

/**
 * Compute concrete milestone dates from a ship date and template.
 * @param {string} shipDate - ISO date string (YYYY-MM-DD)
 * @param {object} template - Template definition with milestones array
 * @returns {object[]} Array of milestone instances with computed dates
 */
function computeMilestones(shipDate, template) {
  const anchor = new Date(shipDate + 'T12:00:00'); // noon to avoid TZ issues
  const skipWeekends = template.skipWeekends !== false;

  return template.milestones.map(m => {
    const computed = subtractBusinessDays(anchor, m.tMinus, skipWeekends);
    const computedDate = formatDate(computed);

    return {
      key: m.key,
      label: m.label,
      tMinus: m.tMinus,
      computedDate,
      overrideDate: null,
      effectiveDate: computedDate,
      status: 'pending',
      completedAt: null,
      completedBy: null,
      owner: m.owner,
      gate: m.gate,
      autoCheck: m.autoCheck || null,
      description: m.description || null,
      missAction: m.missAction || null,
    };
  });
}

/**
 * Recompute milestones when ship date changes, preserving manual overrides.
 * @param {string} newShipDate - New ship date (YYYY-MM-DD)
 * @param {object[]} existingMilestones - Current milestone instances
 * @param {object} template - Template definition
 * @returns {object[]} Updated milestones
 */
function recomputeMilestones(newShipDate, existingMilestones, template) {
  const anchor = new Date(newShipDate + 'T12:00:00');
  const skipWeekends = template.skipWeekends !== false;

  return existingMilestones.map(existing => {
    const computed = subtractBusinessDays(anchor, existing.tMinus, skipWeekends);
    const computedDate = formatDate(computed);

    return {
      ...existing,
      computedDate,
      effectiveDate: existing.overrideDate || computedDate,
    };
  });
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Check if any gate on the release has been acted on (met, missed, skipped).
 * Used to categorize refresh impact.
 */
function hasGateActivity(milestones) {
  if (!milestones || !milestones.length) return false;
  return milestones.some(m => m.gate && (m.status === 'met' || m.status === 'missed' || m.status === 'skipped'));
}

/**
 * Refresh milestones from a new (or updated) template while preserving history.
 *
 * Rules:
 * - Gates already acted on (met/missed/skipped) keep their status, completedAt,
 *   completedBy — cannot undo history.
 * - Manual date overrides are preserved.
 * - T-minus, owner, label, description, gate flag, auto-check come from new template.
 * - Dates recompute from the new T-minus values (and current shipDate).
 * - Milestones removed from the template are dropped ONLY if pending; if acted on,
 *   they stay as an orphan record with a warning flag.
 * - New milestones in the template are added as pending.
 *
 * @param {string} shipDate - release ship date
 * @param {object[]} existingMilestones - current milestone instances on the release
 * @param {object} template - new template definition
 * @returns {{ milestones: object[], changes: object }}
 */
function refreshFromTemplate(shipDate, existingMilestones, template) {
  const anchor = new Date(shipDate + 'T12:00:00');
  const skipWeekends = template.skipWeekends !== false;
  const existingByKey = new Map((existingMilestones || []).map(m => [m.key, m]));
  const templateKeys = new Set(template.milestones.map(m => m.key));

  const added = [];
  const updated = [];
  const removed = [];
  const preserved = [];

  // 1. Build new list from template
  const next = template.milestones.map(tm => {
    const existing = existingByKey.get(tm.key);
    const computed = subtractBusinessDays(anchor, tm.tMinus, skipWeekends);
    const computedDate = formatDate(computed);

    if (existing) {
      // Existing milestone — merge template spec with release history
      const acted = existing.status === 'met' || existing.status === 'missed' || existing.status === 'skipped';
      const merged = {
        key: tm.key,
        label: tm.label,
        tMinus: tm.tMinus,
        computedDate,
        overrideDate: existing.overrideDate || null,
        effectiveDate: existing.overrideDate || computedDate,
        status: existing.status || 'pending',
        completedAt: acted ? existing.completedAt : null,
        completedBy: acted ? existing.completedBy : null,
        owner: tm.owner,
        gate: tm.gate,
        autoCheck: tm.autoCheck || null,
        description: tm.description || null,
        missAction: tm.missAction || null,
      };
      if (acted) preserved.push(tm.key);
      else updated.push(tm.key);
      return merged;
    }

    // Brand new milestone from template
    added.push(tm.key);
    return {
      key: tm.key,
      label: tm.label,
      tMinus: tm.tMinus,
      computedDate,
      overrideDate: null,
      effectiveDate: computedDate,
      status: 'pending',
      completedAt: null,
      completedBy: null,
      owner: tm.owner,
      gate: tm.gate,
      autoCheck: tm.autoCheck || null,
      description: tm.description || null,
      missAction: tm.missAction || null,
    };
  });

  // 2. Track removals — existing milestones not in new template
  for (const existing of existingMilestones || []) {
    if (!templateKeys.has(existing.key)) {
      const acted = existing.status === 'met' || existing.status === 'missed' || existing.status === 'skipped';
      if (acted) {
        // Keep as orphan — history should not be lost
        next.push({ ...existing, _orphaned: true });
        preserved.push(existing.key);
      } else {
        removed.push(existing.key);
      }
    }
  }

  return {
    milestones: next,
    changes: { added, updated, removed, preserved },
  };
}

// ── Template Store ───────────────────────────────────────────────────────────

class TemplateStore {
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    this._ensureDefaults();
  }

  _ensureDefaults() {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM release_templates').get().n;
    if (count === 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO release_templates (key, label, shipDay, bufferDay, skipWeekends, milestones, version, updatedAt, updatedBy)
        VALUES (@key, @label, @shipDay, @bufferDay, @skipWeekends, @milestones, 1, @updatedAt, 'system')
      `);
      const now = new Date().toISOString();
      for (const tmpl of Object.values(DEFAULT_TEMPLATES)) {
        stmt.run({
          key: tmpl.key,
          label: tmpl.label,
          shipDay: tmpl.shipDay,
          bufferDay: tmpl.bufferDay,
          skipWeekends: tmpl.skipWeekends ? 1 : 0,
          milestones: JSON.stringify(tmpl.milestones),
          updatedAt: now,
        });
      }
      log.info('Seeded default release templates');
    }
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM release_templates ORDER BY key').all();
    return rows.map(r => this._deserialize(r));
  }

  get(key) {
    const row = this.db.prepare('SELECT * FROM release_templates WHERE key = ?').get(key);
    if (!row) return null;
    return this._deserialize(row);
  }

  update(key, data, updatedBy = 'unknown') {
    const existing = this.get(key);
    if (!existing) throw new Error(`Template not found: ${key}`);

    const newVersion = existing.version + 1;
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE release_templates
      SET label = @label, shipDay = @shipDay, bufferDay = @bufferDay,
          skipWeekends = @skipWeekends, milestones = @milestones,
          version = @version, updatedAt = @updatedAt, updatedBy = @updatedBy
      WHERE key = @key
    `).run({
      key,
      label: data.label || existing.label,
      shipDay: data.shipDay !== undefined ? data.shipDay : existing.shipDay,
      bufferDay: data.bufferDay !== undefined ? data.bufferDay : existing.bufferDay,
      skipWeekends: data.skipWeekends !== undefined ? (data.skipWeekends ? 1 : 0) : (existing.skipWeekends ? 1 : 0),
      milestones: data.milestones ? JSON.stringify(data.milestones) : JSON.stringify(existing.milestones),
      version: newVersion,
      updatedAt: now,
      updatedBy,
    });

    log.info(`Template ${key} updated to v${newVersion} by ${updatedBy}`);
    return this.get(key);
  }

  _deserialize(row) {
    return {
      key: row.key,
      label: row.label,
      shipDay: row.shipDay,
      bufferDay: row.bufferDay,
      skipWeekends: !!row.skipWeekends,
      milestones: JSON.parse(row.milestones || '[]'),
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }
}

// ── Inference ────────────────────────────────────────────────────────────────

/**
 * Infer release type from version string.
 *   "4.2.0"          → monthly   (patch = 0)
 *   "4.2.1"          → point     (patch > 0)
 *   "4.2.7-lumen"    → point     (patch > 0, suffix ignored)
 *   "foo"            → null      (unparseable)
 * Hotfix cannot be inferred from version alone.
 */
function inferReleaseType(version) {
  if (!version) return null;
  const base = String(version).split('-')[0];
  const parts = base.split('.');
  if (parts.length < 3) return null;
  const patch = parseInt(parts[2], 10);
  if (isNaN(patch)) return null;
  return patch === 0 ? 'monthly' : 'point';
}

/**
 * Given a release and template store, compute milestones if possible.
 * Returns { milestones, releaseType, shipDate, templateVersion } or null if insufficient data.
 */
function autoComputeForRelease(release, templateStore) {
  if (!release || !templateStore) return null;
  const releaseType = release.releaseType || inferReleaseType(release.version);
  const shipDate = release.shipDate || release.jiraReleaseDate;
  if (!releaseType || !shipDate) return null;
  const template = templateStore.get(releaseType);
  if (!template) return null;
  const milestones = computeMilestones(shipDate, template);
  return { milestones, releaseType, shipDate, templateVersion: template.version };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  TemplateStore,
  computeMilestones,
  recomputeMilestones,
  refreshFromTemplate,
  hasGateActivity,
  subtractBusinessDays,
  formatDate,
  inferReleaseType,
  autoComputeForRelease,
  DEFAULT_TEMPLATES,
};
