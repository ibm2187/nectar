import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'http';
import express from 'express';

const AlertRuleStore = require('../../src/core/alert-rule-store');
const IncidentStore = require('../../src/core/incident-store');
const createAlertsRouter = require('../../src/api/alerts');
const { createTestDb } = require('../../src/core/db');

/**
 * Build a test app that mounts the alerts router at /api/alerts with
 * a fresh in-memory DB and a fake Slack client. Returns the app plus
 * the service references so tests can inspect state.
 */
function makeApp({ slackReady = true, slackOverrides = {} } = {}) {
  const db = createTestDb();
  const alertRules = new AlertRuleStore({ db });
  const incidents = new IncidentStore({ db });

  const slack = {
    isConfigured: () => slackReady,
    validateChannel: vi.fn(async (channel) => {
      if (!channel) return { ok: false, code: 'empty' };
      if (channel === '#nope') return { ok: false, code: 'channel_not_found', error: 'not found' };
      if (channel === '#not-invited') return { ok: false, code: 'not_in_channel', error: 'Bot not in channel' };
      return { ok: true, inChannel: true, channelId: 'C1', name: channel.replace('#', '') };
    }),
    postAlert: vi.fn(async ({ channels }) => channels.map(c => ({ channel: c, ok: true, ts: '111.222' }))),
    postReply: vi.fn(async () => ({ ok: true, ts: '111.333' })),
    ...slackOverrides,
  };

  const app = express();
  app.use(express.json());
  // Fake auth populates req.user so actor attribution works
  app.use((req, _res, next) => { req.user = { email: 'tester@viv', name: 'Tester' }; next(); });
  app.use('/api/alerts', createAlertsRouter({ alertRules, incidents, slack }));

  return { app, alertRules, incidents, slack, db };
}

function request(app, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const opts = {
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json' },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// ── Triggers ──────────────────────────────────────────────

describe('GET /api/alerts/triggers', () => {
  it('returns the trigger catalog', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/api/alerts/triggers');
    expect(res.status).toBe(200);
    const keys = res.body.triggers.map(t => t.key);
    expect(keys).toContain('env-unhealthy');
    expect(keys).toContain('deploy-failed');
  });

  it('includes filter field schemas', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/api/alerts/triggers');
    const envUnhealthy = res.body.triggers.find(t => t.key === 'env-unhealthy');
    const tierField = envUnhealthy.filterFields.find(f => f.key === 'envTier');
    expect(tierField).toBeDefined();
    expect(tierField.options).toContain('production');
  });
});

// ── Channel validation ────────────────────────────────────

describe('POST /api/alerts/validate-channel', () => {
  it('returns ok for a valid channel', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/validate-channel', { channel: '#alerts-prod' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns not_in_channel error', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/validate-channel', { channel: '#not-invited' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('not_in_channel');
  });

  it('returns 400 when channel missing', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/validate-channel', {});
    expect(res.status).toBe(400);
  });

  it('returns 503 when Slack not connected', async () => {
    const { app } = makeApp({ slackReady: false });
    const res = await request(app, 'POST', '/api/alerts/validate-channel', { channel: '#a' });
    expect(res.status).toBe(503);
  });
});

// ── Rules CRUD ────────────────────────────────────────────

describe('Rules CRUD', () => {
  it('creates a rule after channel validation passes', async () => {
    const { app, alertRules } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/rules', {
      name: 'Prod health',
      triggerType: 'env-unhealthy',
      channels: ['#alerts-prod'],
      filter: { envTier: ['production'] },
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Prod health');
    expect(alertRules.list()).toHaveLength(1);
  });

  it('rejects rule with invalid channel (not_in_channel)', async () => {
    const { app, alertRules } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/rules', {
      name: 'Broken',
      triggerType: 'env-unhealthy',
      channels: ['#not-invited'],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_in_channel');
    expect(alertRules.list()).toHaveLength(0);
  });

  it('rejects rule with unknown trigger type', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/rules', {
      name: 'x',
      triggerType: 'bogus',
      channels: ['#alerts-prod'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown triggerType/);
  });

  it('rejects rule with missing required fields', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/rules', {
      triggerType: 'env-unhealthy',
      channels: ['#a'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it('skips channel validation when Slack is not connected', async () => {
    // If Slack is offline, still allow rule creation (admin can't validate
    // right now, but they can save the rule and test it later)
    const { app } = makeApp({ slackReady: false });
    const res = await request(app, 'POST', '/api/alerts/rules', {
      name: 'x',
      triggerType: 'env-unhealthy',
      channels: ['#a'],
    });
    expect(res.status).toBe(201);
  });

  it('lists all rules', async () => {
    const { app, alertRules } = makeApp();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
    alertRules.create({ name: 'b', triggerType: 'env-recovered', channels: ['#b'] });
    const res = await request(app, 'GET', '/api/alerts/rules');
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(2);
  });

  it('filters rules by triggerType', async () => {
    const { app, alertRules } = makeApp();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
    alertRules.create({ name: 'b', triggerType: 'env-recovered', channels: ['#b'] });
    const res = await request(app, 'GET', '/api/alerts/rules?triggerType=env-unhealthy');
    expect(res.body.rules).toHaveLength(1);
  });

  it('gets a single rule by id', async () => {
    const { app, alertRules } = makeApp();
    const created = alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
    const res = await request(app, 'GET', `/api/alerts/rules/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
  });

  it('returns 404 for missing rule', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/api/alerts/rules/bogus');
    expect(res.status).toBe(404);
  });

  it('patches a rule', async () => {
    const { app, alertRules } = makeApp();
    const created = alertRules.create({ name: 'old', triggerType: 'env-unhealthy', channels: ['#a'] });
    const res = await request(app, 'PATCH', `/api/alerts/rules/${created.id}`, { name: 'new' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('new');
  });

  it('re-validates channel on patch when channels change', async () => {
    const { app, alertRules } = makeApp();
    const created = alertRules.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
    const res = await request(app, 'PATCH', `/api/alerts/rules/${created.id}`, {
      channels: ['#not-invited'],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_in_channel');
  });

  it('rejects PATCH that would leave a rule with zero channels', async () => {
    // A rule with no channels can't post anywhere, which silently breaks
    // the alert. The store validator enforces this on merge.
    const { app, alertRules } = makeApp();
    const created = alertRules.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
    const res = await request(app, 'PATCH', `/api/alerts/rules/${created.id}`, {
      channels: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one channel/);
    // Original rule is untouched
    expect(alertRules.get(created.id).channels).toEqual(['#a']);
  });

  it('deletes a rule', async () => {
    const { app, alertRules } = makeApp();
    const created = alertRules.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
    const res = await request(app, 'DELETE', `/api/alerts/rules/${created.id}`);
    expect(res.status).toBe(204);
    expect(alertRules.get(created.id)).toBeNull();
  });

  it('returns 404 when deleting missing rule', async () => {
    const { app } = makeApp();
    const res = await request(app, 'DELETE', '/api/alerts/rules/bogus');
    expect(res.status).toBe(404);
  });
});

// ── Test a rule (synthetic alert) ─────────────────────────

describe('POST /api/alerts/rules/:id/test', () => {
  it('posts a synthetic alert to each channel', async () => {
    const { app, alertRules, slack } = makeApp();
    const rule = alertRules.create({
      name: 'Prod', triggerType: 'env-unhealthy', channels: ['#a', '#b'],
    });
    const res = await request(app, 'POST', `/api/alerts/rules/${rule.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(slack.postAlert).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['#a', '#b'],
      text: expect.stringContaining('Test alert'),
    }));
  });

  it('returns 404 for unknown rule', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/rules/bogus/test');
    expect(res.status).toBe(404);
  });

  it('returns 502 when all channels fail', async () => {
    const { app, alertRules } = makeApp({
      slackOverrides: {
        postAlert: vi.fn(async ({ channels }) =>
          channels.map(c => ({ channel: c, ok: false, error: 'bad' }))
        ),
      },
    });
    const rule = alertRules.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
    const res = await request(app, 'POST', `/api/alerts/rules/${rule.id}/test`);
    expect(res.status).toBe(502);
  });

  it('records lastFiredAt after successful test', async () => {
    const { app, alertRules } = makeApp();
    const rule = alertRules.create({ name: 'x', triggerType: 'env-unhealthy', channels: ['#a'] });
    expect(rule.lastFiredAt).toBeNull();
    await request(app, 'POST', `/api/alerts/rules/${rule.id}/test`);
    const fresh = alertRules.get(rule.id);
    expect(fresh.lastFiredAt).toBeTruthy();
  });
});

// ── Incidents ─────────────────────────────────────────────

describe('Incidents — list/get/counts', () => {
  it('lists incidents with active filter', async () => {
    const { app, incidents } = makeApp();
    const open = incidents.open({ summary: 'a', triggerType: 'env-unhealthy' });
    const b = incidents.open({ summary: 'b', triggerType: 'env-unhealthy' });
    incidents.resolve(b.id, { actorName: 'x' });

    const res = await request(app, 'GET', '/api/alerts/incidents?active=true');
    expect(res.status).toBe(200);
    expect(res.body.incidents.map(i => i.id)).toEqual([open.id]);
  });

  it('lists with status filter (comma-separated)', async () => {
    const { app, incidents } = makeApp();
    incidents.open({ summary: 'a', triggerType: 'env-unhealthy' });
    const b = incidents.open({ summary: 'b', triggerType: 'env-unhealthy' });
    incidents.acknowledge(b.id, { actorName: 'x' });

    const res = await request(app, 'GET', '/api/alerts/incidents?status=open,acknowledged');
    expect(res.body.incidents).toHaveLength(2);
  });

  it('counts endpoint returns status summary', async () => {
    const { app, incidents } = makeApp();
    incidents.open({ summary: 'a', triggerType: 'env-unhealthy' });
    const b = incidents.open({ summary: 'b', triggerType: 'env-unhealthy' });
    incidents.resolve(b.id, { actorName: 'x' });

    const res = await request(app, 'GET', '/api/alerts/incidents/counts');
    expect(res.body.open).toBe(1);
    expect(res.body.resolved).toBe(1);
    expect(res.body.active).toBe(1);
  });

  it('gets a single incident with events', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    incidents.acknowledge(inc.id, { actorName: 'a' });
    const res = await request(app, 'GET', `/api/alerts/incidents/${inc.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(inc.id);
    expect(res.body.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Incidents — manual creation', () => {
  it('creates a manual incident without Slack broadcast', async () => {
    const { app, incidents, slack } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/incidents', {
      summary: 'Manually reported issue',
      description: 'Customer reported slow page loads',
      customerId: 'bayada',
      envId: 'bayada-prod',
      severity: 'warning',
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('manual');
    expect(res.body.summary).toBe('Manually reported issue');
    expect(slack.postAlert).not.toHaveBeenCalled();
  });

  it('creates a manual incident with Slack broadcast when channel given', async () => {
    const { app, slack } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/incidents', {
      summary: 'Broadcast me',
      slackChannel: '#alerts-prod',
    });
    expect(res.status).toBe(201);
    expect(slack.postAlert).toHaveBeenCalled();
    expect(res.body.slackChannel).toBe('#alerts-prod');
    expect(res.body.slackTs).toBe('111.222');
  });

  it('rejects manual incident without summary', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/incidents', { description: 'no summary' });
    expect(res.status).toBe(400);
  });

  it('records the authenticated user as actor', async () => {
    const { app, incidents } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/incidents', { summary: 's' });
    const full = incidents.getWithEvents(res.body.id);
    const opened = full.events.find(e => e.type === 'opened');
    expect(opened.actorName).toBe('Tester');
    expect(opened.actorUserId).toBe('tester@viv');
  });
});

describe('Incidents — lifecycle actions', () => {
  it('acknowledges', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/acknowledge`, {
      note: 'on it',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('acknowledged');
    expect(res.body.acknowledgedBy).toBe('Tester');
  });

  it('resolves', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.resolution).toBe('manual');
  });

  it('reopens', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    incidents.resolve(inc.id, { actorName: 'x' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/reopen`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reopened');
  });

  it('adds notes', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/note`, {
      text: 'investigating redis',
    });
    expect(res.status).toBe(200);
    const events = incidents.listEvents(inc.id).filter(e => e.type === 'note');
    expect(events).toHaveLength(1);
    expect(events[0].payload.text).toBe('investigating redis');
  });

  it('rejects empty notes', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/note`, { text: '' });
    expect(res.status).toBe(400);
  });

  it('assigns to a user', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/assign`, {
      assigneeUserId: 'nukul@viv',
      assigneeSlackId: 'U1',
      assigneeName: 'Nukul',
    });
    expect(res.status).toBe(200);
    expect(res.body.assigneeUserId).toBe('nukul@viv');
  });

  it('unassigns when assigneeUserId is null', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    incidents.assign(inc.id, { assigneeUserId: 'nukul@viv' });
    const res = await request(app, 'POST', `/api/alerts/incidents/${inc.id}/assign`, {
      assigneeUserId: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.assigneeUserId).toBeNull();
  });

  it('updates severity', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'PATCH', `/api/alerts/incidents/${inc.id}`, {
      severity: 'warning',
    });
    expect(res.status).toBe(200);
    expect(res.body.severity).toBe('warning');
  });

  it('rejects invalid severity', async () => {
    const { app, incidents } = makeApp();
    const inc = incidents.open({ summary: 'x', triggerType: 'env-unhealthy' });
    const res = await request(app, 'PATCH', `/api/alerts/incidents/${inc.id}`, {
      severity: 'fatal',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when acting on missing incident', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/api/alerts/incidents/bogus/acknowledge');
    expect(res.status).toBe(404);
  });
});
