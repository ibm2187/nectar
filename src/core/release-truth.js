const log = require('./log');
const JiraClient = require('../integrations/jira');

/**
 * Release Truth Engine — Per-Ticket Verification
 *
 * For each ticket in a release, computes a health verdict by reconciling:
 *   - JIRA workflow status (Ready for Testing, In QA, Certified, etc.)
 *   - Cherry-pick PR state (open, merged, none)
 *   - Whether the commit is actually on the release branch
 *
 * Surfaces "lying" tickets where JIRA workflow says one thing but reality differs.
 */

// JIRA status → workflow stage
const STATUS_STAGES = {
  // Stage 1: Pre-development
  'open': 'pre-dev',
  'to do': 'pre-dev',
  'ready to develop': 'pre-dev',

  // Stage 2: In development
  'in progress': 'in-dev',
  'development in progress': 'in-dev',
  'in development': 'in-dev',
  'code review': 'in-dev',
  'in review': 'in-dev',

  // Stage 3: Awaiting cherry-pick
  'waiting for cherry pick': 'awaiting-cp',
  'ready for cherry pick': 'awaiting-cp',

  // Stage 4: On branch, in QA
  'cherry picked': 'in-qa',
  'ready for testing': 'in-qa',
  'ready for qa': 'in-qa',
  'in testing': 'in-qa',
  'testing in branch': 'in-qa',
  'retest after cherrypick': 'in-qa',
  'in qa': 'in-qa',

  // Stage 4b: Needs re-investigation (pre-work, not active testing)
  // "Re-verify Bug" = something might have incidentally fixed this, check before doing more work
  're-verify bug': 'needs-review',
  'needs re-verification': 'needs-review',

  // Stage 5: Failed QA — needs rework
  'testing failed': 'failed-qa',
  'failed qa': 'failed-qa',
  'rejected': 'failed-qa',

  // Stage 6: Certified — done
  'qa certified': 'certified',
  'no qa - certified': 'certified',
  'qa done': 'certified',
  'done': 'certified',
  'closed': 'certified',
  'resolved': 'certified',
  'released': 'released',
  'resolved without code': 'resolved-no-code',
  'wont do': 'resolved-no-code',
  'won\'t do': 'resolved-no-code',
  'duplicate': 'resolved-no-code',
  'cancelled': 'resolved-no-code',

  // Blocked states
  'blocked': 'blocked',
  'needs requirements': 'blocked',
  'on hold': 'blocked',
};

function getStage(jiraStatus) {
  if (!jiraStatus) return 'unknown';
  return STATUS_STAGES[jiraStatus.toLowerCase()] || 'unknown';
}

class ReleaseTruth {
  constructor(releases, repoManager, github, config) {
    this.releases = releases;
    this.repoManager = repoManager;
    this.github = github;
    this.config = config;
  }

  async compute(repo, version) {
    const release = this.releases.get(version, repo);
    if (!release) throw new Error(`Release ${repo}:${version} not found`);

    const startTime = Date.now();
    const repoConfig = this.config.repos.find(r => r.name === repo);
    if (!repoConfig) throw new Error(`Repo ${repo} not configured`);

    // ── 1. Get JIRA-sourced tickets ──────────────────────
    // Only tickets that came from JIRA sync are part of the planned set.
    const allTickets = release.tickets || [];
    const jiraTickets = allTickets.filter(t => t.source === 'jira');
    const jiraKeys = new Set(jiraTickets.map(t => t.key));

    // ── 2. Get commits on the release branch ─────────────
    // We need TWO sets:
    //   gitKeys     = ALL JIRA keys on branch (including inherited from master)
    //                 → used to answer "is this ticket on the branch?"
    //   pickedKeys  = JIRA keys added AFTER branch was cut (cherry-picks)
    //                 → used to detect rogues (post-cut commits not in JIRA fixVersion)
    const branchExists = !!release.branch;
    let gitCommits = [];
    let gitKeys = new Set();
    let pickedCommits = [];
    let pickedKeys = new Set();

    if (branchExists) {
      // Fetch latest before reading — ensures we see cherry-picks that just landed
      try {
        await this.repoManager.fetch(repo);
      } catch (err) {
        log.warn(`Truth: fetch failed for ${repo}: ${err.message}`);
      }

      const jiraProject = repoConfig.jiraProject || 'DEV';

      try {
        // All JIRA-keyed commits on the branch (full history)
        gitCommits = await this.repoManager.commitsWithJiraKeys(repo, release.branch, jiraProject);
        for (const commit of gitCommits) {
          for (const k of JiraClient.extractKeys(commit.message)) {
            gitKeys.add(k);
          }
        }
      } catch (err) {
        log.warn(`Truth: failed to read git log for ${repo}:${version}: ${err.message}`);
      }

      // Find post-cut commits (cherry-picks) using merge-base with master
      try {
        let baseRef = null;
        for (const candidate of ['master', 'main']) {
          const mergeBase = await this.repoManager.mergeBase(repo, candidate, release.branch);
          if (mergeBase) { baseRef = mergeBase; break; }
        }
        if (baseRef) {
          // git log baseRef..branch — only the post-cut commits
          const range = `${baseRef}..${release.branch}`;
          pickedCommits = await this.repoManager.log(repo, range);
          for (const commit of pickedCommits) {
            for (const k of JiraClient.extractKeys(commit.message)) {
              pickedKeys.add(k);
            }
          }
        }
      } catch (err) {
        log.warn(`Truth: failed to compute cherry-picks for ${repo}:${version}: ${err.message}`);
      }
    }

    // ── 3. Get OPEN PRs targeting the release branch ─────
    const prByKey = new Map(); // jiraKey → PR info
    let openPRsCount = 0;

    if (this.github.isConfigured() && branchExists) {
      try {
        const openPRs = await this.github.listPRsForBranch(
          release.branch, 'open', repoConfig.github
        );
        openPRsCount = openPRs.length;

        for (const pr of openPRs) {
          const text = (pr.title || '') + ' ' + (pr.body || '').slice(0, 500);
          const keys = JiraClient.extractKeys(text);
          for (const k of keys) {
            prByKey.set(k, {
              prNumber: pr.number,
              prTitle: pr.title,
              prAuthor: pr.user ? pr.user.login : null,
              prUrl: pr.html_url,
              prCreatedAt: pr.created_at,
            });
          }
        }
      } catch (err) {
        log.warn(`Truth: failed to fetch PRs for ${repo}:${version}: ${err.message}`);
      }
    }

    // ── 4. Verify each JIRA ticket ───────────────────────
    // "branchHasCommits" means: branch exists AND has any history we can read.
    // Tickets are checked against ALL commits (including inherited from master),
    // not just post-cut cherry-picks.
    const branchHasCommits = branchExists && gitCommits.length > 0;
    const verified = jiraTickets.map(t => this._verifyTicket(t, gitKeys, prByKey, branchHasCommits));

    // ── 5. Find rogue keys ────────────────────────────────
    // Rogues = JIRA keys cherry-picked POST-CUT but not in JIRA fixVersion.
    // We use pickedKeys (post-cut only) so we don't flag everything inherited from master.
    const rogues = [];
    for (const key of pickedKeys) {
      if (!jiraKeys.has(key)) {
        const commit = pickedCommits.find(c => c.message.includes(key));
        rogues.push({
          key,
          commitSha: commit ? commit.sha : null,
          commitMessage: commit ? commit.message.substring(0, 120) : null,
        });
      }
    }

    // ── 6. Compute rollup by health ──────────────────────
    const rollup = {
      planned: jiraTickets.length,
      done: 0,
      inQa: 0,
      awaitingCp: 0,
      inDev: 0,
      attention: 0,
      rogue: rogues.length,
    };

    for (const v of verified) {
      switch (v.healthCategory) {
        case 'done': rollup.done++; break;
        case 'in-qa': rollup.inQa++; break;
        case 'awaiting-cp': rollup.awaitingCp++; break;
        case 'in-dev': rollup.inDev++; break;
        case 'attention': rollup.attention++; break;
      }
    }

    // ── 7. Derive release state from real data ───────────
    const derivedState = this._deriveState(release, rollup, gitCommits.length);

    return {
      repo,
      version,
      branch: release.branch,
      jira: {
        versionId: release.jiraVersionId || null,
        versionName: release.jiraVersionName || null,
        released: release.jiraReleased || false,
        releaseDate: release.jiraReleaseDate || null,
        archived: release.jiraArchived || false,
      },
      git: {
        branchExists,
        commitCount: gitCommits.length,
        cherryPickCount: pickedCommits.length,
        cutFrom: release.cutFrom || null,
      },
      pullRequests: {
        open: openPRsCount,
      },
      rollup,
      verified,
      rogues,
      derivedState,
      currentState: release.state,
      stateMatchesReality: derivedState === release.state,
      computedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Verify a single ticket — check JIRA status against git+PR reality.
   * Returns ticket with `health`, `healthCategory`, `healthMessage`, and PR info.
   */
  _verifyTicket(ticket, gitKeys, prByKey, branchHasCommits) {
    const jiraStatus = ticket.jiraStatus || 'Unknown';
    const stage = getStage(jiraStatus);
    const onBranch = gitKeys.has(ticket.key);
    const pr = prByKey.get(ticket.key) || null;

    const result = {
      key: ticket.key,
      summary: ticket.summary,
      jiraStatus,
      type: ticket.type || null,
      assignee: ticket.assignee || null,
      stage,
      onBranch,
      branchHasCommits,
      pr,
    };

    // Resolved-without-code is the same regardless of branch state
    if (stage === 'resolved-no-code') {
      result.health = 'no-code';
      result.healthCategory = 'done';
      result.healthMessage = `Resolved without code change (${jiraStatus})`;
      return result;
    }

    // Blocked is the same regardless of branch state
    if (stage === 'blocked') {
      result.health = 'blocked';
      result.healthCategory = 'attention';
      result.healthMessage = jiraStatus;
      return result;
    }

    // Failed QA is always attention
    if (stage === 'failed-qa') {
      result.health = 'failed-qa';
      result.healthCategory = 'attention';
      result.healthMessage = 'Failed QA — needs rework';
      return result;
    }

    // Needs re-verification (e.g., "Re-verify Bug") is a pre-work investigation state.
    // It means "something might have incidentally fixed this, check before doing more work".
    // Never triggers "lying" — not being on branch is expected.
    if (stage === 'needs-review') {
      if (onBranch) {
        result.health = 'in-qa';
        result.healthCategory = 'in-qa';
        result.healthMessage = `${jiraStatus} (already on branch)`;
      } else {
        result.health = 'needs-review';
        result.healthCategory = 'in-dev';
        result.healthMessage = `${jiraStatus} — investigate whether still a bug`;
      }
      return result;
    }

    // ── Branch not yet cut: trust JIRA status alone, no lying detection ─
    if (!branchHasCommits) {
      switch (stage) {
        case 'certified':
        case 'released':
          result.health = 'healthy';
          result.healthCategory = 'done';
          result.healthMessage = `${jiraStatus} (branch not cut yet)`;
          return result;
        case 'in-qa':
          result.health = 'in-qa';
          result.healthCategory = 'in-qa';
          result.healthMessage = `${jiraStatus} (branch not cut yet)`;
          return result;
        case 'awaiting-cp':
          result.health = 'awaiting-cp';
          result.healthCategory = 'awaiting-cp';
          result.healthMessage = 'Waiting for branch cut';
          return result;
        case 'in-dev':
          result.health = 'in-dev';
          result.healthCategory = 'in-dev';
          result.healthMessage = jiraStatus;
          return result;
        case 'pre-dev':
          result.health = 'pre-dev';
          result.healthCategory = 'in-dev';
          result.healthMessage = 'Not started yet';
          return result;
        default:
          result.health = 'unknown';
          result.healthCategory = 'attention';
          result.healthMessage = `Unrecognized status: ${jiraStatus}`;
          return result;
      }
    }

    // ── Branch has commits: full verification with discrepancy detection ─
    switch (stage) {
      case 'certified':
      case 'released':
        if (onBranch) {
          result.health = 'healthy';
          result.healthCategory = 'done';
          result.healthMessage = 'Certified and on branch';
        } else if (pr) {
          result.health = 'pr-pending';
          result.healthCategory = 'in-qa';
          result.healthMessage = `Cherry-pick PR open (#${pr.prNumber})`;
        } else {
          result.health = 'stale-cert';
          result.healthCategory = 'attention';
          result.healthMessage = 'Marked certified but NOT on branch — possibly reverted or never picked';
        }
        break;

      case 'in-qa':
        if (onBranch) {
          result.health = 'in-qa';
          result.healthCategory = 'in-qa';
          result.healthMessage = jiraStatus;
        } else if (pr) {
          result.health = 'pr-pending';
          result.healthCategory = 'in-qa';
          result.healthMessage = `Cherry-pick PR open (#${pr.prNumber})`;
        } else {
          result.health = 'lying';
          result.healthCategory = 'attention';
          result.healthMessage = `JIRA says "${jiraStatus}" but no cherry-pick exists`;
        }
        break;

      case 'awaiting-cp':
        if (onBranch) {
          result.health = 'status-stale';
          result.healthCategory = 'in-qa';
          result.healthMessage = 'Already on branch — JIRA status outdated';
        } else if (pr) {
          result.health = 'pr-pending';
          result.healthCategory = 'awaiting-cp';
          result.healthMessage = `Cherry-pick PR open (#${pr.prNumber})`;
        } else {
          result.health = 'awaiting-cp';
          result.healthCategory = 'awaiting-cp';
          result.healthMessage = 'Waiting for cherry-pick';
        }
        break;

      case 'in-dev':
        if (onBranch) {
          result.health = 'status-stale';
          result.healthCategory = 'in-qa';
          result.healthMessage = 'Already on branch — JIRA hasn\'t advanced';
        } else if (pr) {
          result.health = 'pr-pending';
          result.healthCategory = 'awaiting-cp';
          result.healthMessage = `Cherry-pick PR open (#${pr.prNumber})`;
        } else {
          result.health = 'in-dev';
          result.healthCategory = 'in-dev';
          result.healthMessage = jiraStatus;
        }
        break;

      case 'pre-dev':
        result.health = 'pre-dev';
        result.healthCategory = 'in-dev';
        result.healthMessage = 'Not started yet';
        break;

      default:
        result.health = 'unknown';
        result.healthCategory = 'attention';
        result.healthMessage = `Unrecognized status: ${jiraStatus}`;
    }

    return result;
  }

  /**
   * Derive the actual release state from real data.
   */
  _deriveState(release, rollup, commitCount) {
    if (release.jiraReleased) return 'done';
    if (!release.branch) return 'planning';
    if (commitCount === 0) return 'cutting';
    if (rollup.planned > 0 && rollup.done >= rollup.planned) return 'approved';
    if (rollup.planned > 0) return 'stabilizing';
    return 'cutting';
  }
}

// Health priority for sorting (worst first)
ReleaseTruth.HEALTH_PRIORITY = {
  'lying': 1,
  'stale-cert': 2,
  'failed-qa': 3,
  'blocked': 4,
  'unknown': 5,
  'pre-dev': 6,
  'in-dev': 7,
  'awaiting-cp': 8,
  'pr-pending': 9,
  'status-stale': 10,
  'in-qa': 11,
  'healthy': 12,
};

module.exports = ReleaseTruth;
