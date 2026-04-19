const log = require('./log');
const JiraClient = require('../integrations/jira');

/**
 * Truth Sync — Background process that computes per-ticket truth
 * for active releases using persisted data (no live API calls).
 *
 * Reads from:
 *   - CommitStore (git_commits, commit_jira_keys)
 *   - TicketStore (jira_tickets)
 *   - PrStore (github_prs, pr_jira_keys)
 *
 * Writes to:
 *   - ticket_truth table (via TicketStore.upsertTruthBatch)
 *
 * Uses the same _verifyTicket logic as ReleaseTruth — imported directly
 * from the ReleaseTruth class to avoid duplication.
 */
class TruthSync {
  /**
   * @param {ReleaseManager} releases
   * @param {RepoManager} repoManager
   * @param {CommitStore} commitStore
   * @param {TicketStore} ticketStore
   * @param {PrStore} prStore
   * @param {object} config
   */
  constructor(releases, repoManager, commitStore, ticketStore, prStore, config) {
    this.releases = releases;
    this.repoManager = repoManager;
    this.commitStore = commitStore;
    this.ticketStore = ticketStore;
    this.prStore = prStore;
    this.config = config;

    // Import the ReleaseTruth class for _verifyTicket reuse.
    // We instantiate a lightweight instance just for the verification method.
    const ReleaseTruth = require('./release-truth');
    this._truthEngine = new ReleaseTruth(releases, repoManager, null, null, config);
  }

  /**
   * Run truth computation for all active releases.
   * @returns {{ computed: number, errors: string[], durationMs: number }}
   */
  async run() {
    const startTime = Date.now();
    const activeReleases = this.releases.active();
    let computed = 0;
    const errors = [];

    for (const release of activeReleases) {
      if (!release.repo) continue; // skip legacy releases without repo

      try {
        await this.computeRelease(release.repo, release.version);
        computed++;
      } catch (err) {
        const msg = `${release.repo}:${release.version}: ${err.message}`;
        errors.push(msg);
        log.warn(`[truth-sync] Error computing ${msg}`);
      }
    }

    const durationMs = Date.now() - startTime;
    log.info(`[truth-sync] Computed truth for ${computed} releases in ${durationMs}ms (${errors.length} errors)`);
    return { computed, errors, durationMs };
  }

  /**
   * Sync git commits for a single release branch into the CommitStore.
   *
   * Two sets of commits are stored:
   *   1. All JIRA-keyed commits on the branch (isPostCut=0)
   *   2. Post-cut commits only (isPostCut=1) -- the cherry-picks
   *
   * @param {string} repo
   * @param {string} branch - The release branch name
   * @param {string} jiraProject - JIRA project prefix (e.g., 'DEV')
   */
  async syncCommitsForBranch(repo, branch, jiraProject = 'DEV') {
    try {
      // 1. Get all JIRA-keyed commits on the branch
      const allCommits = await this.repoManager.commitsWithJiraKeys(repo, branch, jiraProject);

      // Clear existing and re-sync
      this.commitStore.clearBranch(repo, branch);

      // Store all commits as non-post-cut first
      if (allCommits.length > 0) {
        this.commitStore.syncBranch(repo, branch, allCommits, false);
      }

      // 2. Find post-cut commits using merge-base with master/main
      let baseRef = null;
      for (const candidate of ['master', 'main']) {
        const mergeBase = await this.repoManager.mergeBase(repo, candidate, branch);
        if (mergeBase) { baseRef = mergeBase; break; }
      }

      if (baseRef) {
        const range = `${baseRef}..${branch}`;
        const postCutCommits = await this.repoManager.log(repo, range);

        // Mark post-cut commits
        if (postCutCommits.length > 0) {
          this.commitStore.syncBranch(repo, branch, postCutCommits, true);
        }
      }
    } catch (err) {
      log.warn(`[truth-sync] Failed to sync commits for ${repo}:${branch}: ${err.message}`);
    }
  }

  /**
   * Compute truth for a single release and persist results.
   *
   * @param {string} repo
   * @param {string} version
   */
  async computeRelease(repo, version) {
    const release = this.releases.get(version, repo);
    if (!release) throw new Error(`Release ${repo}:${version} not found`);

    const repoConfig = this.config.repos.find(r => r.name === repo);
    if (!repoConfig) throw new Error(`Repo ${repo} not configured`);

    const branchExists = !!release.branch;
    let gitKeys = new Set();
    let pickedKeys = new Set();

    if (branchExists) {
      // Check if commits are already in the CommitStore for this branch.
      // If not, sync them from git first.
      const existing = this.commitStore.getForBranch(repo, release.branch);
      if (existing.length === 0) {
        const jiraProject = repoConfig.jiraProject || 'DEV';
        try {
          await this.repoManager.fetch(repo);
        } catch (err) {
          log.warn(`[truth-sync] Fetch failed for ${repo}: ${err.message}`);
        }
        await this.syncCommitsForBranch(repo, release.branch, jiraProject);
      }

      // Read from CommitStore
      gitKeys = this.commitStore.getKeysForBranch(repo, release.branch);
      pickedKeys = this.commitStore.getPostCutKeysForBranch(repo, release.branch);
    }

    // Get tickets from TicketStore
    const allTickets = this.releases.getTickets(release);
    const jiraTickets = allTickets.filter(t => t.source === 'jira');
    const jiraKeys = new Set(jiraTickets.map(t => t.key));

    // Get open PRs from PrStore (instead of GitHub API)
    const prByKey = new Map();
    if (branchExists && this.prStore) {
      // Find PRs targeting the release branch that are still open
      const openPrs = this.prStore.getByFilter({
        status: 'open',
        limit: 500,
      });
      for (const pr of openPrs.prs) {
        if (pr.baseBranch !== release.branch) continue;
        const text = (pr.prTitle || '') + ' ' + (pr.prUrl || '');
        const keys = JiraClient.extractKeys(text);

        // Also look up JIRA keys from the pr_jira_keys junction table
        const prJiraKeys = this.prStore.findByJiraKey ? [] : [];
        // Use the PR's linked JIRA keys
        const prRecord = this.prStore.get(pr.repo, pr.prNumber);
        const linkedKeys = prRecord ? (prRecord.jiraKeys || []) : [];
        const allKeys = new Set([...keys, ...linkedKeys]);

        for (const k of allKeys) {
          prByKey.set(k, {
            prNumber: pr.prNumber,
            prTitle: pr.prTitle,
            prAuthor: pr.prAuthor,
            prUrl: pr.prUrl,
            prCreatedAt: pr.prCreatedAt,
          });
        }
      }
    }

    // Verify each JIRA ticket using ReleaseTruth._verifyTicket
    const branchHasCommits = branchExists && gitKeys.size > 0;
    const truthRows = [];

    for (const ticket of jiraTickets) {
      const result = this._truthEngine._verifyTicket(
        ticket, gitKeys, prByKey, branchHasCommits, version
      );

      truthRows.push({
        jiraKey: result.key,
        repo,
        version,
        health: result.health,
        healthCategory: result.healthCategory,
        healthMessage: result.healthMessage || null,
        onBranch: result.onBranch,
        prNumber: result.pr ? result.pr.prNumber : null,
        prUrl: result.pr ? result.pr.prUrl : null,
        stage: result.stage,
        inTarget: result.inTarget,
        inFixVersion: result.inFixVersion,
      });
    }

    // NOTE: Rogue detection is NOT done here. Rogues only make sense in the
    // context of a deployment impact diff (prod version → target version).
    // Without knowing the prod version, we can't distinguish inherited commits
    // from actual rogues. See ReleaseTruth.computeImpact() for rogue detection.

    // Clear old truth and write new results
    this.ticketStore.clearTruthForRelease(repo, version);
    if (truthRows.length > 0) {
      this.ticketStore.upsertTruthBatch(truthRows);
    }
  }
}

module.exports = TruthSync;
