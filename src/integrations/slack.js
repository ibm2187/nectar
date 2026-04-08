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
    if (!this.ready) return;
    // Skip bogus channels (failed once, don't retry every time)
    if (this._badChannels && this._badChannels.has(channel)) return;
    try {
      const opts = { channel, text };
      if (blocks) opts.blocks = blocks;
      await this.app.client.chat.postMessage(opts);
    } catch (err) {
      if (err.message.includes('channel_not_found') || err.message.includes('not_in_channel')) {
        if (!this._badChannels) this._badChannels = new Set();
        this._badChannels.add(channel);
        log.warn(`Slack: disabled notifications to ${channel} (${err.data?.error || err.message})`);
      } else {
        log.error(`Slack postMessage to ${channel} failed:`, err.message);
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

  async stop() {
    if (this.app) {
      await this.app.stop().catch(() => {});
      this.ready = false;
    }
  }
}

module.exports = SlackNotifier;
