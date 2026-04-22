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
    this.notificationSettings = null;
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

    const redirect = this.notificationSettings?.redirectChannel;
    if (redirect) {
      text = `[-> ${channel}] ${text}`;
      channel = redirect;
    }

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

    const redirect = this.notificationSettings?.redirectDM;
    if (redirect) {
      text = `[-> DM ${userId}] ${text}`;
      userId = redirect;
    }

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
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
    const text = [
      `*Release ${release.version} has been cut*`,
      `Branch: \`${release.branch}\``,
      release.cutBy ? `Cut by: ${release.cutBy}` : '',
      release.cutFrom ? `From: \`${release.cutFrom.substring(0, 7)}\`` : '',
    ].filter(Boolean).join('\n');
    return this.postMessage(channel, text);
  }

  notifyTransition(release, from, to) {
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
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
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
    const text = `*${release.version}*: ${approval.role} approval from ${approval.user}`;
    return this.postMessage(channel, text);
  }

  notifyAllApproved(release) {
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
    const text = `*${release.version}* has all required approvals — ready for deployment`;
    return this.postMessage(channel, text);
  }

  notifyApprovalNeeded(release, missingRoles) {
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
    const text = `*${release.version}* needs approval from: ${missingRoles.join(', ')}`;
    return this.postMessage(channel, text);
  }

  notifyDeployment(release, deployment) {
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
    const emoji = deployment.status === 'deployed' ? ':white_check_mark:' : ':warning:';
    const text = `${emoji} *${release.version}* → ${deployment.customer} (${deployment.env}): ${deployment.status}`;
    return this.postMessage(channel, text);
  }

  notifyDeployFailed(release, deployment) {
    const channel = SlackNotifier.releaseChannelName(release.version);
    if (this._badChannels) this._badChannels.delete(channel);
    const text = `:x: *${release.version}* deploy FAILED for ${deployment.customer} (${deployment.env})`;
    return this.postMessage(channel, text);
  }

  notifyCherryPickConflict(release, cherryPick, author) {
    if (!author) return; // DM-only — no channel fallback
    // Skip GitHub bot accounts (e.g. "dependabot[bot]", "viv-tech-dev[bot]")
    if (/\[bot\]$/.test(author)) return;
    // Skip non-Slack identifiers (GitHub usernames etc. don't start with U/W).
    // A proper fix would resolve the GitHub login to a Slack ID via
    // PeopleDirectory, but for now we avoid spamming bad channel_not_found
    // errors by requiring a Slack-shaped ID.
    if (!/^[UW][A-Z0-9]{6,}$/.test(author)) return;
    const text = `:warning: Cherry-pick conflict on *${release.version}*\nPR #${cherryPick.pr} (${cherryPick.ticket || 'no ticket'})\nPlease resolve manually.`;
    return this.dmUser(author, text);
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
  static _statusEmoji(jiraStatus) {
    const s = jiraStatus || '';
    if (['Blocked', 'Testing Failed'].includes(s)) return '🔴';
    if (['Ready For Testing', 'Cherry Picked'].includes(s)) return '🔵';
    if (['In Testing', 'Testing in Branch', 'Re-verify Bug'].includes(s)) return '🟣';
    if (['QA Certified', 'Done', 'Closed', 'Resolved', 'Resolved Without Code'].includes(s)) return '🟢';
    return '🟡'; // In Dev / default
  }

  async notifyReleaseStatus(release, statusData) {
    const channel = SlackNotifier.releaseChannelName(release.version);
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
          const emoji = SlackNotifier._statusEmoji(t.jiraStatus);
          lines.push(`  ${emoji} <${statusData.jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} _(${t.jiraStatus || 'Unknown'})_`);
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
        lines.push(`  🔴 <${statusData.jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} _(${assignee})_`);
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

  // ── Alerting helpers ────────────────────────────────────

  /**
   * Validate that a channel exists and the bot is a member.
   *
   * Used by the alerting system to block rule saves until the target
   * channel is reachable. Returns a structured result so callers can
   * render a specific UI error (not-in-channel vs not-found).
   *
   * @param {string} channelName - channel name with or without '#', or channel ID
   * @returns {Promise<{ ok: boolean, inChannel?: boolean, channelId?: string, name?: string, error?: string, code?: string }>}
   */
  async validateChannel(channelName) {
    if (!this.ready) {
      return { ok: false, error: 'Slack is not connected', code: 'not_connected' };
    }
    if (!channelName) {
      return { ok: false, error: 'Channel name is required', code: 'empty' };
    }

    // Normalize: strip leading '#'
    const raw = String(channelName).trim();
    const bare = raw.startsWith('#') ? raw.slice(1) : raw;
    const looksLikeId = /^[CG][A-Z0-9]{6,}$/.test(bare);

    try {
      let channelId = looksLikeId ? bare : null;

      // If we were given a name, resolve to an ID via conversations.list.
      // Slack requires an ID (not a name) for conversations.info.
      if (!channelId) {
        // Search public then private; stop when found
        for (const types of ['public_channel', 'private_channel']) {
          let cursor;
          let found = null;
          do {
            const resp = await this.app.client.conversations.list({
              types,
              limit: 1000,
              cursor,
              exclude_archived: true,
            });
            found = (resp.channels || []).find(c => c.name === bare);
            if (found) break;
            cursor = resp.response_metadata?.next_cursor;
          } while (cursor);
          if (found) { channelId = found.id; break; }
        }
        if (!channelId) {
          return { ok: false, error: `Channel #${bare} not found`, code: 'channel_not_found' };
        }
      }

      const info = await this.app.client.conversations.info({ channel: channelId });
      const channel = info.channel || {};
      if (channel.is_archived) {
        return { ok: false, error: 'Channel is archived', code: 'is_archived' };
      }
      const inChannel = !!channel.is_member;
      if (!inChannel) {
        return {
          ok: false,
          inChannel: false,
          channelId,
          name: channel.name,
          error: `The Nectar bot is not a member of #${channel.name}. Add it to the channel with /invite @Nectar before saving.`,
          code: 'not_in_channel',
        };
      }
      return { ok: true, inChannel: true, channelId, name: channel.name };
    } catch (err) {
      const code = err.data?.error || err.message || 'unknown';
      log.warn(`Slack validateChannel(${channelName}): ${code}`);
      if (code === 'channel_not_found' || code === 'not_in_channel') {
        return { ok: false, error: `Channel ${channelName}: ${code}`, code };
      }
      return { ok: false, error: `Slack error: ${code}`, code };
    }
  }

  /**
   * Post an alert to one or more channels. Returns an array of
   * per-channel results so callers can track Slack message timestamps
   * for threading.
   *
   * @param {object} opts
   * @param {string[]} opts.channels - channel names (with or without '#')
   * @param {string} opts.text - fallback text (also used as notification preview)
   * @param {Array} [opts.blocks] - Slack Block Kit blocks
   * @param {string} [opts.mention] - '@here' | '@channel' | '<@UXXX>' | '<!subteam^SXXX>'
   * @param {string} [opts.threadTs] - post as a threaded reply (to a specific channel's anchor ts)
   * @returns {Promise<Array<{ channel, ok, ts?, error? }>>}
   */
  async postAlert({ channels = [], text = '', blocks = null, mention = null, threadTs = null } = {}) {
    if (!this.ready) {
      return channels.map(c => ({ channel: c, ok: false, error: 'Slack not connected' }));
    }
    const prefixed = mention ? `${mention} ${text}` : text;
    const results = [];
    for (const channel of channels) {
      const res = await this._postOne({ channel, text: prefixed, blocks, threadTs });
      results.push({ channel, ...res });
    }
    return results;
  }

  /**
   * Post a threaded reply. Used for ack/resolve/recovery updates on an
   * existing incident post.
   */
  async postReply({ channel, ts, text, blocks = null } = {}) {
    if (!this.ready) return { ok: false, error: 'Slack not connected' };
    if (!channel || !ts) return { ok: false, error: 'channel and ts are required' };
    return this._postOne({ channel, text, blocks, threadTs: ts });
  }

  /**
   * Shared helper used by both postAlert and postReply. Respects the
   * redirectChannel setting from NotificationSettings and tracks bogus
   * channels in _badChannels to avoid retry storms.
   */
  async _postOne({ channel, text, blocks = null, threadTs = null }) {
    let target = channel;
    let body = text;

    const redirect = this.notificationSettings?.redirectChannel;
    if (redirect) {
      body = `[-> ${target}] ${body}`;
      target = redirect;
    }

    if (this._badChannels && this._badChannels.has(target)) {
      return { ok: false, error: `Channel ${target} previously failed` };
    }

    try {
      const opts = { channel: target, text: body };
      if (blocks) opts.blocks = blocks;
      if (threadTs) opts.thread_ts = threadTs;
      const resp = await this.app.client.chat.postMessage(opts);
      return { ok: true, ts: resp.ts, channel: resp.channel || target };
    } catch (err) {
      const code = err.data?.error || err.message;
      if (String(code).includes('channel_not_found') || String(code).includes('not_in_channel')) {
        if (!this._badChannels) this._badChannels = new Set();
        this._badChannels.add(target);
        log.warn(`Slack: disabled notifications to ${target} (${code})`);
      } else {
        log.error(`Slack postAlert to ${target} failed: ${code}`);
      }
      return { ok: false, error: String(code) };
    }
  }

  async stop() {
    if (this.app) {
      await this.app.stop().catch(() => {});
      this.ready = false;
    }
  }
}

module.exports = SlackNotifier;
