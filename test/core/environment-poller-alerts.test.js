import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * End-to-end: EnvironmentPoller → AlertRouter → Slack.
 *
 * Stubs the poller's _fetchEndpoint/_fetchHealthEndpoint so we can
 * control the health response and verify that the full pipeline
 * (observe → flap guard → rule match → incident → Slack post) works.
 */

const { createTestDb } = require('../../src/core/db');
const EnvironmentPoller = require('../../src/core/environment-poller');
const AlertRuleStore = require('../../src/core/alert-rule-store');
const IncidentStore = require('../../src/core/incident-store');
const AlertRouter = require('../../src/core/alert-router');

function makeEnvs() {
  return [{
    id: 'qualitycare-prod',
    customerId: 'qualitycare',
    name: 'Quality Care prod',
    tier: 'production',
    url: 'https://qualitycare.example.com',
    versionEndpoint: 'https://qualitycare.example.com/api/status/version',
    disabled: false,
  }];
}

function makeCustomerStore() {
  const updates = [];
  return {
    listEnvironments: () => makeEnvs(),
    updateLiveState: vi.fn(),
    updateVersion: vi.fn(),
    updateFeatures: vi.fn(),
    updateIntegrations: vi.fn(),
    updateUpgrades: vi.fn(),
    updateHealth: vi.fn((envId, data) => { updates.push({ envId, data }); }),
    _updates: updates,
  };
}

function makeSlack() {
  const calls = { postAlert: [], postReply: [] };
  return {
    isConfigured: () => true,
    postAlert: vi.fn(async ({ channels, ...rest }) => {
      calls.postAlert.push({ channels, ...rest });
      return channels.map((c, i) => ({ channel: c, ok: true, ts: `${Date.now()}.${i}` }));
    }),
    postReply: vi.fn(async (opts) => { calls.postReply.push(opts); return { ok: true, ts: '1' }; }),
    dmUser: vi.fn(),
    _calls: calls,
  };
}

/**
 * Build a poller that fetches a scripted sequence of health responses
 * per poll. `healthResponses` is an array — each run() call pops one.
 */
function makePoller({ customerStore, healthResponses = [] }) {
  const poller = new EnvironmentPoller(customerStore, { polling: { environmentVersions: 10_000 } });

  // Stub endpoints
  poller._fetchEndpoint = vi.fn(async (url, path) => {
    if (path.startsWith('/api/status/version')) return { version: 'v4.1.0.4-qualitycare' };
    if (path.startsWith('/api/status/features')) return {};
    if (path.startsWith('/api/status/integrations')) return {};
    if (path.startsWith('/api/status/upgrades')) return { items: [], pagination: { hasMore: false } };
    return {};
  });

  let idx = 0;
  poller._fetchHealthEndpoint = vi.fn(async () => {
    const resp = healthResponses[Math.min(idx, healthResponses.length - 1)];
    idx++;
    return { data: resp, responseTimeMs: 10 };
  });

  return poller;
}

/**
 * Shared setup: in-memory DB, rule+incident stores, router, poller,
 * slack. Returns everything tests need to exercise the full pipeline.
 */
function setup({ healthResponses, flapThreshold = 2 } = {}) {
  const db = createTestDb();
  const alertRules = new AlertRuleStore({ db });
  const incidents = new IncidentStore({ db });
  const slack = makeSlack();
  const customerStore = makeCustomerStore();
  const router = new AlertRouter({
    alertRules, incidents, slack,
    notificationSettings: { get: () => true },
    db, flapThreshold,
  });
  const poller = makePoller({ customerStore, healthResponses });
  poller.on('env:health-observed', (obs) => {
    router.observeEnvHealth(obs).catch(() => {});
  });
  return { db, alertRules, incidents, slack, router, poller };
}

// Helper: build a health response with a failing component.
// Shape mirrors the real webplatform /api/status endpoint:
//   checks.criticalFunctionality.services.<name> = { status }
function unhealthyResp(failing = ['redis']) {
  const services = {
    mongodb: { status: 'healthy' },
    redis: { status: 'healthy' },
  };
  for (const name of failing) {
    services[name] = { status: 'unhealthy' };
  }
  return {
    checks: {
      criticalFunctionality: { services },
      externalServices: { services: {} },
    },
    summary: { totalChecks: 8, passed: 8 - failing.length, failed: failing.length, degraded: 0, skipped: 0 },
  };
}

function healthyResp() {
  return {
    checks: {
      criticalFunctionality: {
        services: { mongodb: { status: 'healthy' }, redis: { status: 'healthy' } },
      },
      externalServices: { services: {} },
    },
    summary: { totalChecks: 8, passed: 8, failed: 0, degraded: 0, skipped: 0 },
  };
}

// Utility to wait for the async router invocation inside the listener
const tick = () => new Promise(r => setImmediate(r));

async function runPolls(poller, n) {
  for (let i = 0; i < n; i++) {
    await poller.run();
    await tick();
  }
}

// ══════════════════════════════════════════════════════════════

describe('EnvironmentPoller → AlertRouter integration', () => {
  it('emits env:health-observed with failing components', async () => {
    const { poller, alertRules, slack } = setup({
      healthResponses: [unhealthyResp(['redis'])],
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    let observed = null;
    poller.on('env:health-observed', (obs) => { observed = obs; });

    await poller.run();
    await tick();

    expect(observed).toBeTruthy();
    expect(observed.status).toBe('unhealthy');
    expect(observed.failingComponents).toContain('Cache'); // mapped from 'redis'
    expect(observed.envId).toBe('qualitycare-prod');
    expect(observed.customerId).toBe('qualitycare');
    expect(observed.envTier).toBe('production');
  });

  it('does not post on first unhealthy observation (flap guard)', async () => {
    const { poller, alertRules, slack } = setup({
      healthResponses: [unhealthyResp(['redis'])],
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    await poller.run();
    await tick();

    expect(slack.postAlert).not.toHaveBeenCalled();
  });

  it('posts once after two consecutive unhealthy observations', async () => {
    const { poller, alertRules, slack, incidents } = setup({
      healthResponses: [unhealthyResp(['redis']), unhealthyResp(['redis'])],
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    await runPolls(poller, 2);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    expect(incidents.list({ status: 'open' })).toHaveLength(1);
  });

  it('component filter in rule matches the mapped component name', async () => {
    const { poller, alertRules, slack } = setup({
      healthResponses: [unhealthyResp(['redis']), unhealthyResp(['redis'])],
    });
    // Rule filters for 'Cache' — should match the 'redis' → 'Cache' mapping
    alertRules.create({
      name: 'cache-only',
      triggerType: 'env-unhealthy',
      channels: ['#alerts-prod'],
      filter: { components: ['Cache'] },
    });
    alertRules.create({
      name: 'db-only',
      triggerType: 'env-unhealthy',
      channels: ['#db-alerts'],
      filter: { components: ['Database'] },
    });

    await runPolls(poller, 2);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    expect(slack.postAlert.mock.calls[0][0].channels).toEqual(['#alerts-prod']);
  });

  it('auto-resolves and posts recovery reply on return to healthy', async () => {
    const { poller, alertRules, slack, incidents } = setup({
      healthResponses: [
        unhealthyResp(['redis']),
        unhealthyResp(['redis']),     // fires
        healthyResp(),
        healthyResp(),                // fires recovery
      ],
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    await runPolls(poller, 4);

    expect(slack.postAlert).toHaveBeenCalledTimes(1);
    expect(slack.postReply).toHaveBeenCalledTimes(1);
    const resolved = incidents.list({ status: 'resolved' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolution).toBe('auto');
  });

  it('suppresses one-poll blip (healthy → unhealthy → healthy) entirely', async () => {
    const { poller, alertRules, slack, incidents } = setup({
      healthResponses: [
        healthyResp(),
        healthyResp(),      // baseline healthy
        unhealthyResp(['redis']), // blip
        healthyResp(),      // back to healthy — no alert ever fired
        healthyResp(),
      ],
    });
    alertRules.create({ name: 'a', triggerType: 'env-unhealthy', channels: ['#alerts-prod'] });

    await runPolls(poller, 5);

    expect(slack.postAlert).not.toHaveBeenCalled();
    expect(slack.postReply).not.toHaveBeenCalled();
    expect(incidents.list()).toHaveLength(0);
  });

  it('keeps customerStore.updateHealth happening every poll (unchanged behavior)', async () => {
    const { poller } = setup({
      healthResponses: [unhealthyResp(['redis'])],
    });
    await poller.run();
    await tick();
    // customerStore.updateHealth is still called for UI state
    // (see makeCustomerStore — tracked in _updates)
    expect(poller.customerStore.updateHealth).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// collectFailingComponents via the poller module
// ══════════════════════════════════════════════════════════════

describe('component name mapping', () => {
  it('maps common service names to human labels', async () => {
    const { poller, alertRules } = setup({
      healthResponses: [unhealthyResp(['mongodb', 'redis', 's3', 'sqs'])],
    });
    let observed = null;
    poller.on('env:health-observed', (obs) => { observed = obs; });

    await poller.run();
    await tick();

    expect(observed.failingComponents.sort()).toEqual(['Cache', 'Database', 'File Storage', 'Message Queue'].sort());
  });

  it('title-cases unknown component names as a fallback', async () => {
    const { poller } = setup({
      healthResponses: [unhealthyResp(['webhook-handler'])],
    });
    let observed = null;
    poller.on('env:health-observed', (obs) => { observed = obs; });
    await poller.run();
    await tick();

    // prettyComponentName just title-cases first letter — works for 'Email', etc.
    expect(observed.failingComponents[0]).toMatch(/^W/);
  });
});
