import { describe, it, expect, beforeEach, vi } from 'vitest';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const { createTestDb } = require('../../src/core/db');

describe('ApprovalEngine', () => {
  let audit, releases, approvals, db;

  const config = {
    approvals: {
      required: ['engineering', 'qa'],
      highRiskAdditional: ['product'],
    },
  };

  beforeEach(() => {
    db = createTestDb();
    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });
    approvals = new ApprovalEngine(releases, config);
  });

  it('returns required roles', () => {
    releases.create({ version: '4.2.0' });
    const release = releases.get('4.2.0');
    const required = approvals.getRequired(release);
    expect(required).toEqual(['engineering', 'qa']);
  });

  it('adds product role for high-risk releases', () => {
    releases.create({ version: '4.2.0' });
    releases.update('4.2.0', { risk: { score: 'high', numericScore: 90, factors: [] } });
    const release = releases.get('4.2.0');
    const required = approvals.getRequired(release);
    expect(required).toContain('product');
    expect(required).toHaveLength(3);
  });

  it('approve records approval and returns status', () => {
    releases.create({ version: '4.2.0' });
    const result = approvals.approve('4.2.0', 'jsmith', 'engineering');
    expect(result.fullyApproved).toBe(false);
    expect(result.missing).toEqual(['qa']);
  });

  it('throws for non-required role', () => {
    releases.create({ version: '4.2.0' });
    expect(() => approvals.approve('4.2.0', 'jsmith', 'legal'))
      .toThrow('not a required approver');
  });

  it('full approval chain works', () => {
    releases.create({ version: '4.2.0' });
    approvals.approve('4.2.0', 'user1', 'engineering');
    const result = approvals.approve('4.2.0', 'user2', 'qa');
    expect(result.fullyApproved).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('isFullyApproved checks all roles', () => {
    releases.create({ version: '4.2.0' });
    const release = releases.get('4.2.0');
    expect(approvals.isFullyApproved(release)).toBe(false);

    approvals.approve('4.2.0', 'u1', 'engineering');
    approvals.approve('4.2.0', 'u2', 'qa');
    expect(approvals.isFullyApproved(releases.get('4.2.0'))).toBe(true);
  });

  it('getStatus returns summary', () => {
    releases.create({ version: '4.2.0' });
    approvals.approve('4.2.0', 'u1', 'engineering');
    const status = approvals.getStatus('4.2.0');
    expect(status.required).toEqual(['engineering', 'qa']);
    expect(status.collected).toHaveLength(1);
    expect(status.missing).toEqual(['qa']);
    expect(status.fullyApproved).toBe(false);
  });

  it('throws for nonexistent release', () => {
    expect(() => approvals.approve('nonexistent', 'u', 'engineering'))
      .toThrow('not found');
    expect(() => approvals.getStatus('nonexistent'))
      .toThrow('not found');
  });
});
