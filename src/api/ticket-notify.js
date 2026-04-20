const log = require('../core/log');
const SlackNotifier = require('../integrations/slack');

/**
 * Ticket notification system — sends Slack messages about tickets
 * to devs, QA, or release channels.
 *
 * Canned messages are defined here so both frontend and backend share
 * the same set (frontend fetches via GET /api/notify/canned-messages).
 */

const CANNED_MESSAGES = [
  { id: 'cherry-pick',      label: 'Cherry-pick request',   text: 'Can you cherry-pick this change?' },
  { id: 'status-update',    label: 'Status update',         text: 'Can you provide a status update on this?' },
  { id: 'release-blocker',  label: 'Release blocker',       text: 'This is blocking the release — please prioritize.' },
  { id: 'ready-for-qa',     label: 'Ready for QA',          text: 'Ready for QA — please test when available.' },
  { id: 'testing-failed',   label: 'Testing failed',        text: 'Testing failed — please investigate and fix.' },
  { id: 'needs-retest',     label: 'Needs retest',          text: 'Cherry-pick is on the branch — please retest.' },
  { id: 'custom',           label: 'Custom message',        text: '' },
];

/**
 * Send ticket notifications via Slack.
 *
 * @param {object} opts
 * @param {string[]} opts.ticketKeys - JIRA keys to notify about
 * @param {string} opts.recipientType - 'dev' | 'qa' | 'both'
 * @param {string} opts.channel - 'dm' | 'release'
 * @param {string} opts.message - The message text to send
 * @param {string} [opts.version] - Release version (for release channel + context)
 * @param {string} [opts.senderName] - Who is sending (for attribution)
 * @param {object} services - { slack, releases, peopleDirectory, ticketStore }
 * @returns {{ sent: number, recipients: string[], errors: string[] }}
 */
async function sendTicketNotification(opts, services) {
  const { ticketKeys, recipientType, channel, message, version, senderName } = opts;
  const { slack, releases, peopleDirectory, ticketStore } = services;

  if (!slack || !slack.isConfigured()) {
    return { sent: 0, recipients: [], errors: ['Slack not configured'] };
  }

  if (!ticketKeys || ticketKeys.length === 0) {
    return { sent: 0, recipients: [], errors: ['No tickets specified'] };
  }

  // Resolve ticket details
  const tickets = ticketKeys.map(key => {
    if (ticketStore) {
      const t = ticketStore.get(key);
      if (t) return t;
    }
    return { key, summary: key, assignee: null, qaAssignee: null, jiraStatus: 'Unknown' };
  });

  const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';
  const attribution = senderName ? `— _${senderName} via Nectar_` : '— _via Nectar_';

  const results = { sent: 0, recipients: [], errors: [] };

  if (channel === 'release') {
    // Post to release channel
    if (!version) {
      results.errors.push('Version required for release channel notifications');
      return results;
    }
    const channelName = SlackNotifier.releaseChannelName(version);
    const text = _formatReleaseChannelMessage(tickets, message, version, jiraBaseUrl, attribution);
    const res = await slack.postMessage(channelName, text);
    if (res.ok) {
      results.sent = 1;
      results.recipients.push(channelName);
    } else {
      results.errors.push(`Failed to post to ${channelName}: ${res.error}`);
    }
  } else {
    // DM — group tickets by recipient to avoid spamming
    const byRecipient = new Map(); // slackId → { name, tickets[] }

    for (const ticket of tickets) {
      const targets = [];
      if ((recipientType === 'dev' || recipientType === 'both') && ticket.assignee) {
        targets.push(ticket.assignee);
      }
      if ((recipientType === 'qa' || recipientType === 'both') && ticket.qaAssignee) {
        targets.push(ticket.qaAssignee);
      }

      for (const personName of targets) {
        const resolved = peopleDirectory ? peopleDirectory.resolveSlackId(personName) : null;
        if (!resolved) {
          results.errors.push(`Could not resolve Slack ID for ${personName}`);
          continue;
        }
        if (!byRecipient.has(resolved.slackId)) {
          byRecipient.set(resolved.slackId, { name: personName, tickets: [] });
        }
        byRecipient.get(resolved.slackId).tickets.push(ticket);
      }
    }

    // Send DMs — one per unique recipient
    for (const [slackId, { name, tickets: recipientTickets }] of byRecipient) {
      const text = _formatDmMessage(recipientTickets, message, version, jiraBaseUrl, attribution);
      try {
        await slack.dmUser(slackId, text);
        results.sent++;
        results.recipients.push(name);
        // Rate limit
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        results.errors.push(`Failed to DM ${name}: ${err.message}`);
      }
    }
  }

  log.info(`Ticket notify: sent ${results.sent} to ${results.recipients.join(', ')} (${ticketKeys.length} tickets, channel=${channel})`);
  return results;
}

function _formatDmMessage(tickets, message, version, jiraBaseUrl, attribution) {
  const versionLabel = version ? ` — Release ${version}` : '';
  const lines = [`📋 *Action needed${versionLabel}*`];
  lines.push('');
  for (const t of tickets) {
    lines.push(`• <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary || t.key} _(${t.jiraStatus || '?'})_`);
  }
  lines.push('');
  lines.push(`💬 ${message}`);
  lines.push('');
  lines.push(attribution);
  return lines.join('\n');
}

function _formatReleaseChannelMessage(tickets, message, version, jiraBaseUrl, attribution) {
  const lines = [`📋 *Release ${version} — Action needed*`];
  lines.push('');
  for (const t of tickets) {
    const assigneeLabel = [t.assignee, t.qaAssignee].filter(Boolean).join(' / ');
    lines.push(`• <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary || t.key} _(${t.jiraStatus || '?'})_${assigneeLabel ? ` — ${assigneeLabel}` : ''}`);
  }
  lines.push('');
  lines.push(`💬 ${message}`);
  lines.push('');
  lines.push(attribution);
  return lines.join('\n');
}

/**
 * Send a standup reminder to a person — their full ticket list formatted
 * like the daily digest, with an optional custom message.
 *
 * @param {object} opts
 * @param {string} opts.personName - JIRA display name
 * @param {string} [opts.message] - Optional custom message to prepend
 * @param {string} [opts.senderName] - Who is sending
 * @param {object} standupData - The person's standup data (from buildStandupData)
 * @param {object} services - { slack, peopleDirectory }
 * @returns {{ sent: boolean, error?: string }}
 */
async function sendStandupReminder(opts, standupData, services) {
  const { personName, message, senderName } = opts;
  const { slack, peopleDirectory } = services;

  if (!slack || !slack.isConfigured()) {
    return { sent: false, error: 'Slack not configured' };
  }

  const resolved = peopleDirectory ? peopleDirectory.resolveSlackId(personName) : null;
  if (!resolved) {
    return { sent: false, error: `Could not resolve Slack ID for ${personName}` };
  }

  const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';
  const nectarBaseUrl = process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com';
  const attribution = senderName ? `— _${senderName} via Nectar_` : '— _via Nectar_';

  const BUCKET_LABELS = {
    releaseCritical: '🔴 Release-Critical',
    awaitingCherryPick: '⏳ Awaiting Cherry-Pick',
    reviewChangesRequested: '🟠 Reviews — Changes Requested',
    reviewApproved: '✅ Reviews — Approved',
    blocked: '🚫 Blocked',
    pendingTesting: '🧪 Pending Testing',
    inDev: '🛠 In Development',
  };

  const lines = [];
  if (message) {
    lines.push(`💬 *${message}*`);
    lines.push('');
  }
  lines.push(`📋 *Your tickets* — ${standupData.totalItems} item${standupData.totalItems !== 1 ? 's' : ''}`);
  lines.push(`🔗 <${nectarBaseUrl}/standup|Open in Nectar>`);
  lines.push('');

  const bucketOrder = ['releaseCritical', 'awaitingCherryPick', 'reviewChangesRequested', 'reviewApproved', 'blocked', 'pendingTesting', 'inDev'];

  for (const bucketKey of bucketOrder) {
    const items = standupData.buckets[bucketKey];
    if (!items || items.length === 0) continue;

    const label = BUCKET_LABELS[bucketKey] || bucketKey;
    lines.push(`*${label}* — ${items.length}`);

    for (const item of items.slice(0, 10)) {
      if (item.key) {
        lines.push(`  <${jiraBaseUrl}/browse/${item.key}|${item.key}> — ${item.summary || item.key} _(${item.jiraStatus || '?'})_`);
      } else if (item.prNumber) {
        lines.push(`  <${item.prUrl}|#${item.prNumber}> _(${item.linkedTicket || 'PR'})_`);
      }
    }
    if (items.length > 10) {
      lines.push(`  _...and ${items.length - 10} more_`);
    }
    lines.push('');
  }

  lines.push(attribution);

  try {
    await slack.dmUser(resolved.slackId, lines.join('\n'));
    log.info(`Standup reminder: sent to ${personName} (${standupData.totalItems} items)`);
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

module.exports = { sendTicketNotification, sendStandupReminder, CANNED_MESSAGES };
