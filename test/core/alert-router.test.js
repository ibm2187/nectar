import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const AlertRuleStore = require('../../src/core/alert-rule-store');
const IncidentStore = require('../../src/core/incident-store');
const AlertRouter = require('../../src/core/alert-router');

/**
 * Build a router with a fake Slack client whose post results can be
 * inspected by tests.
 */
function setup({ flapThreshold = 2, settingsGet = null } = {}) {
  const db = createTestDb();
  const alertRules = new AlertRuleStore({ db });
  const incidents = new IncidentStore({ db });

  const posts = []; // capture of all postAlert calls
  const replies = []; // capture of all postReply calls
  const dms = [];

  const slack = {
    isConfigured: () => true,
    postAlert: vi.fn(async ({ channels, text, mention, threadTs }) => {
      posts.push({ channels, text, mention, threadTs });
      return channels.map((c, i) => ({
        channel: c, ok: true, ts: `${Date.now()}.${i}`,
      }));
    }),
    postReply: vi.fn(async ({ channel, ts, text }) => {
      replies.push({ channel, ts, text });
      return { ok: true, ts: `${Date.now()}` };
    }),
    dmUser: vi.fn(async (userId, text) => { dms.push({ userId, text }); }),
  };

  let timeMs = Date.parse('2026-04-22T08:00:00Z');
  const now = () => timeMs;
  const advanceMs = (ms) => { timeMs += ms; };
  const advanceMinutes = (min) => advanceMs(min * 60 * 1000);

  const notificationSettings = settingsGet
    ? { get: settingsGet }
    : { get: () => true };

  const router = new AlertRouter({
    alertRules, incidents, slack,
    notificationSettings,
    db, flapThreshold, now,
  });

  return { db, alertRules, incidents, slack, router, posts, replies, dms, advanceMs, advanceMinutes };
}

// ══════════════════════════════════════════════════════════════
// Flap guard
// ══════════════════════════════════════════════════════════════

describe('AlertRouter flap guard', () => {
  it('does not fire on the first unhealthy observation (pre-stable)', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({
      name: 'any', triggerType: 'env-unhealthy', channels: ['#a'],
    });

    const result = await router.observeEnvHealth({
      envId: 'env-1', envName: 'bayada-prod', customerId: 'bayada', envTier: 'production',
      status: 'unhealthy', failingComponents: ['Cache'],
    });

    expect(result.transition).toBeNull();
    expect(slack.postAlert).not.toHaveBeenCalled();
  });

  it('fires on the second consecutive unhealthy observation (stable)', async () => {
    const { alertRules, router, slack, incidents } = setup();
    alertRules.create({
      name: 'any', triggerType: 'env-unhealthy', channels: ['#a'],
    });

    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    const result = await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    expect(result.transition).toBe('env-unhealthy');
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    expect(incidents.list({ status: 'open' })).toHaveLength(1);
  });

  it('does not fire on subsequent polls past the flap threshold', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({ name: 'any', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Poll 1-5 all unhealthy
    for (let i = 0; i < 5; i++) {
      await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    }

    // Only the exact threshold poll (count=2) fires
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });

  it('suppresses single-poll blips (healthy → unhealthy → healthy)', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({ name: 'any', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Build up baseline
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    // Single-poll blip
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    // Immediate recovery — no alert
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });

    expect(slack.postAlert).not.toHaveBeenCalled();
  });

  it('respects a custom flap threshold', async () => {
    const { alertRules, router, slack } = setup({ flapThreshold: 3 });
    alertRules.create({ name: 'any', triggerType: 'env-unhealthy', channels: ['#a'] });

    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).not.toHaveBeenCalled(); // count=2 < 3

    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).toHaveBeenCalledTimes(1); // count=3 === 3
  });

  it('flapThreshold=1 fires on the very first observation', async () => {
    const { alertRules, router, slack } = setup({ flapThreshold: 1 });
    alertRules.create({ name: 'any', triggerType: 'env-unhealthy', channels: ['#a'] });

    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// Rule matching + incident creation
// ══════════════════════════════════════════════════════════════

describe('AlertRouter rule matching', () => {
  async function fireStable(router, obs) {
    // Fire by reaching flap threshold (default 2) with identical obs
    await router.observeEnvHealth(obs);
    return router.observeEnvHealth(obs);
  }

  it('opens an incident with severity matching the highest rule', async () => {
    const { alertRules, router, incidents } = setup();
    alertRules.create({
      name: 'warn', triggerType: 'env-unhealthy', channels: ['#a'], severity: 'warning',
    });
    alertRules.create({
      name: 'crit', triggerType: 'env-unhealthy', channels: ['#b'], severity: 'critical',
    });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    const open = incidents.list({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe('critical');
  });

  it('does not fire when no rules match', async () => {
    const { alertRules, router, slack, incidents } = setup();
    alertRules.create({
      name: 'bayada-only', triggerType: 'env-unhealthy', channels: ['#a'],
      filter: { customerIds: ['bayada'] },
    });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'ck', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).not.toHaveBeenCalled();
    expect(incidents.list()).toHaveLength(0);
  });

  it('posts to all matching rules (multi-channel fan-out)', async () => {
    const { alertRules, router, slack, posts } = setup();
    alertRules.create({
      name: 'a', triggerType: 'env-unhealthy', channels: ['#chan-a'],
    });
    alertRules.create({
      name: 'b', triggerType: 'env-unhealthy', channels: ['#chan-b', '#chan-c'],
    });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    // Two rules → two postAlert calls
    expect(slack.postAlert).toHaveBeenCalledTimes(2);
    const allChannels = posts.flatMap(p => p.channels);
    expect(allChannels).toEqual(expect.arrayContaining(['#chan-a', '#chan-b', '#chan-c']));
  });

  it('applies each rule\'s mention independently', async () => {
    const { alertRules, router, posts } = setup();
    alertRules.create({
      name: 'with-mention', triggerType: 'env-unhealthy', channels: ['#a'], mention: '@here',
    });
    alertRules.create({
      name: 'no-mention', triggerType: 'env-unhealthy', channels: ['#b'],
    });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    const mentionMap = new Map(posts.map(p => [p.channels[0], p.mention]));
    expect(mentionMap.get('#a')).toBe('@here');
    expect(mentionMap.get('#b')).toBeNull();
  });

  it('customer filter excludes non-matching customers', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({
      name: 'bayada', triggerType: 'env-unhealthy', channels: ['#a'],
      filter: { customerIds: ['bayada'] },
    });
    alertRules.create({
      name: 'ck', triggerType: 'env-unhealthy', channels: ['#b'],
      filter: { customerIds: ['ck'] },
    });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'bayada', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    expect(slack.postAlert.mock.calls[0][0].channels).toEqual(['#a']);
  });

  it('component filter excludes envs whose failing components do not intersect', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({
      name: 'cache-only', triggerType: 'env-unhealthy', channels: ['#a'],
      filter: { components: ['Cache'] },
    });

    // Only Database is failing — cache filter doesn't match
    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Database'] });
    expect(slack.postAlert).not.toHaveBeenCalled();

    // Now failing Cache — matches
    await fireStable(router, { envId: 'e2', envName: 'e2', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });

  it('disabled rules are ignored', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({
      name: 'off', triggerType: 'env-unhealthy', channels: ['#a'], enabled: false,
    });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).not.toHaveBeenCalled();
  });

  it('tracks Slack ts on the incident for threading', async () => {
    const { alertRules, router, incidents, slack } = setup();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a', '#b'] });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    const open = incidents.list({ status: 'open' })[0];
    expect(open.slackPosts).toHaveLength(2);
    expect(open.slackPosts[0].channel).toBe('#a');
    expect(open.slackTs).toBeTruthy();
  });

  it('updates rule.lastFiredAt after successful post', async () => {
    const { alertRules, router } = setup();
    const rule = alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
    expect(rule.lastFiredAt).toBeNull();

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    const fresh = alertRules.get(rule.id);
    expect(fresh.lastFiredAt).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════
// Dedup
// ══════════════════════════════════════════════════════════════

describe('AlertRouter dedup', () => {
  it('repeated observations update the incident record but do not re-post', async () => {
    const { alertRules, router, slack, incidents } = setup();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Poll 1+2: fires
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).toHaveBeenCalledTimes(1);

    // Poll 3, 4, 5: still unhealthy — should not re-post
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(slack.postAlert).toHaveBeenCalledTimes(1);

    expect(incidents.list({ status: 'open' })).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// Recovery
// ══════════════════════════════════════════════════════════════

describe('AlertRouter recovery', () => {
  it('auto-resolves incident and threads recovery reply when env becomes healthy', async () => {
    const { alertRules, router, slack, incidents, replies } = setup();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Unhealthy stable — fires
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    const openInc = incidents.list({ status: 'open' })[0];
    expect(openInc).toBeTruthy();
    const anchorTs = openInc.slackTs;

    // Healthy stable — recovers
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });

    expect(slack.postReply).toHaveBeenCalledTimes(1);
    expect(replies[0].ts).toBe(anchorTs);
    expect(replies[0].text).toMatch(/Recovered/i);

    const resolved = incidents.get(openInc.id);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('auto');
  });

  it('noop recovery when no active incident exists', async () => {
    const { alertRules, router, slack } = setup();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Start healthy, stay healthy — should not alert or reply
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    expect(slack.postAlert).not.toHaveBeenCalled();
    expect(slack.postReply).not.toHaveBeenCalled();
  });

  it('healthy → unhealthy → healthy → unhealthy fires two incidents', async () => {
    const { alertRules, router, incidents } = setup();
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });

    for (let i = 0; i < 2; i++) {
      await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    }
    for (let i = 0; i < 2; i++) {
      await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    }
    for (let i = 0; i < 2; i++) {
      await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    }

    const all = incidents.list();
    expect(all).toHaveLength(2);
    expect(all.filter(i => i.status === 'resolved')).toHaveLength(1);
    expect(all.filter(i => i.status === 'open')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// Sustained trigger
// ══════════════════════════════════════════════════════════════

describe('AlertRouter sustained', () => {
  async function fireStable(router, obs) {
    await router.observeEnvHealth(obs);
    return router.observeEnvHealth(obs);
  }

  // We pass firstFailedAt explicitly so the sustained calc uses mocked
  // time consistently — incident.openedAt uses real Date, which would
  // skew the age computation against the mocked router.now().
  const BASELINE_ISO = '2026-04-22T08:00:00Z';

  it('fires when active unhealthy env exceeds sustainedMinutes threshold', async () => {
    const { alertRules, router, incidents, slack, advanceMinutes } = setup();
    alertRules.create({
      name: 'sustained-15',
      triggerType: 'env-degraded-sustained',
      channels: ['#a'],
      filter: { sustainedMinutes: 15 },
    });
    alertRules.create({ name: 'unh', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Fire unhealthy — creates an incident
    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(incidents.list({ status: 'open' })).toHaveLength(1);

    const callsBefore = slack.postAlert.mock.calls.length;

    // Advance router time past threshold. 20min > 15min threshold.
    advanceMinutes(20);

    await router.checkSustained([{
      envId: 'e1', envName: 'e1', customerId: 'c1', envTier: 'production',
      components: ['Cache'],
      firstFailedAt: BASELINE_ISO,
    }]);

    expect(slack.postAlert).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it('does not fire sustained before the threshold', async () => {
    const { alertRules, router, slack, advanceMinutes } = setup();
    alertRules.create({
      name: 'sustained-15',
      triggerType: 'env-degraded-sustained',
      channels: ['#a'],
      filter: { sustainedMinutes: 15 },
    });
    alertRules.create({ name: 'unh', triggerType: 'env-unhealthy', channels: ['#a'] });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    const callsBefore = slack.postAlert.mock.calls.length;

    advanceMinutes(10); // below 15

    await router.checkSustained([{
      envId: 'e1', envName: 'e1', customerId: 'c1', envTier: 'production',
      components: ['Cache'],
      firstFailedAt: BASELINE_ISO,
    }]);

    expect(slack.postAlert).toHaveBeenCalledTimes(callsBefore);
  });

  it('only fires sustained once per streak', async () => {
    const { alertRules, router, slack, advanceMinutes } = setup();
    alertRules.create({
      name: 'sustained-15',
      triggerType: 'env-degraded-sustained',
      channels: ['#a'],
      filter: { sustainedMinutes: 15 },
    });
    alertRules.create({ name: 'unh', triggerType: 'env-unhealthy', channels: ['#a'] });

    await fireStable(router, { envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    advanceMinutes(20);
    await router.checkSustained([{
      envId: 'e1', envName: 'e1', customerId: 'c1', envTier: 'production',
      components: ['Cache'],
      firstFailedAt: BASELINE_ISO,
    }]);

    const firstFire = slack.postAlert.mock.calls.length;

    advanceMinutes(30); // still unhealthy, even longer
    await router.checkSustained([{
      envId: 'e1', envName: 'e1', customerId: 'c1', envTier: 'production',
      components: ['Cache'],
      firstFailedAt: BASELINE_ISO,
    }]);

    expect(slack.postAlert.mock.calls.length).toBe(firstFire); // no additional fires
  });
});

// ══════════════════════════════════════════════════════════════
// Master toggle respect
// ══════════════════════════════════════════════════════════════

describe('AlertRouter respects NotificationSettings', () => {
  it('does not post when envUnhealthy toggle is off', async () => {
    const { alertRules, router, slack, incidents } = setup({
      settingsGet: (key) => key !== 'envUnhealthy',
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });

    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });

    expect(slack.postAlert).not.toHaveBeenCalled();
    expect(incidents.list()).toHaveLength(0);
  });

  it('does not post recovery reply when envRecovered toggle is off', async () => {
    // Recovery is suppressed, but the incident still auto-resolves so
    // the state machine stays clean for the next unhealthy streak.
    let envRecoveredOn = true;
    const { alertRules, router, slack, incidents } = setup({
      settingsGet: (key) => {
        if (key === 'envRecovered') return envRecoveredOn;
        return true;
      },
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });

    // Open an incident
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    expect(incidents.list({ status: 'open' })).toHaveLength(1);

    // Flip toggle off, then env recovers
    envRecoveredOn = false;
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });
    await router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'healthy' });

    // No recovery reply was posted
    expect(slack.postReply).not.toHaveBeenCalled();
    // Incident stays open (admin can close manually)
    expect(incidents.list({ status: 'open' })).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// Incident round-trip (Nectar → Slack thread replies)
// ══════════════════════════════════════════════════════════════

describe('AlertRouter incident round-trip', () => {
  async function setupWithIncident() {
    const ctx = setup();
    ctx.alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#a'] });
    // Fire to get a real incident with slackPosts tracked
    await ctx.router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    await ctx.router.observeEnvHealth({ envId: 'e1', envName: 'e1', customerId: 'c1', status: 'unhealthy', failingComponents: ['Cache'] });
    const incident = ctx.incidents.list({ status: 'open' })[0];
    return { ...ctx, incident };
  }

  it('onIncidentAcknowledged posts threaded reply', async () => {
    const { incidents, router, slack, incident } = await setupWithIncident();
    const acked = incidents.acknowledge(incident.id, { actorName: 'Nukul', note: 'on it' });
    const events = incidents.listEvents(incident.id);
    const ackEvent = events.find(e => e.type === 'acknowledged');

    const callsBefore = slack.postReply.mock.calls.length;
    await router.onIncidentAcknowledged(acked, ackEvent);
    expect(slack.postReply).toHaveBeenCalledTimes(callsBefore + 1);
    expect(slack.postReply.mock.calls[callsBefore][0].text).toMatch(/Acknowledged by Nukul/);
    expect(slack.postReply.mock.calls[callsBefore][0].text).toMatch(/on it/);
  });

  it('onIncidentResolved (manual) posts threaded reply', async () => {
    const { incidents, router, slack, incident } = await setupWithIncident();
    const resolved = incidents.resolve(incident.id, { actorName: 'Nukul', resolution: 'manual' });
    const events = incidents.listEvents(incident.id);
    const resEvent = events.find(e => e.type === 'resolved');

    const callsBefore = slack.postReply.mock.calls.length;
    await router.onIncidentResolved(resolved, resEvent);
    expect(slack.postReply).toHaveBeenCalledTimes(callsBefore + 1);
    expect(slack.postReply.mock.calls[callsBefore][0].text).toMatch(/Resolved by Nukul/);
  });

  it('onIncidentResolved skips reply when resolution=auto (already threaded by recovery)', async () => {
    const { incidents, router, slack, incident } = await setupWithIncident();
    const resolved = incidents.resolve(incident.id, { resolution: 'auto' });
    const events = incidents.listEvents(incident.id);
    const resEvent = events.find(e => e.type === 'resolved');

    const callsBefore = slack.postReply.mock.calls.length;
    await router.onIncidentResolved(resolved, resEvent);
    expect(slack.postReply).toHaveBeenCalledTimes(callsBefore);
  });

  it('onIncidentAssigned posts reply and DMs assignee with Slack ID', async () => {
    const { incidents, router, slack, incident, dms } = await setupWithIncident();
    const assigned = incidents.assign(incident.id, {
      assigneeUserId: 'nukul@viv',
      assigneeSlackId: 'U12345',
      assigneeName: 'Nukul',
      actorName: 'admin',
    });
    const events = incidents.listEvents(incident.id);
    const assignEvent = events.find(e => e.type === 'assigned');

    const replyCallsBefore = slack.postReply.mock.calls.length;
    await router.onIncidentAssigned(assigned, assignEvent);
    expect(slack.postReply).toHaveBeenCalledTimes(replyCallsBefore + 1);
    expect(dms).toHaveLength(1);
    expect(dms[0].userId).toBe('U12345');
  });

  it('onIncidentNoteAdded posts threaded reply', async () => {
    const { incidents, router, slack, incident } = await setupWithIncident();
    const noted = incidents.addNote(incident.id, { text: 'redis restart queued', actorName: 'Nukul' });
    const events = incidents.listEvents(incident.id);
    const noteEvent = events.find(e => e.type === 'note');

    await router.onIncidentNoteAdded(noted, noteEvent);
    expect(slack.postReply).toHaveBeenCalled();
    const lastCall = slack.postReply.mock.calls[slack.postReply.mock.calls.length - 1][0];
    expect(lastCall.text).toMatch(/redis restart queued/);
  });
});

// ══════════════════════════════════════════════════════════════
// Bundle 8: re-open after manual resolve, dispatch-failed events,
// sustained re-arm, evaluate-now
// ══════════════════════════════════════════════════════════════

describe('AlertRouter — re-arm after manual resolve while still unhealthy', () => {
  it('opens a fresh incident within flapThreshold polls of a still-unhealthy env', async () => {
    const { alertRules, router, incidents, slack, posts } = setup();
    alertRules.create({
      id: 'r1', name: 'r1', triggerType: 'env-unhealthy', filter: {},
      channels: ['#alerts'], severity: 'critical', enabled: true,
    });

    const obs = { envId: 'e1', envName: 'E1', customerId: 'c1', envTier: 'production', status: 'unhealthy', failingComponents: ['db'] };
    // Two polls to fire the first incident (flapThreshold=2).
    await router.observeEnvHealth(obs);
    await router.observeEnvHealth(obs);
    expect(posts).toHaveLength(1);
    const inc1 = incidents.findActiveBySubject('env-health:e1');
    expect(inc1).toBeTruthy();

    // User manually resolves while env is still unhealthy.
    incidents.resolve(inc1.id, { actorName: 'nukul', resolution: 'manual' });
    expect(incidents.get(inc1.id).status).toBe('resolved');

    // Steady-state polls would normally just bump the count. With the
    // re-arm fix, the next poll is treated as a transition (count=1).
    posts.length = 0;
    await router.observeEnvHealth(obs); // count=1
    expect(posts).toHaveLength(0);
    await router.observeEnvHealth(obs); // count=2 → fires
    expect(posts).toHaveLength(1);
    const inc2 = incidents.findActiveBySubject('env-health:e1');
    expect(inc2).toBeTruthy();
    expect(inc2.id).not.toBe(inc1.id);
  });
});

describe('AlertRouter — dispatch-failed events surface Slack post failures', () => {
  it('writes a dispatch-failed timeline event when _postAlert returns ok=false', async () => {
    const { alertRules, router, incidents, slack } = setup();
    // Make Slack pretend the bot is not in the channel.
    slack.postAlert.mockImplementation(async ({ channels }) =>
      channels.map(c => ({ channel: c, ok: false, error: 'not_in_channel', code: 'not_in_channel' }))
    );
    alertRules.create({
      id: 'r1', name: 'r1', triggerType: 'env-unhealthy', filter: {},
      channels: ['#alerts'], severity: 'critical', enabled: true,
    });

    const obs = { envId: 'e1', envName: 'E1', customerId: 'c1', envTier: 'production', status: 'unhealthy' };
    await router.observeEnvHealth(obs);
    await router.observeEnvHealth(obs);

    const inc = incidents.findActiveBySubject('env-health:e1');
    const events = incidents.listEvents(inc.id);
    const failure = events.find(e => e.type === 'dispatch-failed');
    expect(failure).toBeTruthy();
    expect(failure.payload.channel).toBe('#alerts');
    expect(failure.payload.code).toBe('not_in_channel');
    // No slackPosts tracked → SlackStatusPanel will render the recovery
    // picker (Bundle 7 path).
    expect(incidents.get(inc.id).slackPosts).toEqual([]);
  });
});

describe('AlertRouter — sustained re-arms after manual resolve', () => {
  it('clears alert_state.escalated when an env-unhealthy incident is manually resolved', async () => {
    const { alertRules, router, incidents, db } = setup();
    alertRules.create({
      id: 'r1', name: 'r1', triggerType: 'env-unhealthy', filter: {},
      channels: ['#alerts'], severity: 'critical', enabled: true,
    });
    const obs = { envId: 'e1', envName: 'E1', customerId: 'c1', envTier: 'production', status: 'unhealthy' };
    await router.observeEnvHealth(obs);
    await router.observeEnvHealth(obs);
    const inc = incidents.findActiveBySubject('env-health:e1');

    // Mark sustained as fired so we can verify the flag clears.
    db.prepare('UPDATE alert_state SET escalated = 1 WHERE key = ?').run('env-health:e1');

    // Manual resolve via incident-store; AlertRouter listens via index.js
    // event hook. We invoke the hook directly here.
    const resolved = incidents.resolve(inc.id, { actorName: 'nukul', resolution: 'manual' });
    const resolvedEvent = incidents.listEvents(inc.id).find(e => e.type === 'resolved');
    await router.onIncidentResolved(resolved, resolvedEvent);

    const state = db.prepare('SELECT escalated FROM alert_state WHERE key = ?').get('env-health:e1');
    expect(state.escalated).toBe(0);
  });
});

describe('AlertRouter.evaluateNow', () => {
  it('force-fires a rule against current alert_state, bypassing the flap guard', async () => {
    const { alertRules, router, incidents, posts } = setup({ flapThreshold: 5 });
    const rule = alertRules.create({
      name: 'r1', triggerType: 'env-unhealthy', filter: {},
      channels: ['#alerts'], severity: 'critical', enabled: true,
    });
    router.setEnvLookup(() => ({ id: 'e1', name: 'E1', customerId: 'c1', tier: 'production' }));

    // One poll only — well below flapThreshold=5 — would normally not fire.
    await router.observeEnvHealth({ envId: 'e1', envName: 'E1', customerId: 'c1', envTier: 'production', status: 'unhealthy' });
    expect(posts).toHaveLength(0);

    const result = await router.evaluateNow(rule.id);
    expect(result.ok).toBe(true);
    expect(result.fired).toBe(1);
    expect(posts).toHaveLength(1);
    expect(incidents.findActiveBySubject('env-health:e1')).toBeTruthy();
  });

  it('rate-limits per rule', async () => {
    const { alertRules, router } = setup();
    const rule = alertRules.create({
      name: 'r1', triggerType: 'env-unhealthy', filter: {},
      channels: ['#alerts'], severity: 'critical', enabled: true,
    });
    router.setEnvLookup(() => null); // no envs to fire on; rate-limit logic still applies

    const first = await router.evaluateNow(rule.id);
    expect(first.ok).toBe(true);
    const second = await router.evaluateNow(rule.id);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('rate-limited');
  });

  it('returns rule not found for unknown ruleId', async () => {
    const { router } = setup();
    const result = await router.evaluateNow('nope');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});
