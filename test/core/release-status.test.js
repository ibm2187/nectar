import { describe, it, expect } from 'vitest';

const { computeReleaseStatus, annotateReleases } = require('../../src/core/release-status');

describe('release-status', () => {
  const now = new Date('2026-04-21T12:00:00Z');

  // A full environment object with heavy fields (features, upgrades, etc.)
  // that should NOT leak into the matchingEnvs response.
  function makeProdEnv(id, customerId, currentVersion) {
    return {
      id,
      customerId,
      currentVersion,
      tier: 'production',
      franchise: 'test',
      url: 'https://example.com',
      reachable: true,
      features: { featureA: true, featureB: false, featureC: 'enabled' },
      integrations: { slack: { enabled: true }, jira: { enabled: true } },
      upgrades: { available: '4.2.0', history: Array(100).fill({ version: '4.1.0', date: '2026-01-01' }) },
      health: { status: 'ok', checks: [{ name: 'db', ok: true }] },
    };
  }

  describe('computeReleaseStatus', () => {
    it('projects matchingEnvs to only { id, customerId, currentVersion }', () => {
      const release = { version: '4.1.0', jiraReleased: false };
      const prodEnvs = [
        makeProdEnv('ck-prod', 'ck', '4.1.0'),
        makeProdEnv('bayada-prod', 'bayada', '4.1.0'),
      ];

      const result = computeReleaseStatus(release, prodEnvs, now);

      expect(result.status).toBe('shipped');
      expect(result.matchingEnvs).toHaveLength(2);
      // Each matchingEnv should only have 3 keys
      for (const env of result.matchingEnvs) {
        expect(Object.keys(env).sort()).toEqual(['currentVersion', 'customerId', 'id']);
      }
      expect(result.matchingEnvs[0]).toEqual({ id: 'ck-prod', customerId: 'ck', currentVersion: '4.1.0' });
      expect(result.matchingEnvs[1]).toEqual({ id: 'bayada-prod', customerId: 'bayada', currentVersion: '4.1.0' });
    });

    it('does not include heavy fields like features, upgrades, integrations, health', () => {
      const release = { version: '4.1.0', jiraReleased: false };
      const prodEnvs = [makeProdEnv('ck-prod', 'ck', '4.1.0')];

      const result = computeReleaseStatus(release, prodEnvs, now);

      const env = result.matchingEnvs[0];
      expect(env).not.toHaveProperty('features');
      expect(env).not.toHaveProperty('upgrades');
      expect(env).not.toHaveProperty('integrations');
      expect(env).not.toHaveProperty('health');
      expect(env).not.toHaveProperty('url');
      expect(env).not.toHaveProperty('tier');
    });

    it('returns empty matchingEnvs for non-shipped releases', () => {
      const release = { version: '5.0.0', jiraReleased: false, jiraReleaseDate: '2026-05-15' };
      const prodEnvs = [makeProdEnv('ck-prod', 'ck', '4.1.0')];

      const result = computeReleaseStatus(release, prodEnvs, now);
      expect(result.status).toBe('upcoming');
      expect(result.matchingEnvs).toEqual([]);
    });
  });

  describe('annotateReleases', () => {
    it('annotates releases with projected matchingEnvs', () => {
      const releases = [
        { version: '4.1.0', jiraReleased: false },
        { version: '5.0.0', jiraReleased: false, jiraReleaseDate: '2026-05-15' },
      ];
      const environments = [
        makeProdEnv('ck-prod', 'ck', '4.1.0'),
        { id: 'ck-staging', customerId: 'ck', currentVersion: '4.2.0', tier: 'staging' },
      ];

      const result = annotateReleases(releases, environments, now);

      expect(result[0].effectiveStatus.status).toBe('shipped');
      expect(result[0].effectiveStatus.matchingEnvs).toHaveLength(1);
      expect(result[0].effectiveStatus.matchingEnvs[0]).toEqual({
        id: 'ck-prod',
        customerId: 'ck',
        currentVersion: '4.1.0',
      });

      // Staging env should be excluded (not tier=production)
      expect(result[1].effectiveStatus.matchingEnvs).toEqual([]);
    });
  });
});
