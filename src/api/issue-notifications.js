const log = require('../core/log');
const {
  extractReporter,
  parseClosingReferences,
  stripReporterFooter,
} = require('../integrations/issue-reporter');

const DEFAULT_CHANNEL = '#nectar';

// Sentinel prNumber on issue_pr_notifications used by the channel-post
// dedup. Real PR numbers are always > 0, so 0 can't collide.
const CHANNEL_POST_SENTINEL = 0;

/**
 * issue-notifications — DM the Nectar reporter when their GitHub issue
 * gets a comment or has a PR linked to it. Reporter is the email in the
 * `<!-- nectar:reporter=email -->` body marker; resolution chain is
 * UserStore → PeopleDirectory → slack.dmUser, with a silent no-op if
 * any link is missing.
 */
class IssueNotifier {
  constructor({
    slack, github, userStore, peopleDirectory, notificationSettings, db,
    repoPath, channel,
  }) {
    this.slack = slack;
    this.github = github;
    this.userStore = userStore;
    this.peopleDirectory = peopleDirectory;
    this.notificationSettings = notificationSettings;
    this.db = db;
    this.repoPath = repoPath || (github && github.repo) || null;
    this.channel = channel || DEFAULT_CHANNEL;
  }

  /**
   * Whether a webhook payload came from the repo this notifier is configured
   * for. When repoPath is unset (test or unconfigured), accept anything.
   */
  isEventFromConfiguredRepo(eventRepoFullName) {
    if (!this.repoPath) return true;
    if (!eventRepoFullName) return true;
    return eventRepoFullName === this.repoPath;
  }

  /**
   * Handle an `issues` GitHub webhook event. Posts a broadcast to the
   * configured Nectar channel when a new issue is opened — whether the
   * issue was filed via the Nectar UI (marker present, attribute to the
   * Nectar user) or directly on github.com (marker absent, fall back to
   * the GitHub author login).
   */
  async onIssueOpened(payload) {
    if (!payload || payload.action !== 'opened') return { skipped: 'not-opened' };
    const issue = payload.issue;
    if (!issue) return { skipped: 'no-issue' };

    if (!this.notificationSettings.get('issueOpened')) {
      return { skipped: 'category-disabled' };
    }

    // Dedup against GitHub redelivery (5xx retry, manual "Redeliver" in
    // the webhook UI, …) so #nectar doesn't get the same post twice.
    if (!this._tryClaimNotification(issue.number, CHANNEL_POST_SENTINEL)) {
      return { skipped: 'already-posted' };
    }

    const reporterEmail = extractReporter(issue.body);
    const opener = this._formatOpener(reporterEmail, issue.user);
    // Skip the strip when there's no marker — that's the github.com-direct
    // case and the body is already clean.
    const cleanBody = reporterEmail ? stripReporterFooter(issue.body || '') : (issue.body || '');
    const snippet = slackEscape(truncate(cleanBody, 240));
    const titleSafe = slackEscape(issue.title);
    const text =
      `:pencil2: New issue *<${issue.html_url}|#${issue.number} ${titleSafe}>* ` +
      `opened by ${opener}` +
      (snippet ? `\n> ${snippet}` : '');

    // slack.postMessage returns { ok, error } and never throws — check the
    // return value rather than try/catch. Release the dedup claim on
    // failure so a webhook redelivery can succeed.
    const result = await this.slack.postMessage(this.channel, text);
    if (result && result.ok) {
      log.info(`IssueNotifier: posted #${issue.number} to ${this.channel}`);
      return { posted: true, channel: this.channel };
    }
    this._releaseClaim(issue.number, CHANNEL_POST_SENTINEL);
    const error = (result && result.error) || 'unknown';
    log.warn(`IssueNotifier: post to ${this.channel} failed: ${error}`);
    return { posted: false, error };
  }

  /**
   * Compose the "opened by …" fragment for the channel post. Prefers the
   * Nectar reporter (resolved to display name when known) over the GitHub
   * author. Output is always Slack-mrkdwn-safe.
   */
  _formatOpener(reporterEmail, githubUser) {
    if (reporterEmail) {
      const user = this.userStore.getUser(reporterEmail);
      const displayName = (user && user.name) || reporterEmail;
      return `*${slackEscape(displayName)}* via Nectar`;
    }
    const login = (githubUser && githubUser.login) || 'someone';
    return `*${slackEscape(login)}* on github.com`;
  }

  async onIssueComment(payload) {
    if (!payload || payload.action !== 'created') return { skipped: 'not-created' };
    // issue_comment fires for both issues and PRs; PRs carry pull_request.
    if (payload.issue && payload.issue.pull_request) return { skipped: 'pr-comment' };

    const reporter = extractReporter(payload.issue && payload.issue.body);
    if (!reporter) return { skipped: 'no-reporter' };

    if (!this.notificationSettings.get('issueActivity')) {
      return { skipped: 'category-disabled' };
    }

    const slackId = this._resolveSlackId(reporter);
    if (!slackId) return { skipped: 'no-slack-id' };

    const issue = payload.issue;
    const comment = payload.comment || {};
    const commenter = slackEscape((comment.user && comment.user.login) || 'someone');
    const url = comment.html_url || issue.html_url;
    const titleSafe = slackEscape(issue.title);
    const snippet = slackEscape(truncate(comment.body || '', 200));
    const text =
      `:speech_balloon: *${commenter}* commented on your issue ` +
      `*<${url}|#${issue.number} ${titleSafe}>*\n` +
      (snippet ? `> ${snippet}` : '');

    return this._dmAndLog({ slackId, reporter, text, ctx: `comment on issue #${issue.number}` });
  }

  async onPullRequest(payload) {
    if (!payload) return { skipped: 'no-payload' };
    const action = payload.action;
    if (action !== 'opened' && action !== 'edited' && action !== 'reopened') {
      return { skipped: `action=${action}` };
    }
    const pr = payload.pull_request;
    if (!pr) return { skipped: 'no-pr' };

    const issueNumbers = parseClosingReferences(pr.body);
    if (issueNumbers.length === 0) return { skipped: 'no-references' };

    if (!this.notificationSettings.get('issueActivity')) {
      return { skipped: 'category-disabled' };
    }

    const results = await Promise.all(
      issueNumbers.map(issueNumber => this._notifyForLinkedIssue({ issueNumber, pr }))
    );
    return { results };
  }

  async _notifyForLinkedIssue({ issueNumber, pr }) {
    // INSERT-first claim closes the race where a SELECT/INSERT split by an
    // awaited GitHub or Slack call lets two concurrent handlers both pass.
    if (!this._tryClaimNotification(issueNumber, pr.number)) {
      return { issueNumber, skipped: 'already-notified' };
    }

    let body;
    let title;
    try {
      const issue = await this.github.getIssue(issueNumber, this.repoPath);
      body = issue && issue.body;
      title = issue && issue.title;
    } catch (err) {
      log.warn(`IssueNotifier: getIssue(#${issueNumber}) failed: ${err.message}`);
      // Release so a transient GitHub failure doesn't permanently mute future retries.
      this._releaseClaim(issueNumber, pr.number);
      return { issueNumber, skipped: 'fetch-failed' };
    }

    const reporter = extractReporter(body);
    if (!reporter) return { issueNumber, skipped: 'no-reporter' };

    const slackId = this._resolveSlackId(reporter);
    if (!slackId) {
      // Keep the claim — re-fetching the issue on every PR edit just to
      // re-discover the missing Slack mapping is wasteful.
      return { issueNumber, skipped: 'no-slack-id' };
    }

    const prUser = slackEscape((pr.user && pr.user.login) || 'someone');
    const prTitleSafe = slackEscape(pr.title);
    const issueTitleSafe = title ? slackEscape(title) : '';
    const text =
      `:link: *${prUser}* opened PR ` +
      `*<${pr.html_url}|#${pr.number} ${prTitleSafe}>* ` +
      `which references your issue *#${issueNumber}${issueTitleSafe ? ` ${issueTitleSafe}` : ''}*`;

    const result = await this._dmAndLog({
      slackId, reporter, text, ctx: `PR #${pr.number} → issue #${issueNumber}`,
    });
    return { issueNumber, ...result };
  }

  // slack.dmUser returns void; failures are logged inside the integration
  // via the _badChannels cache.
  async _dmAndLog({ slackId, reporter, text, ctx }) {
    await this.slack.dmUser(slackId, text);
    log.info(`IssueNotifier: DM'd ${reporter} re ${ctx}`);
    return { sent: true, reporter, slackId };
  }

  _resolveSlackId(email) {
    const user = this.userStore.getUser(email);
    if (!user || !user.name) return null;
    const resolved = this.peopleDirectory.resolveSlackId(user.name);
    return resolved ? resolved.slackId : null;
  }

  _tryClaimNotification(issueNumber, prNumber) {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO issue_pr_notifications (issueNumber, prNumber, notifiedAt)
       VALUES (?, ?, ?)`
    ).run(issueNumber, prNumber, new Date().toISOString());
    return result.changes > 0;
  }

  _releaseClaim(issueNumber, prNumber) {
    this.db.prepare(
      'DELETE FROM issue_pr_notifications WHERE issueNumber = ? AND prNumber = ?'
    ).run(issueNumber, prNumber);
  }
}

function truncate(text, max) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Remove Slack mrkdwn special chars so untrusted content (issue titles,
// commenter logins, comment snippets) can't break out of <url|text> links
// or inject @here / @channel mentions.
function slackEscape(text) {
  return String(text || '').replace(/[<>|&]/g, '');
}

module.exports = IssueNotifier;
