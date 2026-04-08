const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const log = require('./log');

/**
 * Manages local bare git clones for all configured repos.
 * Used for branch listing, diffing, log parsing, and version reading.
 */
class RepoManager {
  constructor(config) {
    this.config = config;
    this.dataDir = config.dataDir || path.join(require('os').homedir(), '.nectar');
    this.reposDir = path.join(this.dataDir, 'repos');
    this.repoConfigs = new Map();

    for (const repo of config.repos || []) {
      this.repoConfigs.set(repo.name, repo);
    }
  }

  /**
   * Initialize — ensure data directory exists and clone any missing repos.
   */
  async init() {
    fs.mkdirSync(this.reposDir, { recursive: true });

    const results = [];
    for (const [name, repo] of this.repoConfigs) {
      const repoPath = this._repoPath(name);
      if (fs.existsSync(repoPath)) {
        log.info(`Repo ${name}: clone exists at ${repoPath}`);
        // Ensure fetch refspec is configured (may be missing from old clones)
        try {
          await this._exec('git', [
            'config', '--local',
            'remote.origin.fetch',
            '+refs/heads/*:refs/heads/*',
          ], { cwd: repoPath });
        } catch { /* ignore */ }
        results.push({ name, action: 'exists' });
      } else {
        log.info(`Repo ${name}: cloning ${repo.github}...`);
        try {
          // Prefer SSH if available (user likely has SSH keys), fall back to HTTPS with token
          const cloneUrl = process.env.GITHUB_TOKEN
            ? `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repo.github}.git`
            : `git@github.com:${repo.github}.git`;
          await this._exec('git', [
            'clone', '--bare', '--filter=blob:none',
            cloneUrl,
            repoPath,
          ], { cwd: this.reposDir, timeout: 120000 });

          // Add a fetch refspec so subsequent fetches update branch refs,
          // not just FETCH_HEAD. (Bare clones don't configure this by default.)
          await this._exec('git', [
            'config', '--local',
            'remote.origin.fetch',
            '+refs/heads/*:refs/heads/*',
          ], { cwd: repoPath });

          log.info(`Repo ${name}: cloned successfully`);
          results.push({ name, action: 'cloned' });
        } catch (err) {
          log.error(`Repo ${name}: clone failed — ${err.message}`);
          results.push({ name, action: 'failed', error: err.message });
        }
      }
    }

    return results;
  }

  /**
   * Fetch latest from origin for a repo.
   * Uses explicit refspec because --bare clones don't auto-configure one,
   * which means `git fetch origin` alone only updates FETCH_HEAD, not branch refs.
   *
   * Force-flag is needed because force-pushes on feature branches would
   * otherwise cause ref lock errors.
   */
  async fetch(repoName) {
    const repoPath = this._repoPath(repoName);
    if (!fs.existsSync(repoPath)) {
      throw new Error(`Repo ${repoName} not cloned yet`);
    }
    try {
      await this._git(repoName, [
        'fetch', 'origin',
        '+refs/heads/*:refs/heads/*',
        '--prune',
        '--force',
      ]);
    } catch (err) {
      // Log but don't throw on partial failures (common with force-pushes).
      // The important branches (master, releases/*) usually succeed even if
      // some feature branches have ref conflicts.
      log.warn(`Fetch warning for ${repoName}: ${err.message.split('\n')[0]}`);
    }
  }

  /**
   * List branches matching a prefix.
   * In bare clones, branches are under refs/heads/ (not refs/remotes/origin/).
   */
  async listBranches(repoName, prefix = '') {
    const output = await this._git(repoName, [
      'for-each-ref', '--format=%(refname:short)',
      `refs/heads/${prefix}*`,
    ]);
    return output.trim().split('\n').filter(Boolean);
  }

  /**
   * Get the HEAD SHA of a branch.
   */
  async getBranchHead(repoName, branch) {
    const output = await this._git(repoName, ['rev-parse', branch]);
    return output.trim();
  }

  /**
   * Get the date of the most recent commit on a branch.
   */
  async getBranchDate(repoName, branch) {
    const output = await this._git(repoName, [
      'log', '-1', '--format=%aI', branch,
    ]);
    return output.trim();
  }

  /**
   * Diff files between two refs. Returns array of { status, filename }.
   */
  async diffFiles(repoName, base, head) {
    try {
      const output = await this._git(repoName, [
        'diff', '--name-status', base, head,
      ]);
      return output.trim().split('\n').filter(Boolean).map(line => {
        const [status, ...parts] = line.split('\t');
        return { status, filename: parts.join('\t') };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get diff stats between two refs.
   */
  async diffStat(repoName, base, head) {
    try {
      const output = await this._git(repoName, [
        'diff', '--shortstat', base, head,
      ]);
      const match = output.match(/(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/);
      if (!match) return { files: 0, insertions: 0, deletions: 0 };
      return {
        files: parseInt(match[1]) || 0,
        insertions: parseInt(match[2]) || 0,
        deletions: parseInt(match[3]) || 0,
      };
    } catch {
      return { files: 0, insertions: 0, deletions: 0 };
    }
  }

  /**
   * Git log between two refs. Returns array of { sha, message }.
   * @param {string} range - Either a single ref ('release/4.2.1') or range ('master..release/4.2.1')
   * @param {object} opts - { limit?: number, grep?: string }
   */
  async log(repoName, range, opts = {}) {
    const args = ['log', '--oneline'];
    if (opts.limit) args.push(`-${opts.limit}`);
    if (opts.grep) args.push(`--grep=${opts.grep}`);
    args.push(range);

    try {
      const output = await this._git(repoName, args);
      return output.trim().split('\n').filter(Boolean).map(line => {
        const spaceIdx = line.indexOf(' ');
        return {
          sha: line.substring(0, spaceIdx),
          message: line.substring(spaceIdx + 1),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get all commits on a branch that mention a JIRA key.
   * Uses git --grep to filter at the git level (fast, no need to read all commits).
   * Returns the full history of JIRA-related commits on the branch.
   */
  async commitsWithJiraKeys(repoName, branch, jiraProjectPrefix = 'DEV') {
    try {
      // --grep with ERE matches commits whose message contains the prefix
      // -E enables extended regex
      const output = await this._git(repoName, [
        'log', '--oneline', '-E', `--grep=${jiraProjectPrefix}-[0-9]+`, branch,
      ]);
      return output.trim().split('\n').filter(Boolean).map(line => {
        const spaceIdx = line.indexOf(' ');
        return {
          sha: line.substring(0, spaceIdx),
          message: line.substring(spaceIdx + 1),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get the merge-base between two refs (where they diverged).
   */
  async mergeBase(repoName, ref1, ref2) {
    try {
      const output = await this._git(repoName, ['merge-base', ref1, ref2]);
      return output.trim();
    } catch {
      return null;
    }
  }

  /**
   * Read a file at a specific ref.
   * e.g., readFile('webplatform', 'origin/releases/4.1.0', '.version')
   */
  async readFile(repoName, ref, filePath) {
    try {
      return await this._git(repoName, ['show', `${ref}:${filePath}`]);
    } catch {
      return null;
    }
  }

  /**
   * Get repo config by name.
   */
  getRepoConfig(name) {
    return this.repoConfigs.get(name) || null;
  }

  /**
   * List all configured repo names.
   */
  listRepos() {
    return [...this.repoConfigs.keys()];
  }

  /**
   * Get status of all repos (cloned, last fetch, etc.)
   */
  getStatus() {
    return [...this.repoConfigs.entries()].map(([name, config]) => {
      const repoPath = this._repoPath(name);
      const exists = fs.existsSync(repoPath);
      return { name, github: config.github, cloned: exists };
    });
  }

  // ── Internal ────────────────────────────────────────────

  _repoPath(name) {
    return path.join(this.reposDir, `${name}.git`);
  }

  _git(repoName, args) {
    const repoPath = this._repoPath(repoName);
    return this._exec('git', args, { cwd: repoPath, timeout: 60000 });
  }

  _exec(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, {
        maxBuffer: 10 * 1024 * 1024, // 10MB
        ...opts,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          // Use GITHUB_TOKEN for HTTPS auth if available
          ...(process.env.GITHUB_TOKEN ? {
            GIT_ASKPASS: 'echo',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'url.https://x-access-token:' + process.env.GITHUB_TOKEN + '@github.com/.insteadOf',
            GIT_CONFIG_VALUE_0: 'https://github.com/',
          } : {}),
        },
      }, (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          reject(new Error(msg.trim()));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

module.exports = RepoManager;
