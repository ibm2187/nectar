const cron = require('node-cron');
const log = require('./log');
const SlackNotifier = require('../integrations/slack');

const BLOCKED_STATUSES = new Set(['Blocked', 'Testing Failed']);
const DONE_STATUSES = new Set(['QA Certified', 'Done', 'Closed', 'Resolved', 'Resolved Without Code']);

/**
 * Release channel notifier.
 * Sends periodic status updates to release-specific Slack channels
 * for releases due today or tomorrow.
 */
class ReleaseNotifier {
  constructor(releases, slack, config) {
    this.releases = releases;
    this.slack = slack;
    this.config = config;
    this._tasks = [];
  }

  start() {
    if (!this.slack.isConfigured()) {
      log.warn('Release notifier disabled (Slack not configured)');
      return;
    }

    // Schedule: 9 AM and 2 PM ET on weekdays
    const schedules = [
      '0 9 * * 1-5',   // 9 AM Mon-Fri
      '0 14 * * 1-5',  // 2 PM Mon-Fri
    ];

    for (const schedule of schedules) {
      const task = cron.schedule(schedule, () => {
        this.notifyDueReleases().catch(err =>
          log.error('Release notifier error:', err.message)
        );
      }, { timezone: 'America/New_York' });
      this._tasks.push(task);
    }

    log.info('Release notifier started (9 AM + 2 PM ET, weekdays)');
  }

  stop() {
    for (const task of this._tasks) task.stop();
    this._tasks = [];
  }

  /**
   * Find releases due today/tomorrow and send status to their channels.
   */
  async notifyDueReleases() {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const due = this.releases.list().filter(r =>
      r.state !== 'done' && !r.jiraArchived &&
      r.jiraReleaseDate && (r.jiraReleaseDate <= tomorrow)
    );

    if (due.length === 0) return;

    log.info(`Release notifier: ${due.length} releases due today/tomorrow`);

    for (const release of due) {
      try {
        await this.notifyRelease(release);
      } catch (err) {
        log.warn(`Release notifier: failed for ${release.version}: ${err.message}`);
      }
    }
  }

  /**
   * Send a status update for a single release to its Slack channel.
   */
  async notifyRelease(release) {
    const tickets = release.tickets || [];

    const groupCounts = {
      total: tickets.length,
      inDev: 0,
      blocked: 0,
      readyForQa: 0,
      inQa: 0,
      done: 0,
    };

    const IN_DEV = new Set([
      'Development In Progress', 'In Progress', 'In Review',
      'Waiting for Cherry Pick', 'Open', 'To Do', 'Backlog',
    ]);
    const READY_FOR_QA = new Set(['Ready For Testing', 'Cherry Picked']);
    const IN_QA = new Set(['In Testing', 'Testing in Branch', 'Re-verify Bug']);

    const blockedTickets = [];

    for (const t of tickets) {
      const status = t.jiraStatus || '';
      if (DONE_STATUSES.has(status)) groupCounts.done++;
      else if (BLOCKED_STATUSES.has(status)) { groupCounts.blocked++; blockedTickets.push(t); }
      else if (READY_FOR_QA.has(status)) groupCounts.readyForQa++;
      else if (IN_QA.has(status)) groupCounts.inQa++;
      else if (IN_DEV.has(status)) groupCounts.inDev++;
    }

    const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';
    const nectarBaseUrl = process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com';
    const releaseKey = release.repo ? `${release.repo}:${release.version}` : release.version;

    const result = await this.slack.notifyReleaseStatus(release, {
      tickets,
      groupCounts,
      blockedTickets,
      doneStatuses: DONE_STATUSES,
      jiraBaseUrl,
      nectarUrl: `${nectarBaseUrl}/releases/${releaseKey}`,
    });

    const channel = SlackNotifier.releaseChannelName(release.version);
    if (result?.ok) {
      log.info(`Release notifier: posted status for ${release.version} to ${channel}`);
    } else {
      log.warn(`Release notifier: failed to post for ${release.version} to ${channel}: ${result?.error || 'unknown'}`);
    }
    return result;
  }
}

module.exports = ReleaseNotifier;
