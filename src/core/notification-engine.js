const cron = require('node-cron');
const log = require('./log');
const SlackNotifier = require('../integrations/slack');

const DONE_STATUSES = new Set([
  'QA Certified', 'No QA - Certified', 'QA Done', 'Done', 'Closed',
  'Resolved', 'Released', 'Resolved Without Code',
]);

// Role-based status buckets for the daily digest.
// A ticket shows under the DEV section only when it's in a dev-actionable status,
// and under the QA section only when it's in a QA-actionable status. A status
// appears in at most one bucket — so a ticket is never in both sections.

const DEV_BUCKETS = [
  // High-priority — red section, shown first
  {
    key: 'needs-attention',
    label: 'Needs attention (as dev)',
    emoji: '🔴',
    statuses: [
      'Blocked', 'Testing Failed', 'Test Failed', 'Pending Bug Fix',
      'Re-verify Bug', 'Needs Re-verification',
    ],
  },
  // Active development
  {
    key: 'in-dev',
    label: 'In Dev (as dev)',
    emoji: '🛠',
    statuses: [
      'Development In Progress', 'In Progress', 'In Review', 'Development',
      'Design In Progress', 'Design In Review', 'Design Review',
      'Implementing', 'Remediation in Progress', 'Defect Remediation in Progress',
      'Code Review',
    ],
  },
  // Awaiting the dev to cherry-pick
  {
    key: 'awaiting-cp',
    label: 'Awaiting Cherry Pick (as dev)',
    emoji: '⏳',
    statuses: [
      'Waiting for Cherry Pick', 'Ready for Cherry Pick',
    ],
  },
  // Pre-dev — queued but not started
  {
    key: 'pre-dev',
    label: 'Pre-Dev (as dev)',
    emoji: '⏸',
    statuses: [
      'Open', 'To Do', 'Backlog', 'Planning', 'Requirements', 'Needs Requirements',
      'Ready to Develop', 'Ready For Estimation', 'Reopened', 'Pending',
      'Pending Dev Investigation', 'Pending Defect Remediation', 'Pending Configuration',
      'Pending Prioritization', 'Investigating Issue', 'Escalated',
    ],
  },
];

const QA_BUCKETS = [
  // Ready to test
  {
    key: 'ready-for-qa',
    label: 'Ready for QA (as qa)',
    emoji: '🔵',
    statuses: [
      'Ready For Testing', 'Cherry Picked', 'Cherrypick is Building',
      'Retest After Cherrypick', 'DQA Required',
    ],
  },
  // Actively testing
  {
    key: 'in-qa',
    label: 'In QA (as qa)',
    emoji: '🟣',
    statuses: [
      'In Testing', 'Testing in Branch', 'Testing',
      'Validating', 'Pending Customer QA/UAT',
    ],
  },
];

// Fast reverse lookup: status → { role, bucketKey, bucketIndex }
const _devStatusMap = new Map();
DEV_BUCKETS.forEach((b, i) => b.statuses.forEach(s => _devStatusMap.set(s, { bucketKey: b.key, bucketIndex: i })));
const _qaStatusMap = new Map();
QA_BUCKETS.forEach((b, i) => b.statuses.forEach(s => _qaStatusMap.set(s, { bucketKey: b.key, bucketIndex: i })));

function devBucketFor(status) { return _devStatusMap.get(status || '') || null; }
function qaBucketFor(status)  { return _qaStatusMap.get(status || '') || null; }

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
  constructor({ slack, releases, releaseNotifier, peopleDirectory, userStore, notificationSettings, availability, config }) {
    this.slack = slack;
    this.releases = releases;
    this.releaseNotifier = releaseNotifier;
    this.people = peopleDirectory;
    this.userStore = userStore;
    this.settings = notificationSettings;
    this.availability = availability || null;
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
   * Compute the digest cutoff date — latest release date to include.
   * "Next 2 business days" — skips weekends and holidays.
   */
  _digestCutoff(todayIso) {
    if (this.availability) {
      const biz = this.availability.nextBusinessDays(2, todayIso);
      if (biz.length) return biz[biz.length - 1];
    }
    // Fallback: next 2 days (weekdays approximation)
    const d = new Date(todayIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Send daily DM to each developer/QA person with their undone tickets
   * across upcoming releases.
   */
  async sendDailyDigests() {
    const todayIso = new Date().toISOString().slice(0, 10);

    // Skip entirely on company holidays — treat like a weekend
    if (this.availability && this.availability.isHoliday(todayIso)) {
      log.info(`Daily digest: skipping — today (${todayIso}) is a holiday`);
      return;
    }

    // Window = next 2 business days (skips weekends + holidays)
    const cutoff = this._digestCutoff(todayIso);

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

    let sent = 0;
    let skipped = 0;
    let filteredOut = 0;

    for (const [person, items] of byPerson) {
      // Resolve Slack ID
      const resolved = this.people.resolveSlackId(person);
      if (!resolved) {
        skipped++;
        continue;
      }

      // Skip if the person is out of office today
      if (this.availability && this.availability.isPersonOut(person)) {
        log.info(`Daily digest: skipping ${person} — out of office`);
        skipped++;
        continue;
      }

      // Check per-user preference (opt-out model — send by default)
      if (!this._isUserEnabled(resolved.slackId, 'dailyDigest')) {
        skipped++;
        continue;
      }

      const message = this._buildPersonDigest(person, items);
      if (!message) {
        // All their tickets were in non-actionable statuses for their role(s)
        filteredOut++;
        continue;
      }

      await this.slack.dmUser(resolved.slackId, message);
      sent++;

      // Rate limit: 1 DM per second
      await new Promise(r => setTimeout(r, 1000));
    }

    log.info(`Daily digest: sent ${sent}, skipped ${skipped}, filtered-out ${filteredOut} (${byPerson.size} total people)`);
  }

  /**
   * Build a role-bucketed digest DM for one person.
   *
   * @param {string} person - JIRA display name
   * @param {Array<{ release, ticket }>} items - tickets where they're assignee or qaAssignee
   * @returns {string|null} formatted Slack message, or null if no tickets pass role filters
   */
  _buildPersonDigest(person, items) {
    const personLower = person.toLowerCase();
    const jiraBaseUrl = process.env.JIRA_URL || process.env.JIRA_BASE_URL || 'https://vivtechnologies.atlassian.net';
    const nectarBaseUrl = process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com';

    // Bucket tickets by (role, bucketKey). A ticket appears once under whichever
    // role matches its status.
    const sections = new Map(); // bucketKey → { role, label, emoji, tickets: [] }
    let devTotal = 0;
    let qaTotal = 0;

    for (const { ticket } of items) {
      const isAssignee = ticket.assignee && ticket.assignee.toLowerCase() === personLower;
      const isQa = ticket.qaAssignee && ticket.qaAssignee.toLowerCase() === personLower;

      if (isAssignee) {
        const b = devBucketFor(ticket.jiraStatus);
        if (b) {
          const bucket = DEV_BUCKETS[b.bucketIndex];
          this._addToBucket(sections, 'dev', bucket, ticket);
          devTotal++;
          continue; // this ticket is accounted for in dev bucket
        }
      }

      if (isQa) {
        const b = qaBucketFor(ticket.jiraStatus);
        if (b) {
          const bucket = QA_BUCKETS[b.bucketIndex];
          this._addToBucket(sections, 'qa', bucket, ticket);
          qaTotal++;
        }
      }
    }

    const totalTickets = devTotal + qaTotal;
    if (totalTickets === 0) return null;

    // Build the message
    const primaryRole = devTotal >= qaTotal ? 'dev' : 'qa';
    const headerLink = `${nectarBaseUrl}/?view=${primaryRole}&person=${encodeURIComponent(person)}`;
    const lines = [
      `📋 *Your tickets this week* — ${totalTickets} item${totalTickets !== 1 ? 's' : ''}`,
      `🔗 <${headerLink}|Open in Nectar>`,
      '',
    ];

    // Render sections in the order defined by DEV_BUCKETS / QA_BUCKETS,
    // skipping empty ones.
    const orderedSections = [
      ...DEV_BUCKETS.map(b => ({ role: 'dev', bucket: b })),
      ...QA_BUCKETS.map(b => ({ role: 'qa', bucket: b })),
    ];

    const SHOW_LIMIT = 10;

    for (const { role, bucket } of orderedSections) {
      const entry = sections.get(bucket.key);
      if (!entry || entry.tickets.length === 0) continue;

      const sectionLink = `${nectarBaseUrl}/?view=${role}&person=${encodeURIComponent(person)}`;
      lines.push(`${bucket.emoji} *${bucket.label}* — ${entry.tickets.length}`);

      const visible = entry.tickets.slice(0, SHOW_LIMIT);
      for (const t of visible) {
        // Cross-role awareness: if I'm a dev, call out if the QA is out; vice versa.
        let oooNote = '';
        if (this.availability) {
          if (role === 'dev' && t.qaAssignee) {
            const qaOut = this.availability.getPersonOut(t.qaAssignee);
            if (qaOut) oooNote = ` ⚠ QA ${t.qaAssignee} out until ${qaOut.endDate}`;
          } else if (role === 'qa' && t.assignee) {
            const devOut = this.availability.getPersonOut(t.assignee);
            if (devOut) oooNote = ` ⚠ Dev ${t.assignee} out until ${devOut.endDate}`;
          }
        }
        lines.push(`  <${jiraBaseUrl}/browse/${t.key}|${t.key}> — ${t.summary} _(${t.jiraStatus || 'Unknown'})_${oooNote}`);
      }
      if (entry.tickets.length > SHOW_LIMIT) {
        lines.push(`  _+${entry.tickets.length - SHOW_LIMIT} more — <${sectionLink}|see all>_`);
      } else {
        lines.push(`  <${sectionLink}|See all your ${role} tickets>`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  _addToBucket(sections, role, bucket, ticket) {
    let entry = sections.get(bucket.key);
    if (!entry) {
      entry = { role, label: bucket.label, emoji: bucket.emoji, tickets: [] };
      sections.set(bucket.key, entry);
    }
    entry.tickets.push(ticket);
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

    // Pick any one of the matching names (usually just one) for the digest header
    const primaryName = matchingNames.values().next().value;
    const message = this._buildPersonDigest(primaryName, items);
    if (!message) {
      return { ok: false, message: 'This user has tickets, but none in actionable statuses for their role(s)' };
    }

    await this.slack.dmUser(targetSlackId, message);
    // Count visible tickets in the message (approximation: count ticket lines)
    const visibleCount = (message.match(/\|DEV-/g) || []).length;
    return { ok: true, message: `Sent digest with ${visibleCount} tickets`, ticketCount: visibleCount };
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
    if (!this.settings.get('buildFailures')) {
      log.info('Build alerts: disabled by notification settings');
      return;
    }
    if (!buildProjects || buildProjects.length === 0) return;

    const isBaseline = this._previousBuildStatus.size === 0;
    const alerts = [];

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

    if (isBaseline) {
      log.info(`Build alerts: cold start baseline set for ${this._previousBuildStatus.size} projects (no alerts on first observation)`);
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

    if (jiraKeys.length === 0) {
      log.warn(`Build alert: ${type} for ${project.projectName} but no JIRA keys in build — skipping`);
      return;
    }

    // Find the release to look up ticket assignees
    const release = version ? this.releases.get(version) : null;
    if (!release) {
      log.warn(`Build alert: ${type} for ${project.projectName} (version=${version}) but release not found — skipping`);
      return;
    }

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

    if (people.size === 0) {
      log.warn(`Build alert: ${type} for ${version} — found ${jiraKeys.length} JIRA keys but none matched release tickets or had assignees`);
      return;
    }

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

    let dmsSent = 0;
    for (const person of people) {
      const resolved = this.people.resolveSlackId(person);
      if (!resolved) {
        log.warn(`Build alert: could not resolve Slack ID for "${person}" — skipping DM`);
        continue;
      }
      if (!this._isUserEnabled(resolved.slackId, 'buildFailures')) {
        log.info(`Build alert: ${person} has buildFailures disabled — skipping DM`);
        continue;
      }
      await this.slack.dmUser(resolved.slackId, message);
      dmsSent++;
      await new Promise(r => setTimeout(r, 500));
    }

    log.info(`Build alert: ${type} for ${version} — ${people.size} affected, ${dmsSent} DMs sent`);
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
