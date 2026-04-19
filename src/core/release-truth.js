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
  'on hold': 'blocked',

  // Info-gathering states (not a hard block — often in active refinement)
  'needs requirements': 'needs-info',
  'ready for discussion': 'needs-info',
  'needs discussion': 'needs-info',
  'requirements': 'needs-info',
};

function getStage(jiraStatus) {
  if (!jiraStatus) return 'unknown';
  return STATUS_STAGES[jiraStatus.toLowerCase()] || 'unknown';
}

class ReleaseTruth {
  constructor(releases, repoManager, github, jira, config) {
    this.releases = releases;
    this.repoManager = repoManager;
    this.github = github;
    this.jira = jira;
    this.config = config;
    this._cache = new Map();    // key → { result, computedAt }
    this._inflight = new Set(); // keys currently computing
    this._errors = new Map();   // key → { error, at }
  }

  /**
   * Get cached truth result for a release.
   * Returns { status, result?, error?, computedAt? }
   */
  getCached(repo, version) {
    const key = `${repo}:${version}`;
    if (this._inflight.has(key)) {
      // Return stale cache alongside computing status if available
      const cached = this._cache.get(key);
      return { status: 'computing', result: cached?.result || null, computedAt: cached?.computedAt || null };
    }
    const err = this._errors.get(key);
    if (err) {
      const cached = this._cache.get(key);
      return { status: 'error', error: err.error, result: cached?.result || null, computedAt: cached?.computedAt || null };
    }
    const cached = this._cache.get(key);
    if (cached) {
      return { status: 'ready', result: cached.result, computedAt: cached.computedAt };
    }
    return { status: 'none' };
  }

  /**
   * Trigger background truth computation. Returns immediately.
   * Deduplicates — won't start a second computation if one is already running.
   */
  trigger(repo, version) {
    const key = `${repo}:${version}`;
    if (this._inflight.has(key)) return; // already running

    this._inflight.add(key);
    this._errors.delete(key);

    this._computeInner(repo, version)
      .then(result => {
        this._cache.set(key, { result, computedAt: new Date().toISOString() });
        this._inflight.delete(key);
        this._errors.delete(key);
        log.info(`Truth computed: ${key} (${result.durationMs}ms, ${result.rollup.planned} tickets)`);
      })
      .catch(err => {
        this._inflight.delete(key);
        this._errors.set(key, { error: err.message, at: new Date().toISOString() });
        log.error(`Truth computation failed: ${key}: ${err.message}`);
      });
  }

  /**
   * Clear cached result for a release (used before refresh).
   */
  clearCached(repo, version) {
    const key = `${repo}:${version}`;
    this._cache.delete(key);
    this._errors.delete(key);
  }

  /**
   * Synchronous compute — used internally by computeImpact and task input gathering.
   * Uses cache when available, otherwise runs the full computation.
   */
  async compute(repo, version) {
    const key = `${repo}:${version}`;
    const cached = this._cache.get(key);
    if (cached) return cached.result;
    const result = await this._computeInner(repo, version);
    this._cache.set(key, { result, computedAt: new Date().toISOString() });
    return result;
  }

  async _computeInner(repo, version) {
    const release = this.releases.get(version, repo);
    if (!release) throw new Error(`Release ${repo}:${version} not found`);

    const startTime = Date.now();
    const repoConfig = this.config.repos.find(r => r.name === repo);
    if (!repoConfig) throw new Error(`Repo ${repo} not configured`);

    // ── 1. Refresh JIRA statuses live ─────────────────────
    // The periodic JIRA sync may have stale data. When the user explicitly
    // asks for truth (Refresh button), re-fetch current status for every
    // ticket in this release so the health verdicts are based on reality.
    const allTickets = this.releases.getTickets(release);
    const jiraTickets = allTickets.filter(t => t.source === 'jira');

    if (jiraTickets.length > 0 && this.jira && this.jira.isConfigured()) {
      try {
        const keys = jiraTickets.map(t => t.key);
        const jql = JiraClient.buildJQL(keys);
        if (jql) {
          const freshIssues = await this.jira.searchAllIssues(jql, {
            maxResults: keys.length,
            fields: JiraClient.NECTAR_FIELDS,
          });
          const freshByKey = new Map();
          const freshNormalized = [];
          for (const issue of freshIssues) {
            const n = JiraClient.normalizeIssue(issue);
            freshByKey.set(n.key, n);
            freshNormalized.push({
              key: issue.key,
              ...n,
              updatedInJira: issue.fields?.updated || null,
              syncedAt: new Date().toISOString(),
            });
          }

          // Upsert fresh data to TicketStore (if available)
          if (this.releases._ticketStore && freshNormalized.length > 0) {
            this.releases._ticketStore.upsertBatch(freshNormalized);
          }

          // Update the in-memory ticket objects for truth computation
          for (const ticket of jiraTickets) {
            const fresh = freshByKey.get(ticket.key);
            if (fresh) {
              ticket.jiraStatus = fresh.status;
              ticket.state = fresh.state || JiraClient.mapStatus(fresh.status);
              ticket.summary = fresh.summary;
              ticket.type = fresh.type;
              ticket.assignee = fresh.assignee;
              ticket.fixVersions = fresh.fixVersions;
              ticket.targetFixVersions = fresh.targetFixVersions;
              ticket.component = fresh.component;
              ticket.customerTags = fresh.customerTags;
              ticket.qaAssignee = fresh.qaAssignee;
              ticket.deployedEnvironments = fresh.deployedEnvironments;
              ticket.priority = fresh.priority;
              ticket.riskLevel = fresh.riskLevel;
              ticket.customerPriority = fresh.customerPriority;
              ticket.zohoRef = fresh.zohoRef;
            }
          }

          // Prune is implicit — after TicketStore update, getForVersion()
          // will only return tickets that still reference this version.
          log.info(`Truth ${repo}:${version}: refreshed ${freshByKey.size}/${keys.length} ticket statuses from JIRA`);
        }
      } catch (err) {
        log.warn(`Truth ${repo}:${version}: JIRA refresh failed, using cached statuses: ${err.message}`);
      }
    }

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

    const jiraKeys = new Set(jiraTickets.map(t => t.key));

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
    const verified = jiraTickets.map(t => this._verifyTicket(t, gitKeys, prByKey, branchHasCommits, version));

    // ── 5. Rogue detection skipped in base truth ──────────
    // Rogues only make sense in the impact view (computeImpact) where we
    // know the prod version and can compute a proper delta. Without that
    // context, post-cut keys from parent/sibling releases cause massive
    // false positives.
    const rogueKeys = [];

    // Enrich rogues with JIRA ticket data so they render like real tickets
    const rogues = [];
    let rogueJiraMap = new Map();
    if (rogueKeys.length > 0 && this.jira.isConfigured()) {
      try {
        const keyList = rogueKeys.slice(0, 200).map(k => `"${k}"`).join(', ');
        const issues = await this.jira.searchAllIssues(
          `key IN (${keyList})`,
          { fields: JiraClient.NECTAR_FIELDS }
        );
        for (const issue of issues) {
          const normalized = JiraClient.normalizeIssue(issue);
          rogueJiraMap.set(issue.key, normalized);
        }
      } catch (err) {
        log.warn(`Truth: failed to fetch JIRA data for ${rogueKeys.length} rogue keys: ${err.message}`);
      }
    }

    for (const key of rogueKeys) {
      const commit = pickedCommits.find(c => c.message.includes(key));
      const jira = rogueJiraMap.get(key);
      rogues.push({
        key,
        commitSha: commit ? commit.sha : null,
        commitMessage: commit ? commit.message.substring(0, 120) : null,
        // JIRA enrichment (null if ticket not found / JIRA unavailable)
        summary: jira ? jira.summary : null,
        jiraStatus: jira ? jira.status : null,
        type: jira ? jira.type : null,
        assignee: jira ? jira.assignee : null,
        component: jira ? jira.component : null,
        fixVersions: jira ? jira.fixVersions : null,
      });
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
  _verifyTicket(ticket, gitKeys, prByKey, branchHasCommits, releaseVersion) {
    const jiraStatus = ticket.jiraStatus || 'Unknown';
    const stage = getStage(jiraStatus);
    const onBranch = gitKeys.has(ticket.key);
    const pr = prByKey.get(ticket.key) || null;

    // Membership of this ticket in the current release, split by source.
    const targetVersions = Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [];
    const actualVersions = Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [];
    const inTarget = targetVersions.includes(releaseVersion);
    const inFixVersion = actualVersions.includes(releaseVersion);

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
      fixVersions: actualVersions,
      targetFixVersions: targetVersions,
      inTarget,
      inFixVersion,
      component: ticket.component || null,
      customerTags: Array.isArray(ticket.customerTags) ? ticket.customerTags : [],
      qaAssignee: ticket.qaAssignee || null,
      deployedEnvironments: Array.isArray(ticket.deployedEnvironments) ? ticket.deployedEnvironments : [],
      zohoRef: ticket.zohoRef || null,
    };

    // Resolved-without-code is the same regardless of branch state
    if (stage === 'resolved-no-code') {
      result.health = 'no-code';
      result.healthCategory = 'done';
      result.healthMessage = `Resolved without code change (${jiraStatus})`;
      return result;
    }

    // Blocked — but if the code is already on the branch, the block
    // is resolved (or was never a code block in the first place).
    if (stage === 'blocked') {
      if (onBranch) {
        result.health = 'in-qa';
        result.healthCategory = 'in-qa';
        result.healthMessage = `${jiraStatus} (code is on branch — JIRA status may be outdated)`;
      } else {
        result.health = 'blocked';
        result.healthCategory = 'attention';
        result.healthMessage = jiraStatus;
      }
      return result;
    }

    // Needs info / requirements — not a blocker, just refinement.
    // If the code is on the branch, it's effectively done (dev work complete).
    if (stage === 'needs-info') {
      if (onBranch) {
        result.health = 'status-stale';
        result.healthCategory = 'in-qa';
        result.healthMessage = `${jiraStatus} (code is on branch — dev work complete)`;
      } else {
        result.health = 'needs-review';
        result.healthCategory = 'in-dev';
        result.healthMessage = `${jiraStatus} — refinement in progress`;
      }
      return result;
    }

    // Failed QA — needs rework. Language differs based on whether code is on branch.
    if (stage === 'failed-qa') {
      result.health = 'failed-qa';
      result.healthCategory = 'attention';
      result.healthMessage = onBranch
        ? 'Failed QA — awaiting re-test or new fix'
        : 'Failed QA — rework required, not yet on branch';
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
          // Neutral framing: the code isn't on the branch yet.
          // Could be: already shipped in a prior release, pending cherry-pick,
          // or tagged with wrong fixVersion. We can't tell which without more data.
          result.health = 'not-on-branch';
          result.healthCategory = 'attention';
          result.healthMessage = `${jiraStatus} in JIRA but not found on this branch — needs cherry-pick or wrong fixVersion`;
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
          result.health = 'not-on-branch';
          result.healthCategory = 'attention';
          result.healthMessage = `${jiraStatus} in JIRA but not found on this branch — needs cherry-pick`;
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
        // Unknown JIRA status — if it's on the branch, the dev work is done
        // regardless of what JIRA says. Only flag as attention if NOT on branch.
        if (onBranch) {
          result.health = 'status-stale';
          result.healthCategory = 'in-qa';
          result.healthMessage = `${jiraStatus} (on branch — unrecognized JIRA status)`;
        } else {
          result.health = 'unknown';
          result.healthCategory = 'attention';
          result.healthMessage = `Unrecognized status: ${jiraStatus}`;
        }
    }

    return result;
  }

  /**
   * Compute the deployment impact of moving from one version to another.
   * Answers: "What changes when we deploy targetVersion to environments
   * currently running prodVersion?"
   *
   * @param {string} repo — e.g., 'webplatform'
   * @param {string} targetVersion — the release being deployed (e.g., '4.2.2')
   * @param {string} prodVersion — what's currently in production (e.g., '4.1.0.3')
   * @returns {Promise<object>} impact report
   */
  async computeImpact(repo, targetVersion, prodVersion) {
    const startTime = Date.now();
    const repoConfig = this.config.repos.find(r => r.name === repo);
    if (!repoConfig) throw new Error(`Repo ${repo} not configured`);

    // ── 1. Compute full truth for the target release ────────
    const targetTruth = await this.compute(repo, targetVersion);

    // ── 2. Get prod release info ────────────────────────────
    const prodRelease = this.releases.get(prodVersion, repo);
    const prodBranch = prodRelease ? prodRelease.branch : `${repoConfig.releaseBranchPrefix || 'releases/'}${prodVersion}`;

    // ── 3. Git delta between prod and target ────────────────
    let deltaCommits = [];
    let deltaJiraKeys = new Set();

    if (targetTruth.branch && prodBranch) {
      try {
        await this.repoManager.fetch(repo);
      } catch { /* already fetched by compute() above */ }

      try {
        const range = `${prodBranch}..${targetTruth.branch}`;
        deltaCommits = await this.repoManager.log(repo, range);

        const jiraProject = repoConfig.jiraProject || 'DEV';
        for (const commit of deltaCommits) {
          for (const key of JiraClient.extractKeys(commit.message)) {
            deltaJiraKeys.add(key);
          }
        }
      } catch (err) {
        log.warn(`Impact: git delta failed for ${prodBranch}..${targetTruth.branch}: ${err.message}`);
      }
    }

    // ── 4. Diff tickets ─────────────────────────────────────
    // "New" tickets = in target truth's verified list but NOT in prod's
    // fixVersion. We use the git delta as the authoritative signal for
    // "what's new" — a ticket is new if its key appears in commits
    // between prod and target.
    const prodTicketKeys = new Set();
    if (prodRelease) {
      for (const t of this.releases.getTickets(prodRelease)) {
        prodTicketKeys.add(t.key);
      }
    }

    const targetTicketMap = new Map();
    for (const t of targetTruth.verified) {
      targetTicketMap.set(t.key, t);
    }

    const newTickets = [];
    const sharedTickets = [];

    for (const ticket of targetTruth.verified) {
      if (prodTicketKeys.has(ticket.key)) {
        sharedTickets.push(ticket);
      } else {
        newTickets.push(ticket);
      }
    }

    // Also check: JIRA keys in the git delta that aren't in the target's
    // fixVersion — these are commits landing but not tracked as planned tickets.
    // They'll appear in the target's rogues already, so just count them.
    const deltaOnlyKeys = [...deltaJiraKeys].filter(k => !targetTicketMap.has(k) && !prodTicketKeys.has(k));

    // Filter rogues to only those in the delta range (between prod and target).
    // Without this, the impact view shows ALL rogues on the entire branch since
    // it diverged from master, most of which shipped in prior releases.
    const deltaRogues = targetTruth.rogues.filter(r => deltaJiraKeys.has(r.key));

    // ── 5. Rollup of new tickets only ───────────────────────
    const rollup = {
      planned: newTickets.length,
      done: 0, inQa: 0, awaitingCp: 0, inDev: 0, attention: 0,
    };
    for (const t of newTickets) {
      switch (t.healthCategory) {
        case 'done': rollup.done++; break;
        case 'in-qa': rollup.inQa++; break;
        case 'awaiting-cp': rollup.awaitingCp++; break;
        case 'in-dev': rollup.inDev++; break;
        case 'attention': rollup.attention++; break;
      }
    }

    return {
      target: {
        version: targetVersion,
        branch: targetTruth.branch,
      },
      prod: {
        version: prodVersion,
        branch: prodBranch,
      },

      // The full truth for the target — available for the "Full View" toggle
      targetTruth,

      delta: {
        commits: {
          total: deltaCommits.length,
          jiraKeys: [...deltaJiraKeys],
        },

        tickets: {
          new: newTickets,
          shared: sharedTickets,
          deltaOnly: deltaOnlyKeys, // in git delta but not in either fixVersion
          total: newTickets.length,
        },

        rollup,
        rogues: deltaRogues,
      },

      computedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    };
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
  'failed-qa': 1,
  'not-on-branch': 2,
  'blocked': 3,
  'unknown': 4,
  'needs-review': 5,
  'pre-dev': 6,
  'in-dev': 7,
  'awaiting-cp': 8,
  'pr-pending': 9,
  'status-stale': 10,
  'in-qa': 11,
  'healthy': 12,
  'no-code': 13,
};

module.exports = ReleaseTruth;
