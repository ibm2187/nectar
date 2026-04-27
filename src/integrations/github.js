const log = require('../core/log');

/**
 * GitHub API client.
 * Uses personal access token (GITHUB_TOKEN) for v1.
 * Can upgrade to GitHub App JWT auth later (mirror Hive's pattern).
 */
class GitHubClient {
  constructor(config) {
    this.token = process.env.GITHUB_TOKEN || '';
    this.repo = (config && config.github && config.github.repo) || 'mavencare/webplatform';
    this.cherryPickLabel = (config && config.github && config.github.cherryPickLabel) || 'CHERRY_PICK';
    this.releaseBranchPrefix = (config && config.github && config.github.releaseBranchPrefix) || 'releases/';
  }

  isConfigured() {
    return !!this.token;
  }

  // ── Core requests ───────────────────────────────────────

  async _request(method, path, body = null) {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    const headers = {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'nectar',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      err.responseBody = text;
      throw err;
    }

    return res.json();
  }

  async _paginate(path, maxPages = 5) {
    const results = [];
    let url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    let page = 0;

    while (url && page < maxPages) {
      const res = await fetch(url, {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'nectar',
        },
      });

      if (!res.ok) break;
      const data = await res.json();
      results.push(...(Array.isArray(data) ? data : []));

      // Parse Link header for next page
      const link = res.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
      page++;
    }

    return results;
  }

  // ── Pull Requests ───────────────────────────────────────

  /**
   * List PRs with CHERRY_PICK label targeting release branches.
   */
  async listCherryPickPRs(state = 'all') {
    const prs = await this._paginate(
      `/repos/${this.repo}/pulls?state=${state}&per_page=100&sort=updated&direction=desc`
    );

    return prs.filter(pr => {
      const hasLabel = pr.labels.some(l => l.name === this.cherryPickLabel);
      const targetsRelease = pr.base.ref.startsWith(this.releaseBranchPrefix);
      return hasLabel && targetsRelease;
    });
  }

  /**
   * List PRs targeting a specific release branch.
   * @param {string} branch - Full branch name (e.g., 'releases/4.2.1')
   * @param {string} state - 'all', 'open', or 'closed'
   * @param {string} repoPath - Optional 'org/repo' override (defaults to this.repo)
   */
  async listPRsForBranch(branch, state = 'all', repoPath = null) {
    const repo = repoPath || this.repo;
    const prs = await this._paginate(
      `/repos/${repo}/pulls?state=${state}&base=${encodeURIComponent(branch)}&per_page=100`
    );
    return prs;
  }

  /**
   * Legacy: list PRs by release version (uses default branch prefix).
   */
  async listPRsForRelease(version, state = 'all') {
    return this.listPRsForBranch(`${this.releaseBranchPrefix}${version}`, state);
  }

  async getPR(number) {
    return this._request('GET', `/repos/${this.repo}/pulls/${number}`);
  }

  async getPRFiles(number) {
    return this._paginate(`/repos/${this.repo}/pulls/${number}/files?per_page=100`);
  }

  // ── Commits & Branches ─────────────────────────────────

  async getCommit(sha) {
    return this._request('GET', `/repos/${this.repo}/commits/${sha}`);
  }

  /**
   * Compare two refs — returns files changed, commits, diff stats.
   * Used for risk scoring.
   */
  async compareBranches(base, head) {
    return this._request('GET', `/repos/${this.repo}/compare/${base}...${head}`);
  }

  async getBranch(branch) {
    return this._request('GET', `/repos/${this.repo}/branches/${branch}`);
  }

  // ── Labels ──────────────────────────────────────────────

  async getPRLabels(number) {
    const pr = await this.getPR(number);
    return pr.labels.map(l => l.name);
  }

  // ── Issues ──────────────────────────────────────────────

  /**
   * List issues for a repo. Note: GitHub's issues API also returns pull requests,
   * so we filter those out (PRs have a `pull_request` property).
   * @param {object} opts
   * @param {string} opts.state - 'open' | 'closed' | 'all' (default 'open')
   * @param {string} [opts.labels] - Comma-separated label names
   * @param {string} [opts.repoPath] - 'org/repo' override (defaults to this.repo)
   */
  async listIssues({ state = 'open', labels = null, repoPath = null } = {}) {
    const repo = repoPath || this.repo;
    const params = new URLSearchParams({ state, per_page: '100', sort: 'updated', direction: 'desc' });
    if (labels) params.set('labels', labels);
    const issues = await this._paginate(`/repos/${repo}/issues?${params}`, 3);
    return issues.filter(i => !i.pull_request);
  }

  /**
   * Create a new issue.
   * @param {object} opts
   * @param {string} opts.title - Required
   * @param {string} [opts.body] - Markdown body
   * @param {string[]} [opts.labels]
   * @param {string} [opts.repoPath] - 'org/repo' override
   */
  async createIssue({ title, body = '', labels = [], repoPath = null }) {
    const repo = repoPath || this.repo;
    if (!title || !title.trim()) throw new Error('Issue title is required');
    const payload = { title };
    if (body) payload.body = body;
    if (labels && labels.length) payload.labels = labels;
    return this._request('POST', `/repos/${repo}/issues`, payload);
  }

  async getIssue(number, repoPath = null) {
    const repo = repoPath || this.repo;
    return this._request('GET', `/repos/${repo}/issues/${number}`);
  }

  // ── Contents / attachments ─────────────────────────────

  /**
   * Get a git ref (e.g., refs/heads/main). Returns null on 404.
   * @param {string} ref - e.g., 'heads/main'
   * @param {string} [repoPath]
   */
  async getRef(ref, repoPath = null) {
    const repo = repoPath || this.repo;
    try {
      return await this._request('GET', `/repos/${repo}/git/ref/${ref}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Create a new branch at the given commit sha. If GitHub responds 422
   * "Reference already exists" (concurrent create race), this resolves
   * normally with `{ raceLost: true }`.
   * @param {string} branch - Bare branch name (e.g., 'issue-attachments')
   * @param {string} sha - Commit sha to point the new ref at
   * @param {string} [repoPath]
   */
  async createBranch(branch, sha, repoPath = null) {
    const repo = repoPath || this.repo;
    try {
      return await this._request('POST', `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha,
      });
    } catch (err) {
      if (err.status === 422 && /already exists/i.test(err.responseBody || err.message)) {
        return { raceLost: true };
      }
      throw err;
    }
  }

  /**
   * Ensure a branch exists; create it from the default branch's HEAD if missing.
   * @param {string} branch - Branch name to ensure
   * @param {string} [repoPath]
   * @returns {Promise<{created: boolean}>}
   */
  async ensureBranch(branch, repoPath = null) {
    const repo = repoPath || this.repo;
    const existing = await this.getRef(`heads/${branch}`, repo);
    if (existing) return { created: false };
    const repoMeta = await this._request('GET', `/repos/${repo}`);
    const defaultBranch = repoMeta.default_branch || 'main';
    const baseRef = await this._request('GET', `/repos/${repo}/git/ref/heads/${defaultBranch}`);
    await this.createBranch(branch, baseRef.object.sha, repo);
    return { created: true };
  }

  /**
   * PUT a file via the Contents API (creates a commit on the target branch).
   * @param {object} opts
   * @param {string} opts.path - Repo-relative path
   * @param {string} opts.contentBase64 - File contents, base64-encoded (no data: prefix)
   * @param {string} opts.message - Commit message
   * @param {string} opts.branch - Target branch
   * @param {string} [opts.repoPath]
   * @returns {Promise<object>} GitHub Contents API response (has content.download_url, content.html_url)
   */
  async uploadContent({ path, contentBase64, message, branch, repoPath = null }) {
    const repo = repoPath || this.repo;
    return this._request('PUT', `/repos/${repo}/contents/${path}`, {
      message,
      content: contentBase64,
      branch,
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  /**
   * Extract release version from a branch name.
   * e.g., 'releases/4.2.1' → '4.2.1'
   */
  extractVersionFromBranch(branch) {
    if (branch.startsWith(this.releaseBranchPrefix)) {
      return branch.slice(this.releaseBranchPrefix.length);
    }
    return null;
  }

  /**
   * Parse a cherry-pick PR to extract metadata.
   * Title format: "CHERRY_PICK: #28781 (DEV-45507) into 4.2.1"
   * Also handles: branch name patterns
   */
  parseCherryPickPR(pr) {
    const titleMatch = pr.title.match(/CHERRY_PICK:\s*#?(\d+)\s*\(([^)]+)\)/i);
    const version = this.extractVersionFromBranch(pr.base.ref);

    let sourcePR = null;
    let jiraKeys = [];

    if (titleMatch) {
      sourcePR = parseInt(titleMatch[1], 10);
      jiraKeys = require('./jira').extractKeys(titleMatch[2]);
    }

    // Fallback: extract JIRA keys from full title
    if (!jiraKeys.length) {
      jiraKeys = require('./jira').extractKeys(pr.title);
    }

    return {
      prNumber: pr.number,
      sha: pr.merge_commit_sha || pr.head.sha,
      sourcePR,
      jiraKeys,
      version,
      status: pr.merged_at ? 'merged' : (pr.state === 'open' ? 'open' : 'closed'),
      branch: pr.head.ref,
      author: pr.user.login,
      url: pr.html_url,
    };
  }
}

module.exports = GitHubClient;
