const crypto = require('crypto');
const { EventEmitter } = require('events');
const log = require('./log');
const { getDb } = require('./db');
const { isValidSeverity } = require('./alert-triggers');

/**
 * IncidentStore — first-class incident tracking for the alerting system.
 *
 * An incident is opened when a trigger fires (or manually by a user) and
 * moves through a lifecycle:
 *    open → acknowledged → resolved
 *    open → resolved (auto-resolve on env recovery, or manual resolve)
 *    resolved → reopened (if user reopens, or if a new incident is
 *               preferred over reopening — router's call)
 *
 * Every state change appends a row to incident_events so the UI can
 * render a timeline.
 *
 * Emits:
 *   incident:opened         (incident)
 *   incident:updated        (incident, { type, changes })
 *   incident:acknowledged   (incident, event)
 *   incident:resolved       (incident, event)
 *   incident:reopened       (incident, event)
 *   incident:assigned       (incident, event)
 *   incident:note-added     (incident, event)
 *   incident:severity-changed (incident, event)
 *   incident:slack-tracked  (incident, { channel, ts, threadTs? })
 */
class IncidentStore extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db]
   */
  constructor(opts = {}) {
    super();
    this.db = opts.db || getDb();
  }

  // ── Queries ─────────────────────────────────────────────

  list(filter = {}) {
    const conditions = [];
    const params = {};
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map((_, i) => `@st${i}`).join(', ');
        conditions.push(`status IN (${placeholders})`);
        filter.status.forEach((s, i) => { params[`st${i}`] = s; });
      } else {
        conditions.push('status = @status');
        params.status = filter.status;
      }
    }
    if (filter.customerId) {
      conditions.push('customerId = @customerId');
      params.customerId = filter.customerId;
    }
    if (filter.envId) {
      conditions.push('envId = @envId');
      params.envId = filter.envId;
    }
    if (filter.severity) {
      conditions.push('severity = @severity');
      params.severity = filter.severity;
    }
    if (filter.assigneeUserId) {
      conditions.push('assigneeUserId = @assigneeUserId');
      params.assigneeUserId = filter.assigneeUserId;
    }
    if (filter.triggerType) {
      conditions.push('triggerType = @triggerType');
      params.triggerType = filter.triggerType;
    }
    if (filter.since) {
      conditions.push('openedAt >= @since');
      params.since = filter.since;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(filter.limit) || 100, 1), 1000);
    const rows = this.db.prepare(
      `SELECT * FROM alert_incidents ${where} ORDER BY openedAt DESC LIMIT ${limit}`
    ).all(params);
    return rows.map(rowToIncident);
  }

  /** Return { open, acknowledged, resolved } counts — for the nav badge. */
  counts() {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'open'         THEN 1 ELSE 0 END) AS openCount,
        SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) AS ackCount,
        SUM(CASE WHEN status = 'resolved'     THEN 1 ELSE 0 END) AS resolvedCount,
        SUM(CASE WHEN status = 'reopened'     THEN 1 ELSE 0 END) AS reopenedCount
      FROM alert_incidents
    `).get();
    return {
      open: row.openCount || 0,
      acknowledged: row.ackCount || 0,
      resolved: row.resolvedCount || 0,
      reopened: row.reopenedCount || 0,
      active: (row.openCount || 0) + (row.ackCount || 0) + (row.reopenedCount || 0),
    };
  }

  get(id) {
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM alert_incidents WHERE id = ?').get(id);
    return row ? rowToIncident(row) : null;
  }

  /** Get incident + its full event timeline. */
  getWithEvents(id) {
    const incident = this.get(id);
    if (!incident) return null;
    const events = this.listEvents(id);
    return { ...incident, events };
  }

  listEvents(incidentId) {
    const rows = this.db.prepare(
      'SELECT * FROM incident_events WHERE incidentId = ? ORDER BY at ASC, rowid ASC'
    ).all(incidentId);
    return rows.map(rowToEvent);
  }

  /**
   * Find the most recent active (open/acknowledged/reopened) incident for
   * a given subject key. Used by the router to decide whether a new
   * trigger event should open a new incident or update an existing one.
   */
  findActiveBySubject(subjectKey) {
    if (!subjectKey) return null;
    const row = this.db.prepare(`
      SELECT * FROM alert_incidents
      WHERE subjectKey = ? AND status IN ('open', 'acknowledged', 'reopened')
      ORDER BY openedAt DESC LIMIT 1
    `).get(subjectKey);
    return row ? rowToIncident(row) : null;
  }

  // ── Mutations ──────────────────────────────────────────

  /**
   * Open a new incident. Always writes an 'opened' event row.
   *
   * @param {object} input
   *   Required: { summary, triggerType }
   *   Optional: ruleId, source, subjectKey, customerId, envId, description,
   *             severity, assigneeUserId, assigneeSlackId, payload,
   *             actorUserId, actorName
   */
  open(input = {}) {
    const { summary, triggerType } = input;
    if (!summary) throw new Error('IncidentStore.open: summary is required');
    if (!triggerType) throw new Error('IncidentStore.open: triggerType is required');

    const now = new Date().toISOString();
    const incident = {
      id: `inc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      ruleId: input.ruleId || null,
      triggerType,
      source: input.source === 'manual' ? 'manual' : 'auto',
      subjectKey: input.subjectKey || null,
      customerId: input.customerId || null,
      envId: input.envId || null,

      summary: String(summary),
      description: input.description || null,
      severity: isValidSeverity(input.severity) ? input.severity : 'critical',

      status: 'open',
      assigneeUserId: input.assigneeUserId || null,
      assigneeSlackId: input.assigneeSlackId || null,

      openedAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,

      slackChannel: input.slackChannel || null,
      slackTs: input.slackTs || null,
      slackPosts: Array.isArray(input.slackPosts) ? input.slackPosts : [],
      payload: input.payload || {},

      createdAt: now,
      updatedAt: now,
    };

    // Insert + opened event atomically — a crash between them would
    // leave an incident with no 'opened' row in its timeline.
    this.db.transaction(() => {
      this._insert(incident);
      this._appendEvent(incident.id, {
        type: 'opened',
        actorUserId: input.actorUserId || null,
        actorName: input.actorName || (incident.source === 'manual' ? 'manual' : 'system'),
        payload: {
          source: incident.source,
          triggerType: incident.triggerType,
          severity: incident.severity,
        },
      });
    })();

    log.info(`Incident opened: ${incident.id} (${incident.triggerType}, severity=${incident.severity})`);
    this.emit('incident:opened', incident);
    return incident;
  }

  /**
   * Acknowledge an incident. No-op if already acknowledged or terminal.
   * A manually-resolved incident cannot be acknowledged (reopen first).
   */
  acknowledge(id, { actorUserId = null, actorName = null, note = null } = {}) {
    const incident = this.get(id);
    if (!incident) return null;
    if (incident.status === 'acknowledged') return incident;
    if (incident.status === 'resolved') {
      throw new Error(`Incident ${id} is resolved — reopen before acknowledging`);
    }
    const now = new Date().toISOString();
    this._patch(id, {
      status: 'acknowledged',
      acknowledgedAt: now,
      acknowledgedBy: actorName || actorUserId || 'unknown',
      updatedAt: now,
    });
    const event = this._appendEvent(id, {
      type: 'acknowledged',
      actorUserId,
      actorName,
      payload: note ? { note } : {},
    });
    const updated = this.get(id);
    this.emit('incident:acknowledged', updated, event);
    this.emit('incident:updated', updated, { type: 'acknowledged' });
    return updated;
  }

  /**
   * Resolve an incident. `resolution` is 'auto' (env recovered) or
   * 'manual' (user clicked resolve).
   */
  resolve(id, { actorUserId = null, actorName = null, resolution = 'manual', note = null } = {}) {
    const incident = this.get(id);
    if (!incident) return null;
    if (incident.status === 'resolved') return incident;
    const now = new Date().toISOString();
    this._patch(id, {
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: actorName || actorUserId || (resolution === 'auto' ? 'system' : 'unknown'),
      resolution: resolution === 'auto' ? 'auto' : 'manual',
      updatedAt: now,
    });
    const event = this._appendEvent(id, {
      type: 'resolved',
      actorUserId,
      actorName: actorName || (resolution === 'auto' ? 'system' : null),
      payload: { resolution, ...(note ? { note } : {}) },
    });
    const updated = this.get(id);
    log.info(`Incident resolved: ${id} (${resolution})`);
    this.emit('incident:resolved', updated, event);
    this.emit('incident:updated', updated, { type: 'resolved' });
    return updated;
  }

  reopen(id, { actorUserId = null, actorName = null, note = null } = {}) {
    const incident = this.get(id);
    if (!incident) return null;
    if (incident.status !== 'resolved') return incident;
    const now = new Date().toISOString();
    this._patch(id, {
      status: 'reopened',
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      updatedAt: now,
    });
    const event = this._appendEvent(id, {
      type: 'reopened',
      actorUserId,
      actorName,
      payload: note ? { note } : {},
    });
    const updated = this.get(id);
    this.emit('incident:reopened', updated, event);
    this.emit('incident:updated', updated, { type: 'reopened' });
    return updated;
  }

  /**
   * Assign an incident to a user. Pass null to unassign. If the user
   * has a Slack ID, record it so the router can DM them without a
   * second lookup.
   */
  assign(id, { assigneeUserId = null, assigneeSlackId = null, assigneeName = null, actorUserId = null, actorName = null } = {}) {
    const incident = this.get(id);
    if (!incident) return null;
    const now = new Date().toISOString();
    this._patch(id, {
      assigneeUserId,
      assigneeSlackId,
      updatedAt: now,
    });
    const event = this._appendEvent(id, {
      type: 'assigned',
      actorUserId,
      actorName,
      payload: { assigneeUserId, assigneeSlackId, assigneeName },
    });
    const updated = this.get(id);
    this.emit('incident:assigned', updated, event);
    this.emit('incident:updated', updated, { type: 'assigned' });
    return updated;
  }

  addNote(id, { text, actorUserId = null, actorName = null } = {}) {
    if (!text || !String(text).trim()) {
      throw new Error('IncidentStore.addNote: text is required');
    }
    const incident = this.get(id);
    if (!incident) return null;
    const event = this._appendEvent(id, {
      type: 'note',
      actorUserId,
      actorName,
      payload: { text: String(text) },
    });
    this._patch(id, { updatedAt: new Date().toISOString() });
    const updated = this.get(id);
    this.emit('incident:note-added', updated, event);
    this.emit('incident:updated', updated, { type: 'note-added' });
    return updated;
  }

  updateSeverity(id, { severity, actorUserId = null, actorName = null } = {}) {
    if (!isValidSeverity(severity)) {
      throw new Error(`IncidentStore.updateSeverity: invalid severity "${severity}"`);
    }
    const incident = this.get(id);
    if (!incident) return null;
    if (incident.severity === severity) return incident;
    const now = new Date().toISOString();
    const oldSeverity = incident.severity;
    this._patch(id, { severity, updatedAt: now });
    const event = this._appendEvent(id, {
      type: 'severity-changed',
      actorUserId,
      actorName,
      payload: { from: oldSeverity, to: severity },
    });
    const updated = this.get(id);
    this.emit('incident:severity-changed', updated, event);
    this.emit('incident:updated', updated, { type: 'severity-changed' });
    return updated;
  }

  /**
   * Record that this incident was posted to Slack. Stores the first post
   * as slackChannel/slackTs for convenience (the thread anchor); all
   * posts are kept in slackPosts so we can reply to each channel.
   */
  trackSlackPost(id, { channel, ts }) {
    const incident = this.get(id);
    if (!incident) return null;
    const posts = Array.isArray(incident.slackPosts) ? [...incident.slackPosts] : [];
    posts.push({ channel, ts });
    const patch = {
      slackPosts: posts,
      updatedAt: new Date().toISOString(),
    };
    if (!incident.slackChannel) patch.slackChannel = channel;
    if (!incident.slackTs) patch.slackTs = ts;
    this._patch(id, patch);
    const updated = this.get(id);
    this.emit('incident:slack-tracked', updated, { channel, ts });
    return updated;
  }

  /**
   * Append a system event without changing status (e.g., sustained-fired,
   * recovery-detected, dedup-suppressed). Useful for an audit trail of
   * router activity.
   */
  recordSystemEvent(id, type, payload = {}) {
    const incident = this.get(id);
    if (!incident) return null;
    this._appendEvent(id, {
      type,
      actorUserId: null,
      actorName: 'system',
      payload,
    });
    this._patch(id, { updatedAt: new Date().toISOString() });
    return this.get(id);
  }

  // ── Internal ────────────────────────────────────────────

  _insert(incident) {
    this.db.prepare(`
      INSERT INTO alert_incidents (
        id, ruleId, triggerType, source, subjectKey, customerId, envId,
        summary, description, severity,
        status, assigneeUserId, assigneeSlackId,
        openedAt, acknowledgedAt, acknowledgedBy, resolvedAt, resolvedBy, resolution,
        slackChannel, slackTs, slackPosts, payloadJson,
        createdAt, updatedAt
      ) VALUES (
        @id, @ruleId, @triggerType, @source, @subjectKey, @customerId, @envId,
        @summary, @description, @severity,
        @status, @assigneeUserId, @assigneeSlackId,
        @openedAt, @acknowledgedAt, @acknowledgedBy, @resolvedAt, @resolvedBy, @resolution,
        @slackChannel, @slackTs, @slackPosts, @payloadJson,
        @createdAt, @updatedAt
      )
    `).run(incidentToRow(incident));
  }

  _patch(id, patch) {
    // Build dynamic UPDATE — only touch the columns present in `patch`
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map(k => {
      if (k === 'slackPosts' || k === 'payload') return `${k === 'payload' ? 'payloadJson' : k} = @${k}_json`;
      return `${k} = @${k}`;
    }).join(', ');
    const params = { id };
    for (const k of keys) {
      if (k === 'slackPosts') {
        params.slackPosts_json = JSON.stringify(patch[k] || []);
      } else if (k === 'payload') {
        params.payload_json = JSON.stringify(patch[k] || {});
      } else {
        params[k] = patch[k];
      }
    }
    this.db.prepare(`UPDATE alert_incidents SET ${set} WHERE id = @id`).run(params);
  }

  _appendEvent(incidentId, { type, actorUserId = null, actorName = null, payload = {} }) {
    const event = {
      id: `incev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      incidentId,
      type,
      actorUserId,
      actorName,
      payload,
      at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO incident_events (id, incidentId, type, actorUserId, actorName, payloadJson, at)
      VALUES (@id, @incidentId, @type, @actorUserId, @actorName, @payloadJson, @at)
    `).run({
      id: event.id,
      incidentId,
      type,
      actorUserId,
      actorName,
      payloadJson: JSON.stringify(payload || {}),
      at: event.at,
    });
    return event;
  }
}

// ── Row <-> object ───────────────────────────────────────

function rowToIncident(row) {
  return {
    id: row.id,
    ruleId: row.ruleId || null,
    triggerType: row.triggerType,
    source: row.source || 'auto',
    subjectKey: row.subjectKey || null,
    customerId: row.customerId || null,
    envId: row.envId || null,

    summary: row.summary,
    description: row.description || null,
    severity: row.severity || 'critical',

    status: row.status || 'open',
    assigneeUserId: row.assigneeUserId || null,
    assigneeSlackId: row.assigneeSlackId || null,

    openedAt: row.openedAt,
    acknowledgedAt: row.acknowledgedAt || null,
    acknowledgedBy: row.acknowledgedBy || null,
    resolvedAt: row.resolvedAt || null,
    resolvedBy: row.resolvedBy || null,
    resolution: row.resolution || null,

    slackChannel: row.slackChannel || null,
    slackTs: row.slackTs || null,
    slackPosts: safeParse(row.slackPosts, []),
    payload: safeParse(row.payloadJson, {}),

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function incidentToRow(inc) {
  return {
    id: inc.id,
    ruleId: inc.ruleId || null,
    triggerType: inc.triggerType,
    source: inc.source || 'auto',
    subjectKey: inc.subjectKey || null,
    customerId: inc.customerId || null,
    envId: inc.envId || null,

    summary: inc.summary,
    description: inc.description || null,
    severity: inc.severity || 'critical',

    status: inc.status || 'open',
    assigneeUserId: inc.assigneeUserId || null,
    assigneeSlackId: inc.assigneeSlackId || null,

    openedAt: inc.openedAt,
    acknowledgedAt: inc.acknowledgedAt || null,
    acknowledgedBy: inc.acknowledgedBy || null,
    resolvedAt: inc.resolvedAt || null,
    resolvedBy: inc.resolvedBy || null,
    resolution: inc.resolution || null,

    slackChannel: inc.slackChannel || null,
    slackTs: inc.slackTs || null,
    slackPosts: JSON.stringify(inc.slackPosts || []),
    payloadJson: JSON.stringify(inc.payload || {}),

    createdAt: inc.createdAt,
    updatedAt: inc.updatedAt,
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    type: row.type,
    actorUserId: row.actorUserId || null,
    actorName: row.actorName || null,
    payload: safeParse(row.payloadJson, {}),
    at: row.at,
  };
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = IncidentStore;
