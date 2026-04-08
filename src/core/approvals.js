const log = require('./log');

/**
 * Approval workflow engine.
 * Enforces role-based approval chains with risk-based escalation.
 */
class ApprovalEngine {
  constructor(releases, config) {
    this.releases = releases;
    this.config = config;
  }

  /**
   * Get required approval roles for a release.
   * High-risk releases require additional approvers.
   */
  getRequired(release) {
    const required = [...this.config.approvals.required];

    if (release.risk.score === 'high' && this.config.approvals.highRiskAdditional) {
      for (const role of this.config.approvals.highRiskAdditional) {
        if (!required.includes(role)) required.push(role);
      }
    }

    return required;
  }

  /**
   * Get collected approval roles.
   */
  getCollected(release) {
    return release.approvals.map(a => a.role);
  }

  /**
   * Get missing approval roles.
   */
  getMissing(release) {
    const required = this.getRequired(release);
    const collected = this.getCollected(release);
    return required.filter(r => !collected.includes(r));
  }

  /**
   * Check if a release is fully approved.
   */
  isFullyApproved(release) {
    return this.getMissing(release).length === 0;
  }

  /**
   * Record an approval. Returns { release, fullyApproved, missing }.
   */
  approve(version, user, role) {
    const release = this.releases.get(version);
    if (!release) throw new Error(`Release ${version} not found`);

    const required = this.getRequired(release);
    if (!required.includes(role)) {
      throw new Error(`Role "${role}" is not a required approver. Required: ${required.join(', ')}`);
    }

    this.releases.addApproval(version, { user, role });

    const missing = this.getMissing(release);
    const fullyApproved = missing.length === 0;

    if (fullyApproved) {
      log.info(`Release ${version} is fully approved`);
    }

    return { release, fullyApproved, missing };
  }

  /**
   * Get approval status summary for a release.
   */
  getStatus(version) {
    const release = this.releases.get(version);
    if (!release) throw new Error(`Release ${version} not found`);

    return {
      required: this.getRequired(release),
      collected: release.approvals,
      missing: this.getMissing(release),
      fullyApproved: this.isFullyApproved(release),
    };
  }
}

module.exports = ApprovalEngine;
