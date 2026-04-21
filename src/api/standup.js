const log = require('../core/log');

/**
 * Daily Standup API — aggregates per-person data with priority buckets
 * for a wizard-style standup page.
 *
 * GET /api/standup?range=week
 *
 * Returns: { people: [...], releasesDueThisWeek: [...], generatedAt }
 */

const DONE_STATUSES = new Set([
  'QA Certified', 'No QA - Certified', 'QA Done', 'Done', 'Closed',
  'Resolved', 'Released', 'Resolved Without Code', 'Completed',
]);

// Health categories from ticket_truth that map to our priority buckets
const ATTENTION_CATEGORIES = new Set(['attention']);
const AWAITING_CP_CATEGORIES = new Set(['awaiting-cp']);
const IN_QA_CATEGORIES = new Set(['in-qa']);
const IN_DEV_CATEGORIES = new Set(['in-dev']);

// Urgency weights for sorting people — higher = more urgent
const URGENCY_WEIGHTS = {
  releaseCritical: 5,
  awaitingCherryPick: 3,
  reviewChangesRequested: 3,
  blocked: 4,
  pendingTesting: 1,
  reviewApproved: 2,
  inDev: 0,
};

// Map a repo (short name or "org/repo") to a team. Unknown repos → null.
function teamForRepo(repo) {
  if (!repo) return null;
  const short = String(repo).toLowerCase().split('/').pop();
  if (short === 'android' || short === 'ios') return 'mobile';
  if (short === 'webplatform' || short === 'bluesummit') return 'web';
  return null;
}

/**
 * Build the standup data for all people with active work.
 *
 * @param {object} services - { releases, ticketStore, prStore, availability, peopleDirectory }
 * @param {object} opts - { horizon }
 * @returns {object} { people, releasesDueThisWeek, generatedAt }
 */
function buildStandupData(services, opts = {}) {
  const { releases, ticketStore, prStore, availability, peopleDirectory } = services;
  const today = new Date().toISOString().slice(0, 10);
  const horizon = opts.horizon || _defaultHorizon(availability);

  // 1. ALL active releases — standup shows everyone's full workload.
  //    The horizon is used only for the "imminent" header and urgency scoring.
  const allReleases = releases.list();
  const activeReleases = allReleases.filter(r =>
    r.state !== 'done' && !r.jiraArchived
  );

  // Releases due within horizon — shown in the header as context for the PM
  const imminentReleases = activeReleases.filter(r =>
    r.jiraReleaseDate && r.jiraReleaseDate <= horizon
  );

  if (activeReleases.length === 0) {
    return { people: [], releasesDueThisWeek: [], generatedAt: new Date().toISOString() };
  }

  // 2. Gather all undone tickets across ALL active releases, grouped by person
  const byPerson = new Map(); // name → { asAssignee: [{ ticket, release }], asQa: [{ ticket, release }] }
  const allTicketKeys = new Set();

  for (const release of activeReleases) {
    const tickets = releases.getTickets(release);
    for (const ticket of tickets) {
      if (DONE_STATUSES.has(ticket.jiraStatus || '')) continue;
      allTicketKeys.add(ticket.key);

      if (ticket.assignee) {
        if (!byPerson.has(ticket.assignee)) byPerson.set(ticket.assignee, { asAssignee: [], asQa: [] });
        byPerson.get(ticket.assignee).asAssignee.push({ ticket, release });
      }
      if (ticket.qaAssignee) {
        if (!byPerson.has(ticket.qaAssignee)) byPerson.set(ticket.qaAssignee, { asAssignee: [], asQa: [] });
        byPerson.get(ticket.qaAssignee).asQa.push({ ticket, release });
      }
    }
  }

  // 3. Batch-fetch enrichment data
  const uniqueKeys = [...allTicketKeys];
  const truthMap = ticketStore ? ticketStore.getTruthForTicketsSlim(uniqueKeys) : new Map();
  const prLookup = prStore ? prStore.findByJiraKeysSlim(uniqueKeys) : new Map();

  // 4. Build per-person buckets
  const people = [];

  for (const [personName, work] of byPerson) {
    // Determine role
    const roles = [];
    if (work.asAssignee.length > 0) roles.push('dev');
    if (work.asQa.length > 0) roles.push('qa');

    // Check OOO
    const isOoo = availability ? availability.isPersonOut(personName) : false;

    // Resolve Slack ID for linking
    const resolved = peopleDirectory ? peopleDirectory.resolveSlackId(personName) : null;
    const slackId = resolved ? resolved.slackId : null;

    // Build priority buckets
    const buckets = {
      releaseCritical: [],
      awaitingCherryPick: [],
      reviewChangesRequested: [],
      reviewApproved: [],
      blocked: [],
      pendingTesting: [],
      inDev: [],
    };

    // Process all tickets for this person
    const seenKeys = new Set();
    const allItems = [...work.asAssignee.map(i => ({ ...i, role: 'dev' })), ...work.asQa.map(i => ({ ...i, role: 'qa' }))];

    for (const { ticket, release, role } of allItems) {
      if (seenKeys.has(ticket.key + ':' + role)) continue;
      seenKeys.add(ticket.key + ':' + role);

      const prs = prLookup.get(ticket.key) || [];
      const truth = truthMap.get(ticket.key) || [];

      // Find the truth entry for this specific release
      const releaseTruth = truth.find(t => t.version === release.version) || null;
      const healthCategory = releaseTruth ? releaseTruth.healthCategory : null;

      const item = {
        key: ticket.key,
        summary: ticket.summary,
        jiraStatus: ticket.jiraStatus,
        type: ticket.type,
        priority: ticket.priority,
        role,
        release: {
          version: release.version,
          dueDate: release.jiraReleaseDate,
          state: release.state,
          repo: release.repo || null,
        },
        prs: prs.map(p => ({
          prNumber: p.prNumber,
          repo: p.repo,
          prUrl: p.prUrl,
          status: p.status,
          reviewDecision: p.reviewDecision,
          prAuthor: p.prAuthor,
        })),
        health: releaseTruth ? releaseTruth.health : null,
        healthCategory,
      };

      // Classify into priority bucket
      if (healthCategory === 'attention') {
        buckets.blocked.push(item);
      } else if (healthCategory === 'awaiting-cp') {
        buckets.awaitingCherryPick.push(item);
      } else if (healthCategory === 'in-qa') {
        buckets.pendingTesting.push(item);
      } else if (healthCategory === 'in-dev') {
        buckets.inDev.push(item);
      } else {
        // Default to inDev if no truth
        buckets.inDev.push(item);
      }
    }

    // Add PR review data — PRs linked to this person's tickets that have review states
    const personTicketKeys = new Set([
      ...work.asAssignee.map(i => i.ticket.key),
    ]);

    for (const key of personTicketKeys) {
      const prs = prLookup.get(key) || [];
      for (const pr of prs) {
        if (pr.status !== 'open') continue;
        const prItem = {
          prNumber: pr.prNumber,
          repo: pr.repo,
          prUrl: pr.prUrl,
          reviewDecision: pr.reviewDecision,
          prAuthor: pr.prAuthor,
          linkedTicket: key,
        };
        if (pr.reviewDecision === 'CHANGES_REQUESTED') {
          // Only add if not already in bucket
          if (!buckets.reviewChangesRequested.find(p => p.prNumber === pr.prNumber)) {
            buckets.reviewChangesRequested.push(prItem);
          }
        } else if (pr.reviewDecision === 'APPROVED') {
          if (!buckets.reviewApproved.find(p => p.prNumber === pr.prNumber)) {
            buckets.reviewApproved.push(prItem);
          }
        }
      }
    }

    // Release-critical = any ticket on a release due within 5 business days
    const critical = [];
    for (const bucketName of ['blocked', 'awaitingCherryPick', 'inDev', 'pendingTesting']) {
      for (const item of buckets[bucketName]) {
        if (item.release.dueDate && item.release.dueDate <= horizon) {
          critical.push({ ...item, originalBucket: bucketName });
        }
      }
    }
    buckets.releaseCritical = critical;

    // Compute urgency score
    const urgencyScore =
      buckets.releaseCritical.length * URGENCY_WEIGHTS.releaseCritical +
      buckets.awaitingCherryPick.length * URGENCY_WEIGHTS.awaitingCherryPick +
      buckets.reviewChangesRequested.length * URGENCY_WEIGHTS.reviewChangesRequested +
      buckets.blocked.length * URGENCY_WEIGHTS.blocked +
      buckets.pendingTesting.length * URGENCY_WEIGHTS.pendingTesting +
      buckets.reviewApproved.length * URGENCY_WEIGHTS.reviewApproved +
      buckets.inDev.length * URGENCY_WEIGHTS.inDev;

    // Count unique tickets (not double-counted across roles or release-critical duplication)
    const uniqueTicketKeys = new Set();
    for (const bucketKey of ['awaitingCherryPick', 'blocked', 'pendingTesting', 'inDev']) {
      for (const item of buckets[bucketKey]) uniqueTicketKeys.add(item.key);
    }
    // PR review items are separate (not ticket-based)
    const totalItems = uniqueTicketKeys.size +
      buckets.reviewChangesRequested.length +
      buckets.reviewApproved.length;

    // Collect which releases this person is involved in (for filter pills)
    // Count unique tickets per release (not duplicated across dev/qa roles)
    const releaseSet = new Map(); // version → { version, dueDate, state, ticketKeys: Set }
    for (const { ticket, release } of allItems) {
      if (!releaseSet.has(release.version)) {
        releaseSet.set(release.version, {
          version: release.version,
          dueDate: release.jiraReleaseDate,
          state: release.state,
          _keys: new Set(),
        });
      }
      releaseSet.get(release.version)._keys.add(ticket.key);
    }
    const personReleases = [...releaseSet.values()]
      .map(r => ({ version: r.version, dueDate: r.dueDate, state: r.state, ticketCount: r._keys.size }))
      .sort((a, b) => (a.dueDate || 'zzzz').localeCompare(b.dueDate || 'zzzz'));

    // Determine default filter: show imminent (5 biz days) if they have
    // tickets in that window, otherwise show all.
    const imminentVersions = new Set(
      imminentReleases.map(r => r.version)
    );
    const hasImminentTickets = allItems.some(i => imminentVersions.has(i.release.version));
    const defaultFilter = hasImminentTickets ? 'imminent' : 'all';

    // Derive teams: QA role → qa only. Non-QA → platform team by ticket repo.
    const teams = new Set();
    if (roles.includes('qa')) {
      teams.add('qa');
    } else {
      for (const { release } of allItems) {
        const t = teamForRepo(release.repo);
        if (t) teams.add(t);
      }
    }

    people.push({
      name: personName,
      slackId,
      roles,
      teams: [...teams],
      isOoo,
      buckets,
      urgencyScore,
      totalItems,
      releases: personReleases,
      defaultFilter,
      imminentVersions: [...imminentVersions],
    });
  }

  // Include team members who have no items (all-clear) so everyone is visible.
  // Pull from ticketStore.getDistinctPeople() which knows all devs/QA from JIRA history.
  if (ticketStore && ticketStore.getDistinctPeople) {
    const allTeam = ticketStore.getDistinctPeople();
    const included = new Set(people.map(p => p.name));
    for (const member of allTeam) {
      if (included.has(member.name)) continue;
      // Only include dev and qa roles in standup
      const standupRoles = member.roles.filter(r => r === 'dev' || r === 'qa');
      if (standupRoles.length === 0) continue;

      const isOoo = availability ? availability.isPersonOut(member.name) : false;
      const resolved = peopleDirectory ? peopleDirectory.resolveSlackId(member.name) : null;
      // Without active tickets we can only infer team from role.
      const teams = standupRoles.includes('qa') ? ['qa'] : [];
      people.push({
        name: member.name,
        slackId: resolved ? resolved.slackId : null,
        roles: standupRoles,
        teams,
        isOoo,
        buckets: {
          releaseCritical: [],
          awaitingCherryPick: [],
          reviewChangesRequested: [],
          reviewApproved: [],
          blocked: [],
          pendingTesting: [],
          inDev: [],
        },
        urgencyScore: 0,
        totalItems: 0,
        releases: [],
        defaultFilter: 'all',
        imminentVersions: [],
      });
    }
  }

  // Default sort: OOO people last, then by urgency score descending
  people.sort((a, b) => {
    if (a.isOoo !== b.isOoo) return a.isOoo ? 1 : -1;
    return b.urgencyScore - a.urgencyScore;
  });

  // Build releases summary — imminent releases shown as header context
  const releasesDueThisWeek = imminentReleases.map(r => ({
    version: r.version,
    dueDate: r.jiraReleaseDate,
    state: r.state,
    repo: r.repo || null,
    ticketsRemaining: (releases.getTickets(r) || []).filter(t => !DONE_STATUSES.has(t.jiraStatus || '')).length,
  })).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));

  return {
    people,
    releasesDueThisWeek,
    generatedAt: new Date().toISOString(),
  };
}

function _defaultHorizon(availability) {
  const todayIso = new Date().toISOString().slice(0, 10);

  // Use availability service for proper business day calculation (skips weekends + holidays)
  if (availability && availability.nextBusinessDays) {
    const bizDays = availability.nextBusinessDays(5, todayIso);
    if (bizDays.length > 0) return bizDays[bizDays.length - 1];
  }

  // Fallback: 5 business days ≈ 7-9 calendar days depending on day of week
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun
  // Mon=9, Tue=8, Wed=7, Thu=9 (skip weekend), Fri=9, Sat=8, Sun=7
  const calDays = dayOfWeek <= 3 ? 7 : 9; // conservative: always covers 5 weekdays
  const end = new Date(today.getTime() + calDays * 24 * 60 * 60 * 1000);
  return end.toISOString().slice(0, 10);
}

module.exports = { buildStandupData, URGENCY_WEIGHTS, teamForRepo };
