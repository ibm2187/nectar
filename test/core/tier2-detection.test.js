import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * End-to-end tests for tier-2 detection: environment-poller diffs
 * features/integrations/upgrades across polls and fires router events
 * that open incidents with correct subjectKey-based dedup.
 */

const { createTestDb } = require('../../src/core/db');
const EnvironmentPoller = require('../../src/core/environment-poller');
const AlertRuleStore = require('../../src/core/alert-rule-store');
const IncidentStore = require('../../src/core/incident-store');
const AlertRouter = require('../../src/core/alert-router');

/**
 * A customerStore stub that stores env state between polls so the
 * poller can read `prevEnv` when diffing. Actual Nectar CustomerStore
 * does the same but uses SQLite; we keep it in-memory here.
 */
function makeCustomerStore(envs) {
  const byId = new Map(envs.map(e => [e.id, { ...e }]));
  return {
    listEnvironments: () => [...byId.values()],
    getEnvironment: (id) => byId.get(id) || null,
    updateLiveState: vi.fn((id, patch) => {
      const e = byId.get(id);
      if (e) Object.assign(e, patch);
    }),
    updateFeatures: vi.fn((id, data) => {
      const e = byId.get(id);
      if (e) e.features = data;
    }),
    updateIntegrations: vi.fn((id, data) => {
      const e = byId.get(id);
      if (e) e.integrations = data;
    }),
    updateUpgrades: vi.fn((id, data) => {
      const e = byId.get(id);
      if (e) e.upgrades = data;
    }),
    updateHealth: vi.fn((id, data) => {
      const e = byId.get(id);
      if (e) e.health = data;
    }),
  };
}

/**
 * Scripted endpoints: supply an array of "poll responses" per poll.
 * Each entry has { features, integrations, upgrades }. The poller
 * advances through them one per run().
 */
function setup(pollResponses) {
  const db = createTestDb();
  const alertRules = new AlertRuleStore({ db });
  const incidents = new IncidentStore({ db });

  const posts = [];
  const slack = {
    isConfigured: () => true,
    postAlert: vi.fn(async ({ channels, text }) => {
      posts.push({ channels, text });
      return channels.map((c, i) => ({ channel: c, ok: true, ts: `t${Date.now()}.${i}` }));
    }),
    postReply: vi.fn(async () => ({ ok: true, ts: 't-reply' })),
    dmUser: vi.fn(),
  };
  const router = new AlertRouter({
    alertRules, incidents, slack,
    notificationSettings: { get: () => true },
    db,
  });

  const env = {
    id: 'bayada-prod',
    customerId: 'bayada',
    name: 'Bayada prod',
    tier: 'production',
    url: 'https://bayada.example.com',
    versionEndpoint: 'https://bayada.example.com/api/status/version',
    disabled: false,
  };
  const customerStore = makeCustomerStore([env]);
  const poller = new EnvironmentPoller(customerStore, { polling: { environmentVersions: 10_000 } });

  // Starts at -1; poll:started bumps to 0 before the first fetch.
  let idx = -1;
  poller._fetchEndpoint = vi.fn(async (_url, path) => {
    const resp = pollResponses[Math.min(Math.max(idx, 0), pollResponses.length - 1)];
    if (path.startsWith('/api/status/version')) return { version: 'v1' };
    if (path.startsWith('/api/status/features')) return resp.features || {};
    if (path.startsWith('/api/status/integrations')) return resp.integrations || {};
    if (path.startsWith('/api/status/upgrades')) return resp.upgrades || { items: [], pagination: { hasMore: false } };
    return {};
  });
  // Advance to the next scripted response on every poll cycle. We hook
  // into poll:started (which fires once per poll, before any endpoint
  // fetches) so idx steps forward one response at a time regardless of
  // how many endpoints each poll hits.
  poller.on('poll:started', () => { idx++; });
  poller._fetchHealthEndpoint = vi.fn(async () => ({
    data: { checks: { criticalFunctionality: { services: { mongodb: { status: 'healthy' }, redis: { status: 'healthy' } } } } },
    responseTimeMs: 10,
  }));

  // Track all async work triggered by poller events so tests can
  // await completion deterministically. EventEmitter doesn't propagate
  // listener returns, so we collect promises in a shared array.
  const pending = [];

  poller.on('env:feature-flag-changed', (ev) => {
    pending.push(router.handleTrigger({
      triggerType: 'feature-flag-changed',
      subjectKey: `flag:${ev.envId}:${ev.source}:${ev.key}`,
      customerId: ev.customerId,
      envId: ev.envId,
      envTier: ev.envTier,
      summary: `Flag "${ev.key}" changed`,
      payload: { source: ev.source, key: ev.key, from: ev.from, to: ev.to },
    }));
  });
  poller.on('env:integration-changed', (ev) => {
    pending.push(router.handleTrigger({
      triggerType: 'integration-config-changed',
      subjectKey: `integration:${ev.envId}:${ev.source}:${ev.key}`,
      customerId: ev.customerId,
      envId: ev.envId,
      envTier: ev.envTier,
      summary: `Integration "${ev.key}" changed`,
      payload: { source: ev.source, key: ev.key, from: ev.from, to: ev.to },
    }));
  });
  poller.on('env:upgrade-failed', (ev) => {
    pending.push(router.handleTrigger({
      triggerType: 'upgrade-failed',
      subjectKey: `upgrade-failed:${ev.envId}:${ev.upgradeName}`,
      customerId: ev.customerId,
      envId: ev.envId,
      envTier: ev.envTier,
      summary: `Upgrade "${ev.upgradeName}" failed on ${ev.envName}`,
      payload: { upgradeName: ev.upgradeName },
    }));
  });
  poller.on('env:upgrade-recovered', (ev) => {
    const active = incidents.findActiveBySubject(`upgrade-failed:${ev.envId}:${ev.upgradeName}`);
    if (active) incidents.resolve(active.id, { resolution: 'auto' });
  });

  async function runPoll() {
    await poller.run();
    // Drain all async work triggered by events from this poll
    while (pending.length > 0) {
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  }

  return { db, alertRules, incidents, slack, router, poller, posts, runPoll };
}

async function runPolls(runPoll, n) {
  for (let i = 0; i < n; i++) await runPoll();
}

// ══════════════════════════════════════════════════════════════
// Feature flags
// ══════════════════════════════════════════════════════════════

describe('feature-flag-changed end-to-end', () => {
  it('fires an alert when a DB feature flag flips on a subsequent poll', async () => {
    const { alertRules, incidents, slack, poller, runPoll } = setup([
      // Poll 1: baseline
      { features: { dbFeatureFlags: [{ key: 'newUi', enabled: false }] } },
      // Poll 2: flag flipped on
      { features: { dbFeatureFlags: [{ key: 'newUi', enabled: true }] } },
    ]);
    alertRules.create({ name: 'flag rule', triggerType: 'feature-flag-changed', channels: ['#flags'] });

    await runPolls(runPoll, 2);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    const inc = incidents.list({ triggerType: 'feature-flag-changed' })[0];
    expect(inc.summary).toMatch(/newUi/);
    expect(inc.payload).toMatchObject({ source: 'db', key: 'newUi', from: false, to: true });
  });

  it('does not fire on the baseline poll (no prev)', async () => {
    const { alertRules, slack, poller, runPoll } = setup([
      { features: { dbFeatureFlags: [{ key: 'newUi', enabled: true }] } },
    ]);
    alertRules.create({ name: 'flag rule', triggerType: 'feature-flag-changed', channels: ['#flags'] });

    await runPolls(runPoll, 1);
    expect(slack.postAlert).not.toHaveBeenCalled();
  });

  it('dedup: the same flag re-flipping to the same value within the active incident does not re-fire', async () => {
    const { alertRules, slack, poller, runPoll } = setup([
      { features: { dbFeatureFlags: [{ key: 'newUi', enabled: false }] } }, // baseline
      { features: { dbFeatureFlags: [{ key: 'newUi', enabled: true }] } },  // poll 2: fire
      { features: { dbFeatureFlags: [{ key: 'newUi', enabled: true }] } },  // poll 3: same — no change
    ]);
    alertRules.create({ name: 'flag rule', triggerType: 'feature-flag-changed', channels: ['#flags'] });

    await runPolls(runPoll, 3);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });

  it('independent flags fire independent incidents', async () => {
    const { alertRules, incidents, slack, poller, runPoll } = setup([
      { features: {
          dbFeatureFlags: [{ key: 'flagA', enabled: false }, { key: 'flagB', enabled: false }],
      } },
      { features: {
          dbFeatureFlags: [{ key: 'flagA', enabled: true }, { key: 'flagB', enabled: true }],
      } },
    ]);
    alertRules.create({ name: 'flag rule', triggerType: 'feature-flag-changed', channels: ['#flags'] });

    await runPolls(runPoll, 2);

    expect(slack.postAlert).toHaveBeenCalledTimes(2);
    expect(incidents.list({ triggerType: 'feature-flag-changed' })).toHaveLength(2);
  });

  it('detects portal config flag changes', async () => {
    const { alertRules, slack, poller, incidents, runPoll } = setup([
      { features: { configFeatures: { portalFeatureFlag: { x: false } } } },
      { features: { configFeatures: { portalFeatureFlag: { x: true } } } },
    ]);
    alertRules.create({ name: 'flag rule', triggerType: 'feature-flag-changed', channels: ['#flags'] });

    await runPolls(runPoll, 2);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    const inc = incidents.list({ triggerType: 'feature-flag-changed' })[0];
    expect(inc.payload.source).toBe('portal');
  });
});

// ══════════════════════════════════════════════════════════════
// Integration config changes
// ══════════════════════════════════════════════════════════════

describe('integration-config-changed end-to-end', () => {
  it('fires when dbIntegrations.enabled flips', async () => {
    const { alertRules, incidents, slack, poller, runPoll } = setup([
      { integrations: { dbIntegrations: { sso: { enabled: true } } } },
      { integrations: { dbIntegrations: { sso: { enabled: false } } } },
    ]);
    alertRules.create({ name: 'int rule', triggerType: 'integration-config-changed', channels: ['#integrations'] });

    await runPolls(runPoll, 2);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    const inc = incidents.list({ triggerType: 'integration-config-changed' })[0];
    expect(inc.summary).toMatch(/sso/);
    expect(inc.payload.to).toBe(false);
  });

  it('fires when disableOutgoingCommunication flips', async () => {
    const { alertRules, slack, poller, runPoll } = setup([
      { integrations: { disableOutgoingCommunication: false } },
      { integrations: { disableOutgoingCommunication: true } },
    ]);
    alertRules.create({ name: 'int rule', triggerType: 'integration-config-changed', channels: ['#integrations'] });

    await runPolls(runPoll, 2);
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });

  it('does not fire when configured changes but enabled does not', async () => {
    const { alertRules, slack, poller, runPoll } = setup([
      { integrations: { dbIntegrations: { sso: { enabled: true, configured: false } } } },
      { integrations: { dbIntegrations: { sso: { enabled: true, configured: true } } } },
    ]);
    alertRules.create({ name: 'int rule', triggerType: 'integration-config-changed', channels: ['#integrations'] });

    await runPolls(runPoll, 2);
    expect(slack.postAlert).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// Upgrade failures
// ══════════════════════════════════════════════════════════════

describe('upgrade-failed end-to-end', () => {
  function upgrade(name, status) {
    return { upgradeName: name, history: status ? { verificationStatus: status } : null };
  }

  it('fires on first observation of a FAILED upgrade (no prev)', async () => {
    const { alertRules, incidents, slack, poller, runPoll } = setup([
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
    ]);
    alertRules.create({ name: 'upg rule', triggerType: 'upgrade-failed', channels: ['#upgrades'] });

    await runPolls(runPoll, 1);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    const inc = incidents.list({ triggerType: 'upgrade-failed' })[0];
    expect(inc.payload.upgradeName).toBe('m1');
  });

  it('does not re-fire when the same upgrade is still FAILED', async () => {
    const { alertRules, slack, poller, runPoll } = setup([
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
    ]);
    alertRules.create({ name: 'upg rule', triggerType: 'upgrade-failed', channels: ['#upgrades'] });

    await runPolls(runPoll, 3);
    expect(slack.postAlert).toHaveBeenCalledTimes(1);
  });

  it('auto-resolves incident when upgrade recovers to SUCCESS', async () => {
    const { alertRules, incidents, poller, runPoll } = setup([
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
      { upgrades: { items: [upgrade('m1', 'SUCCESS')], pagination: { hasMore: false } } },
    ]);
    alertRules.create({ name: 'upg rule', triggerType: 'upgrade-failed', channels: ['#upgrades'] });

    await runPolls(runPoll, 2);

    const upgrades = incidents.list({ triggerType: 'upgrade-failed' });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].status).toBe('resolved');
    expect(upgrades[0].resolution).toBe('auto');
  });

  it('re-fires after recovery if the same upgrade fails again (new streak)', async () => {
    const { alertRules, incidents, slack, poller, runPoll } = setup([
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
      { upgrades: { items: [upgrade('m1', 'SUCCESS')], pagination: { hasMore: false } } },
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
    ]);
    alertRules.create({ name: 'upg rule', triggerType: 'upgrade-failed', channels: ['#upgrades'] });

    await runPolls(runPoll, 3);

    expect(slack.postAlert).toHaveBeenCalledTimes(2);
    expect(incidents.list({ triggerType: 'upgrade-failed' })).toHaveLength(2);
  });

  it('respects customer filter on upgrade-failed rules', async () => {
    const { alertRules, slack, poller, runPoll } = setup([
      { upgrades: { items: [upgrade('m1', 'SUCCESS')], pagination: { hasMore: false } } },
      { upgrades: { items: [upgrade('m1', 'FAILED')], pagination: { hasMore: false } } },
    ]);
    alertRules.create({
      name: 'upg rule',
      triggerType: 'upgrade-failed',
      channels: ['#upgrades'],
      filter: { customerIds: ['ck'] }, // env is bayada, so should NOT match
    });

    await runPolls(runPoll, 2);
    expect(slack.postAlert).not.toHaveBeenCalled();
  });
});
