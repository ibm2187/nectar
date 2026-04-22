import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createTestDb } = require('../../src/core/db');
const AlertRuleStore = require('../../src/core/alert-rule-store');
const IncidentStore = require('../../src/core/incident-store');
const AlertRouter = require('../../src/core/alert-router');

function setup() {
  const db = createTestDb();
  const alertRules = new AlertRuleStore({ db });
  const incidents = new IncidentStore({ db });

  const posts = [];
  const slack = {
    isConfigured: () => true,
    postAlert: vi.fn(async ({ channels, text, mention }) => {
      posts.push({ channels, text, mention });
      return channels.map((c, i) => ({ channel: c, ok: true, ts: `t${Date.now()}.${i}` }));
    }),
    postReply: vi.fn(async () => ({ ok: true, ts: 't0' })),
    dmUser: vi.fn(),
  };

  const router = new AlertRouter({
    alertRules, incidents, slack,
    notificationSettings: { get: () => true },
    db,
  });

  return { db, alertRules, incidents, slack, router, posts };
}

describe('AlertRouter.handleTrigger — generic pathway', () => {
  it('rejects unknown trigger types with noMatch', async () => {
    const { router } = setup();
    const res = await router.handleTrigger({ triggerType: 'bogus' });
    expect(res.noMatch).toBe(true);
  });

  it('does nothing when no rules match', async () => {
    const { router, slack, incidents } = setup();
    const res = await router.handleTrigger({
      triggerType: 'deploy-failed',
      envId: 'env-1',
    });
    expect(res.noMatch).toBe(true);
    expect(slack.postAlert).not.toHaveBeenCalled();
    expect(incidents.list()).toHaveLength(0);
  });

  it('creates an incident and posts on match', async () => {
    const { router, alertRules, slack, incidents } = setup();
    alertRules.create({
      name: 'Deploy alerts',
      triggerType: 'deploy-failed',
      channels: ['#deploys'],
    });

    const res = await router.handleTrigger({
      triggerType: 'deploy-failed',
      envId: 'bayada-prod',
      customerId: 'bayada',
      envTier: 'production',
      summary: 'Deploy of v4.2.1 failed',
      payload: { version: 'v4.2.1' },
    });

    expect(res.incidentId).toBeTruthy();
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    const inc = incidents.get(res.incidentId);
    expect(inc.summary).toBe('Deploy of v4.2.1 failed');
    expect(inc.triggerType).toBe('deploy-failed');
    expect(inc.payload.version).toBe('v4.2.1');
  });

  it('respects customer filter', async () => {
    const { router, alertRules, slack } = setup();
    alertRules.create({
      name: 'Bayada only', triggerType: 'deploy-failed', channels: ['#a'],
      filter: { customerIds: ['bayada'] },
    });

    // Non-matching customer
    await router.handleTrigger({
      triggerType: 'deploy-failed', customerId: 'ck',
      summary: 'Fail on ck',
    });
    expect(slack.postAlert).not.toHaveBeenCalled();

    // Matching
    await router.handleTrigger({
      triggerType: 'deploy-failed', customerId: 'bayada',
      summary: 'Fail on bayada',
    });
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });

  it('dedupes by subjectKey — same subject fires once', async () => {
    const { router, alertRules, slack, incidents } = setup();
    alertRules.create({ name: 'deploys', triggerType: 'deploy-failed', channels: ['#a'] });

    await router.handleTrigger({
      triggerType: 'deploy-failed',
      subjectKey: 'deploy-failed:v4.2.1:bayada:prod',
      summary: 'First fail',
    });
    const callsBefore = slack.postAlert.mock.calls.length;

    // Same subject — deduped
    const res = await router.handleTrigger({
      triggerType: 'deploy-failed',
      subjectKey: 'deploy-failed:v4.2.1:bayada:prod',
      summary: 'Second fail',
    });

    expect(res.deduped).toBe(true);
    expect(slack.postAlert).toHaveBeenCalledTimes(callsBefore);
    expect(incidents.list({ status: 'open' })).toHaveLength(1);
  });

  it('different subjectKey opens a new incident', async () => {
    const { router, alertRules, incidents } = setup();
    alertRules.create({ name: 'deploys', triggerType: 'deploy-failed', channels: ['#a'] });

    await router.handleTrigger({
      triggerType: 'deploy-failed',
      subjectKey: 'deploy-failed:v4.2.1:bayada:prod',
      summary: 'First',
    });
    await router.handleTrigger({
      triggerType: 'deploy-failed',
      subjectKey: 'deploy-failed:v4.2.2:bayada:prod',
      summary: 'Second',
    });

    expect(incidents.list()).toHaveLength(2);
  });

  it('uses severity fallback from matching rules when not specified', async () => {
    const { router, alertRules, incidents } = setup();
    alertRules.create({
      name: 'warn', triggerType: 'feature-flag-changed', channels: ['#a'], severity: 'warning',
    });

    const res = await router.handleTrigger({
      triggerType: 'feature-flag-changed',
      summary: 'Some flag flipped',
    });
    const inc = incidents.get(res.incidentId);
    expect(inc.severity).toBe('warning');
  });

  it('uses explicit severity when provided', async () => {
    const { router, alertRules, incidents } = setup();
    alertRules.create({
      name: 'warn', triggerType: 'feature-flag-changed', channels: ['#a'], severity: 'warning',
    });

    const res = await router.handleTrigger({
      triggerType: 'feature-flag-changed',
      summary: 'Critical flag flipped',
      severity: 'critical',
    });
    const inc = incidents.get(res.incidentId);
    expect(inc.severity).toBe('critical');
  });

  it('falls back to a default summary when none provided', async () => {
    const { router, alertRules, incidents } = setup();
    alertRules.create({ name: 'deploys', triggerType: 'deploy-failed', channels: ['#a'] });
    const res = await router.handleTrigger({
      triggerType: 'deploy-failed',
      envId: 'bayada-prod',
    });
    const inc = incidents.get(res.incidentId);
    expect(inc.summary).toMatch(/bayada-prod/);
    expect(inc.summary).toMatch(/Deploy failed/);
  });

  it('works for upgrade-failed trigger', async () => {
    const { router, alertRules, incidents, slack } = setup();
    alertRules.create({ name: 'upgrades', triggerType: 'upgrade-failed', channels: ['#upgrades'] });

    const res = await router.handleTrigger({
      triggerType: 'upgrade-failed',
      envId: 'ck-prod',
      customerId: 'ck',
      summary: 'Migration v42 failed',
    });
    expect(res.incidentId).toBeTruthy();
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    const inc = incidents.get(res.incidentId);
    expect(inc.triggerType).toBe('upgrade-failed');
  });

  it('tracks Slack posts on the incident for threading', async () => {
    const { router, alertRules, incidents } = setup();
    alertRules.create({ name: 'deploys', triggerType: 'deploy-failed', channels: ['#a', '#b'] });

    const res = await router.handleTrigger({
      triggerType: 'deploy-failed',
      summary: 'Fail',
    });
    const inc = incidents.get(res.incidentId);
    expect(inc.slackPosts).toHaveLength(2);
  });
});
