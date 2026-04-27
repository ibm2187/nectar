const crypto = require('crypto');
const { Router } = require('express');
const log = require('../core/log');
const JiraClient = require('../integrations/jira');
const { safeEqual } = require('../core/mcp-oauth-store');

/**
 * Webhook handlers for GitHub and JIRA.
 * Faster than polling for real-time cherry-pick and ticket updates.
 *
 * @param {object} releases - ReleaseManager
 * @param {object} github - integrations/github
 * @param {object} config
 * @param {object} [extras] - optional extras for issue notifications
 * @param {object} [extras.issueNotifier] - IssueNotifier instance; when
 *        provided, issue_comment + pull_request events also DM the
 *        Nectar reporter.
 */
module.exports = function createWebhookRoutes(releases, github, config, extras = {}) {
  const router = Router();
  const { issueNotifier } = extras;

  // ── GitHub webhook ──────────────────────────────────────
  // Receives PR events (opened, merged, labeled), issue comments,
  // and (when an IssueNotifier is wired in) reporter DMs.
  router.post('/github', (req, res) => {
    // Verify signature if secret is configured. Constant-time compare via
    // the shared safeEqual helper — string `!==` would leak timing data.
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-hub-signature-256'] || '';
      const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (!safeEqual(sig, expected)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.headers['x-github-event'];
    const payload = req.body;
    const eventRepo = payload && payload.repository && payload.repository.full_name;
    const fromConfiguredRepo = !issueNotifier || issueNotifier.isEventFromConfiguredRepo(eventRepo);

    if (event === 'pull_request') {
      handlePREvent(payload, releases, github).catch(err =>
        log.error('GitHub webhook PR handler error:', err.message)
      );
      if (issueNotifier && fromConfiguredRepo) {
        issueNotifier.onPullRequest(payload).catch(err =>
          log.error('IssueNotifier.onPullRequest error:', err.message)
        );
      }
    }

    if (event === 'issue_comment' && issueNotifier && fromConfiguredRepo) {
      issueNotifier.onIssueComment(payload).catch(err =>
        log.error('IssueNotifier.onIssueComment error:', err.message)
      );
    }

    if (event === 'issues' && issueNotifier && fromConfiguredRepo) {
      issueNotifier.onIssueOpened(payload).catch(err =>
        log.error('IssueNotifier.onIssueOpened error:', err.message)
      );
    }

    res.json({ ok: true });
  });

  // ── JIRA webhook ────────────────────────────────────────
  // Receives issue:updated events
  const jiraWebhookToken = process.env.JIRA_WEBHOOK_TOKEN;
  router.post('/jira', (req, res) => {
    // Optional token-based auth for JIRA webhooks
    if (jiraWebhookToken) {
      const provided = req.query.token || req.headers['x-jira-token'];
      if (provided !== jiraWebhookToken) {
        return res.status(401).json({ error: 'Invalid JIRA webhook token' });
      }
    }

    const payload = req.body;

    if (payload.webhookEvent === 'jira:issue_updated' || payload.issue) {
      handleJiraEvent(payload, releases).catch(err =>
        log.error('JIRA webhook handler error:', err.message)
      );
    }

    res.json({ ok: true });
  });

  return router;
};

// ── GitHub PR event handler ───────────────────────────────

async function handlePREvent(payload, releases, github) {
  const pr = payload.pull_request;
  if (!pr) return;

  const action = payload.action; // opened, closed, labeled, unlabeled
  const hasLabel = pr.labels.some(l => l.name === github.cherryPickLabel);
  const version = github.extractVersionFromBranch(pr.base.ref);

  if (!hasLabel || !version) return;

  const release = releases.get(version);
  if (!release) return;

  const parsed = github.parseCherryPickPR(pr);

  // Determine status
  let status = 'pending';
  if (action === 'closed' && pr.merged) status = 'merged';
  else if (action === 'closed' && !pr.merged) status = 'closed';
  else if (action === 'opened' || action === 'labeled') status = 'pending';

  // Register cherry-pick
  for (const jiraKey of parsed.jiraKeys) {
    releases.addCherryPick(version, {
      sha: parsed.sha,
      pr: parsed.prNumber,
      ticket: jiraKey,
      status,
    }, 'github-webhook');
  }

  if (parsed.jiraKeys.length === 0) {
    releases.addCherryPick(version, {
      sha: parsed.sha,
      pr: parsed.prNumber,
      ticket: null,
      status,
    }, 'github-webhook');
  }

  log.info(`Webhook: cherry-pick PR #${pr.number} ${action} for ${version} (${status})`);
}

// ── JIRA issue event handler ──────────────────────────────

async function handleJiraEvent(payload, releases) {
  const issue = payload.issue;
  if (!issue) return;

  const key = issue.key;
  const newStatus = issue.fields && issue.fields.status && issue.fields.status.name;

  // Update ticket state in TicketStore
  const JiraClient = require('../integrations/jira');
  const newState = newStatus ? JiraClient.mapStatus(newStatus) : null;

  if (releases._ticketStore && newState) {
    const ticket = releases._ticketStore.get(key);
    if (ticket && ticket.state !== newState) {
      ticket.state = newState;
      ticket.status = newStatus;
      ticket.statusCategory = null; // Will be refreshed on next sync
      releases._ticketStore.upsert(ticket);
      log.info(`Webhook: ${key} status → ${newState}`);
    }
  }
}
