const { EventEmitter } = require('events');
const log = require('./log');
const { getDb } = require('./db');

/**
 * Default flap guard: a status change must persist for this many
 * consecutive polls before an alert fires. Prevents single-poll blips
 * from paging anyone. Override per-construction for tests.
 */
const DEFAULT_FLAP_THRESHOLD = 2;

/**
 * Severity-to-emoji mapping used in Slack post text (falls back to a
 * neutral :warning: for unknowns).
 */
const SEVERITY_ICONS = {
  critical: ':rotating_light:',
  warning: ':warning:',
  info: ':information_source:',
};

/**
 * AlertRouter — the choke point for "do we fire an alert, where does it
 * go, and what incident does it belong to".
 *
 * Consumers call one of the handle* methods with a raw observation.
 * The router:
 *   1. Applies a flap guard (uses alert_state table).
 *   2. Finds matching rules via AlertRuleStore.findMatching.
 *   3. Opens or updates an Incident via IncidentStore.
 *   4. Posts to Slack (via slack.postAlert / postReply).
 *   5. Tracks the Slack thread anchor on the incident so future
 *      recovery/ack/resolve messages can thread into it.
 *
 * The flap guard + dedup logic lives here, not in the poller, so that:
 *   - The poller stays simple ("I observed X on env Y, router handles it").
 *   - Tests can exercise the router with fake time and fake Slack.
 *   - A future direct API (e.g., a /alerts/simulate route) can reuse it.
 */
class AlertRouter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./alert-rule-store')} opts.alertRules
   * @param {import('./incident-store')} opts.incidents
   * @param {import('../integrations/slack')} opts.slack
   * @param {import('./notification-settings')} [opts.notificationSettings]
   * @param {import('better-sqlite3').Database} [opts.db]
   * @param {number} [opts.flapThreshold]
   * @param {function} [opts.now] - injectable Date.now, for tests
   */
  constructor(opts = {}) {
    super();
    this.alertRules = opts.alertRules;
    this.incidents = opts.incidents;
    this.slack = opts.slack;
    this.settings = opts.notificationSettings || null;
    this.db = opts.db || getDb();
    this.flapThreshold = opts.flapThreshold ?? DEFAULT_FLAP_THRESHOLD;
    this.now = opts.now || (() => Date.now());

    if (!this.alertRules) throw new Error('AlertRouter: alertRules is required');
    if (!this.incidents) throw new Error('AlertRouter: incidents is required');
  }

  // ══════════════════════════════════════════════════════
  // Public: health observation entrypoint
  // ══════════════════════════════════════════════════════

  /**
   * Called by the environment poller on every health poll.
   *
   * Applies the flap guard to turn a stream of raw observations into
   * stable transition events, then routes those events to rules.
   *
   * @param {object} obs
   * @param {string} obs.envId
   * @param {string} obs.envName
   * @param {string} obs.customerId
   * @param {string} [obs.envTier]
   * @param {'healthy'|'degraded'|'unhealthy'} obs.status
   * @param {string[]} [obs.failingComponents]
   * @param {string} [obs.version]
   * @param {string} [obs.url]
   * @returns {Promise<{ transition: string | null, incidentId?: string }>}
   */
  async observeEnvHealth(obs) {
    const key = `env-health:${obs.envId}`;
    const nowIso = new Date(this.now()).toISOString();
    const prev = this._loadState(key);

    // Normalize failing components list (undefined → [])
    const components = Array.isArray(obs.failingComponents) ? obs.failingComponents.slice() : [];

    // ── Update state machine ───────────────────────────
    // The "stable" status is prev.status. A change must persist for
    // `flapThreshold` consecutive polls before we treat it as a real
    // transition.
    const prevStatus = prev ? prev.status : null;
    let nextState;

    if (prevStatus === obs.status) {
      // Steady state. Bump consecutiveCount but don't reset firstFailedAt
      // (we want "how long have we been unhealthy" for sustained alerts).
      nextState = {
        key,
        status: prevStatus,
        failingComponents: components,
        firstFailedAt: prev?.firstFailedAt || (obs.status !== 'healthy' ? nowIso : null),
        lastAlertedAt: prev?.lastAlertedAt || null,
        consecutiveCount: (prev?.consecutiveCount || 0) + 1,
        incidentId: prev?.incidentId || null,
        escalated: prev?.escalated ? 1 : 0,
        updatedAt: nowIso,
      };
    } else {
      // Transition attempt. Count starts at 1; if it reaches flapThreshold
      // below, we promote this to the stable status and fire the event.
      // We store it as a "pending" state in consecutiveCount but keep
      // `status` = the OLD stable status until promoted, OR we just store
      // the new status with count=1 and let the router interpret.
      //
      // Simpler approach: store the new status immediately with count=1.
      // The router only fires when count >= flapThreshold.
      nextState = {
        key,
        status: obs.status,
        failingComponents: components,
        firstFailedAt: obs.status !== 'healthy' ? nowIso : null,
        lastAlertedAt: null,
        consecutiveCount: 1,
        incidentId: null, // cleared on status change — new incident if we decide to fire
        escalated: 0,
        updatedAt: nowIso,
      };
    }

    // ── Decide whether to fire ─────────────────────────
    // Fire exactly once when consecutiveCount hits the flap threshold
    // for a given stable status. Lower counts are pre-stable; higher
    // counts already fired and don't fire again.
    const toStatus = obs.status;

    // Persist state regardless — this must happen whether we fire or not
    this._saveState(nextState);

    if (nextState.consecutiveCount !== this.flapThreshold) {
      return { transition: null };
    }

    // Route based on the destination status
    const baseContext = {
      envId: obs.envId,
      envName: obs.envName,
      customerId: obs.customerId,
      envTier: obs.envTier,
      components,
      version: obs.version || null,
      url: obs.url || null,
    };

    if (toStatus === 'unhealthy') {
      const result = await this._fireEnvUnhealthy(baseContext, nextState);
      this._markFired(key, toStatus, nowIso, result.incidentId);
      return { transition: 'env-unhealthy', ...result };
    }

    if (toStatus === 'degraded') {
      // Degraded from healthy OR degraded from unhealthy (partial recovery).
      // For v1, treat degraded→unhealthy as an unhealthy alert; leave
      // healthy→degraded for later. Don't fire anything here yet.
      this._markFired(key, toStatus, nowIso, null);
      return { transition: 'env-degraded' };
    }

    if (toStatus === 'healthy') {
      // Transition from unhealthy or degraded back to healthy.
      const result = await this._fireEnvRecovered(baseContext, prev);
      this._markFired(key, toStatus, nowIso, null);
      return { transition: 'env-recovered', ...result };
    }

    this._markFired(key, toStatus, nowIso, null);
    return { transition: null };
  }

  /**
   * Separate entrypoint for the sustained-degradation trigger. Called
   * periodically by the poller (e.g., end of each poll cycle). For
   * every active unhealthy incident whose firstFailedAt age exceeds the
   * minimum rule's threshold, fires sustained alerts.
   *
   * The poller doesn't need to know which rules exist — it just hands
   * the router the current set of active unhealthy envs.
   *
   * @param {Array<object>} activeUnhealthy - [{ envId, envName, customerId, envTier, components[], firstFailedAt }]
   */
  async checkSustained(activeUnhealthy = []) {
    const nowMs = this.now();
    for (const env of activeUnhealthy) {
      // Allow caller to pass firstFailedAt directly (used by tests for
      // deterministic mocked-time math). Otherwise, read from the
      // router's own alert_state table — the authoritative source since
      // the router populates it when unhealthy is first observed.
      let firstFailedAt = env.firstFailedAt;
      if (!firstFailedAt) {
        const state = this._loadState(`env-health:${env.envId}`);
        firstFailedAt = state?.firstFailedAt || null;
      }
      if (!firstFailedAt) continue;
      const ageMs = nowMs - new Date(firstFailedAt).getTime();
      const ageMinutes = Math.floor(ageMs / 60000);

      const key = `env-health:${env.envId}`;
      const state = this._loadState(key);
      if (state?.escalated) continue; // already fired sustained for this streak

      // Find rules that want to fire at or before this age
      const context = {
        customerId: env.customerId,
        envId: env.envId,
        envTier: env.envTier,
        components: env.components || [],
        durationMinutes: ageMinutes,
      };
      const matches = this.alertRules.findMatching('env-degraded-sustained', context);
      if (matches.length === 0) continue;

      // Pick the lowest-threshold match so we only fire once; the
      // incident payload mentions this was an escalation.
      const minMatch = matches.reduce((best, m) => {
        const bestSust = best.filter?.sustainedMinutes ?? Infinity;
        const mSust = m.filter?.sustainedMinutes ?? Infinity;
        return mSust < bestSust ? m : best;
      }, matches[0]);

      await this._fireEnvSustained(env, matches, minMatch, ageMinutes);

      // Mark state.escalated = 1 so we don't re-fire for the same streak
      this._patchState(key, { escalated: 1, updatedAt: new Date(nowMs).toISOString() });
    }
  }

  // ══════════════════════════════════════════════════════
  // Internal: individual trigger handlers
  // ══════════════════════════════════════════════════════

  async _fireEnvUnhealthy(baseContext, state) {
    if (!this._groupEnabled('envUnhealthy')) {
      log.info('AlertRouter: envUnhealthy disabled via NotificationSettings');
      return {};
    }

    const rules = this.alertRules.findMatching('env-unhealthy', baseContext);
    if (rules.length === 0) {
      log.info(`AlertRouter: no env-unhealthy rules match envId=${baseContext.envId}`);
      return {};
    }

    // Check for an existing active incident for this subject — if one
    // is open, update it rather than opening a new one (dedup).
    const subjectKey = `env-health:${baseContext.envId}`;
    const existing = this.incidents.findActiveBySubject(subjectKey);

    if (existing) {
      this.incidents.recordSystemEvent(existing.id, 'dedup-suppressed', {
        reason: 'active-incident-exists',
        components: baseContext.components,
      });
      log.info(`AlertRouter: dedup-suppressed env-unhealthy for envId=${baseContext.envId} (incident=${existing.id})`);
      return { incidentId: existing.id, deduped: true };
    }

    // Open a new incident. Severity is the highest of any matching rule.
    const severity = pickHighestSeverity(rules.map(r => r.severity));
    const summary = buildUnhealthySummary(baseContext);

    const incident = this.incidents.open({
      triggerType: 'env-unhealthy',
      source: 'auto',
      subjectKey,
      customerId: baseContext.customerId,
      envId: baseContext.envId,
      summary,
      severity,
      ruleId: rules[0]?.id || null,
      payload: {
        envName: baseContext.envName,
        envTier: baseContext.envTier,
        components: baseContext.components,
        version: baseContext.version,
      },
    });

    // Post to every matching rule's channels. Each rule's mention is
    // applied per rule (so one rule can @here and another not).
    for (const rule of rules) {
      const text = this._renderUnhealthyText({ rule, incident, context: baseContext });
      const posts = await this._postAlert({
        rule,
        channels: rule.channels,
        text,
      });
      for (const p of posts) {
        if (p.ok && p.ts) this.incidents.trackSlackPost(incident.id, { channel: p.channel, ts: p.ts });
      }
      this.alertRules.recordFired(rule.id);
    }

    // Record an incidentId on alert_state for thread anchoring
    this._patchState(subjectKey, { incidentId: incident.id, lastAlertedAt: new Date(this.now()).toISOString() });

    this.emit('fired', { trigger: 'env-unhealthy', incidentId: incident.id, ruleIds: rules.map(r => r.id) });
    return { incidentId: incident.id, ruleIds: rules.map(r => r.id) };
  }

  async _fireEnvRecovered(baseContext, prevState) {
    const subjectKey = `env-health:${baseContext.envId}`;

    // Respect the envRecovered toggle under NotificationSettings →
    // environmentAlerts. If recovery posts are disabled, leave the
    // incident open — admin can close it manually — and clear state.
    if (!this._groupEnabled('envRecovered')) {
      log.info('AlertRouter: envRecovered disabled via NotificationSettings');
      this._patchState(subjectKey, { incidentId: null, escalated: 0, firstFailedAt: null });
      return {};
    }

    // Only fire if we previously opened an incident for this env
    const incident = this.incidents.findActiveBySubject(subjectKey);

    if (!incident) {
      // No active incident — nothing to recover from. Reset state.
      this._patchState(subjectKey, { incidentId: null, escalated: 0, firstFailedAt: null });
      return {};
    }

    // Auto-resolve the incident. Resolution = 'auto'.
    const resolved = this.incidents.resolve(incident.id, {
      actorName: 'system',
      resolution: 'auto',
    });

    // Post recovery reply to each Slack post tracked on the incident,
    // threaded to the original anchor.
    if (this.slack && this.slack.isConfigured() && Array.isArray(incident.slackPosts)) {
      for (const { channel, ts } of incident.slackPosts) {
        const text = this._renderRecoveryText({ incident, context: baseContext });
        await this.slack.postReply({ channel, ts, text }).catch(err =>
          log.warn(`AlertRouter: recovery reply failed for ${channel}: ${err.message}`)
        );
      }
    }

    // Clear state for a fresh future cycle
    this._patchState(subjectKey, { incidentId: null, escalated: 0, firstFailedAt: null, lastAlertedAt: new Date(this.now()).toISOString() });

    this.emit('fired', { trigger: 'env-recovered', incidentId: incident.id });
    return { incidentId: resolved.id };
  }

  async _fireEnvSustained(env, rules, triggeringRule, ageMinutes) {
    if (!this._groupEnabled('envSustained')) {
      log.info('AlertRouter: envSustained disabled via NotificationSettings');
      return;
    }
    const subjectKey = `env-health:${env.envId}`;
    const incident = this.incidents.findActiveBySubject(subjectKey);
    if (!incident) return; // safety — should always exist if env is active-unhealthy

    this.incidents.recordSystemEvent(incident.id, 'sustained', {
      ageMinutes,
      ruleId: triggeringRule.id,
    });

    for (const rule of rules) {
      const text = `:warning: *Still unhealthy* — ${env.envName || env.envId} has been unhealthy for ${ageMinutes} min` +
        (incident.slackChannel ? `\nIncident: ${incident.summary}` : '');
      // Per-channel threading: if this channel has an existing anchor
      // from the initial unhealthy post, thread into that thread.
      // Otherwise post as a top-level message in this channel.
      const postsByChannel = new Map((incident.slackPosts || []).map(p => [p.channel, p.ts]));
      for (const channel of rule.channels) {
        const anchorTs = postsByChannel.get(channel) || null;
        await this._postAlert({
          rule,
          channels: [channel],
          text,
          threadTs: anchorTs,
        });
      }
    }
    this.emit('fired', { trigger: 'env-degraded-sustained', incidentId: incident.id, ageMinutes });
  }

  // ══════════════════════════════════════════════════════
  // Generic event-driven triggers (tier-2)
  // ══════════════════════════════════════════════════════

  /**
   * Fire an alert for an event-driven trigger (deploy-failed,
   * feature-flag-changed, upgrade-failed, etc.). Unlike env-health,
   * these don't have a flap guard — the caller is expected to deliver
   * only real events, not continuous observations.
   *
   * Dedup works via subjectKey: if an active incident exists for the
   * subject, we update it but don't re-post. There is no auto-recovery
   * for tier-2 triggers in v1; users manually resolve.
   *
   * @param {object} opts
   * @param {string} opts.triggerType
   * @param {string} [opts.subjectKey] - if provided, used for dedup
   * @param {string} [opts.customerId]
   * @param {string} [opts.envId]
   * @param {string} [opts.envTier]
   * @param {string[]} [opts.components]
   * @param {string} [opts.summary]
   * @param {string} [opts.description]
   * @param {'critical'|'warning'|'info'} [opts.severity]
   * @param {object} [opts.payload]
   * @returns {Promise<{ incidentId?: string, deduped?: boolean, noMatch?: boolean, disabled?: boolean }>}
   */
  async handleTrigger(opts = {}) {
    const { isValidTriggerType } = require('./alert-triggers');
    if (!isValidTriggerType(opts.triggerType)) {
      log.warn(`AlertRouter.handleTrigger: unknown triggerType "${opts.triggerType}"`);
      return { noMatch: true };
    }

    const context = {
      customerId: opts.customerId,
      envId: opts.envId,
      envTier: opts.envTier,
      components: opts.components || [],
    };

    // Dedup via subjectKey
    if (opts.subjectKey) {
      const existing = this.incidents.findActiveBySubject(opts.subjectKey);
      if (existing) {
        this.incidents.recordSystemEvent(existing.id, 'dedup-suppressed', {
          reason: 'active-incident-exists',
          triggerType: opts.triggerType,
        });
        return { deduped: true, incidentId: existing.id };
      }
    }

    const rules = this.alertRules.findMatching(opts.triggerType, context);
    if (rules.length === 0) {
      log.info(`AlertRouter: no ${opts.triggerType} rules match (envId=${opts.envId})`);
      return { noMatch: true };
    }

    const severity = opts.severity || pickHighestSeverity(rules.map(r => r.severity));
    const incident = this.incidents.open({
      triggerType: opts.triggerType,
      source: 'auto',
      subjectKey: opts.subjectKey || null,
      customerId: opts.customerId || null,
      envId: opts.envId || null,
      summary: opts.summary || defaultSummary(opts),
      description: opts.description || null,
      severity,
      ruleId: rules[0]?.id || null,
      payload: opts.payload || {},
    });

    for (const rule of rules) {
      const text = this._renderGenericText({ rule, incident, opts });
      const posts = await this._postAlert({ rule, channels: rule.channels, text });
      for (const p of posts) {
        if (p.ok && p.ts) this.incidents.trackSlackPost(incident.id, { channel: p.channel, ts: p.ts });
      }
      this.alertRules.recordFired(rule.id);
    }

    this.emit('fired', { trigger: opts.triggerType, incidentId: incident.id, ruleIds: rules.map(r => r.id) });
    return { incidentId: incident.id };
  }

  _renderGenericText({ rule, incident, opts }) {
    const icon = SEVERITY_ICONS[incident.severity] || ':rotating_light:';
    const lines = [`${icon} *${incident.summary}*`];
    if (opts.envId) lines.push(`Env: ${opts.envId}${opts.envTier ? ` (${opts.envTier})` : ''}`);
    if (opts.customerId) lines.push(`Customer: ${opts.customerId}`);
    if (opts.description) lines.push(opts.description);
    lines.push(`<${nectarIncidentUrl(incident.id)}|View incident in Nectar>`);
    return lines.join('\n');
  }

  // ══════════════════════════════════════════════════════
  // Incident → Slack round-trip (ack/resolve/assign/note)
  // Called by wiring in index.js via IncidentStore events.
  // ══════════════════════════════════════════════════════

  async onIncidentAcknowledged(incident, event) {
    await this._postRoundTrip(incident, `:mute: Acknowledged by ${event.actorName || 'unknown'}${event.payload?.note ? ` — ${event.payload.note}` : ''}`);
  }

  async onIncidentResolved(incident, event) {
    if (event?.payload?.resolution === 'auto') return; // already threaded by _fireEnvRecovered
    await this._postRoundTrip(incident, `:white_check_mark: Resolved by ${event.actorName || 'unknown'}${event.payload?.note ? ` — ${event.payload.note}` : ''}`);
  }

  async onIncidentReopened(incident, event) {
    await this._postRoundTrip(incident, `:arrows_counterclockwise: Reopened by ${event.actorName || 'unknown'}${event.payload?.note ? ` — ${event.payload.note}` : ''}`);
  }

  async onIncidentAssigned(incident, event) {
    const assigneeName = event.payload?.assigneeName || event.payload?.assigneeUserId || 'nobody';
    await this._postRoundTrip(incident, `:bust_in_silhouette: Assigned to ${assigneeName}`);
    // DM the assignee if we have a Slack ID
    if (this.slack && this.slack.isConfigured() && event.payload?.assigneeSlackId) {
      const url = nectarIncidentUrl(incident.id);
      const text = `You've been assigned to incident: *${incident.summary}*\n${url}`;
      await this.slack.dmUser(event.payload.assigneeSlackId, text).catch(err =>
        log.warn(`AlertRouter: assignee DM failed: ${err.message}`)
      );
    }
  }

  async onIncidentNoteAdded(incident, event) {
    const noteText = event.payload?.text || '';
    if (!noteText) return;
    await this._postRoundTrip(incident, `:memo: Note from ${event.actorName || 'unknown'}: ${noteText}`);
  }

  async _postRoundTrip(incident, text) {
    if (!this.slack || !this.slack.isConfigured()) return;
    if (!Array.isArray(incident.slackPosts)) return;
    for (const { channel, ts } of incident.slackPosts) {
      await this.slack.postReply({ channel, ts, text }).catch(err =>
        log.warn(`AlertRouter: round-trip reply failed for ${channel}: ${err.message}`)
      );
    }
  }

  // ══════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════

  async _postAlert({ rule, channels, text, threadTs = null }) {
    if (!this.slack || !this.slack.isConfigured()) {
      return channels.map(c => ({ channel: c, ok: false, error: 'Slack not connected' }));
    }
    return this.slack.postAlert({
      channels,
      text,
      mention: rule.mention || null,
      threadTs,
    });
  }

  /** Respects NotificationSettings master toggle and child toggle. */
  _groupEnabled(childKey) {
    if (!this.settings) return true;
    return !!this.settings.get(childKey);
  }

  _renderUnhealthyText({ rule, incident, context }) {
    const icon = SEVERITY_ICONS[incident.severity] || ':rotating_light:';
    const lines = [
      `${icon} *${incident.summary}*`,
      `Environment: *${context.envName || context.envId}*` + (context.envTier ? ` (${context.envTier})` : ''),
    ];
    if (context.version) lines.push(`Version: \`${context.version}\``);
    if (context.components && context.components.length > 0) {
      lines.push(`Failing: ${context.components.map(c => `\`${c}\``).join(', ')}`);
    }
    lines.push(`<${nectarIncidentUrl(incident.id)}|View incident in Nectar>`);
    return lines.join('\n');
  }

  _renderRecoveryText({ incident, context }) {
    return `:white_check_mark: *Recovered* — ${context.envName || context.envId} is healthy again. (Auto-resolved incident)`;
  }

  // ── alert_state CRUD (internal) ────────────────────────

  _loadState(key) {
    const row = this.db.prepare('SELECT * FROM alert_state WHERE key = ?').get(key);
    if (!row) return null;
    return {
      key: row.key,
      status: row.status,
      failingComponents: safeParse(row.failingComponents, []),
      firstFailedAt: row.firstFailedAt,
      lastAlertedAt: row.lastAlertedAt,
      consecutiveCount: row.consecutiveCount || 0,
      incidentId: row.incidentId,
      escalated: !!row.escalated,
      updatedAt: row.updatedAt,
    };
  }

  _saveState(state) {
    // Preserve lastFiredStatus if present in prev state — we don't write
    // it directly; _markFired handles that. Here we just upsert the
    // observation-tracking fields.
    const existing = this.db.prepare('SELECT lastAlertedAt, incidentId FROM alert_state WHERE key = ?').get(state.key);
    this.db.prepare(`
      INSERT INTO alert_state (key, status, failingComponents, firstFailedAt, lastAlertedAt, consecutiveCount, incidentId, escalated, updatedAt)
      VALUES (@key, @status, @failingComponents, @firstFailedAt, @lastAlertedAt, @consecutiveCount, @incidentId, @escalated, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        status = excluded.status,
        failingComponents = excluded.failingComponents,
        firstFailedAt = CASE WHEN excluded.firstFailedAt IS NULL THEN NULL ELSE COALESCE(alert_state.firstFailedAt, excluded.firstFailedAt) END,
        consecutiveCount = excluded.consecutiveCount,
        incidentId = excluded.incidentId,
        escalated = excluded.escalated,
        updatedAt = excluded.updatedAt
    `).run({
      key: state.key,
      status: state.status || null,
      failingComponents: JSON.stringify(state.failingComponents || []),
      firstFailedAt: state.firstFailedAt || null,
      lastAlertedAt: state.lastAlertedAt || existing?.lastAlertedAt || null,
      consecutiveCount: state.consecutiveCount || 0,
      incidentId: state.incidentId || existing?.incidentId || null,
      escalated: state.escalated ? 1 : 0,
      updatedAt: state.updatedAt,
    });
  }

  _patchState(key, patch) {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const set = cols.map(c => {
      if (c === 'failingComponents') return `failingComponents = @failingComponents_json`;
      return `${c} = @${c}`;
    }).join(', ');
    const params = { key };
    for (const c of cols) {
      if (c === 'failingComponents') params.failingComponents_json = JSON.stringify(patch[c] || []);
      else if (c === 'escalated') params[c] = patch[c] ? 1 : 0;
      else params[c] = patch[c];
    }
    // Ensure row exists (if not, create minimal row)
    const exists = this.db.prepare('SELECT 1 FROM alert_state WHERE key = ?').get(key);
    if (!exists) {
      this.db.prepare(`
        INSERT INTO alert_state (key, consecutiveCount, escalated, updatedAt)
        VALUES (?, 0, 0, ?)
      `).run(key, new Date(this.now()).toISOString());
    }
    this.db.prepare(`UPDATE alert_state SET ${set} WHERE key = @key`).run(params);
  }

  /**
   * Record that we fired for this state on this poll. Since firing
   * only happens when consecutiveCount === flapThreshold (exactly),
   * we don't need a separate lastFiredStatus column.
   */
  _markFired(key, status, atIso, incidentId) {
    this.db.prepare(`
      UPDATE alert_state SET
        lastAlertedAt = ?,
        incidentId = COALESCE(?, incidentId),
        updatedAt = ?
      WHERE key = ?
    `).run(atIso, incidentId, atIso, key);
  }
}

function pickHighestSeverity(severities) {
  const order = { critical: 3, warning: 2, info: 1 };
  let best = 'info';
  let bestRank = 0;
  for (const s of severities) {
    const r = order[s] || 0;
    if (r > bestRank) { best = s; bestRank = r; }
  }
  return best;
}

function defaultSummary(opts) {
  switch (opts.triggerType) {
    case 'deploy-failed':
      return opts.envId
        ? `Deploy failed on ${opts.envId}`
        : 'Deploy failed';
    case 'feature-flag-changed':
      return opts.envId
        ? `Feature flag changed on ${opts.envId}`
        : 'Feature flag changed';
    case 'upgrade-failed':
      return opts.envId
        ? `Upgrade failed on ${opts.envId}`
        : 'Upgrade failed';
    default:
      return `${opts.triggerType} event`;
  }
}

function buildUnhealthySummary(ctx) {
  const parts = [`${ctx.envName || ctx.envId} is unhealthy`];
  if (ctx.components && ctx.components.length > 0) {
    parts.push(`— ${ctx.components.join(', ')} failing`);
  }
  return parts.join(' ');
}

function nectarIncidentUrl(incidentId) {
  const base = process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com';
  return `${base}/incidents/${incidentId}`;
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = AlertRouter;
module.exports.DEFAULT_FLAP_THRESHOLD = DEFAULT_FLAP_THRESHOLD;
