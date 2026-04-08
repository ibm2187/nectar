const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');

/**
 * Cherry-pick watcher.
 * Polls GitHub for PRs with CHERRY_PICK label targeting release branches.
 * Matches cherry-pick PRs to releases and updates ReleaseManager.
 *
 * Events:
 *   cherry-pick:detected  (release, parsed)
 *   cherry-pick:merged    (release, parsed)
 *   cherry-pick:conflict  (release, parsed)
 */
class CherryPickWatcher extends EventEmitter {
  constructor(releases, github, config) {
    super();
    this.releases = releases;
    this.github = github;
    this.config = config;
    this.seenPRs = new Set(); // Track processed PR numbers
    this._timer = null;
  }

  start() {
    if (!this.github.isConfigured()) {
      log.warn('Cherry-pick watcher disabled (GitHub not configured)');
      return;
    }

    const interval = this.config.polling.githubPRs || 60000;
    log.info(`Cherry-pick watcher started (polling every ${interval / 1000}s)`);

    // Initial poll
    this._poll().catch(err => log.error('Cherry-pick poll error:', err.message));

    this._timer = setInterval(() => {
      this._poll().catch(err => log.error('Cherry-pick poll error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _poll() {
    const prs = await this.github.listCherryPickPRs('all');

    for (const pr of prs) {
      const parsed = this.github.parseCherryPickPR(pr);
      if (!parsed.version) continue;

      const release = this.releases.get(parsed.version);
      if (!release) continue;

      // Check if we've already processed this PR in its current state
      const stateKey = `${pr.number}:${parsed.status}`;
      if (this.seenPRs.has(stateKey)) continue;
      this.seenPRs.add(stateKey);

      // Register cherry-pick on the release
      for (const jiraKey of parsed.jiraKeys) {
        this.releases.addCherryPick(parsed.version, {
          sha: parsed.sha,
          pr: parsed.prNumber,
          ticket: jiraKey,
          status: parsed.status === 'merged' ? 'merged' : 'pending',
        }, 'cherry-pick-watcher');
      }

      // If no JIRA keys found, still register the cherry-pick
      if (parsed.jiraKeys.length === 0) {
        this.releases.addCherryPick(parsed.version, {
          sha: parsed.sha,
          pr: parsed.prNumber,
          ticket: null,
          status: parsed.status === 'merged' ? 'merged' : 'pending',
        }, 'cherry-pick-watcher');
      }

      // Emit events
      if (parsed.status === 'merged') {
        this.emit('cherry-pick:merged', release, parsed);
      } else if (parsed.status === 'open') {
        this.emit('cherry-pick:detected', release, parsed);
      } else if (parsed.status === 'closed' && !pr.merged_at) {
        // Closed without merging — possible conflict
        this.emit('cherry-pick:conflict', release, parsed);
      }
    }

    // Trim seenPRs to prevent unbounded growth (keep last 2000)
    if (this.seenPRs.size > 2000) {
      const arr = [...this.seenPRs];
      this.seenPRs = new Set(arr.slice(-1000));
    }
  }

  /**
   * Manually sync cherry-picks for a specific release version.
   * Useful for initial population or forced refresh.
   */
  async syncRelease(version) {
    const release = this.releases.get(version);
    if (!release) throw new Error(`Release ${version} not found`);

    const prs = await this.github.listPRsForRelease(version);
    let count = 0;

    for (const pr of prs) {
      const hasLabel = pr.labels.some(l => l.name === this.github.cherryPickLabel);
      if (!hasLabel) continue;

      const parsed = this.github.parseCherryPickPR(pr);

      for (const jiraKey of parsed.jiraKeys) {
        this.releases.addCherryPick(version, {
          sha: parsed.sha,
          pr: parsed.prNumber,
          ticket: jiraKey,
          status: parsed.status === 'merged' ? 'merged' : 'pending',
        }, 'cherry-pick-sync');
        count++;
      }

      if (parsed.jiraKeys.length === 0) {
        this.releases.addCherryPick(version, {
          sha: parsed.sha,
          pr: parsed.prNumber,
          ticket: null,
          status: parsed.status === 'merged' ? 'merged' : 'pending',
        }, 'cherry-pick-sync');
        count++;
      }
    }

    return count;
  }
}

module.exports = CherryPickWatcher;
