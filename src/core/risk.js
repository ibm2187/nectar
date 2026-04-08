const log = require('./log');

/**
 * Risk assessment engine.
 * Analyzes diff between release branch and its cut point to produce a risk score.
 */
class RiskAssessor {
  constructor(releases, github, jenkins, config) {
    this.releases = releases;
    this.github = github;
    this.jenkins = jenkins;
    this.weights = config.risk.weights;
    this.thresholds = config.risk.thresholds;
  }

  /**
   * Assess risk for a release. Updates release.risk and returns the result.
   */
  async assess(version) {
    const release = this.releases.get(version);
    if (!release) throw new Error(`Release ${version} not found`);
    if (!release.cutFrom) throw new Error(`Release ${version} has no cutFrom SHA`);

    const factors = [];
    let totalScore = 0;

    // ── Analyze GitHub diff ─────────────────────────────
    if (this.github.isConfigured()) {
      try {
        const comparison = await this.github.compareBranches(
          release.cutFrom,
          release.branch
        );

        const files = comparison.files || [];
        const totalLines = files.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);

        // Database migrations
        const migrations = files.filter(f => f.filename.startsWith('server/upgrade/'));
        if (migrations.length > 0) {
          const points = migrations.length * this.weights.migration;
          factors.push({ reason: `${migrations.length} database migration(s)`, points, files: migrations.map(f => f.filename) });
          totalScore += points;
        }

        // Billing engine changes
        const billingFiles = files.filter(f => f.filename.startsWith('server/api/rcm_v2/engine/'));
        if (billingFiles.length > 0) {
          factors.push({ reason: 'Billing engine changes', points: this.weights.billingEngine, files: billingFiles.map(f => f.filename) });
          totalScore += this.weights.billingEngine;
        }

        // Model/schema changes
        const modelFiles = files.filter(f => f.filename.endsWith('.model.js'));
        if (modelFiles.length > 0) {
          const points = modelFiles.length * this.weights.modelChange;
          factors.push({ reason: `${modelFiles.length} model/schema change(s)`, points, files: modelFiles.map(f => f.filename) });
          totalScore += points;
        }

        // Auth/permission changes
        const authFiles = files.filter(f =>
          f.filename.includes('acl') ||
          f.filename.includes('permission') ||
          f.filename.includes('auth') ||
          f.filename.includes('rbac')
        );
        if (authFiles.length > 0) {
          factors.push({ reason: 'Auth/permission changes', points: this.weights.authChange, files: authFiles.map(f => f.filename) });
          totalScore += this.weights.authChange;
        }

        // API route changes
        const routeFiles = files.filter(f =>
          f.filename.includes('/routes') || f.filename.includes('.routes.')
        );
        if (routeFiles.length > 0) {
          const points = routeFiles.length * this.weights.apiRoute;
          factors.push({ reason: `${routeFiles.length} API route change(s)`, points, files: routeFiles.map(f => f.filename) });
          totalScore += points;
        }

        // Large diff size
        if (totalLines > 500) {
          const points = Math.floor(totalLines / 500) * this.weights.largeDiff;
          factors.push({ reason: `Large diff (${totalLines} lines)`, points });
          totalScore += points;
        }

        // Dependency changes
        const depFiles = files.filter(f =>
          f.filename === 'package.json' ||
          f.filename === 'server/package.json' ||
          f.filename === 'client/package.json'
        );
        if (depFiles.length > 0) {
          factors.push({ reason: 'Dependency changes', points: this.weights.dependencyChange, files: depFiles.map(f => f.filename) });
          totalScore += this.weights.dependencyChange;
        }
      } catch (err) {
        log.error(`Risk: GitHub comparison failed for ${version}:`, err.message);
        factors.push({ reason: 'GitHub comparison failed (unable to analyze diff)', points: 0 });
      }
    }

    // ── Tickets without tests ───────────────────────────
    if (this.github.isConfigured() && release.cherryPicks.length > 0) {
      let untestedCount = 0;
      for (const cp of release.cherryPicks.slice(0, 20)) { // Cap API calls
        if (!cp.pr) continue;
        try {
          const files = await this.github.getPRFiles(cp.pr);
          const hasSpecs = files.some(f =>
            f.filename.includes('.spec.') ||
            f.filename.includes('.test.') ||
            f.filename.includes('e2e/')
          );
          if (!hasSpecs) untestedCount++;
        } catch {
          // Skip on error
        }
      }
      if (untestedCount > 0) {
        const points = untestedCount * this.weights.untestedTicket;
        factors.push({ reason: `${untestedCount} cherry-pick(s) without test files`, points });
        totalScore += points;
      }
    }

    // ── CI status ───────────────────────────────────────
    if (this.jenkins.isConfigured()) {
      try {
        const ci = await this.jenkins.getCIForRelease(version);
        if (ci.status === 'failing') {
          factors.push({ reason: 'CI failing on release branch', points: this.weights.ciFailure });
          totalScore += this.weights.ciFailure;
        }
        // Also update release CI status
        this.releases.update(version, { ci }, 'risk-assessor');
      } catch (err) {
        log.error(`Risk: Jenkins check failed for ${version}:`, err.message);
      }
    }

    // ── Compute score label ─────────────────────────────
    let score = 'high';
    if (totalScore <= this.thresholds.low) score = 'low';
    else if (totalScore <= this.thresholds.medium) score = 'medium';

    const risk = { score, numericScore: totalScore, factors };
    this.releases.update(version, { risk }, 'risk-assessor');

    return risk;
  }
}

module.exports = RiskAssessor;
