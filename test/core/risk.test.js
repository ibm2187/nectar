import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const RiskAssessor = require('../../src/core/risk');
const { createTestDb } = require('../../src/core/db');

describe('RiskAssessor', () => {
  let audit, releases, risk, db;
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
    db = createTestDb();
    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });
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

  it('flags model/schema changes', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'server/models/patient.model.js', additions: 20, deletions: 5 },
        { filename: 'server/models/user.model.js', additions: 10, deletions: 3 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('model/schema'))).toBe(true);
    expect(result.factors.find(f => f.reason.includes('model/schema')).points).toBe(2 * config.risk.weights.modelChange);
  });

  it('flags API route changes', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'server/api/patient/routes/get-patients.js', additions: 15, deletions: 5 },
        { filename: 'server/api/billing.routes.js', additions: 10, deletions: 2 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('API route'))).toBe(true);
  });

  it('flags dependency changes', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'package.json', additions: 5, deletions: 2 },
        { filename: 'server/package.json', additions: 3, deletions: 1 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('Dependency'))).toBe(true);
    expect(result.factors.find(f => f.reason.includes('Dependency')).points).toBe(config.risk.weights.dependencyChange);
  });

  it('scores medium risk for moderate changes', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    // Auth change (12) + model changes (2 * 8 = 16) + dependency (5) = 33 → medium
    mockGithub.compareBranches.mockResolvedValue({
      files: [
        { filename: 'server/middleware/auth.js', additions: 10, deletions: 5 },
        { filename: 'server/models/a.model.js', additions: 5, deletions: 2 },
        { filename: 'server/models/b.model.js', additions: 5, deletions: 2 },
        { filename: 'package.json', additions: 1, deletions: 1 },
      ],
    });

    const result = await risk.assess('4.2.0');
    expect(result.score).toBe('medium');
    expect(result.numericScore).toBeGreaterThan(config.risk.thresholds.low);
    expect(result.numericScore).toBeLessThanOrEqual(config.risk.thresholds.medium);
  });

  it('scores CI failure when Jenkins reports failing', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockResolvedValue({ files: [] });

    // Enable Jenkins and mock CI failure
    mockJenkins = {
      isConfigured: () => true,
      getCIForRelease: vi.fn().mockResolvedValue({ status: 'failing', buildUrl: 'https://ci/123' }),
    };
    risk = new RiskAssessor(releases, mockGithub, mockJenkins, config);

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('CI failing'))).toBe(true);
    expect(result.numericScore).toBeGreaterThanOrEqual(config.risk.weights.ciFailure);
  });

  it('handles GitHub comparison failure gracefully', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.compareBranches.mockRejectedValue(new Error('API rate limit'));

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('GitHub comparison failed'))).toBe(true);
    expect(result.score).toBeDefined();
  });

  it('scores untested cherry-picks', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    // Add cherry-picks to the release
    const release = releases.get('4.2.0');
    release.cherryPicks = [
      { sha: 'abc', pr: 101, ticket: 'DEV-100', status: 'merged' },
      { sha: 'def', pr: 102, ticket: 'DEV-101', status: 'merged' },
    ];

    mockGithub.compareBranches.mockResolvedValue({ files: [] });
    // First PR has no tests, second PR has tests
    mockGithub.getPRFiles
      .mockResolvedValueOnce([{ filename: 'server/api/fix.js' }]) // no tests
      .mockResolvedValueOnce([{ filename: 'server/api/fix.js' }, { filename: 'server/api/fix.spec.js' }]); // has tests

    const result = await risk.assess('4.2.0');
    expect(result.factors.some(f => f.reason.includes('without test files'))).toBe(true);
    expect(result.factors.find(f => f.reason.includes('without test')).points).toBe(config.risk.weights.untestedTicket);
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

  it('returns zero score when GitHub is not configured', async () => {
    releases.create({ version: '4.2.0', cutFrom: 'abc123' });
    releases.update('4.2.0', { branch: 'release/4.2.0' });

    mockGithub.isConfigured = () => false;
    risk = new RiskAssessor(releases, mockGithub, mockJenkins, config);

    const result = await risk.assess('4.2.0');
    expect(result.numericScore).toBe(0);
    expect(result.score).toBe('low');
  });
});
