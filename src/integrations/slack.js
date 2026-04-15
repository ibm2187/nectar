const log = require('../core/log');

/**
 * Slack notification sender.
 * Uses @slack/bolt in Socket Mode for outbound notifications.
 * Hive handles Slack commands — Nectar only sends notifications.
 */
class SlackNotifier {
  constructor(config) {
    this.config = config;
    this.app = null;
    this.ready = false;
  }

  async start() {
    const appToken = process.env.SLACK_APP_TOKEN;
    const botToken = process.env.SLACK_BOT_TOKEN;

    if (!appToken || !botToken) {
      log.warn('Slack not configured (missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN)');
      return;
    }

    try {
      const { App } = require('@slack/bolt');
      this.app = new App({
        token: botToken,
        appToken,
        socketMode: true,
      });

      await this.app.start();
      this.ready = true;
      log.info('Slack connected (Socket Mode)');
    } catch (err) {
      log.error('Slack failed to connect:', err.message);
    }
  }

  isConfigured() {
    return this.ready;
  }

  // ── Send messages ───────────────────────────────────────

  async postMessage(channel, text, blocks = null) {
    if (!this.ready) return { ok: false, error: 'Slack not connected' };
    // Skip bogus channels (failed once, don't retry every time)
    if (this._badChannels && this._badChannels.has(channel)) return { ok: false, error: `Channel ${channel} previously failed` };
    try {
      const opts = { channel, text };
      if (blocks) opts.blocks = blocks;
      await this.app.client.chat.postMessage(opts);
      return { ok: true };
    } catch (err) {
      if (err.message.includes('channel_not_found') || err.message.includes('not_in_channel')) {
        if (!this._badChannels) this._badChannels = new Set();
        this._badChannels.add(channel);
        log.warn(`Slack: disabled notifications to ${channel} (${err.data?.error || err.message})`);
        return { ok: false, error: `Channel ${channel} not found` };
      } else {
        log.error(`Slack postMessage to ${channel} failed:`, err.message);
        return { ok: false, error: err.message };
      }
    }
  }

  async dmUser(userId, text) {
    if (!this.ready) return;
    if (this._badChannels && this._badChannels.has(userId)) return;
    try {
      await this.app.client.chat.postMessage({ channel: userId, text });
    } catch (err) {
      if (err.message.includes('channel_not_found') || err.message.includes('not_in_channel')) {
        if (!this._badChannels) this._badChannels = new Set();
        this._badChannels.add(userId);
        log.warn(`Slack: disabled DM to ${userId} (${err.data?.error || 'channel_not_found'})`);
      } else {
        log.error(`Slack DM to ${userId} failed:`, err.message);
      }
    }
  }

  // ── Lifecycle notification templates ────────────────────

  notifyReleaseCut(release) {
    const channel = this.config.slack.releases;
    const text = [
      `*Release ${release.version} has been cut*`,
      `Branch: \`${release.branch}\``,
      release.cutBy ? `Cut by: ${release.cutBy}` : '',
      release.cutFrom ? `From: \`${release.cutFrom.substring(0, 7)}\`` : '',
    ].filter(Boolean).join('\n');
    return this.postMessage(channel, text);
  }

  notifyTransition(release, from, to) {
    const channel = this.config.slack.releases;
    const emoji = {
      planning: ':clipboard:',
      cutting: ':scissors:',
      stabilizing: ':test_tube:',
      approved: ':white_check_mark:',
      deploying: ':rocket:',
      done: ':tada:',
    };
    const text = `${emoji[to] || ':arrow_right:'} *${release.version}* moved from *${from}* to *${to}*`;
    return this.postMessage(channel, text);
  }

  notifyApprovalAdded(release, approval) {
    const channel = this.config.slack.releases;
    const text = `*${release.version}*: ${approval.role} approval from ${approval.user}`;
    return this.postMessage(channel, text);
  }

  notifyAllApproved(release) {
    const channels = [this.config.slack.releases, this.config.slack.deploys];
    const text = `*${release.version}* has all required approvals — ready for deployment`;
    return Promise.all(channels.map(ch => this.postMessage(ch, text)));
  }

  notifyApprovalNeeded(release, missingRoles) {
    const channel = this.config.slack.releases;
    const text = `*${release.version}* needs approval from: ${missingRoles.join(', ')}`;
    return this.postMessage(channel, text);
  }

  notifyDeployment(release, deployment) {
    const channel = this.config.slack.deploys;
    const emoji = deployment.status === 'deployed' ? ':white_check_mark:' : ':warning:';
    const text = `${emoji} *${release.version}* → ${deployment.customer} (${deployment.env}): ${deployment.status}`;
    return this.postMessage(channel, text);
  }

  notifyDeployFailed(release, deployment) {
    const channel = this.config.slack.deploys;
    const text = `:x: *${release.version}* deploy FAILED for ${deployment.customer} (${deployment.env})`;
    return this.postMessage(channel, text);
  }

  notifyCherryPickConflict(release, cherryPick, author) {
    const text = `:warning: Cherry-pick conflict on *${release.version}*\nPR #${cherryPick.pr} (${cherryPick.ticket || 'no ticket'})\nPlease resolve manually.`;
    if (author) {
      return this.dmUser(author, text);
    }
    return this.postMessage(this.config.slack.releases, text);
  }

  notifyRiskAssessment(release) {
    const channel = this.config.slack.releases;
    const r = release.risk;
    if (!r || r.numericScore === null) return;

    const emoji = r.score === 'low' ? ':large_green_circle:' : r.score === 'medium' ? ':large_yellow_circle:' : ':red_circle:';
    const factors = (r.factors || []).map(f => `  • ${f.reason} (+${f.points})`).join('\n');
    const text = `${emoji} *${release.version}* risk: *${(r.score || '').toUpperCase()}* (score: ${r.numericScore})\n${factors}`;
    return this.postMessage(channel, text);
  }

  // ── Release channel notifications ──────────────────────

  /**
   * Get the Slack channel name for a release version.
   * e.g., "4.1.0.5-ck" → "#4-1-0-5-ck"
   */
  static releaseChannelName(version) {
    return '#releases-' + version.replace(/\./g, '-');
  }

  /**
   * Check if a release channel exists by trying to look it up.
   */
  async channelExists(channelName) {
    if (!this.ready) return false;
    if (this._badChannels && this._badChannels.has(channelName)) return false;
    try {
      // Posting a test isn't needed — the postMessage will fail with channel_not_found
      // and get added to _badChannels. For checking, we just return true if not in bad list.
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Post a release status update to the release-specific channel.
   */
  async notifyReleaseStatus(release, statusData) {
    const channel = SlackNotifier.releaseChannelName(release.version);
    // Always retry release channels — don't let the bad channel cache block them
    if (this._badChannels) this._badChannels.delete(channel);
    const { tickets, groupCounts, blockedTickets, nectarUrl } = statusData;

    const totalNotDone = (groupCounts.total || 0) - (groupCounts.done || 0);

    const lines = [
      `📋 *Release ${release.version}* — Status Update`,
      '',
      `*Release date:* ${release.jiraReleaseDate || 'Unscheduled'}`,
      `*State:* ${release.state}`,
      '',
      `*Tickets:* ${groupCounts.total || 0} total`,
      groupCounts.inDev ? `  🟡 In Dev: ${groupCounts.inDev}` : null,
      groupCounts.blocked ? `  🔴 Blocked: ${groupCounts.blocked}` : null,
      groupCounts.readyForQa ? `  🔵 Ready for QA: ${groupCounts.readyForQa}` : null,
      groupCounts.inQa ? `  🟣 In QA: ${groupCounts.inQa}` : null,
      groupCounts.done ? `  🟢 Done: ${groupCounts.done}` : null,
    ].filter(l => l !== null);

    // Not Done section
    if (totalNotDone > 0) {
      lines.push('');
      if (totalNotDone <= 10) {
        lines.push(`*Not Done (${totalNotDone}):*`);
        for (const t of tickets.filter(t => !statusData.doneStatuses.has(t.jiraStatus || ''))) {
          lines.push(`  • <${statusData.jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} (${t.jiraStatus || 'Unknown'})`);
        }
      } else {
        lines.push(`*Not Done:* ${totalNotDone} tickets remaining`);
      }
    }

    // Always show blocked tickets
    if (blockedTickets.length > 0) {
      lines.push('');
      lines.push(`⚠️ *Blocked (${blockedTickets.length}):*`);
      for (const t of blockedTickets) {
        const assignee = t.assignee || 'Unassigned';
        lines.push(`  • <${statusData.jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} (${assignee})`);
      }
    }

    if (nectarUrl) {
      lines.push('');
      lines.push(`🔗 <${nectarUrl}|View in Nectar>`);
    }

    const result = await this.postMessage(channel, lines.join('\n'));
    return { ...result, channel };
  }

  /**
   * Post a deployment notification to the release-specific channel.
   */
  async notifyReleaseDeployment(version, envName, customerName, previousVersion) {
    const channel = SlackNotifier.releaseChannelName(version);
    if (this._badChannels) this._badChannels.delete(channel);
    const lines = [
      `🚀 *${version}* deployed to *${customerName} ${envName}*`,
      previousVersion ? `Previously running: ${previousVersion}` : null,
      `Detected at ${new Date().toLocaleTimeString()}`,
    ].filter(Boolean);
    return this.postMessage(channel, lines.join('\n'));
  }

  async stop() {
    if (this.app) {
      await this.app.stop().catch(() => {});
      this.ready = false;
    }
  }
}

module.exports = SlackNotifier;
