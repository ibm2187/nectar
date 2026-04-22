import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * End-to-end lifecycle test: one real scenario that exercises the
 * full pipeline (unhealthy → ack → sustained → note → recovery)
 * and asserts the Slack/incident state after each step.
 *
 * This is higher-level than the granular router tests — it's meant
 * to prove the pieces compose correctly.
 */

const { createTestDb } = require('../../src/core/db');
const AlertRuleStore = require('../../src/core/alert-rule-store');
const IncidentStore = require('../../src/core/incident-store');
const AlertRouter = require('../../src/core/alert-router');

function setup() {
  const db = createTestDb();
  const alertRules = new AlertRuleStore({ db });
  const incidents = new IncidentStore({ db });

  const calls = { postAlert: [], postReply: [], dmUser: [] };
  const slack = {
    isConfigured: () => true,
    postAlert: vi.fn(async ({ channels, text, mention, threadTs }) => {
      const results = channels.map((c, i) => ({ channel: c, ok: true, ts: `${Date.now()}.${i}.${calls.postAlert.length}` }));
      calls.postAlert.push({ channels, text, mention, threadTs, results });
      return results;
    }),
    postReply: vi.fn(async (opts) => {
      calls.postReply.push(opts);
      return { ok: true, ts: `${Date.now()}.reply.${calls.postReply.length}` };
    }),
    dmUser: vi.fn(async (userId, text) => { calls.dmUser.push({ userId, text }); }),
  };

  let timeMs = Date.parse('2026-04-22T08:00:00Z');
  const router = new AlertRouter({
    alertRules, incidents, slack,
    notificationSettings: { get: () => true },
    db, flapThreshold: 2,
    now: () => timeMs,
  });

  // Wire incident events → router round-trip (mirrors index.js)
  incidents.on('incident:acknowledged', (inc, ev) => router.onIncidentAcknowledged(inc, ev));
  incidents.on('incident:resolved', (inc, ev) => router.onIncidentResolved(inc, ev));
  incidents.on('incident:reopened', (inc, ev) => router.onIncidentReopened(inc, ev));
  incidents.on('incident:assigned', (inc, ev) => router.onIncidentAssigned(inc, ev));
  incidents.on('incident:note-added', (inc, ev) => router.onIncidentNoteAdded(inc, ev));

  return {
    db, alertRules, incidents, slack, router, calls,
    advanceMinutes: (m) => { timeMs += m * 60 * 1000; },
  };
}

describe('Full alerting lifecycle', () => {
  it('runs unhealthy → ack → sustained → note → recover end-to-end', async () => {
    const { alertRules, incidents, slack, router, calls, advanceMinutes } = setup();

    // Two rules: one for the initial unhealthy alert, one for sustained
    alertRules.create({
      name: 'Prod health',
      triggerType: 'env-unhealthy',
      channels: ['#alerts-prod'],
      mention: '@here',
    });
    alertRules.create({
      name: 'Prod sustained',
      triggerType: 'env-degraded-sustained',
      channels: ['#alerts-prod'],
      filter: { sustainedMinutes: 15 },
    });

    // 1. First unhealthy poll: no alert yet (flap guard at 2)
    await router.observeEnvHealth({
      envId: 'qualitycare-prod', envName: 'Quality Care prod', customerId: 'qualitycare',
      envTier: 'production', status: 'unhealthy', failingComponents: ['Cache'],
    });
    expect(calls.postAlert).toHaveLength(0);
    expect(incidents.list()).toHaveLength(0);

    // 2. Second unhealthy poll: fires alert + opens incident
    await router.observeEnvHealth({
      envId: 'qualitycare-prod', envName: 'Quality Care prod', customerId: 'qualitycare',
      envTier: 'production', status: 'unhealthy', failingComponents: ['Cache'],
    });

    expect(calls.postAlert).toHaveLength(1);
    expect(calls.postAlert[0].channels).toEqual(['#alerts-prod']);
    expect(calls.postAlert[0].mention).toBe('@here');

    const open = incidents.list({ status: 'open' });
    expect(open).toHaveLength(1);
    const incident = open[0];
    expect(incident.summary).toMatch(/unhealthy/);
    expect(incident.slackChannel).toBe('#alerts-prod');
    const originalTs = incident.slackTs;
    expect(originalTs).toBeTruthy();

    // 3. User acknowledges in Nectar → threaded reply in Slack
    incidents.acknowledge(incident.id, { actorName: 'Nukul', note: 'looking now' });
    await new Promise(r => setImmediate(r)); // let event listener fire

    expect(calls.postReply).toHaveLength(1);
    expect(calls.postReply[0].ts).toBe(originalTs);
    expect(calls.postReply[0].text).toMatch(/Acknowledged by Nukul/);
    expect(calls.postReply[0].text).toMatch(/looking now/);

    // 4. Sustained trigger fires after 20 min
    advanceMinutes(20);
    const baselineIso = '2026-04-22T08:00:00Z';
    await router.checkSustained([{
      envId: 'qualitycare-prod', envName: 'Quality Care prod', customerId: 'qualitycare',
      envTier: 'production', components: ['Cache'],
      firstFailedAt: baselineIso,
    }]);

    expect(calls.postAlert).toHaveLength(2); // initial + sustained
    const sustainedPost = calls.postAlert[1];
    expect(sustainedPost.channels).toEqual(['#alerts-prod']);
    // Sustained should thread to the original post since same channel
    expect(sustainedPost.threadTs).toBe(originalTs);
    expect(sustainedPost.text).toMatch(/Still unhealthy/);

    // Repeated sustained check doesn't re-fire
    const alertsBefore = calls.postAlert.length;
    await router.checkSustained([{
      envId: 'qualitycare-prod', envName: 'Quality Care prod', customerId: 'qualitycare',
      envTier: 'production', components: ['Cache'],
      firstFailedAt: baselineIso,
    }]);
    expect(calls.postAlert).toHaveLength(alertsBefore); // no new fires

    // 5. User adds a note → threaded reply
    incidents.addNote(incident.id, { text: 'restarted redis', actorName: 'Nukul' });
    await new Promise(r => setImmediate(r));

    const noteReplies = calls.postReply.filter(r => r.text.includes('restarted redis'));
    expect(noteReplies).toHaveLength(1);
    expect(noteReplies[0].ts).toBe(originalTs);

    // 6. Env recovers → auto-resolves + recovery reply (separate from note reply)
    await router.observeEnvHealth({
      envId: 'qualitycare-prod', envName: 'Quality Care prod', customerId: 'qualitycare',
      envTier: 'production', status: 'healthy',
    });
    await router.observeEnvHealth({
      envId: 'qualitycare-prod', envName: 'Quality Care prod', customerId: 'qualitycare',
      envTier: 'production', status: 'healthy',
    });

    const recoveryReplies = calls.postReply.filter(r => r.text && r.text.match(/Recovered/i));
    expect(recoveryReplies).toHaveLength(1);
    expect(recoveryReplies[0].ts).toBe(originalTs);

    const finalIncident = incidents.get(incident.id);
    expect(finalIncident.status).toBe('resolved');
    expect(finalIncident.resolution).toBe('auto');
    // Ack info preserved even after auto-resolve
    expect(finalIncident.acknowledgedBy).toBe('Nukul');

    // Timeline should contain all expected events in order
    const events = incidents.listEvents(incident.id);
    const types = events.map(e => e.type);
    expect(types).toContain('opened');
    expect(types).toContain('acknowledged');
    expect(types).toContain('sustained');
    expect(types).toContain('note');
    expect(types).toContain('resolved');
  });

  it('assignment DMs the assignee and posts a thread reply', async () => {
    const { alertRules, incidents, slack, router, calls } = setup();

    alertRules.create({ name: 'Prod', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    // Fire to open an incident with a Slack post
    for (let i = 0; i < 2; i++) {
      await router.observeEnvHealth({
        envId: 'e1', envName: 'e1', customerId: 'c1', envTier: 'production',
        status: 'unhealthy', failingComponents: ['Cache'],
      });
    }
    const incident = incidents.list({ status: 'open' })[0];

    incidents.assign(incident.id, {
      assigneeUserId: 'nukul@viv',
      assigneeSlackId: 'U12345',
      assigneeName: 'Nukul',
      actorName: 'admin',
    });
    await new Promise(r => setImmediate(r));

    const assignReplies = calls.postReply.filter(r => r.text.includes('Assigned to Nukul'));
    expect(assignReplies).toHaveLength(1);
    expect(calls.dmUser).toHaveLength(1);
    expect(calls.dmUser[0].userId).toBe('U12345');
    expect(calls.dmUser[0].text).toMatch(/assigned/i);
  });

  it('reopen posts a thread reply and auto-resolve works post-reopen', async () => {
    const { alertRules, incidents, router, calls } = setup();
    alertRules.create({ name: 'Prod', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    for (let i = 0; i < 2; i++) {
      await router.observeEnvHealth({
        envId: 'e1', envName: 'e1', customerId: 'c1', envTier: 'production',
        status: 'unhealthy', failingComponents: ['Cache'],
      });
    }
    const incident = incidents.list({ status: 'open' })[0];

    // Manually resolve
    incidents.resolve(incident.id, { actorName: 'admin', resolution: 'manual' });
    await new Promise(r => setImmediate(r));

    const beforeReopen = calls.postReply.length;

    // Reopen
    incidents.reopen(incident.id, { actorName: 'admin' });
    await new Promise(r => setImmediate(r));

    expect(calls.postReply.length).toBe(beforeReopen + 1);
    expect(calls.postReply[calls.postReply.length - 1].text).toMatch(/Reopened/);
  });
});
