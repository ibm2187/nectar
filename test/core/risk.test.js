import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const RiskAssessor = require('../../src/core/risk');

describe('RiskAssessor', () => {
  let audit, releases, risk;
  let mockGithub, mockJenkins;

  const config = {
    risk: {
      weights: {
        migration: 15,
        billingEngine: 20,
        modelChange: 8,
        authChange: 12,
        apiRoute: 5,
        largeDiff: 3,
        dependencyChange: 5,
        untestedTicket: 5,
        ciFailure: 10,
      },
      thresholds: { low: 30, medium: 60 },
    },
  };

  beforeEach(() => {
    audit = new Audit();
    releases = new ReleaseManager(audit);
    releases.releases.clear();
    audit.entries = [];
    mockGithub = {
      isConfigured: () => true,
      compareBranches: vi.fn(),
      getPRFiles: vi.fn(),
    };
    mockJenkins = {
      isConfigured: () => false,
    };
    risk = new RiskAssessor(releases, mockGithub, mockJenkins, config);
  });

  it('throws for nonexistent release', async () => {
    await expect(risk.assess('nonexistent')).rejects.toThrow('not found');
  });

  it('throws for release without cutFrom', async () => {
    releases.create({ version: '4.2.0' });
    await expect(risk.assess('4.2.0')).rejects.toThrow('no cutFrom');
  });

  it('assesses low risk for small safe diff', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'client/src/App.tsx', additions: 10, deletions: 2 },
        { filename: 'server/api/routes.js', additions: 5, deletions: 1 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.score).toBe('low');
    expect(result.numericScore).toBeLessThanOrEqual(30);
  });

  it('flags migrations as high risk', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'server/upgrade/add-column.js', additions: 50, deletions: 0 },
        { filename: 'server/upgrade/fix-data.js', additions: 100, deletions: 0 },
        { filename: 'server/upgrade/another.js', additions: 30, deletions: 0 },
        { filename: 'server/api/rcm_v2/engine/calc.js', additions: 200, deletions: 100 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('migration'))).toBe(true);
    expect(result.factors.some(f => f.reason.includes('Billing'))).toBe(true);
    expect(result.score).toBe('high');
  });

  it('flags auth changes', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'server/middleware/acl.js', additions: 10, deletions: 5 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('Auth'))).toBe(true);
  });

  it('flags large diffs', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'big-file.js', additions: 800, deletions: 200 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('Large diff'))).toBe(true);
  });

  it('updates release.risk after assessment', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({ files: [] });
    await risk.assess('4.2.0');

    const r = releases.get('4.2.0');
    expect(r.risk.score).not.toBeNull();
    expect(r.risk.numericScore).toBe(0);
  });
});
