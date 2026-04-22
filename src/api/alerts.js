const { Router } = require('express');
const log = require('../core/log');
const { listTriggers } = require('../core/alert-triggers');

/**
 * Create the /alerts router.
 *
 * @param {object} services
 * @param {import('../core/alert-rule-store')} services.alertRules
 * @param {import('../core/incident-store')} services.incidents
 * @param {import('../integrations/slack')} services.slack
 * @param {object} [services.alertRouter] - optional AlertRouter for test-firing rules (M2+)
 */
function createAlertsRouter(services) {
  const { alertRules, incidents, slack, alertRouter } = services;
  const router = Router();

  const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  // ── Trigger catalog ────────────────────────────────────
  router.get('/triggers', (req, res) => {
    res.json({ triggers: listTriggers() });
  });

  // ── Channel validation ─────────────────────────────────
  router.post('/validate-channel', asyncHandler(async (req, res) => {
    const { channel } = req.body || {};
    if (!channel) return res.status(400).json({ ok: false, error: 'channel is required', code: 'empty' });
    if (!slack || !slack.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'Slack is not connected', code: 'not_connected' });
    }
    const result = await slack.validateChannel(channel);
    res.json(result);
  }));

  // ── Rules CRUD ─────────────────────────────────────────
  router.get('/rules', (req, res) => {
    const { triggerType, enabled } = req.query;
    const filter = {};
    if (triggerType) filter.triggerType = triggerType;
    if (enabled !== undefined) filter.enabled = enabled === 'true' || enabled === '1';
    res.json({ rules: alertRules.list(filter) });
  });

  router.get('/rules/:id', (req, res) => {
    const rule = alertRules.get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'rule not found' });
    res.json(rule);
  });

  router.post('/rules', asyncHandler(async (req, res) => {
    const body = req.body || {};

    // If user supplied channels and Slack is live, validate each one
    // before creating. This is the same check the UI does on blur but
    // we enforce it server-side too so API clients can't bypass.
    if (slack && slack.isConfigured() && Array.isArray(body.channels) && body.channels.length > 0) {
      for (const channel of body.channels) {
        const result = await slack.validateChannel(channel);
        if (!result.ok) {
          return res.status(400).json({
            error: `Channel ${channel} validation failed: ${result.error}`,
            code: result.code,
            channel,
          });
        }
      }
    }

    try {
      const rule = alertRules.create(body);
      res.status(201).json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  router.patch('/rules/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};

    // Only re-validate channels if they're actually being changed
    if (
      slack && slack.isConfigured() &&
      Array.isArray(body.channels) && body.channels.length > 0
    ) {
      for (const channel of body.channels) {
        const result = await slack.validateChannel(channel);
        if (!result.ok) {
          return res.status(400).json({
            error: `Channel ${channel} validation failed: ${result.error}`,
            code: result.code,
            channel,
          });
        }
      }
    }

    try {
      const rule = alertRules.update(id, body);
      if (!rule) return res.status(404).json({ error: 'rule not found' });
      res.json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  router.delete('/rules/:id', (req, res) => {
    const ok = alertRules.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'rule not found' });
    res.status(204).end();
  });

  // ── Test a rule ────────────────────────────────────────
  // Fires a synthetic Slack alert so the user can confirm routing
  // without waiting for a real event. Intentionally does NOT open an
  // incident — we don't want Test clicks cluttering the incidents
  // list. The rule's lastFiredAt is bumped so the UI reflects the test.
  router.post('/rules/:id/test', asyncHandler(async (req, res) => {
    const rule = alertRules.get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'rule not found' });
    if (!slack || !slack.isConfigured()) {
      return res.status(503).json({ error: 'Slack is not connected' });
    }

    const text = `🧪 *Test alert* — rule "${rule.name}" (${rule.triggerType})\n` +
      `This is a manual test. No real event occurred.`;
    const posts = await slack.postAlert({
      channels: rule.channels,
      mention: rule.mention,
      text,
    });

    const failed = posts.filter(p => !p.ok);
    if (failed.length === rule.channels.length) {
      return res.status(502).json({
        error: 'All channels failed',
        results: posts,
      });
    }

    alertRules.recordFired(rule.id);
    res.json({ ok: true, results: posts });
  }));

  // ── Incidents ──────────────────────────────────────────

  router.get('/incidents', (req, res) => {
    const { status, customerId, envId, severity, assigneeUserId, triggerType, since, limit, active } = req.query;
    const filter = {};
    if (active === 'true' || active === '1') {
      filter.status = ['open', 'acknowledged', 'reopened'];
    } else if (status) {
      filter.status = status.includes(',') ? status.split(',').map(s => s.trim()) : status;
    }
    if (customerId) filter.customerId = customerId;
    if (envId) filter.envId = envId;
    if (severity) filter.severity = severity;
    if (assigneeUserId) filter.assigneeUserId = assigneeUserId;
    if (triggerType) filter.triggerType = triggerType;
    if (since) filter.since = since;
    if (limit) filter.limit = parseInt(limit, 10);
    res.json({ incidents: incidents.list(filter) });
  });

  router.get('/incidents/counts', (req, res) => {
    res.json(incidents.counts());
  });

  router.get('/incidents/:id', (req, res) => {
    const full = incidents.getWithEvents(req.params.id);
    if (!full) return res.status(404).json({ error: 'incident not found' });
    res.json(full);
  });

  router.post('/incidents', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const summary = (body.summary || '').trim();
    if (!summary) return res.status(400).json({ error: 'summary is required' });

    const actor = getActor(req);
    try {
      const incident = incidents.open({
        summary,
        description: body.description || null,
        triggerType: body.triggerType || 'manual',
        source: 'manual',
        customerId: body.customerId || null,
        envId: body.envId || null,
        subjectKey: body.subjectKey || null,
        severity: body.severity || 'warning',
        assigneeUserId: body.assigneeUserId || null,
        assigneeSlackId: body.assigneeSlackId || null,
        payload: body.payload || {},
        actorUserId: actor.userId,
        actorName: actor.name,
      });

      // Optional: broadcast to Slack channel if provided
      if (body.slackChannel && slack && slack.isConfigured()) {
        const posts = await slack.postAlert({
          channels: [body.slackChannel],
          text: `:rotating_light: *${incident.summary}* (manual incident)` +
            (incident.description ? `\n${incident.description}` : ''),
          mention: body.mention || null,
        });
        for (const p of posts) {
          if (p.ok && p.ts) {
            incidents.trackSlackPost(incident.id, { channel: p.channel, ts: p.ts });
          }
        }
      }
      res.status(201).json(incidents.get(incident.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  router.post('/incidents/:id/acknowledge', (req, res) => {
    const actor = getActor(req);
    try {
      const incident = incidents.acknowledge(req.params.id, {
        actorUserId: actor.userId,
        actorName: actor.name,
        note: (req.body && req.body.note) || null,
      });
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      res.json(incident);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/incidents/:id/resolve', (req, res) => {
    const actor = getActor(req);
    const incident = incidents.resolve(req.params.id, {
      actorUserId: actor.userId,
      actorName: actor.name,
      resolution: 'manual',
      note: (req.body && req.body.note) || null,
    });
    if (!incident) return res.status(404).json({ error: 'incident not found' });
    res.json(incident);
  });

  router.post('/incidents/:id/reopen', (req, res) => {
    const actor = getActor(req);
    const incident = incidents.reopen(req.params.id, {
      actorUserId: actor.userId,
      actorName: actor.name,
      note: (req.body && req.body.note) || null,
    });
    if (!incident) return res.status(404).json({ error: 'incident not found' });
    res.json(incident);
  });

  router.post('/incidents/:id/note', (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });
    const actor = getActor(req);
    try {
      const incident = incidents.addNote(req.params.id, {
        text,
        actorUserId: actor.userId,
        actorName: actor.name,
      });
      if (!incident) return res.status(404).json({ error: 'incident not found' });
      res.json(incident);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/incidents/:id/assign', (req, res) => {
    const body = req.body || {};
    const actor = getActor(req);
    const incident = incidents.assign(req.params.id, {
      assigneeUserId: body.assigneeUserId || null,
      assigneeSlackId: body.assigneeSlackId || null,
      assigneeName: body.assigneeName || null,
      actorUserId: actor.userId,
      actorName: actor.name,
    });
    if (!incident) return res.status(404).json({ error: 'incident not found' });
    res.json(incident);
  });

  router.patch('/incidents/:id', (req, res) => {
    const body = req.body || {};
    const actor = getActor(req);
    const incident = incidents.get(req.params.id);
    if (!incident) return res.status(404).json({ error: 'incident not found' });

    try {
      let updated = incident;
      if (body.severity && body.severity !== incident.severity) {
        updated = incidents.updateSeverity(req.params.id, {
          severity: body.severity,
          actorUserId: actor.userId,
          actorName: actor.name,
        }) || updated;
      }
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Extract the acting user from the request. The auth middleware
 * populates req.user; fall back to 'anonymous' so unauthenticated API
 * callers still produce an audit entry.
 */
function getActor(req) {
  const user = req.user || {};
  return {
    userId: user.email || user.id || null,
    name: user.name || user.email || 'anonymous',
  };
}

module.exports = createAlertsRouter;
