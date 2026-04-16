const cron = require('node-cron');
const log = require('./log');
const SlackNotifier = require('../integrations/slack');

const DONE_STATUSES = new Set([
  'QA Certified', 'No QA - Certified', 'QA Done', 'Done', 'Closed',
  'Resolved', 'Released', 'Resolved Without Code',
]);

/**
 * NotificationEngine — central coordinator for all notification features.
 *
 * Features:
 *   1. Daily DM digest per developer/QA (weekdays 7-day window, weekends 3-day)
 *   2. Build failure/recovery alerts to affected dev + QA
 *   3. Ticket added/removed buffering for scheduled digests
 *   4. Per-user notification preferences (via userStore)
 *   5. Channel notification toggles (via notificationSettings)
 */
class NotificationEngine {
  constructor({ slack, releases, releaseNotifier, peopleDirectory, userStore, notificationSettings, config }) {
    this.slack = slack;
    this.releases = releases;
    this.releaseNotifier = releaseNotifier;
    this.people = peopleDirectory;
    this.userStore = userStore;
    this.settings = notificationSettings;
    this.config = config;

    // Feature 2: build status cache (transient — no persistence needed)
    this._previousBuildStatus = new Map(); // projectName → latestStatus

    // Feature 3: ticket change buffer (drained at each scheduled digest)
    this._ticketChanges = new Map(); // releaseVersion → { added: Map<key, {key,summary}>, removed: Map<key, {key,summary}>, since: ISO }

    this._cronTasks = [];
  }

  // ── Lifecycle ────────────────────────────────────────────

  start() {
    if (process.env.NODE_ENV !== 'production') {
      log.info('Notification engine: scheduled notifications disabled (not production). Manual triggers still work.');
      return;
    }

    if (!this.slack.isConfigured()) {
      log.warn('Notification engine: disabled (Slack not configured)');
      return;
    }

    // Daily DM digest: weekdays 9 AM ET, weekends 9 AM ET
    const digestTask = cron.schedule('0 9 * * *', () => {
      if (!this.settings.get('dailyDigest')) return;
      this.sendDailyDigests().catch(err =>
        log.error(`Daily digest error: ${err.message}`)
      );
    }, { timezone: 'America/New_York' });
    this._cronTasks.push(digestTask);

    // Ticket changes: append to the existing 9 AM + 2 PM release digests
    // Run 30 seconds after release-notifier to post as a follow-up
    for (const schedule of ['0 9 * * 1-5', '0 14 * * 1-5']) {
      const task = cron.schedule(schedule, () => {
        if (!this.settings.get('releaseStatus')) return;
        setTimeout(() => {
          this.sendTicketChangeDigests().catch(err =>
            log.error(`Ticket change digest error: ${err.message}`)
          );
        }, 30_000);
      }, { timezone: 'America/New_York' });
      this._cronTasks.push(task);
    }

    log.info('Notification engine started (daily digest 9 AM ET, ticket changes 9 AM + 2 PM ET)');
  }

  stop() {
    for (const task of this._cronTasks) task.stop();
    this._cronTasks = [];
  }

  // ════════════════════════════════════════════════════════
  // Feature 1: Daily DM Digest
  // ════════════════════════════════════════════════════════

  /**
   * Send daily DM to each developer/QA person with their undone tickets
   * across upcoming releases.
   */
  async sendDailyDigests() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const windowDays = isWeekend ? 3 : 7;

    const cutoff = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    // Find releases with release date within window that aren't done
    const allReleases = this.releases.list();
    const relevant = allReleases.filter(r =>
      r.state !== 'done' && !r.jiraArchived &&
      r.jiraReleaseDate && r.jiraReleaseDate <= cutoff
    );

    if (relevant.length === 0) {
      log.info('Daily digest: no releases in window, skipping');
      return;
    }

    // Group undone tickets by person (assignee + qaAssignee)
    const byPerson = new Map(); // name → [{ release, ticket }]

    for (const release of relevant) {
      for (const ticket of (release.tickets || [])) {
        const status = ticket.jiraStatus || '';
        if (DONE_STATUSES.has(status)) continue;

        const people = new Set();
        if (ticket.assignee) people.add(ticket.assignee);
        if (ticket.qaAssignee) people.add(ticket.qaAssignee);

        for (const person of people) {
          if (!byPerson.has(person)) byPerson.set(person, []);
          byPerson.get(person).push({ release, ticket });
        }
      }
    }

    if (byPerson.size === 0) {
      log.info('Daily digest: no undone tickets assigned, skipping');
      return;
    }

    log.info(`Daily digest: sending to ${byPerson.size} people across ${relevant.length} releases`);

    const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';
    let sent = 0;
    let skipped = 0;

    for (const [person, items] of byPerson) {
      // Resolve Slack ID
      const resolved = this.people.resolveSlackId(person);
      if (!resolved) {
        skipped++;
        continue;
      }

      // Check per-user preference (opt-out model — send by default)
      if (!this._isUserEnabled(resolved.slackId, 'dailyDigest')) {
        skipped++;
        continue;
      }

      // Group items by release
      const byRelease = new Map();
      for (const item of items) {
        const ver = item.release.version;
        if (!byRelease.has(ver)) byRelease.set(ver, { release: item.release, tickets: [] });
        byRelease.get(ver).tickets.push(item.ticket);
      }

      // Format DM
      const lines = [`📋 *Your tickets this week* — ${items.length} item${items.length !== 1 ? 's' : ''} need attention`, ''];

      for (const [version, group] of byRelease) {
        const dateStr = group.release.jiraReleaseDate || 'Unscheduled';
        lines.push(`*${version}* (due ${dateStr})`);
        for (const t of group.tickets) {
          const emoji = this._statusEmoji(t.jiraStatus);
          lines.push(`  ${emoji} <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} _(${t.jiraStatus || 'Unknown'})_`);
        }
        lines.push('');
      }

      await this.slack.dmUser(resolved.slackId, lines.join('\n'));
      sent++;

      // Rate limit: 1 DM per second
      await new Promise(r => setTimeout(r, 1000));
    }

    log.info(`Daily digest: sent ${sent}, skipped ${skipped} (${byPerson.size} total people)`);
  }

  /**
   * Send a test daily digest to a single Slack user.
   * Used by the admin test UI to preview what a person would receive.
   *
   * @param {string} targetSlackId - Slack user ID to send to
   * @returns {{ ok: boolean, message: string, ticketCount?: number }}
   */
  async sendDailyDigestToUser(targetSlackId) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const windowDays = isWeekend ? 3 : 7;
    const cutoff = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const relevant = this.releases.list().filter(r =>
      r.state !== 'done' && !r.jiraArchived &&
      r.jiraReleaseDate && r.jiraReleaseDate <= cutoff
    );

    // Find all people names that resolve to this Slack ID
    const matchingNames = new Set();
    const allPeople = new Set();
    for (const release of relevant) {
      for (const ticket of (release.tickets || [])) {
        if (ticket.assignee) allPeople.add(ticket.assignee);
        if (ticket.qaAssignee) allPeople.add(ticket.qaAssignee);
      }
    }
    for (const name of allPeople) {
      const resolved = this.people.resolveSlackId(name);
      if (resolved && resolved.slackId === targetSlackId) {
        matchingNames.add(name);
      }
    }

    if (matchingNames.size === 0) {
      return { ok: false, message: 'No tickets found for this user in upcoming releases' };
    }

    // Collect their undone tickets
    const items = [];
    for (const release of relevant) {
      for (const ticket of (release.tickets || [])) {
        if (DONE_STATUSES.has(ticket.jiraStatus || '')) continue;
        const isAssignee = ticket.assignee && matchingNames.has(ticket.assignee);
        const isQa = ticket.qaAssignee && matchingNames.has(ticket.qaAssignee);
        if (isAssignee || isQa) {
          items.push({ release, ticket });
        }
      }
    }

    if (items.length === 0) {
      return { ok: false, message: 'No undone tickets for this user' };
    }

    // Group by release
    const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';
    const byRelease = new Map();
    for (const item of items) {
      const ver = item.release.version;
      if (!byRelease.has(ver)) byRelease.set(ver, { release: item.release, tickets: [] });
      byRelease.get(ver).tickets.push(item.ticket);
    }

    const lines = [`📋 *Your tickets this week* — ${items.length} item${items.length !== 1 ? 's' : ''} need attention`, ''];
    for (const [version, group] of byRelease) {
      const dateStr = group.release.jiraReleaseDate || 'Unscheduled';
      lines.push(`*${version}* (due ${dateStr})`);
      for (const t of group.tickets) {
        const emoji = this._statusEmoji(t.jiraStatus);
        lines.push(`  ${emoji} <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} _(${t.jiraStatus || 'Unknown'})_`);
      }
      lines.push('');
    }

    await this.slack.dmUser(targetSlackId, lines.join('\n'));
    return { ok: true, message: `Sent digest with ${items.length} tickets`, ticketCount: items.length };
  }

  // ════════════════════════════════════════════════════════
  // Feature 2: Build Failure/Recovery Alerts
  // ════════════════════════════════════════════════════════

  /**
   * Called after each pipeline sync. Detects build status transitions
   * and DMs affected dev + QA assignees.
   *
   * @param {Array} buildProjects - from pipelineSync.buildProjects
   */
  async checkBuildTransitions(buildProjects) {
    if (!this.settings.get('buildFailures')) return;
    if (!buildProjects || buildProjects.length === 0) return;

    const alerts = []; // { type: 'failure'|'recovery', project, jiraKeys, version }

    for (const project of buildProjects) {
      const prevStatus = this._previousBuildStatus.get(project.projectName);
      const currStatus = project.latestStatus;

      // Update cache
      this._previousBuildStatus.set(project.projectName, currStatus);

      // Skip first observation (cold start baseline)
      if (!prevStatus) continue;

      // Detect transitions
      if (prevStatus !== 'FAILED' && currStatus === 'FAILED') {
        alerts.push({ type: 'failure', project, version: project.version });
      } else if (prevStatus === 'FAILED' && currStatus === 'SUCCEEDED') {
        alerts.push({ type: 'recovery', project, version: project.version });
      }
    }

    if (alerts.length === 0) return;

    log.info(`Build alerts: ${alerts.length} transition(s) detected`);

    for (const alert of alerts) {
      await this._sendBuildAlert(alert);
    }
  }

  async _sendBuildAlert(alert) {
    const { type, project, version } = alert;
    const jiraKeys = project.jiraKeys || [];

    if (jiraKeys.length === 0) return;

    // Find the release to look up ticket assignees
    const release = version ? this.releases.get(version) : null;
    if (!release) return;

    // Collect unique people affected
    const people = new Set();
    const ticketSummaries = [];

    for (const key of jiraKeys) {
      const ticket = (release.tickets || []).find(t => t.key === key);
      if (!ticket) continue;
      if (ticket.assignee) people.add(ticket.assignee);
      if (ticket.qaAssignee) people.add(ticket.qaAssignee);
      ticketSummaries.push(`${key} — ${ticket.summary || 'Unknown'}`);
    }

    if (people.size === 0) return;

    const emoji = type === 'failure' ? ':x:' : ':white_check_mark:';
    const verb = type === 'failure' ? 'failed' : 'recovered';
    const buildNum = project.builds?.[0]?.buildNumber || '?';

    const lines = [
      `${emoji} *Build ${verb}* for \`${version}\` (Build #${buildNum})`,
      '',
      `Affected tickets:`,
      ...ticketSummaries.slice(0, 10).map(s => `  • ${s}`),
    ];
    if (ticketSummaries.length > 10) {
      lines.push(`  _+${ticketSummaries.length - 10} more_`);
    }

    const message = lines.join('\n');

    for (const person of people) {
      const resolved = this.people.resolveSlackId(person);
      if (!resolved) continue;
      if (!this._isUserEnabled(resolved.slackId, 'buildFailures')) continue;
      await this.slack.dmUser(resolved.slackId, message);
      await new Promise(r => setTimeout(r, 500));
    }

    log.info(`Build alert: ${type} for ${version}, notified ${people.size} people`);
  }

  // ════════════════════════════════════════════════════════
  // Feature 3: Ticket Changes in Scheduled Digest
  // ════════════════════════════════════════════════════════

  /**
   * Buffer ticket add/remove changes from JIRA sync.
   * Called when jira-sync emits 'sync:version-tickets'.
   *
   * @param {string} version - release version
   * @param {{ repo: string, added: Array<{key,summary}>, removed: Array<{key,summary}> }} changes
   */
  bufferTicketChanges(version, changes) {
    if (!this._ticketChanges.has(version)) {
      this._ticketChanges.set(version, {
        added: new Map(),
        removed: new Map(),
        since: new Date().toISOString(),
      });
    }

    const buf = this._ticketChanges.get(version);

    for (const t of (changes.added || [])) {
      // If this ticket was previously marked as removed, cancel them out
      if (buf.removed.has(t.key)) {
        buf.removed.delete(t.key);
      } else {
        buf.added.set(t.key, t);
      }
    }

    for (const t of (changes.removed || [])) {
      // If this ticket was previously marked as added, cancel them out
      if (buf.added.has(t.key)) {
        buf.added.delete(t.key);
      } else {
        buf.removed.set(t.key, t);
      }
    }
  }

  /**
   * Send ticket change digests to release channels.
   * Called 30 seconds after the scheduled release status update.
   * Drains the buffer for each release.
   */
  async sendTicketChangeDigests() {
    if (this._ticketChanges.size === 0) return;

    const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';

    for (const [version, buf] of this._ticketChanges) {
      const addedList = Array.from(buf.added.values());
      const removedList = Array.from(buf.removed.values());

      if (addedList.length === 0 && removedList.length === 0) continue;

      const channel = SlackNotifier.releaseChannelName(version);
      const lines = [`📋 *Ticket changes* since last update:`];

      if (addedList.length > 0) {
        lines.push('');
        const SHOW_LIMIT = 5;
        lines.push(`➕ *Added (${addedList.length}):*`);
        for (const t of addedList.slice(0, SHOW_LIMIT)) {
          lines.push(`  <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary}`);
        }
        if (addedList.length > SHOW_LIMIT) {
          lines.push(`  _+${addedList.length - SHOW_LIMIT} more_`);
        }
      }

      if (removedList.length > 0) {
        lines.push('');
        const SHOW_LIMIT = 5;
        lines.push(`➖ *Removed (${removedList.length}):*`);
        for (const t of removedList.slice(0, SHOW_LIMIT)) {
          lines.push(`  <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary}`);
        }
        if (removedList.length > SHOW_LIMIT) {
          lines.push(`  _+${removedList.length - SHOW_LIMIT} more_`);
        }
      }

      await this.slack.postMessage(channel, lines.join('\n'));
      log.info(`Ticket changes: posted ${addedList.length} added, ${removedList.length} removed for ${version} to ${channel}`);
    }

    // Drain the buffer
    this._ticketChanges.clear();
  }

  // ════════════════════════════════════════════════════════
  // Feature 4 & 5: Preference + Toggle Helpers
  // ════════════════════════════════════════════════════════

  /**
   * Check if a specific user has a notification type enabled.
   * Opt-out model: returns true if no preference is stored.
   *
   * @param {string} slackId - Slack user ID
   * @param {string} prefKey - e.g. 'dailyDigest', 'buildFailures'
   * @returns {boolean}
   */
  _isUserEnabled(slackId, prefKey) {
    // Try to find the user in userStore by matching Slack ID back to email
    // For now, we don't have a slackId→email mapping, so opt-out model:
    // all users get notifications unless they explicitly disable them.
    // Users who have logged into Nectar and set preferences are matched by
    // iterating the user store and checking if their name resolves to this slackId.
    for (const user of this.userStore.listUsers()) {
      const resolved = this.people.resolveSlackId(user.name);
      if (resolved && resolved.slackId === slackId) {
        const prefs = user.notificationPrefs;
        if (prefs && typeof prefs[prefKey] === 'boolean') {
          return prefs[prefKey];
        }
        break;
      }
    }
    // Default: enabled (opt-out model)
    return true;
  }

  _statusEmoji(jiraStatus) {
    return SlackNotifier._statusEmoji(jiraStatus);
  }
}

module.exports = NotificationEngine;
