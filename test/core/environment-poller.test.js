import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/core/log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

const EnvironmentPoller = require('../../src/core/environment-poller');

function makeMockCustomerStore(environments) {
  return {
    listEnvironments: () => environments,
    updateLiveState: vi.fn(),
    updateFeatures: vi.fn(),
    updateIntegrations: vi.fn(),
    updateUpgrades: vi.fn(),
    updateHealth: vi.fn(),
  };
}

describe('EnvironmentPoller', () => {
  let poller, mockStore;

  const config = {
    polling: { environmentVersions: 60000 },
  };

  describe('circuit breaker', () => {
    it('skips environments with 3+ consecutive failures', async () => {
      const envs = [
        { id: 'good', url: 'http://good.test', versionEndpoint: 'http://good.test/version', tier: 'staging' },
        { id: 'bad', url: 'http://bad.test', versionEndpoint: 'http://bad.test/version', tier: 'staging' },
      ];
      mockStore = makeMockCustomerStore(envs);
      poller = new EnvironmentPoller(mockStore, config);

      // Simulate 3 consecutive failures for 'bad'
      poller._failures.set('bad', 3);
      poller._pollCount = 1; // not a 5th cycle

      // Mock _pollOne to succeed for good, fail for bad
      const originalPollOne = poller._pollOne.bind(poller);
      poller._pollOne = vi.fn(async (env) => {
        if (env.id === 'bad') throw new Error('unreachable');
        return { versionChanged: false };
      });

      const results = await poller.run();

      // 'bad' should be skipped (circuit-broken), only 'good' polled
      expect(poller._pollOne).toHaveBeenCalledTimes(1);
      expect(poller._pollOne).toHaveBeenCalledWith(expect.objectContaining({ id: 'good' }));
      expect(results.skipped).toBe(1);
      expect(results.succeeded).toBe(1);
    });

    it('retries circuit-broken envs on every 5th cycle', async () => {
      const envs = [
        { id: 'bad', url: 'http://bad.test', versionEndpoint: 'http://bad.test/version', tier: 'staging' },
      ];
      mockStore = makeMockCustomerStore(envs);
      poller = new EnvironmentPoller(mockStore, config);

      poller._failures.set('bad', 5);
      poller._pollCount = 4; // next run will be 5th cycle

      poller._pollOne = vi.fn(async () => {
        throw new Error('still bad');
      });

      const results = await poller.run();

      // pollCount is now 5, so circuit-broken envs should be retried
      expect(poller._pollOne).toHaveBeenCalledTimes(1);
      expect(results.skipped).toBe(0);
    });

    it('resets failure count on success', async () => {
      const envs = [
        { id: 'recovering', url: 'http://ok.test', versionEndpoint: 'http://ok.test/version', tier: 'staging' },
      ];
      mockStore = makeMockCustomerStore(envs);
      poller = new EnvironmentPoller(mockStore, config);

      poller._failures.set('recovering', 2);

      poller._pollOne = vi.fn(async () => ({ versionChanged: false }));

      await poller.run();

      expect(poller._failures.has('recovering')).toBe(false);
    });

    it('increments failure count on failure', async () => {
      const envs = [
        { id: 'flaky', url: 'http://flaky.test', versionEndpoint: 'http://flaky.test/version', tier: 'staging' },
      ];
      mockStore = makeMockCustomerStore(envs);
      poller = new EnvironmentPoller(mockStore, config);

      poller._pollOne = vi.fn(async () => {
        throw new Error('timeout');
      });

      await poller.run();

      expect(poller._failures.get('flaky')).toBe(1);

      await poller.run();

      expect(poller._failures.get('flaky')).toBe(2);
    });
  });

  describe('timeout', () => {
    it('uses 3s timeout for endpoint fetches', () => {
      // Verify the timeout constant by checking _fetchEndpoint behavior.
      // We test this indirectly: create a poller and inspect the source.
      const envs = [];
      mockStore = makeMockCustomerStore(envs);
      poller = new EnvironmentPoller(mockStore, config);

      // The timeout is hardcoded at 3000ms in _fetchEndpoint.
      // We verify by reading the source (functional test would need a real server).
      const source = poller._fetchEndpoint.toString();
      expect(source).toContain('3000');
    });
  });

  describe('poll count tracking', () => {
    it('increments pollCount on each run', async () => {
      mockStore = makeMockCustomerStore([]);
      poller = new EnvironmentPoller(mockStore, config);

      expect(poller._pollCount).toBe(0);

      await poller.run();
      expect(poller._pollCount).toBe(1);

      await poller.run();
      expect(poller._pollCount).toBe(2);
    });
  });
});
