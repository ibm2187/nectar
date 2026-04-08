const crypto = require('crypto');
const { Router } = require('express');
const log = require('../core/log');
const JiraClient = require('../integrations/jira');

/**
 * Webhook handlers for GitHub and JIRA.
 * Faster than polling for real-time cherry-pick and ticket updates.
 */
module.exports = function createWebhookRoutes(releases, github, config) {
  const router = Router();

  // ── GitHub webhook ──────────────────────────────────────
  // Receives PR events (opened, merged, labeled)
  router.post('/github', (req, res) => {
    // Verify signature if secret is configured
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-hub-signature-256'] || '';
      const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (sig !== expected) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.headers['x-github-event'];
    const payload = req.body;

    if (event === 'pull_request') {
      handlePREvent(payload, releases, github).catch(err =>
        log.error('GitHub webhook PR handler error:', err.message)
      );
    }

    res.json({ ok: true });
  });

  // ── JIRA webhook ────────────────────────────────────────
  // Receives issue:updated events
  router.post('/jira', (req, res) => {
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

  // Find all releases containing this ticket and update state
  for (const release of releases.list()) {
    const ticket = release.tickets.find(t => t.key === key);
    if (ticket && newStatus) {
      // Map JIRA status to our ticket states
      let state = ticket.state;
      if (newStatus.toLowerCase().includes('cherry picked')) state = 'cherry-picked';
      else if (newStatus.toLowerCase().includes('ready for testing')) state = 'ready-for-testing';
      else if (newStatus.toLowerCase().includes('in progress')) state = 'in-progress';
      else if (newStatus.toLowerCase().includes('done') || newStatus.toLowerCase().includes('closed')) state = 'done';

      if (state !== ticket.state) {
        releases.addTicket(release.version, { key, state }, 'jira-webhook');
        log.info(`Webhook: ${key} status → ${state} in release ${release.version}`);
      }
    }
  }
}
