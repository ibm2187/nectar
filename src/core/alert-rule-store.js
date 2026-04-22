const crypto = require('crypto');
const log = require('./log');
const { getDb } = require('./db');
const {
  isValidTriggerType,
  isValidSeverity,
  sanitizeFilter,
  getTrigger,
} = require('./alert-triggers');

/**
 * AlertRuleStore — CRUD for alert_rules.
 *
 * Each rule defines: which trigger to listen for, how to filter events
 * (by customer/env/component/etc.), which Slack channel(s) to post to,
 * and the mention to use. The AlertRouter reads this store to decide
 * where and whether to fire.
 *
 * Channel validation is caller-driven: invoke `validateChannel()` via
 * the SlackNotifier before creating/updating a rule so the bot's
 * membership is confirmed. This store accepts whatever channels it's
 * given.
 *
 * Row shape:
 *   { id, name, triggerType, filter, channels, mention,
 *     severity, enabled, lastFiredAt, createdAt, updatedAt }
 *
 * `filter` and `channels` are stored as JSON TEXT and parsed on read.
 */
class AlertRuleStore {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db]
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
  }

  // ── CRUD ────────────────────────────────────────────────

  list(filter = {}) {
    const conditions = [];
    const params = {};
    if (filter.triggerType) {
      conditions.push('triggerType = @triggerType');
      params.triggerType = filter.triggerType;
    }
    if (filter.enabled !== undefined) {
      conditions.push('enabled = @enabled');
      params.enabled = filter.enabled ? 1 : 0;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM alert_rules ${where} ORDER BY createdAt DESC`).all(params);
    return rows.map(rowToRule);
  }

  get(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
    return row ? rowToRule(row) : null;
  }

  /**
   * Create a rule. Validates the trigger type, sanitizes the filter
   * against the trigger's declared filter schema, and coerces the
   * severity to a valid value.
   *
   * @param {object} input
   * @returns {object} — the created rule
   * @throws {Error} on invalid trigger type or missing required fields
   */
  create(input = {}) {
    const validated = this._validate(input);
    const now = new Date().toISOString();
    const rule = {
      id: `alrt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      ...validated,
      lastFiredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this._insert(rule);
    log.info(`AlertRule created: ${rule.id} (${rule.name}, trigger=${rule.triggerType})`);
    return rule;
  }

  /**
   * Update a rule. Only fields present on the patch object are touched.
   * Re-validates trigger type + filter when those change.
   */
  update(id, patch = {}) {
    const existing = this.get(id);
    if (!existing) return null;

    // Merge — allow partial updates but re-validate the merged shape
    const merged = { ...existing, ...patch };
    const validated = this._validate(merged, { allowPartial: true, existing });

    const next = {
      ...existing,
      ...validated,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this._update(next);
    log.info(`AlertRule updated: ${next.id}`);
    return next;
  }

  delete(id) {
    const r = this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    if (r.changes > 0) log.info(`AlertRule deleted: ${id}`);
    return r.changes > 0;
  }

  /**
   * Mark a rule as having fired now. Used by the router after a
   * successful Slack post so the UI can show "last fired".
   */
  recordFired(id, at = new Date().toISOString()) {
    this.db.prepare('UPDATE alert_rules SET lastFiredAt = ?, updatedAt = ? WHERE id = ?')
      .run(at, at, id);
  }

  // ── Matching ────────────────────────────────────────────

  /**
   * Find all enabled rules whose triggerType matches and whose filter
   * accepts the given event context. The router calls this for every
   * trigger event.
   *
   * @param {string} triggerType
   * @param {object} context — { customerId, envId, envTier, components[], durationMinutes }
   * @returns {Array<rule>}
   */
  findMatching(triggerType, context = {}) {
    const rules = this.list({ triggerType, enabled: true });
    return rules.filter(rule => filterMatches(rule.filter, context));
  }

  // ── Internal ────────────────────────────────────────────

  _validate(input, { allowPartial = false, existing = null } = {}) {
    const triggerType = input.triggerType ?? existing?.triggerType;
    if (!triggerType) {
      throw new Error('AlertRule: triggerType is required');
    }
    if (!isValidTriggerType(triggerType)) {
      throw new Error(`AlertRule: unknown triggerType "${triggerType}"`);
    }

    const name = (input.name ?? existing?.name ?? '').toString().trim();
    if (!name) {
      throw new Error('AlertRule: name is required');
    }

    const channelsSource = input.channels !== undefined ? input.channels : existing?.channels;
    const channels = normalizeChannels(channelsSource);
    // A rule with zero channels can't post anywhere, so we reject
    // regardless of whether this is a create or a partial update.
    // allowPartial only softens field-presence checks, not correctness.
    if (channels.length === 0) {
      throw new Error('AlertRule: at least one channel is required');
    }

    const severity = (() => {
      const raw = input.severity ?? existing?.severity;
      if (isValidSeverity(raw)) return raw;
      return getTrigger(triggerType)?.defaultSeverity || 'critical';
    })();

    const filter = sanitizeFilter(triggerType, input.filter ?? existing?.filter ?? {});

    const mention = input.mention !== undefined ? (input.mention || null) : (existing?.mention || null);

    const enabled = (() => {
      const raw = input.enabled !== undefined ? input.enabled : (existing?.enabled !== undefined ? existing.enabled : true);
      return !!raw;
    })();

    return { name, triggerType, filter, channels, mention, severity, enabled };
  }

  _insert(rule) {
    this.db.prepare(`
      INSERT INTO alert_rules (id, name, triggerType, filter, channels, mention, severity, enabled, lastFiredAt, createdAt, updatedAt)
      VALUES (@id, @name, @triggerType, @filter, @channels, @mention, @severity, @enabled, @lastFiredAt, @createdAt, @updatedAt)
    `).run(ruleToRow(rule));
  }

  _update(rule) {
    this.db.prepare(`
      UPDATE alert_rules SET
        name = @name,
        triggerType = @triggerType,
        filter = @filter,
        channels = @channels,
        mention = @mention,
        severity = @severity,
        enabled = @enabled,
        lastFiredAt = @lastFiredAt,
        updatedAt = @updatedAt
      WHERE id = @id
    `).run(ruleToRow(rule));
  }
}

// ── Helpers ──────────────────────────────────────────────

function normalizeChannels(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map(c => String(c || '').trim())
    .filter(Boolean)
    // Normalize: leading '#' is optional in UI but we store with '#'
    .map(c => c.startsWith('#') || c.startsWith('@') ? c : `#${c}`);
}

function rowToRule(row) {
  return {
    id: row.id,
    name: row.name,
    triggerType: row.triggerType,
    filter: safeParse(row.filter, {}),
    channels: safeParse(row.channels, []),
    mention: row.mention || null,
    severity: row.severity || 'critical',
    enabled: !!row.enabled,
    lastFiredAt: row.lastFiredAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ruleToRow(rule) {
  return {
    id: rule.id,
    name: rule.name,
    triggerType: rule.triggerType,
    filter: JSON.stringify(rule.filter || {}),
    channels: JSON.stringify(rule.channels || []),
    mention: rule.mention || null,
    severity: rule.severity || 'critical',
    enabled: rule.enabled ? 1 : 0,
    lastFiredAt: rule.lastFiredAt || null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Evaluate whether a filter accepts the given context. All populated
 * filter fields are ANDed. Empty/missing filter fields = accept all.
 *
 *   filter.customerIds = ['bayada']  → context.customerId must be 'bayada'
 *   filter.envTier     = ['production'] → context.envTier must match
 *   filter.components  = ['Cache']    → context.components must intersect
 *
 * Unknown filter keys are ignored (sanitizeFilter drops them on write).
 */
function filterMatches(filter = {}, context = {}) {
  if (filter.customerIds && filter.customerIds.length > 0) {
    if (!context.customerId || !filter.customerIds.includes(context.customerId)) return false;
  }
  if (filter.envIds && filter.envIds.length > 0) {
    if (!context.envId || !filter.envIds.includes(context.envId)) return false;
  }
  if (filter.envTier && filter.envTier.length > 0) {
    if (!context.envTier || !filter.envTier.includes(context.envTier)) return false;
  }
  if (filter.components && filter.components.length > 0) {
    const eventComponents = Array.isArray(context.components) ? context.components : [];
    const intersects = eventComponents.some(c => filter.components.includes(c));
    if (!intersects) return false;
  }
  if (typeof filter.sustainedMinutes === 'number') {
    const actual = Number(context.durationMinutes);
    if (!Number.isFinite(actual) || actual < filter.sustainedMinutes) return false;
  }
  return true;
}

module.exports = AlertRuleStore;
module.exports.filterMatches = filterMatches;
module.exports.normalizeChannels = normalizeChannels;
