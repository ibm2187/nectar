const log = require('./log');

/**
 * Pre-release validation.
 * Checks JIRA, git, and CI are all in sync before a release can be approved.
 */
class ReleaseValidator {
  constructor(releases, jira, github, jenkins, config) {
    this.releases = releases;
    this.jira = jira;
    this.github = github;
    this.jenkins = jenkins;
    this.config = config;
  }

  /**
   * Run full validation for a release. Returns a structured report.
   */
  async validate(version) {
    const release = this.releases.get(version);
    if (!release) throw new Error(`Release ${version} not found`);

    const report = {
      version,
      state: release.state,
      timestamp: new Date().toISOString(),
      jira: { ok: true, issues: [] },
      git: { ok: true, issues: [] },
      ci: { ok: true, issues: [] },
      approvals: { ok: true, issues: [] },
      ready: false,
    };

    // ── JIRA validation ─────────────────────────────────
    if (this.jira.isConfigured() && release.tickets.length > 0) {
      await this._validateJira(release, report);
    } else {
      // Validate from local ticket state
      this._validateTicketsLocal(release, report);
    }

    // ── Git validation ──────────────────────────────────
    this._validateGit(release, report);

    // ── CI validation ───────────────────────────────────
    if (this.jenkins.isConfigured()) {
      await this._validateCI(release, report);
    } else {
      this._validateCILocal(release, report);
    }

    // ── Approval validation ─────────────────────────────
    this._validateApprovals(release, report);

    // ── Overall readiness ───────────────────────────────
    report.ready = report.jira.ok && report.git.ok && report.ci.ok && report.approvals.ok;

    return report;
  }

  async _validateJira(release, report) {
    const keys = release.tickets.map(t => t.key);
    if (!keys.length) return;

    try {
      const jql = require('../integrations/jira').buildJQL(keys);
      if (!jql) return;

      const issues = await this.jira.searchIssues(jql);
      const issueMap = new Map(issues.map(i => [i.key, i]));

      for (const ticket of release.tickets) {
        const jiraIssue = issueMap.get(ticket.key);
        if (!jiraIssue) {
          report.jira.issues.push({ key: ticket.key, problem: 'Not found in JIRA' });
          report.jira.ok = false;
          continue;
        }

        const status = jiraIssue.fields.status.name;

        // Flag tickets still in progress
        if (status.toLowerCase().includes('in progress') ||
            status.toLowerCase().includes('to do') ||
            status.toLowerCase().includes('open')) {
          report.jira.issues.push({
            key: ticket.key,
            problem: `Still in "${status}" — expected cherry-picked or ready for testing`,
            status,
          });
          report.jira.ok = false;
        }

        // Update local ticket state from JIRA
        if (status.toLowerCase().includes('cherry picked')) {
          ticket.state = 'cherry-picked';
        }
      }
    } catch (err) {
      report.jira.issues.push({ problem: `JIRA query failed: ${err.message}` });
      // Don't fail the whole validation on JIRA errors
    }
  }

  _validateTicketsLocal(release, report) {
    const pending = release.tickets.filter(t => t.state === 'pending');
    if (pending.length > 0) {
      report.jira.ok = false;
      for (const t of pending) {
        report.jira.issues.push({ key: t.key, problem: 'Still pending — not cherry-picked' });
      }
    }
  }

  _validateGit(release, report) {
    // Check all cherry-picks are merged
    const unmerged = release.cherryPicks.filter(c => c.status !== 'merged');
    if (unmerged.length > 0) {
      report.git.ok = false;
      for (const cp of unmerged) {
        report.git.issues.push({
          pr: cp.pr,
          sha: cp.sha,
          ticket: cp.ticket,
          problem: `Cherry-pick PR #${cp.pr || '?'} not merged (status: ${cp.status})`,
        });
      }
    }

    // Check for tickets planned but not cherry-picked
    for (const ticket of release.tickets) {
      if (ticket.state === 'pending') {
        const hasCherryPick = release.cherryPicks.some(c => c.ticket === ticket.key);
        if (!hasCherryPick) {
          report.git.issues.push({
            ticket: ticket.key,
            problem: `Planned for release but no cherry-pick PR found`,
          });
          report.git.ok = false;
        }
      }
    }

    // Check for cherry-picks not in ticket list (orphans)
    for (const cp of release.cherryPicks) {
      if (cp.ticket && !release.tickets.find(t => t.key === cp.ticket)) {
        report.git.issues.push({
          ticket: cp.ticket,
          pr: cp.pr,
          problem: `Cherry-pick for ${cp.ticket} exists but ticket is not in the release plan`,
        });
        // This is a warning, not a blocker
      }
    }
  }

  async _validateCI(release, report) {
    try {
      const ci = await this.jenkins.getCIForRelease(release.version);
      if (ci.status === 'failing') {
        report.ci.ok = false;
        report.ci.issues.push({
          problem: 'CI is failing on release branch',
          buildUrl: ci.buildUrl,
        });
      } else if (ci.status === null) {
        report.ci.issues.push({
          problem: 'No CI builds found for release branch',
        });
        // Not a blocker — CI might not have run yet
      }
    } catch (err) {
      report.ci.issues.push({ problem: `Jenkins check failed: ${err.message}` });
    }
  }

  _validateCILocal(release, report) {
    if (release.ci.status === 'failing') {
      report.ci.ok = false;
      report.ci.issues.push({
        problem: 'CI is failing on release branch',
        buildUrl: release.ci.buildUrl,
      });
    }
  }

  _validateApprovals(release, report) {
    const required = [...this.config.approvals.required];

    // High-risk releases need additional approvers
    if (release.risk.score === 'high' && this.config.approvals.highRiskAdditional) {
      for (const role of this.config.approvals.highRiskAdditional) {
        if (!required.includes(role)) required.push(role);
      }
    }

    const collected = release.approvals.map(a => a.role);
    const missing = required.filter(r => !collected.includes(r));

    if (missing.length > 0) {
      report.approvals.ok = false;
      report.approvals.issues.push({
        problem: `Missing approvals: ${missing.join(', ')}`,
        required,
        collected,
        missing,
      });
    }
  }
}

module.exports = ReleaseValidator;
