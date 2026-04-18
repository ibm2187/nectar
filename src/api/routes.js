const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const log = require('../core/log');
const { requireAdmin } = require('./auth');
const ReleaseManager = require('../core/release');
const { annotateReleases } = require('../core/release-status');
const { aggregateFeatureFlags, aggregateIntegrations } = require('../core/feature-aggregator');

/** Wrap async route handlers so rejected promises become proper error responses */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Statuses treated as "done" — excluded from OOO risk calculation. */
const DONE_STATUSES_FOR_RISK = new Set([
  'QA Certified', 'No QA - Certified', 'QA Done', 'Done', 'Closed',
  'Resolved', 'Released', 'Resolved Without Code', 'Completed',
]);

/**
 * REST API routes — primary consumer is Hive.
 * @param {object} services - All initialized services
 * @param {object} config
 */
module.exports = function createRoutes(services, config) {
  const { releases, repoManager, github, risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth, customerStore, webplatformScanner, envPoller, themeConfig, apiKeys, taskQueue, userStore, datadog, datadogPoller } = services;

  // Nectar's own repo — used by the Issues page so users can file bugs/feedback.
  const NECTAR_REPO = 'mavencare/nectar';
  const router = Router();

  // NOTE: Auth is now handled by the unified auth middleware in web/server.js.
  // The old WEB_TOKEN-only middleware has been replaced by createAuthMiddleware
  // which supports API keys, WEB_TOKEN, and Google SSO JWT cookies.

  // ── Releases ──────────────────────────────────────────

  router.get('/releases', (req, res) => {
    const { state, repo } = req.query;
    const filter = {};
    if (state) filter.state = state;
    if (repo) filter.repo = repo;
    const list = releases.list(filter);
    // Annotate with effective release status based on prod env deployments
    const environments = customerStore.listEnvironments();
    res.json(annotateReleases(list, environments));
  });

  // Release calendar — all releases annotated with effective status
  // (shipped/in-flight/upcoming/overdue) using prod env data.
  // Includes unscheduled releases (no jiraReleaseDate) for the unscheduled column.
  router.get('/releases/calendar', (req, res) => {
    const { repo, from, to } = req.query;
    let list = releases.list();
    if (repo) list = list.filter(r => r.repo === repo);
    list = list.filter(r => !r.jiraArchived);
    list = list.filter(r => {
      if (!r.jiraReleaseDate) return true; // unscheduled — always include
      if (from && r.jiraReleaseDate < from) return false;
      if (to && r.jiraReleaseDate > to) return false;
      return true;
    });
    list.sort((a, b) => (a.jiraReleaseDate || 'zzzz').localeCompare(b.jiraReleaseDate || 'zzzz'));
    const environments = customerStore.listEnvironments();
    res.json(annotateReleases(list, environments));
  });

  router.get('/releases/active', (req, res) => {
    res.json(releases.active());
  });

  // Home dashboard — overdue + upcoming 2 weeks of releases with tickets,
  // optionally filtered by person and role view.
  /**
   * Compute the horizon date from a range parameter.
   * 'today' = end of today, 'week' = end of this Sunday,
   * '2w' = end of next Sunday, '4w' = 4 weeks out.
   * Also accepts numeric days via ?days= for backward compat.
   */
  function computeHorizon(query) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const range = query.range || null;
    if (range === 'today') {
      return today.toISOString().slice(0, 10);
    }
    if (range === 'week') {
      const dayOfWeek = today.getDay(); // 0=Sun
      const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      const sunday = new Date(today.getTime() + daysToSunday * 24 * 60 * 60 * 1000);
      return sunday.toISOString().slice(0, 10);
    }
    if (range === '2w') {
      const dayOfWeek = today.getDay();
      const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      const nextSunday = new Date(today.getTime() + (daysToSunday + 7) * 24 * 60 * 60 * 1000);
      return nextSunday.toISOString().slice(0, 10);
    }
    if (range === '4w') {
      const d = new Date(today.getTime() + 28 * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    }
    // Fallback: numeric days param or default 7
    const days = Math.min(Math.max(parseInt(query.days) || 7, 1), 90);
    return new Date(today.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  router.get('/releases/home', (req, res) => {
    const { view, person } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const horizon = computeHorizon(req.query);

    let list = releases.list();
    // Exclude done/archived
    list = list.filter(r => r.state !== 'done' && !r.jiraArchived);
    // Include: overdue (past release date) OR upcoming (within horizon) OR no date (unscheduled active)
    list = list.filter(r => {
      if (!r.jiraReleaseDate) return true; // unscheduled active
      if (r.jiraReleaseDate < today) return true; // overdue
      if (r.jiraReleaseDate <= horizon) return true; // upcoming
      return false;
    });

    // Sort: overdue first, then by date
    list.sort((a, b) => {
      const aDate = a.jiraReleaseDate || 'zzzz';
      const bDate = b.jiraReleaseDate || 'zzzz';
      return aDate.localeCompare(bDate);
    });

    // Annotate with effective status
    const environments = customerStore.listEnvironments();
    const annotated = annotateReleases(list, environments);

    // Build response with ticket filtering per view/person
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const availability = services.availability;

    // Helper: does a person's OOO overlap with the release date window?
    const releaseImpactingOut = (name, releaseDate) => {
      if (!availability || !name || !releaseDate) return null;
      // Impact window is today through release date (if within 2 days)
      if (releaseDate > tomorrow) return null;
      return availability.getPersonOutInRange(name, today, releaseDate);
    };

    let result = annotated.map(release => {
      let tickets = release.tickets || [];

      // Enrich tickets with PR data + build status + OOO annotations
      const prsByJiraKey = release.prsByJiraKey || {};
      const buildByJiraKey = release.buildByJiraKey || {};
      const releaseDate = release.jiraReleaseDate;
      const isImminentRelease = releaseDate && releaseDate <= tomorrow && release.state !== 'done';

      tickets = tickets.map(t => {
        const enriched = {
          ...t,
          prs: prsByJiraKey[t.key] || [],
          build: buildByJiraKey[t.key] || null,
        };
        if (availability) {
          const assigneeOut = t.assignee ? availability.getPersonOut(t.assignee) : null;
          const qaOut = t.qaAssignee ? availability.getPersonOut(t.qaAssignee) : null;
          if (assigneeOut) {
            enriched.assigneeOut = {
              startDate: assigneeOut.startDate, endDate: assigneeOut.endDate,
              blockingRelease: isImminentRelease,
            };
          }
          if (qaOut) {
            enriched.qaAssigneeOut = {
              startDate: qaOut.startDate, endDate: qaOut.endDate,
              blockingRelease: isImminentRelease,
            };
          }
        }
        return enriched;
      });

      // Filter tickets by person + view role
      if (person && view) {
        const personLower = person.toLowerCase();
        tickets = tickets.filter(t => {
          switch (view) {
            case 'dev':
              return t.assignee && t.assignee.toLowerCase() === personLower;
            case 'qa':
              return t.qaAssignee && t.qaAssignee.toLowerCase() === personLower;
            case 'pm':
              // PM matches across both dev and qa assignees
              return (t.assignee && t.assignee.toLowerCase() === personLower) ||
                     (t.qaAssignee && t.qaAssignee.toLowerCase() === personLower);
            default:
              return true;
          }
        });
      }

      // Release-impact OOO risk — only for releases due today or tomorrow
      const oooRisk = [];
      if (isImminentRelease && availability) {
        const seen = new Set();
        for (const t of tickets) {
          const status = t.jiraStatus || '';
          if (DONE_STATUSES_FOR_RISK.has(status)) continue;
          const addRisk = (name, role, outEvent) => {
            if (!outEvent) return;
            const key = `${name}:${role}`;
            if (seen.has(key)) return;
            seen.add(key);
            oooRisk.push({
              name, role,
              endDate: outEvent.endDate,
              blockingTickets: tickets
                .filter(x => (role === 'dev' ? x.assignee : x.qaAssignee) === name)
                .map(x => x.key)
                .slice(0, 20),
            });
          };
          if (t.assigneeOut && t.assigneeOut.blockingRelease) {
            addRisk(t.assignee, 'dev', availability.getPersonOut(t.assignee));
          }
          if (t.qaAssigneeOut && t.qaAssigneeOut.blockingRelease) {
            addRisk(t.qaAssignee, 'qa', availability.getPersonOut(t.qaAssignee));
          }
        }
      }

      return {
        ...release,
        tickets,
        ticketCount: tickets.length,
        totalTicketCount: (release.tickets || []).length,
        zohoTicketCount: (release.zohoTickets || []).length,
        zohoTickets: release.zohoTickets || [],
        pipeline: release.pipeline || null,
        isOverdue: release.jiraReleaseDate && release.jiraReleaseDate < today,
        oooRisk,
      };
    });

    // When filtering by person, hide releases with 0 matching tickets
    if (person && view && (view === 'dev' || view === 'qa' || view === 'pm')) {
      result = result.filter(r => r.ticketCount > 0);
    }

    res.json(result);
  });

  /**
   * GET /api/tickets/home — flat list of tickets in immediate releases,
   * with each ticket enriched with ALL releases it belongs to (including
   * past shipped ones).
   *
   * Same filter semantics as /releases/home: ?view=dev|qa|pm&person=...
   * The qualifying ticket set is restricted to immediate releases (overdue
   * + upcoming 2 weeks + unscheduled active), but the per-ticket release
   * list is unfiltered — so you see every release a ticket is in.
   */
  router.get('/tickets/home', (req, res) => {
    const { view, person } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const horizon = computeHorizon(req.query);

    const allReleases = releases.list();

    // Step 1: identify "immediate" releases (same logic as /releases/home)
    const immediateReleases = allReleases.filter(r => {
      if (r.state === 'done' || r.jiraArchived) return false;
      if (!r.jiraReleaseDate) return true;        // unscheduled active
      if (r.jiraReleaseDate < today) return true;  // overdue
      if (r.jiraReleaseDate <= horizon) return true; // upcoming
      return false;
    });

    // Step 2: collect tickets from immediate releases (deduped by key)
    // Apply person/role filter at this stage so we only enrich relevant tickets
    const personLower = person ? person.toLowerCase() : null;
    const ticketsByKey = new Map();

    for (const release of immediateReleases) {
      const prsByJiraKey = release.prsByJiraKey || {};
      const buildByJiraKey = release.buildByJiraKey || {};

      for (const ticket of (release.tickets || [])) {
        if (ticket.source !== 'jira') continue;

        // Person/role filter (same as /releases/home)
        if (personLower && view) {
          const matchesDev = ticket.assignee && ticket.assignee.toLowerCase() === personLower;
          const matchesQa = ticket.qaAssignee && ticket.qaAssignee.toLowerCase() === personLower;
          const matches =
            (view === 'dev' && matchesDev) ||
            (view === 'qa' && matchesQa) ||
            (view === 'pm' && (matchesDev || matchesQa));
          if (!matches) continue;
        }

        if (ticketsByKey.has(ticket.key)) continue; // dedupe across releases

        ticketsByKey.set(ticket.key, {
          key: ticket.key,
          summary: ticket.summary || '',
          jiraStatus: ticket.jiraStatus || 'Unknown',
          state: ticket.state || 'pending',
          type: ticket.type || null,
          assignee: ticket.assignee || null,
          qaAssignee: ticket.qaAssignee || null,
          component: ticket.component || null,
          customerTags: Array.isArray(ticket.customerTags) ? ticket.customerTags : [],
          deployedEnvironments: Array.isArray(ticket.deployedEnvironments) ? ticket.deployedEnvironments : [],
          priority: ticket.priority || null,
          riskLevel: ticket.riskLevel || null,
          customerPriority: ticket.customerPriority || null,
          zohoRef: ticket.zohoRef || null,
          fixVersions: Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [],
          targetFixVersions: Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [],
          prs: prsByJiraKey[ticket.key] || [],
          build: buildByJiraKey[ticket.key] || null,
          releases: [],
        });
      }
    }

    // Build immediate-releases column list (used for filter chips)
    const releaseColumns = immediateReleases.map(r => ({
      repo: r.repo,
      version: r.version,
      state: r.state,
      jiraReleaseDate: r.jiraReleaseDate || null,
    })).sort((a, b) => (a.jiraReleaseDate || 'zzzz').localeCompare(b.jiraReleaseDate || 'zzzz'));

    if (ticketsByKey.size === 0) {
      return res.json({ releases: releaseColumns, tickets: [] });
    }

    // Step 3: cross-reference each ticket against ALL releases (not just immediate)
    // to enrich the per-ticket release list
    for (const release of allReleases) {
      const releaseVersion = release.version;
      const isImmediate = immediateReleases.some(r => r.version === releaseVersion && r.repo === release.repo);
      const isShipped = release.state === 'done' || !!release.jiraReleased;
      const isOverdue = !!release.jiraReleaseDate && release.jiraReleaseDate < today && !isShipped;

      for (const ticket of (release.tickets || [])) {
        if (ticket.source !== 'jira') continue;
        const enriched = ticketsByKey.get(ticket.key);
        if (!enriched) continue;

        const targetVersions = Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [];
        const fixVersions = Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [];
        const inTarget = targetVersions.includes(releaseVersion);
        const inFixVersion = fixVersions.includes(releaseVersion);
        if (!inTarget && !inFixVersion) continue;

        // Avoid duplicate release entries for the same ticket
        if (enriched.releases.some(r => r.repo === release.repo && r.version === releaseVersion)) continue;

        enriched.releases.push({
          repo: release.repo,
          version: releaseVersion,
          state: release.state,
          jiraReleaseDate: release.jiraReleaseDate || null,
          isImmediate,
          isShipped,
          isOverdue,
          inTarget,
          inFixVersion,
          source: inTarget && inFixVersion ? 'both' : inTarget ? 'target' : 'fixVersion',
        });
      }
    }

    // Sort each ticket's releases: overdue first, then upcoming, then future, then shipped
    for (const t of ticketsByKey.values()) {
      t.releases.sort((a, b) => {
        // Shipped releases go to the end
        if (a.isShipped !== b.isShipped) return a.isShipped ? 1 : -1;
        // Then overdue first
        if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
        // Then by date
        const aDate = a.jiraReleaseDate || 'zzzz';
        const bDate = b.jiraReleaseDate || 'zzzz';
        return aDate.localeCompare(bDate);
      });
    }

    const tickets = Array.from(ticketsByKey.values());

    // Sort tickets by their most urgent release date (overdue first), then by status severity
    const STATUS_PRIORITY = {
      'Blocked': 0, 'Testing Failed': 1, 'Re-verify Bug': 2,
      'In Progress': 3, 'Development In Progress': 3, 'In Review': 4,
      'Waiting for Cherry Pick': 5, 'Ready For Testing': 6, 'Cherry Picked': 7,
      'In Testing': 8, 'Testing in Branch': 9,
    };
    tickets.sort((a, b) => {
      const aFirst = a.releases.find(r => !r.isShipped);
      const bFirst = b.releases.find(r => !r.isShipped);
      const aDate = aFirst?.jiraReleaseDate || 'zzzz';
      const bDate = bFirst?.jiraReleaseDate || 'zzzz';
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      const aPri = STATUS_PRIORITY[a.jiraStatus] ?? 99;
      const bPri = STATUS_PRIORITY[b.jiraStatus] ?? 99;
      return aPri - bPri;
    });

    res.json({ releases: releaseColumns, tickets });
  });

  router.get('/releases/:version', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    res.json(release);
  });

  // Notify release channel — sends status update to Slack
  router.post('/releases/:version/notify', asyncHandler(async (req, res) => {
    const version = req.params.version;
    const release = releases.get(version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    if (!services.releaseNotifier) {
      return res.status(503).json({ error: 'Release notifier not configured' });
    }

    const SlackNotifier = require('../integrations/slack');
    const channel = SlackNotifier.releaseChannelName(release.version);

    try {
      const result = await services.releaseNotifier.notifyRelease(release);
      res.json({ ok: result?.ok || false, channel, version: release.version, error: result?.error || null });
    } catch (err) {
      res.status(500).json({ error: err.message, channel });
    }
  }));

  // Per-release refresh — git fetch + JIRA sync + PR sync for one version
  router.post('/releases/:version/refresh', asyncHandler(async (req, res) => {
    const version = req.params.version;
    const release = releases.get(version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const results = { git: false, jira: false, pr: false, durationMs: 0 };
    const start = Date.now();

    // 1. Git fetch for this repo
    if (release.repo && repoManager) {
      try {
        await repoManager.fetch(release.repo);
        results.git = true;
      } catch (err) {
        log.warn(`Refresh: git fetch failed for ${release.repo}: ${err.message}`);
      }
    }

    // 2. JIRA sync for this specific version
    if (jiraSync && jiraSync.jira.isConfigured()) {
      try {
        const jiraVersionName = release.jiraVersionName || version;
        await jiraSync._syncVersionTickets(jiraVersionName);
        results.jira = true;
      } catch (err) {
        log.warn(`Refresh: JIRA sync failed for ${version}: ${err.message}`);
      }
    }

    // 3. PR sync — trigger a full run (fast if incremental)
    if (services.prSync) {
      try {
        await services.prSync.run();
        results.pr = true;
      } catch (err) {
        log.warn(`Refresh: PR sync failed: ${err.message}`);
      }
    }

    results.durationMs = Date.now() - start;
    log.info(`Refresh ${version}: git=${results.git} jira=${results.jira} pr=${results.pr} in ${results.durationMs}ms`);

    // Return the updated release
    const updated = releases.get(version);
    res.json({ release: updated, refresh: results });
  }));

  // Customer impact — Zoho tickets grouped by customer/department
  router.get('/releases/:version/customer-impact', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const zohoTickets = release.zohoTickets || [];
    const zohoByJiraKey = release.zohoByJiraKey || {};

    // Group by department (≈ customer)
    const byDepartment = {};
    for (const ticket of zohoTickets) {
      const dept = ticket.departmentId || 'unknown';
      if (!byDepartment[dept]) byDepartment[dept] = [];
      byDepartment[dept].push(ticket);
    }

    // Map department IDs to customer names using customerStore
    const deptMap = {};
    if (customerStore) {
      const customers = customerStore.listCustomers ? customerStore.listCustomers() : [];
      for (const c of customers) {
        // Department IDs may be stored on customer — build mapping
        if (c.zohoDepartmentId) deptMap[c.zohoDepartmentId] = c.name;
      }
    }

    const groups = Object.entries(byDepartment).map(([deptId, tickets]) => ({
      departmentId: deptId,
      customerName: deptMap[deptId] || null,
      tickets,
      count: tickets.length,
    }));

    res.json({
      version: release.version,
      repo: release.repo,
      totalZohoTickets: zohoTickets.length,
      zohoSyncedAt: release.zohoSyncedAt || null,
      byJiraKey: zohoByJiraKey,
      byCustomer: groups,
    });
  });

  router.post('/releases', (req, res) => {
    try {
      const release = releases.create(req.body);
      res.status(201).json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/releases/:version', (req, res) => {
    try {
      const { state, user, ...fields } = req.body;
      let release;

      if (state) {
        release = releases.transition(req.params.version, state, user);
      }

      if (Object.keys(fields).length > 0) {
        release = releases.update(req.params.version, fields, user);
      }

      if (!release) release = releases.get(req.params.version);
      res.json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/releases/:version', (req, res) => {
    try {
      releases.delete(req.params.version, req.body.user);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Tickets ───────────────────────────────────────────

  router.post('/releases/:version/tickets', (req, res) => {
    try {
      const release = releases.addTicket(req.params.version, req.body, req.body.user);
      res.json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/releases/:version/tickets/:key', (req, res) => {
    try {
      const release = releases.removeTicket(req.params.version, req.params.key, req.body.user);
      res.json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Cherry-picks ──────────────────────────────────────

  router.post('/releases/:version/cherry-pick', (req, res) => {
    try {
      const release = releases.addCherryPick(req.params.version, req.body, req.body.user);
      res.json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/releases/:version/cherry-pick/sync — force-sync from GitHub
  router.post('/releases/:version/cherry-pick/sync', asyncHandler(async (req, res) => {
    const count = await cherryPickWatcher.syncRelease(req.params.version);
    res.json({ ok: true, synced: count });
  }));

  // ── Approvals ─────────────────────────────────────────

  router.post('/releases/:version/approve', (req, res) => {
    try {
      const result = approvals.approve(req.params.version, req.body.user, req.body.role);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/releases/:version/approvals', (req, res) => {
    try {
      res.json(approvals.getStatus(req.params.version));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Comments ──────────────────────────────────────────

  router.get('/releases/:version/comments', (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });
      const comments = (release.comments || []).slice().reverse(); // newest first
      res.json(comments);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/releases/:version/comments', (req, res) => {
    try {
      const { text } = req.body;
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'text is required' });
      }
      const user = (req.user && (req.user.email || req.user.name)) || 'anonymous';
      const comment = releases.addComment(req.params.version, { text: text.trim(), user });
      res.status(201).json(comment);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/releases/:version/comments/:commentId', (req, res) => {
    try {
      const user = (req.user && (req.user.email || req.user.name)) || 'anonymous';
      const isUserAdmin = req.user && req.user.role === 'admin';
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });
      const comment = (release.comments || []).find(c => c.id === req.params.commentId);
      if (!comment) return res.status(404).json({ error: 'Comment not found' });
      // Allow deletion if user is the author or an admin
      if (comment.user !== user && !isUserAdmin) {
        return res.status(403).json({ error: 'Only the comment author or an admin can delete this comment' });
      }
      releases.deleteComment(req.params.version, req.params.commentId, user);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Deployments ───────────────────────────────────────

  router.post('/releases/:version/deploy', (req, res) => {
    try {
      const release = releases.addDeployment(req.params.version, req.body, req.body.user);
      res.json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Risk assessment ───────────────────────────────────

  router.get('/releases/:version/risk', asyncHandler(async (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    // If risk hasn't been assessed yet or force refresh requested
    if (req.query.refresh || release.risk.numericScore === null) {
      try {
        const result = await risk.assess(req.params.version);
        return res.json(result);
      } catch (err) {
        // Fall through to return cached risk
        if (release.risk.numericScore !== null) {
          return res.json(release.risk);
        }
        return res.status(400).json({ error: err.message });
      }
    }

    res.json(release.risk);
  }));

  // ── Validation ────────────────────────────────────────

  router.get('/releases/:version/validate', asyncHandler(async (req, res) => {
    const report = await validator.validate(req.params.version);
    res.json(report);
  }));

  // ── Release notes ────────────────────────────────────
  // Notes and presentation URLs are populated by Hive via the task queue (Phase 2).

  router.get('/releases/:version/notes', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    res.json({
      version: release.version,
      notes: release.notes,
      presentation: release.presentationUrl || null,
      generated: !!(release.notes || release.presentationUrl),
    });
  });

  // ── Customers ─────────────────────────────────────────

  router.get('/customers', (req, res) => {
    const includeEnvs = req.query.includeEnvs === 'true';
    const list = customerStore.listCustomers();
    if (includeEnvs) {
      res.json(list.map(c => ({
        ...c,
        environments: customerStore.listEnvironments({ customerId: c.id }),
      })));
    } else {
      res.json(list);
    }
  });

  router.get('/customers/:id', (req, res) => {
    const customer = customerStore.getCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const environments = customerStore.listEnvironments({ customerId: customer.id });
    res.json({ ...customer, environments });
  });

  // ── Environments ──────────────────────────────────────

  router.get('/environments', (req, res) => {
    const filter = {};
    if (req.query.customerId) filter.customerId = req.query.customerId;
    if (req.query.tier) filter.tier = req.query.tier;
    if (req.query.franchise) filter.franchise = req.query.franchise;
    res.json(customerStore.listEnvironments(filter));
  });

  // Bulk set the same version across many environments
  // IMPORTANT: must be declared BEFORE /environments/:id/* routes to avoid
  // Express matching "bulk" as the :id parameter.
  // Body: { environmentIds: ['ck-615', 'ck-1097', ...], version: '4.2.1', setBy: 'nukulb' }
  router.patch('/environments/bulk/version', (req, res) => {
    const { environmentIds, version, branch, setBy } = req.body;
    if (!Array.isArray(environmentIds) || environmentIds.length === 0) {
      return res.status(400).json({ error: 'environmentIds must be a non-empty array' });
    }
    const updated = customerStore.setManualVersionBulk(environmentIds, { version, branch, setBy });
    res.json({ updated: updated.length, environments: updated });
  });

  router.get('/environments/:id', (req, res) => {
    const env = customerStore.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    res.json(env);
  });

  // Manually set the version for a single environment
  router.patch('/environments/:id/version', (req, res) => {
    const { version, branch, setBy } = req.body;
    const env = customerStore.setManualVersion(req.params.id, { version, branch, setBy });
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    res.json(env);
  });

  // ── Deployments ───────────────────────────────────────

  router.get('/deployments', (req, res) => {
    const filter = {};
    if (req.query.customerId) filter.customerId = req.query.customerId;
    if (req.query.environmentId) filter.environmentId = req.query.environmentId;
    if (req.query.version) filter.version = req.query.version;
    if (req.query.active === 'true') filter.active = true;
    res.json(customerStore.listDeployments(filter));
  });

  // ── Webplatform scan ──────────────────────────────────

  router.post('/webplatform/scan', asyncHandler(async (req, res) => {
    const scanResults = await webplatformScanner.scan();
    const applied = customerStore.applyScanResults(scanResults);
    res.json({ ok: true, ...applied, scanStatus: webplatformScanner.getStatus() });
  }));

  router.get('/webplatform/scan/status', (req, res) => {
    res.json(webplatformScanner.getStatus() || { neverRun: true });
  });

  // ── Environment poller ────────────────────────────────

  router.post('/environments/poll', asyncHandler(async (req, res) => {
    const results = await envPoller.run();
    res.json({ ok: true, ...results });
  }));

  router.get('/environments/poll/status', (req, res) => {
    res.json(envPoller.getStatus());
  });

  // ── Health overview — dashboard and per-customer status ────────

  /**
   * GET /api/health/overview
   * Returns all environments grouped by customer with health status.
   * Used by the Health Dashboard page.
   */
  router.get('/health/overview', (req, res) => {
    const customers = customerStore.listCustomers();
    const environments = customerStore.listEnvironments();

    const grouped = customers.map(c => {
      const envs = environments
        .filter(e => e.customerId === c.id && !e.disabled)
        .map(e => ({
          id: e.id,
          name: e.name,
          tier: e.tier,
          franchise: e.franchise || null,
          franchiseDisplayName: e.franchiseDisplayName || null,
          url: e.url,
          currentVersion: e.currentVersion || null,
          reachable: e.reachable,
          lastChecked: e.lastChecked || null,
          health: e.health || null,
        }));

      return {
        id: c.id,
        name: c.name,
        active: c.active,
        environments: envs,
      };
    });

    // Calculate rollup stats across all environments
    const allHealth = environments
      .filter(e => !e.disabled && e.health)
      .map(e => e.health.status);

    const stats = {
      total: allHealth.length,
      healthy: allHealth.filter(s => s === 'healthy').length,
      degraded: allHealth.filter(s => s === 'degraded').length,
      unhealthy: allHealth.filter(s => s === 'unhealthy').length,
      unreachable: allHealth.filter(s => s === 'unreachable').length,
    };

    res.json({ customers: grouped, stats });
  });

  /**
   * GET /api/health/:customerId
   * Returns a single customer's environments with health data,
   * formatted for the per-customer status page.
   */
  router.get('/health/:customerId', (req, res) => {
    const customer = customerStore.getCustomer(req.params.customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const environments = customerStore
      .listEnvironments({ customerId: customer.id })
      .filter(e => !e.disabled)
      .map(e => ({
        id: e.id,
        name: e.name,
        tier: e.tier,
        franchise: e.franchise || null,
        franchiseDisplayName: e.franchiseDisplayName || null,
        url: e.url,
        currentVersion: e.currentVersion || null,
        reachable: e.reachable,
        lastChecked: e.lastChecked || null,
        health: e.health || null,
      }));

    // Determine overall customer status
    const statuses = environments
      .filter(e => e.health)
      .map(e => e.health.status);

    let overallStatus = 'healthy';
    if (statuses.some(s => s === 'unhealthy')) overallStatus = 'unhealthy';
    else if (statuses.some(s => s === 'degraded')) overallStatus = 'degraded';
    else if (statuses.every(s => s === 'unreachable')) overallStatus = 'unreachable';

    res.json({
      customer: {
        id: customer.id,
        name: customer.name,
      },
      overallStatus,
      environments,
    });
  });

  /**
   * GET /api/health/env/:envId
   * Returns a single environment's health data for a per-environment status page.
   */
  router.get('/health/env/:envId', (req, res) => {
    const env = customerStore.listEnvironments().find(e => e.id === req.params.envId);
    if (!env) return res.status(404).json({ error: 'Environment not found' });

    const customer = customerStore.getCustomer(env.customerId);
    res.json({
      customer: customer ? { id: customer.id, name: customer.name } : null,
      environment: {
        id: env.id,
        name: env.name || env.id,
        tier: env.tier,
        franchise: env.franchise || null,
        franchiseDisplayName: env.franchiseDisplayName || null,
        url: env.url,
        currentVersion: env.currentVersion || null,
        reachable: env.reachable,
        lastChecked: env.lastChecked || null,
        health: env.health || null,
      },
      overallStatus: env.health?.status || (env.reachable ? 'healthy' : 'unreachable'),
    });
  });

  /**
   * GET /api/health/env/:envId/deployments
   * Returns the last 5 deployments for an environment with their datadogImpact data.
   * Used by the per-environment status page to show recent deployment impact.
   */
  router.get('/health/env/:envId/deployments', (req, res) => {
    const env = customerStore.listEnvironments().find(e => e.id === req.params.envId);
    if (!env) return res.status(404).json({ error: 'Environment not found' });

    const deployments = customerStore.listDeployments({ environmentId: env.id });
    const recent = deployments.slice(0, 5).map(d => ({
      id: d.id,
      environmentId: d.environmentId,
      customerId: d.customerId,
      version: d.version,
      previousVersion: d.previousVersion || null,
      detectedAt: d.detectedAt,
      datadogImpact: d.datadogImpact || null,
    }));

    res.json({ environmentId: env.id, deployments: recent });
  });

  // ── Feature flag aggregation — for the Features cleanup page ───
  router.get('/features/aggregated', (req, res) => {
    try {
      const environments = customerStore.listEnvironments();
      const result = aggregateFeatureFlags(environments);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Integrations aggregation — for the Integrations cleanup page ──
  router.get('/integrations/aggregated', (req, res) => {
    try {
      const environments = customerStore.listEnvironments();
      const result = aggregateIntegrations(environments);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Upgrade script content (from local webplatform clone) ─
  // Reads the actual script file from master so users can see the code.
  // Extracts the JIRA key from the git commit message (reliable, not filename).
  router.get('/upgrades/:upgradeName/source', asyncHandler(async (req, res) => {
    const upgradeName = req.params.upgradeName;
    // Sanitize — no path traversal, no absolute paths
    if (upgradeName.includes('..') || upgradeName.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid upgrade name' });
    }

      // The file could have .upgrade.js suffix or not — try both
      const candidates = upgradeName.endsWith('.upgrade.js')
        ? [upgradeName]
        : [`${upgradeName}.upgrade.js`, upgradeName];

      let content = null;
      let foundPath = null;
      for (const c of candidates) {
        const path = `server/upgrade/upgradePool/${c}`;
        try {
          content = await repoManager.readFile('webplatform', 'master', path);
          if (content) { foundPath = path; break; }
        } catch { /* try next */ }
      }

      if (!content) {
        return res.status(404).json({ error: 'Upgrade script not found' });
      }

      // Get the introducing commit (--follow handles renames)
      let jiraKey = null;
      let introCommit = null;
      let introAuthor = null;
      let introDate = null;
      try {
        const logOutput = await repoManager._git('webplatform', [
          'log', '--follow', '--format=%H|%s|%an|%aI', '--reverse', '--', foundPath,
        ]);
        const firstLine = logOutput.trim().split('\n')[0];
        if (firstLine) {
          const [sha, subject, author, date] = firstLine.split('|');
          introCommit = sha;
          introAuthor = author;
          introDate = date;
          const match = (subject || '').match(/\b(DEV|MAV)-\d+\b/);
          if (match) jiraKey = match[0];
        }
      } catch { /* ok */ }

      res.json({
        upgradeName,
        path: foundPath,
        content,
        jiraKey,
        introCommit,
        introAuthor,
        introDate,
      });
  }));

  // ── Ticket lookup ─────────────────────────────────────

  router.get('/tickets/:key/releases', (req, res) => {
    const key = req.params.key;
    const matches = releases.list().filter(
      r => r.tickets.some(t => t.key === key)
    );
    res.json(matches.map(r => ({
      version: r.version,
      state: r.state,
      ticketState: r.tickets.find(t => t.key === key).state,
    })));
  });

  // ── Audit trail ───────────────────────────────────────

  router.get('/audit/:version', (req, res) => {
    const entries = releases.audit.forRelease(req.params.version);
    res.json(entries);
  });

  // ── Repos ──────────────────────────────────────────────

  router.get('/repos', (req, res) => {
    res.json(repoManager.getStatus());
  });

  // ── Discovery ─────────────────────────────────────────

  router.get('/discover/status', (req, res) => {
    res.json(discovery.getStatus());
  });

  router.post('/discover', asyncHandler(async (req, res) => {
    const results = await discovery.run();
    res.json(results);
  }));

  // ── Release Truth ──────────────────────────────────────

  router.get('/releases/:repo/:version/truth', asyncHandler(async (req, res) => {
    const { repo, version } = req.params;
    const refresh = req.query.refresh === 'true';

    // If refresh requested, clear cache and trigger fresh computation
    if (refresh) {
      releaseTruth.clearCached(repo, version);
      releaseTruth.trigger(repo, version);
      return res.json({ status: 'computing' });
    }

    // Check for cached/in-progress result
    const cached = releaseTruth.getCached(repo, version);

    switch (cached.status) {
      case 'ready':
        return res.json({ status: 'ready', result: cached.result, computedAt: cached.computedAt });
      case 'computing':
        // Return stale result if available while recomputing
        return res.json({ status: 'computing', result: cached.result, computedAt: cached.computedAt });
      case 'error':
        // Return error + stale result if available; client can retry
        return res.json({ status: 'error', error: cached.error, result: cached.result, computedAt: cached.computedAt });
      case 'none':
      default:
        // No cache — trigger computation and tell client to poll
        releaseTruth.trigger(repo, version);
        return res.json({ status: 'computing' });
    }
  }));

  // Deployment impact — diff between target release and current prod version
  router.get('/releases/:repo/:version/impact', asyncHandler(async (req, res) => {
    const { prodVersion } = req.query;
    if (!prodVersion) {
      return res.status(400).json({ error: 'prodVersion query parameter is required' });
    }
    const impact = await releaseTruth.computeImpact(
      req.params.repo, req.params.version, prodVersion
    );
    res.json(impact);
  }));

  // ── JIRA Sync ──────────────────────────────────────────

  router.get('/jira/status', (req, res) => {
    res.json(jiraSync.getStatus());
  });

  router.post('/jira/sync', asyncHandler(async (req, res) => {
    const results = await jiraSync.run();
    res.json(results);
  }));

  // ── People (extracted from synced JIRA tickets) ──────

  router.get('/people', (req, res) => {
    const people = new Map(); // name → { name, roles: Set }
    const allReleases = releases.list();
    for (const release of allReleases) {
      for (const ticket of (release.tickets || [])) {
        if (ticket.assignee) {
          const p = people.get(ticket.assignee) || { name: ticket.assignee, roles: new Set() };
          p.roles.add('dev');
          people.set(ticket.assignee, p);
        }
        if (ticket.reporter) {
          const p = people.get(ticket.reporter) || { name: ticket.reporter, roles: new Set() };
          p.roles.add('reporter');
          people.set(ticket.reporter, p);
        }
        if (ticket.qaAssignee) {
          const p = people.get(ticket.qaAssignee) || { name: ticket.qaAssignee, roles: new Set() };
          p.roles.add('qa');
          people.set(ticket.qaAssignee, p);
        }
        if (ticket.productAssignee) {
          const p = people.get(ticket.productAssignee) || { name: ticket.productAssignee, roles: new Set() };
          p.roles.add('pm');
          people.set(ticket.productAssignee, p);
        }
      }
    }
    const availability = services.availability;
    const result = Array.from(people.values())
      .map(p => {
        const out = availability ? availability.getPersonOut(p.name) : null;
        return {
          name: p.name,
          roles: Array.from(p.roles),
          out: out ? { startDate: out.startDate, endDate: out.endDate, summary: out.summary } : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(result);
  });

  // ── Availability (BambooHR Who's Out + Holidays) ──────

  router.get('/availability', (req, res) => {
    const availability = services.availability;
    if (!availability) return res.json({ loaded: false, currentlyOut: [], upcomingHolidays: [] });
    res.json(availability.snapshot());
  });

  router.post('/availability/refresh', requireAdmin, asyncHandler(async (req, res) => {
    const availability = services.availability;
    if (!availability) return res.status(503).json({ error: 'Availability not configured' });
    const result = await availability.refresh();
    res.json({ ok: true, ...result });
  }));

  // ── People Directory (Slack ID resolution) ────────────

  router.get('/people/directory', (req, res) => {
    const { peopleDirectory } = services;
    if (!peopleDirectory || !peopleDirectory.isLoaded()) {
      return res.json({ loaded: false, entries: [], unresolved: [] });
    }
    res.json({
      loaded: true,
      entries: peopleDirectory.getAll(),
      unresolved: peopleDirectory.getUnresolved(),
    });
  });

  router.post('/people/directory/reload', requireAdmin, asyncHandler(async (req, res) => {
    const { peopleDirectory } = services;
    const count = peopleDirectory.reload();
    res.json({ ok: true, loaded: count });
  }));

  // ── Notification Settings ─────────────────────────────

  router.get('/notifications/settings', (req, res) => {
    const { notificationSettings } = services;
    res.json(notificationSettings.getAll());
  });

  router.put('/notifications/settings', requireAdmin, (req, res) => {
    const { notificationSettings } = services;
    notificationSettings.update(req.body);
    res.json(notificationSettings.getAll());
  });

  router.put('/users/:email/notifications', (req, res) => {
    const { userStore } = services;
    const user = userStore.updateUser(req.params.email, { notificationPrefs: req.body });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ notificationPrefs: user.notificationPrefs });
  });

  router.post('/notifications/test-digest', requireAdmin, asyncHandler(async (req, res) => {
    const { notificationEngine } = services;
    const { slackId } = req.body || {};
    if (!slackId) return res.status(400).json({ error: 'slackId is required — select a person to send to' });
    const result = await notificationEngine.sendDailyDigestToUser(slackId);
    res.json(result);
  }));

  router.post('/notifications/test-ticket-changes', requireAdmin, asyncHandler(async (req, res) => {
    const { notificationEngine } = services;
    await notificationEngine.sendTicketChangeDigests();
    res.json({ ok: true, message: 'Ticket change digest triggered' });
  }));

  // Resolve an unresolved JIRA name by manually mapping it to a Slack user
  router.post('/people/directory/resolve', requireAdmin, asyncHandler(async (req, res) => {
    const { peopleDirectory } = services;
    const { jiraName, slackId } = req.body || {};
    if (!jiraName || !slackId) return res.status(400).json({ error: 'jiraName and slackId are required' });
    peopleDirectory.addOverride(jiraName, slackId);
    res.json({ ok: true, jiraName, slackId });
  }));

  // Search Slack users by name (for resolving unmatched names)
  router.post('/people/directory/search-slack', requireAdmin, asyncHandler(async (req, res) => {
    const { slack } = services;
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query is required' });
    if (!slack.isConfigured() || !slack.app) {
      return res.status(503).json({ error: 'Slack not connected' });
    }
    try {
      const result = await slack.app.client.users.list({ limit: 200 });
      const members = (result.members || [])
        .filter(m => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT')
        .filter(m => {
          const name = (m.real_name || m.name || '').toLowerCase();
          return name.includes(query.toLowerCase());
        })
        .slice(0, 10)
        .map(m => ({ id: m.id, name: m.real_name || m.name, username: m.name }));
      res.json({ results: members });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }));

  // ── PR Sync ───────────────────────────────────────────

  router.get('/pr/status', (req, res) => {
    if (!services.prSync) return res.json({ configured: false });
    res.json(services.prSync.getStatus());
  });

  router.post('/pr/sync', asyncHandler(async (req, res) => {
    if (!services.prSync) return res.status(503).json({ error: 'PR sync not configured' });
    const results = await services.prSync.run();
    res.json(results);
  }));

  // ── Pipeline Sync (AWS CodeBuild + CodePipeline) ──────

  router.get('/pipeline/status', (req, res) => {
    if (!services.pipelineSync) return res.json({ configured: false });
    res.json(services.pipelineSync.getStatus());
  });

  router.get('/pipeline/builds', (req, res) => {
    if (!services.pipelineSync) return res.json({ builds: [], deployTargets: {}, lastRun: null });
    res.json(services.pipelineSync.getBuildsPageData());
  });

  router.post('/pipeline/sync', asyncHandler(async (req, res) => {
    if (!services.pipelineSync) return res.status(503).json({ error: 'Pipeline sync not configured' });
    const results = await services.pipelineSync.run();
    res.json(results);
  }));

  // ── Zoho Sync ─────────────────────────────────────────

  router.get('/zoho/status', (req, res) => {
    if (!services.zohoSync) return res.json({ configured: false });
    res.json(services.zohoSync.getStatus());
  });

  router.post('/zoho/sync', asyncHandler(async (req, res) => {
    if (!services.zohoSync) return res.status(503).json({ error: 'Zoho sync not configured' });
    const results = await services.zohoSync.run();
    res.json(results);
  }));

  // ── Issues (self-service bug/feedback on mavencare/nectar) ──

  router.get('/issues', asyncHandler(async (req, res) => {
    if (!github || !github.isConfigured()) {
      return res.status(503).json({ error: 'GitHub integration not configured' });
    }
    const { state = 'open', labels } = req.query;
    const issues = await github.listIssues({
      state,
      labels: labels || null,
      repoPath: NECTAR_REPO,
    });
    const slim = issues.map(i => ({
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      url: i.html_url,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      closedAt: i.closed_at,
      comments: i.comments,
      author: i.user ? { login: i.user.login, avatarUrl: i.user.avatar_url } : null,
      labels: (i.labels || []).map(l => ({
        name: typeof l === 'string' ? l : l.name,
        color: typeof l === 'string' ? null : l.color,
      })),
    }));
    res.json({ repo: NECTAR_REPO, issues: slim });
  }));

  router.post('/issues', asyncHandler(async (req, res) => {
    if (!github || !github.isConfigured()) {
      return res.status(503).json({ error: 'GitHub integration not configured' });
    }
    const { title, body, labels } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const issue = await github.createIssue({
      title: title.trim(),
      body: body || '',
      labels: Array.isArray(labels) ? labels : [],
      repoPath: NECTAR_REPO,
    });
    res.status(201).json({
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
      createdAt: issue.created_at,
    });
  }));

  // ── Tickets aggregation (across all unreleased releases) ─

  /**
   * Returns one record per unique JIRA ticket that is referenced by any
   * active (non-done, non-archived) release — either via canonical fixVersion
   * or via Target FixVersion. Each record lists the releases it's in and the
   * source (target / fixVersion / both), so the frontend can render a
   * roadmap-style table with per-release badges.
   */
  router.get('/tickets', (req, res) => {
    // Only look at releases that are actively being worked. Done releases
    // have already shipped and don't need to be part of the roadmap view.
    const activeReleases = releases.active().filter(r => !r.jiraArchived);

    // Column list for the UI — sorted by JIRA release date ascending so the
    // roadmap reads left-to-right in time.
    const releaseColumns = activeReleases.map(r => ({
      repo: r.repo,
      version: r.version,
      state: r.state,
      jiraReleaseDate: r.jiraReleaseDate || null,
      branch: r.branch || null,
    })).sort((a, b) => {
      // Nulls last
      if (!a.jiraReleaseDate && !b.jiraReleaseDate) return a.version.localeCompare(b.version);
      if (!a.jiraReleaseDate) return 1;
      if (!b.jiraReleaseDate) return -1;
      return a.jiraReleaseDate.localeCompare(b.jiraReleaseDate);
    });

    // Walk every active release's tickets[], dedupe by key, accumulate
    // per-release membership.
    const byKey = new Map();
    for (const release of activeReleases) {
      const releaseVersion = release.version;
      for (const ticket of release.tickets || []) {
        if (ticket.source !== 'jira') continue;

        const targetVersions = Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [];
        const fixVersions = Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [];
        const inTarget = targetVersions.includes(releaseVersion);
        const inFixVersion = fixVersions.includes(releaseVersion);
        // Should never happen given the sync JQL, but guard anyway
        if (!inTarget && !inFixVersion) continue;

        let record = byKey.get(ticket.key);
        if (!record) {
          record = {
            key: ticket.key,
            summary: ticket.summary || '',
            jiraStatus: ticket.jiraStatus || 'Unknown',
            state: ticket.state || 'pending',
            type: ticket.type || null,
            assignee: ticket.assignee || null,
            component: ticket.component || null,
            customerTags: Array.isArray(ticket.customerTags) ? ticket.customerTags : [],
            qaAssignee: ticket.qaAssignee || null,
            deployedEnvironments: Array.isArray(ticket.deployedEnvironments) ? ticket.deployedEnvironments : [],
            zohoRef: ticket.zohoRef || null,
            fixVersions,
            targetFixVersions: targetVersions,
            releases: [],
          };
          byKey.set(ticket.key, record);
        }

        record.releases.push({
          repo: release.repo,
          version: releaseVersion,
          inTarget,
          inFixVersion,
          source: inTarget && inFixVersion ? 'both' : inTarget ? 'target' : 'fixVersion',
        });
      }
    }

    // Sort ticket releases by the same column order as releaseColumns, so the
    // frontend can render them in a consistent left-to-right order.
    const columnOrder = new Map();
    releaseColumns.forEach((c, idx) => columnOrder.set(`${c.repo}:${c.version}`, idx));
    for (const record of byKey.values()) {
      record.releases.sort((a, b) => {
        const ai = columnOrder.get(`${a.repo}:${a.version}`) ?? 999;
        const bi = columnOrder.get(`${b.repo}:${b.version}`) ?? 999;
        return ai - bi;
      });
    }

    const tickets = Array.from(byKey.values());
    // Headline stats so the frontend can render a compact summary bar
    const stats = {
      total: tickets.length,
      plannedOnly: tickets.filter(t => t.releases.every(r => r.source === 'target')).length,
      deliveredAsPlanned: tickets.filter(t => t.releases.every(r => r.source === 'both')).length,
      anyUnplanned: tickets.filter(t => t.releases.some(r => r.source === 'fixVersion')).length,
      anyMissing: tickets.filter(t => t.releases.some(r => r.source === 'target')).length,
    };

    res.json({
      releases: releaseColumns,
      stats,
      tickets,
    });
  });

  // ── Datadog ────────────────────────────────────────────

  /**
   * GET /api/datadog/monitors — all monitors with status, grouped by state.
   */
  router.get('/datadog/monitors', (req, res) => {
    if (!datadogPoller) return res.status(503).json({ error: 'Datadog not available' });
    res.json(datadogPoller.getMonitorsGrouped());
  });

  /**
   * GET /api/datadog/monitors/:envTag — monitors for a specific environment.
   */
  router.get('/datadog/monitors/:envTag', (req, res) => {
    if (!datadogPoller) return res.status(503).json({ error: 'Datadog not available' });
    const monitors = datadogPoller.getMonitorsForEnv(req.params.envTag);
    res.json({ envTag: req.params.envTag, monitors, total: monitors.length });
  });

  /**
   * GET /api/datadog/alerts — recent alerts (last 24h by default, ?hours=N param).
   * Optional ?env=<envId> to filter by environment.
   */
  router.get('/datadog/alerts', asyncHandler(async (req, res) => {
    if (!datadog || !datadog.isConfigured()) {
      return res.json({ events: [], configured: false });
    }
    const hours = parseInt(req.query.hours) || 24;
    const now = Math.floor(Date.now() / 1000);
    const from = now - (hours * 3600);
    try {
      const data = await datadog.getAlertEvents(from, now);
      let events = data.events || [];

      // Optional env filter — best-effort matching on tags
      if (req.query.env) {
        const envFilter = req.query.env.toLowerCase();
        events = events.filter(e => {
          const tags = (e.tags || []).join(' ').toLowerCase();
          return tags.includes(envFilter) || tags.includes(`env:${envFilter}`);
        });
      }

      res.json({
        events: events.map(e => ({
          id: e.id,
          title: e.title,
          text: e.text,
          alertType: e.alert_type,
          priority: e.priority,
          source: e.source,
          dateHappened: e.date_happened,
          tags: e.tags || [],
          url: e.url,
        })),
        total: events.length,
        hours,
        configured: true,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, configured: true });
    }
  }));

  /**
   * GET /api/datadog/impact/:version — deployment impact data for a release.
   * Returns impact data across all environments that deployed this version.
   */
  router.get('/datadog/impact/:version', (req, res) => {
    const version = req.params.version;
    const deployments = customerStore.listDeployments({ version });

    const impacts = deployments.map(d => ({
      deploymentId: d.id,
      environmentId: d.environmentId,
      customerId: d.customerId,
      version: d.version,
      previousVersion: d.previousVersion,
      detectedAt: d.detectedAt,
      datadogImpact: d.datadogImpact || null,
    }));

    res.json({
      version,
      deployments: impacts,
      total: impacts.length,
      withImpactData: impacts.filter(i => i.datadogImpact).length,
    });
  });

  /**
   * GET /api/datadog/hosts — infrastructure host list with metrics.
   */
  router.get('/datadog/hosts', asyncHandler(async (req, res) => {
    if (!datadog || !datadog.isConfigured()) {
      return res.json({ hosts: [], configured: false });
    }
    try {
      const data = await datadog.getHosts(req.query.filter);
      res.json({ hosts: data.host_list || [], total: data.total_matching || 0, configured: true });
    } catch (err) {
      res.status(500).json({ error: err.message, configured: true });
    }
  }));

  /**
   * GET /api/datadog/hosts/:envTag — hosts filtered by environment.
   * Matches by: 1) env: tags, 2) hostname prefix (e.g., "bayada-prod-" matches env "bayada").
   * This fallback is needed because most hosts lack env: tags in Datadog.
   */
  // Shared infrastructure mapping — some customers share infra with others
  const SHARED_INFRA = {
    // All CK franchises share CK infrastructure
    'ck': 'ck',
    // Tribute, Quality Care, and Haven share Tribute infrastructure
    'tribute': 'tribute',
    'qualitycare': 'tribute',
    'haven': 'tribute',
  };

  router.get('/datadog/hosts/:envTag', asyncHandler(async (req, res) => {
    if (!datadog || !datadog.isConfigured()) {
      return res.json({ hosts: [], configured: false });
    }
    try {
      const data = await datadog.getHosts();
      const envId = req.params.envTag.toLowerCase();
      const allHosts = data.host_list || [];

      // Determine which host prefixes to match:
      // 1. The env ID itself (e.g., "bayada")
      // 2. The customer ID if this is a franchise (e.g., "ck-615" → also match "ck")
      // 3. The shared infra parent (e.g., "qualitycare" → also match "tribute")
      const matchPrefixes = new Set([envId]);

      // Extract customer prefix (e.g., "ck-615" → "ck", "bayada-staging" → "bayada")
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (env && env.customerId) matchPrefixes.add(env.customerId.toLowerCase());

      // Add shared infra mappings
      for (const prefix of [...matchPrefixes]) {
        if (SHARED_INFRA[prefix]) matchPrefixes.add(SHARED_INFRA[prefix]);
      }

      const filtered = allHosts.filter(host => {
        // Match 1: env: tags
        const tagsBySource = host.tags_by_source || {};
        const allTags = Object.values(tagsBySource).flat();
        const tagMatch = allTags.some(t => {
          const tag = (t || '').toLowerCase();
          return [...matchPrefixes].some(p => tag === `env:${p}` || tag === p);
        });
        if (tagMatch) return true;

        // Match 2: hostname starts with any matching prefix
        const name = (host.name || '').toLowerCase();
        for (const prefix of matchPrefixes) {
          if (name.startsWith(prefix + '-') || name === prefix) return true;
        }

        return false;
      });

      const mapped = filtered.map(host => ({
        name: host.name || host.host_name || '',
        cpu: host.metrics?.cpu ?? null,
        load: host.metrics?.load ?? null,
        apps: host.apps || [],
        envTags: (Object.values(host.tags_by_source || {}).flat() || [])
          .filter(t => (t || '').startsWith('env:')),
      }));
      res.json({ hosts: mapped, total: mapped.length, configured: true });
    } catch (err) {
      res.status(500).json({ error: err.message, configured: true });
    }
  }));

  /**
   * POST /api/admin/datadog/backfill — iterate through deployments within
   * Datadog's retention window and backfill impact data. Rate-limited.
   */
  router.post('/admin/datadog/backfill', requireAdmin, asyncHandler(async (req, res) => {
    if (!datadog || !datadog.isConfigured()) {
      return res.status(400).json({ error: 'Datadog is not configured' });
    }

    const RETENTION_MONTHS = 15;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
    const cutoffISO = cutoff.toISOString();

    // Find deployments within retention that lack impact data
    const allDeployments = customerStore.listDeployments({});
    const eligible = allDeployments.filter(d =>
      d.detectedAt >= cutoffISO && !d.datadogImpact
    );

    // Process in background with rate limiting (max 5 per minute to be safe)
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    // Process up to 50 at a time, then return progress
    const batchSize = Math.min(eligible.length, 50);
    const batch = eligible.slice(0, batchSize);

    for (const deployment of batch) {
      // Use environmentId as the Datadog env tag — matches how DD monitors are tagged
      const envTag = `env:${deployment.environmentId}`;
      log.info(`Backfill [${processed + 1}/${batchSize}]: ${deployment.environmentId} v${deployment.version} (${deployment.detectedAt.slice(0,16)}) tag=${envTag}`);
      try {
        const impact = await datadog.getDeploymentImpact(envTag, deployment.detectedAt);
        log.info(`  → error: ${impact.errorRate.before} → ${impact.errorRate.after}, latency: ${impact.latencyP90.before} → ${impact.latencyP90.after}, throughput: ${impact.throughput.before} → ${impact.throughput.after}, alerts: ${impact.alertsTriggered}`);
        deployment.datadogImpact = {
          capturedAt: new Date().toISOString(),
          window: impact.window,
          errorRate: impact.errorRate,
          latencyP90: impact.latencyP90,
          throughput: impact.throughput,
          alertsTriggered: impact.alertsTriggered,
        };
        succeeded++;
      } catch (err) {
        log.warn(`  → FAILED: ${err.message}`);
        failed++;
      }
      processed++;

      // Rate limit: pause 200ms between requests to stay well under 300/min
      if (processed < batchSize) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // customerStore writes are synchronous now (SQLite-backed) — no explicit flush needed

    res.json({
      ok: true,
      totalEligible: eligible.length,
      processed,
      succeeded,
      failed,
      remaining: eligible.length - processed,
    });
  }));

  // ── Config (safe values exposed to frontend) ──────────

  router.get('/config', (req, res) => {
    res.json({
      jiraBaseUrl: (process.env.JIRA_BASE_URL || process.env.JIRA_URL || '').replace(/\/$/, ''),
      githubRepo: (config.repos || []).map(r => ({ name: r.name, github: r.github })),
    });
  });

  // ── Roadmap (theme × time grid) ────────────────────────

  router.get('/roadmap', (req, res) => {
    const customerFilter = req.query.customer || null;
    const activeReleases = releases.active().filter(r => !r.jiraArchived);

    // Ensure theme config is initialized
    if (themeConfig.themes.length === 0) {
      const components = new Set();
      for (const release of activeReleases) {
        for (const ticket of release.tickets || []) {
          if (ticket.component) components.add(ticket.component);
        }
      }
      if (components.size > 0) themeConfig.autoGenerate(Array.from(components));
    }

    // ── Build time buckets: monthly columns for 12 months forward ───
    const now = new Date();
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        start: d.toISOString().slice(0, 10),
        end: new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10),
      });
    }

    // ── Helper: parse customer from release branch name ─────
    function deriveCustomers(release) {
      const v = (release.version || '').toLowerCase();
      const customers = [];
      if (v.includes('bayada') || v.includes('byd')) customers.push('Bayada');
      if (v.includes('ck') || v.includes('comfortkeepers') || v.includes('comfort')) customers.push('CK');
      if (v.includes('tribute') || v.includes('trib')) customers.push('Tribute');
      if (v.includes('lumen')) customers.push('Lumen');
      if (v.includes('qualitycare') || v.includes('qc')) customers.push('Quality Care');
      if (v.includes('hah') || v.includes('help')) customers.push('Help-at-Home');
      return customers.length > 0 ? customers : ['All'];
    }

    // ── Helper: get month key for a date string ─────────────
    function getMonthKey(dateStr) {
      if (!dateStr) return null;
      return dateStr.slice(0, 7); // "2026-04" from "2026-04-22"
    }

    // ── Aggregate: theme → month → release cards ────────────
    // Structure: { [themeName]: { [monthKey]: [releaseCard, ...] } }
    const themeGrid = new Map();
    const allCustomers = new Set();
    const unmappedComponents = new Set();

    for (const release of activeReleases) {
      const monthKey = getMonthKey(release.jiraReleaseDate);
      // Skip releases with no date — they go in "Unscheduled"
      const effectiveMonth = monthKey || 'unscheduled';

      const releaseCustomers = deriveCustomers(release);
      releaseCustomers.forEach(c => allCustomers.add(c));

      // If customer filter is active, skip releases that don't match
      if (customerFilter && !releaseCustomers.some(c =>
        c.toLowerCase() === customerFilter.toLowerCase()
      )) continue;

      // Group tickets by theme
      const ticketsByTheme = new Map();
      for (const ticket of release.tickets || []) {
        if (ticket.source !== 'jira') continue;

        // Check customer filter at ticket level too
        const ticketCustomers = Array.isArray(ticket.customerTags) ? ticket.customerTags : [];
        if (customerFilter && ticketCustomers.length > 0) {
          const matchesFilter = ticketCustomers.some(c =>
            c.toLowerCase() === customerFilter.toLowerCase() || c.toLowerCase() === 'internal'
          );
          if (!matchesFilter) continue;
        }

        const themeName = themeConfig.resolveComponent(ticket.component);
        if (themeName === themeConfig.unmappedLabel && ticket.component) {
          unmappedComponents.add(ticket.component);
        }

        if (!ticketsByTheme.has(themeName)) ticketsByTheme.set(themeName, []);
        ticketsByTheme.get(themeName).push(ticket);
      }

      // Create a release card for each theme that has tickets
      for (const [themeName, tickets] of ticketsByTheme) {
        if (!themeGrid.has(themeName)) themeGrid.set(themeName, new Map());
        const themeMonths = themeGrid.get(themeName);
        if (!themeMonths.has(effectiveMonth)) themeMonths.set(effectiveMonth, []);

        const targetVersions = tickets.map(t => Array.isArray(t.targetFixVersions) ? t.targetFixVersions : []);
        const fixVersions = tickets.map(t => Array.isArray(t.fixVersions) ? t.fixVersions : []);

        const done = tickets.filter(t => {
          const s = (t.state || '').toLowerCase();
          return s === 'done' || s === 'cherry-picked' || s === 'ready-for-testing';
        }).length;
        const inProgress = tickets.filter(t => {
          const s = (t.state || '').toLowerCase();
          return s === 'in-progress';
        }).length;
        const missingPlan = tickets.filter(t => {
          const tv = Array.isArray(t.targetFixVersions) ? t.targetFixVersions : [];
          const fv = Array.isArray(t.fixVersions) ? t.fixVersions : [];
          return tv.includes(release.version) && !fv.includes(release.version);
        }).length;

        themeMonths.get(effectiveMonth).push({
          repo: release.repo,
          version: release.version,
          state: release.state,
          jiraReleaseDate: release.jiraReleaseDate || null,
          customers: releaseCustomers,
          tickets: tickets.length,
          done,
          inProgress,
          pending: tickets.length - done - inProgress,
          missingPlan,
          progress: tickets.length > 0 ? Math.round((done / tickets.length) * 100) : 0,
        });
      }
    }

    // ── Flatten into response shape ─────────────────────────
    // Sort themes: configured themes first (by config order), then unmapped
    const configuredOrder = themeConfig.themes.map(t => t.name);
    const themeNames = Array.from(themeGrid.keys()).sort((a, b) => {
      const ai = configuredOrder.indexOf(a);
      const bi = configuredOrder.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      if (a === themeConfig.unmappedLabel) return 1;
      if (b === themeConfig.unmappedLabel) return -1;
      return a.localeCompare(b);
    });

    const themes = themeNames.map(name => {
      const monthMap = themeGrid.get(name);
      const monthEntries = {};
      let totalTickets = 0;
      let totalDone = 0;

      for (const [monthKey, cards] of monthMap) {
        monthEntries[monthKey] = cards.sort((a, b) =>
          (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || '')
        );
        for (const card of cards) {
          totalTickets += card.tickets;
          totalDone += card.done;
        }
      }

      return {
        name,
        icon: themeConfig.themes.find(t => t.name === name)?.icon || null,
        months: monthEntries,
        totalTickets,
        totalDone,
        progress: totalTickets > 0 ? Math.round((totalDone / totalTickets) * 100) : 0,
      };
    });

    res.json({
      months,
      themes,
      customers: Array.from(allCustomers).sort(),
      unmappedComponents: Array.from(unmappedComponents).sort(),
      stats: {
        totalThemes: themes.length,
        totalReleases: activeReleases.length,
        totalTickets: themes.reduce((s, t) => s + t.totalTickets, 0),
      },
    });
  });

  // ── Roadmap drill-down: tickets for a theme × release ──

  router.get('/roadmap/:theme/:version', (req, res) => {
    const themeName = decodeURIComponent(req.params.theme);
    const version = decodeURIComponent(req.params.version);

    const release = releases.get(version) || releases.active().find(r => r.version === version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    // Ensure theme config is initialized
    if (themeConfig.themes.length === 0) {
      const components = new Set();
      for (const r of releases.active()) {
        for (const t of r.tickets || []) {
          if (t.component) components.add(t.component);
        }
      }
      if (components.size > 0) themeConfig.autoGenerate(Array.from(components));
    }

    const tickets = [];
    for (const ticket of release.tickets || []) {
      if (ticket.source !== 'jira') continue;
      const resolved = themeConfig.resolveComponent(ticket.component);
      if (resolved !== themeName) continue;

      const targetVersions = Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [];
      const fixVersions = Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [];
      const inTarget = targetVersions.includes(release.version);
      const inFixVersion = fixVersions.includes(release.version);

      tickets.push({
        key: ticket.key,
        summary: ticket.summary || '',
        jiraStatus: ticket.jiraStatus || 'Unknown',
        state: ticket.state || 'pending',
        type: ticket.type || null,
        assignee: ticket.assignee || null,
        component: ticket.component || null,
        customerTags: Array.isArray(ticket.customerTags) ? ticket.customerTags : [],
        inTarget,
        inFixVersion,
      });
    }

    const done = tickets.filter(t => {
      const s = (t.state || '').toLowerCase();
      return s === 'done' || s === 'cherry-picked' || s === 'ready-for-testing';
    }).length;

    res.json({
      theme: themeName,
      version: release.version,
      repo: release.repo,
      state: release.state,
      jiraReleaseDate: release.jiraReleaseDate || null,
      tickets,
      stats: {
        total: tickets.length,
        done,
        remaining: tickets.length - done,
      },
    });
  });

  // ── Theme configuration (roadmap) — admin only ────────

  router.get('/config/themes', requireAdmin, (req, res) => {
    // If themes haven't been configured yet, auto-generate from observed data
    if (themeConfig.themes.length === 0) {
      const components = new Set();
      for (const release of releases.active()) {
        for (const ticket of release.tickets || []) {
          if (ticket.component) components.add(ticket.component);
        }
      }
      if (components.size > 0) {
        themeConfig.autoGenerate(Array.from(components));
      }
    }
    res.json(themeConfig.getConfig());
  });

  router.put('/config/themes', requireAdmin, (req, res) => {
    try {
      themeConfig.setConfig(req.body);
      res.json(themeConfig.getConfig());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Auto-categorize: suggest theme groupings from all observed JIRA components
  router.post('/config/themes/auto', requireAdmin, (req, res) => {
    // Gather all observed components from active releases
    const components = new Set();
    for (const release of releases.list()) {
      for (const ticket of release.tickets || []) {
        if (ticket.component) components.add(ticket.component);
      }
    }
    const ThemeConfig = require('../core/theme-config');
    const suggestions = ThemeConfig.suggestThemes(
      Array.from(components),
      themeConfig.themes,
    );
    res.json({ suggestions, totalComponents: components.size });
  });

  // ── API Keys — admin only ────────────────────────────

  if (apiKeys) {
    router.post('/keys', requireAdmin, (req, res) => {
      try {
        const { label } = req.body || {};
        const createdBy = req.user ? req.user.email : null;
        const result = apiKeys.create(label, createdBy);
        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    router.get('/keys', requireAdmin, (req, res) => {
      res.json(apiKeys.list());
    });

    router.delete('/keys/:id', requireAdmin, (req, res) => {
      const deleted = apiKeys.revoke(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Key not found' });
      res.json({ ok: true });
    });
  }

  // ── Users — admin only ────────────────────────────────

  if (userStore) {
    router.get('/users', requireAdmin, (req, res) => {
      const users = userStore.listUsers().map(u => ({
        email: u.email,
        name: u.name,
        picture: u.picture,
        role: userStore.getRole(u.email),
        permissions: userStore.getPermissions(u.email),
        isEnvAdmin: userStore.isEnvAdmin(u.email),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      }));
      res.json(users);
    });

    router.patch('/users/:email', requireAdmin, (req, res) => {
      const email = decodeURIComponent(req.params.email);
      const { role, permissions } = req.body || {};
      const updated = userStore.updateUser(email, { role, permissions });
      if (!updated) return res.status(404).json({ error: 'User not found' });
      res.json({
        email: updated.email,
        name: updated.name,
        picture: updated.picture,
        role: userStore.getRole(updated.email),
        permissions: userStore.getPermissions(updated.email),
        isEnvAdmin: userStore.isEnvAdmin(updated.email),
        lastLoginAt: updated.lastLoginAt,
        createdAt: updated.createdAt,
      });
    });
  }

  // ── Tasks ───────────────────────────────────────────

  if (taskQueue) {
    router.post('/tasks', asyncHandler(async (req, res) => {
      const { type, version, slackUserId, compareVersion, prompt } = req.body || {};

      if (!type) {
        return res.status(400).json({ error: 'type is required' });
      }

      // Build task input from release truth data
      let input = req.body.input;
      if (!input && version) {
        // Auto-gather input from release
        const release = releases.get(version);
        if (!release) {
          return res.status(404).json({ error: `Release not found: ${version}` });
        }

        // When compareVersion is provided, use impact data (delta between versions)
        // instead of full truth for richer diff-based input
        let truth = null;
        let impact = null;
        if (release.repo && releaseTruth) {
          try {
            if (compareVersion) {
              impact = await releaseTruth.computeImpact(release.repo, release.version, compareVersion);
              truth = impact.targetTruth;
            } else {
              truth = await releaseTruth.compute(release.repo, release.version);
            }
          } catch (err) {
            log.warn(`Could not compute truth for task input: ${err.message}`);
          }
        }

        const mapTicket = (t) => ({
          key: t.key,
          summary: t.summary,
          type: t.type,
          component: t.component || null,
          assignee: t.assignee || null,
          qaAssignee: t.qaAssignee || null,
          jiraStatus: t.jiraStatus,
          health: t.health,
          pr: t.pr ? t.pr.prNumber : null,
          zohoRef: t.zohoRef || null,
          customerTags: t.customerTags || [],
        });

        const mapRawTicket = (t) => ({
          key: t.key,
          summary: t.summary,
          type: t.type || null,
          component: t.component || null,
          assignee: t.assignee || null,
          qaAssignee: t.qaAssignee || null,
          jiraStatus: t.jiraStatus || null,
          pr: t.pr || null,
          zohoRef: t.zohoRef || null,
          customerTags: t.customerTags || [],
        });

        input = {
          repo: release.repo || 'webplatform',
          version: release.version,
          branch: release.branch,
          jiraReleaseDate: release.jiraReleaseDate || null,
          tickets: truth ? truth.verified.map(mapTicket) : (release.tickets || []).map(mapRawTicket),
          rogues: truth ? truth.rogues : [],
          riskScore: release.risk ? release.risk.numericScore : null,
          riskFactors: release.risk ? release.risk.factors : [],
        };

        // Include prompt from the generation dialog
        if (prompt) {
          input.prompt = prompt;
        }

        // Include compareVersion and impact delta in the task input
        if (compareVersion) {
          input.compareVersion = compareVersion;
          if (impact && impact.delta) {
            input.delta = {
              newTickets: impact.delta.tickets.new.map(mapTicket),
              sharedTickets: impact.delta.tickets.shared.map(mapTicket),
              deltaOnlyKeys: impact.delta.tickets.deltaOnly,
              totalDeltaTickets: impact.delta.tickets.total,
              commits: impact.delta.commits,
              rollup: impact.delta.rollup,
              rogues: impact.delta.rogues,
            };
          }
        }
      }

      if (!input) {
        return res.status(400).json({ error: 'Either version or input is required' });
      }

      // Cancel any existing pending/in-progress task for the same release+type
      if (input.version) {
        const existing = taskQueue.findByRelease(type, input.version);
        if (existing && (existing.status === 'pending' || existing.status === 'in-progress')) {
          taskQueue.fail(existing.id, 'Superseded by new task');
        }
      }

      const requestedBy = req.user ? req.user.email : null;
      const task = taskQueue.createTask(type, input, requestedBy, { slackUserId });
      res.status(201).json(task);
    }));

    router.get('/tasks', (req, res) => {
      const filters = {};
      if (req.query.status) filters.status = req.query.status;
      if (req.query.type) filters.type = req.query.type;
      if (req.query.limit) filters.limit = parseInt(req.query.limit);
      if (req.query.offset) filters.offset = parseInt(req.query.offset);
      const result = taskQueue.listTasks(filters);
      // When offset is explicitly provided, return paginated response with
      // { tasks, total, hasMore }. Otherwise return flat array for backward
      // compatibility with existing callers (e.g., ReleaseDetail).
      if (req.query.offset !== undefined) {
        res.json(result);
      } else {
        res.json(result.tasks);
      }
    });

    router.get('/tasks/:id', (req, res) => {
      const task = taskQueue.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json(task);
    });

    router.patch('/tasks/:id', (req, res) => {
      const task = taskQueue.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      const { status, output, error: errorMsg } = req.body || {};

      try {
        let updated;
        if (status === 'in-progress') {
          updated = taskQueue.claim(req.params.id);
        } else if (status === 'completed') {
          updated = taskQueue.complete(req.params.id, output);

          // On completion: store results on release and notify via Slack
          if (updated.input && updated.input.version) {
            const release = releases.get(updated.input.version);
            if (release && output) {
              const updates = {};
              if (output.gammaUrl) updates.presentationUrl = output.gammaUrl;
              if (output.notes) updates.notes = output.notes;
              if (Object.keys(updates).length > 0) {
                releases.update(updated.input.version, updates, 'task-queue');
              }
            }
          }

          // Slack DM on completion
          if (updated.slackUserId && services.slack) {
            const version = updated.input ? updated.input.version : 'unknown';
            const gammaLink = output && output.gammaUrl ? `\n<${output.gammaUrl}|View Presentation>` : '';
            services.slack.dmUser(
              updated.slackUserId,
              `Your ${updated.type} task for *${version}* is complete!${gammaLink}`
            ).catch(() => {});
          }
        } else if (status === 'failed') {
          updated = taskQueue.fail(req.params.id, errorMsg || 'Failed');
        } else {
          return res.status(400).json({ error: 'Invalid status. Must be in-progress, completed, or failed' });
        }

        res.json(updated);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
  }

  // ── Release Artifact Downloads ──────────────────────────
  // Serves signed S3 download URLs for release notes PDFs and drafts.
  // Bucket stays private — Nectar signs a short-lived URL on each request.

  router.get('/releases/:version/artifacts/:filename', asyncHandler(async (req, res) => {
    const { version, filename } = req.params;

    // Only allow known filenames
    const ALLOWED = ['release-notes.pdf', 'release-notes-draft.md'];
    if (!ALLOWED.includes(filename)) {
      return res.status(400).json({ error: `Unknown artifact: ${filename}` });
    }

    const bucket = process.env.RELEASE_ARTIFACTS_BUCKET;
    const region = process.env.RELEASE_ARTIFACTS_REGION || 'us-east-1';
    const accessKeyId = process.env.RELEASE_ARTIFACTS_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.RELEASE_ARTIFACTS_AWS_SECRET_ACCESS_KEY;

    if (!bucket || !accessKeyId || !secretAccessKey) {
      return res.status(503).json({ error: 'S3 release artifacts not configured' });
    }

    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

    const s3 = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });

    const key = `releases/${version}/${filename}`;

    try {
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: 900, // 15 minutes
      });
      res.redirect(302, url);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey') {
        return res.status(404).json({ error: `Artifact not found: ${key}` });
      }
      log.error(`Failed to sign artifact URL: ${err.message}`);
      res.status(500).json({ error: 'Failed to generate download URL' });
    }
  }));

  // ── Integrations Config ────────────────────────────────
  // Manage external service connections via .env file

  const ENV_PATH = path.join(__dirname, '..', '..', '.env');
  const NECTAR_ROOT = path.join(__dirname, '..', '..');

  /**
   * Integration definitions — maps integration name to its env vars
   * and metadata for the frontend.
   */
  const INTEGRATIONS = {
    jira: {
      label: 'JIRA',
      vars: [
        { key: 'JIRA_URL', label: 'Base URL', secret: false },
        { key: 'JIRA_USERNAME', label: 'Email / Username', secret: false },
        { key: 'JIRA_API_TOKEN', label: 'API Token', secret: true },
      ],
    },
    github: {
      label: 'GitHub',
      vars: [
        { key: 'GITHUB_TOKEN', label: 'Token', secret: true },
      ],
    },
    jenkins: {
      label: 'Jenkins',
      vars: [
        { key: 'JENKINS_BASE_URL', label: 'Base URL', secret: false },
        { key: 'JENKINS_USER', label: 'User', secret: false },
        { key: 'JENKINS_TOKEN', label: 'Token', secret: true },
      ],
    },
    slack: {
      label: 'Slack',
      vars: [
        { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', secret: true },
        { key: 'SLACK_APP_TOKEN', label: 'App Token', secret: true },
      ],
    },
    google_sso: {
      label: 'Google SSO',
      vars: [
        { key: 'ENABLE_GOOGLE_SSO', label: 'Enabled', secret: false, type: 'boolean' },
        { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', secret: false },
        { key: 'GOOGLE_CLIENT_SECRET', label: 'Client Secret', secret: true },
        { key: 'GOOGLE_ALLOWED_DOMAIN', label: 'Allowed Domain', secret: false },
        { key: 'GOOGLE_REDIRECT_URI', label: 'Redirect URI', secret: false },
      ],
    },
    gamma: {
      label: 'Gamma',
      vars: [
        { key: 'GAMMA_API_KEY', label: 'API Key', secret: true },
      ],
    },
    datadog: {
      label: 'Datadog',
      vars: [
        { key: 'DATADOG_API_KEY', label: 'API Key', secret: true },
        { key: 'DATADOG_API_KEY_ID', label: 'API Key ID' },
        { key: 'DATADOG_APP_KEY', label: 'App Key', secret: true },
        { key: 'DATADOG_APP_KEY_ID', label: 'App Key ID' },
      ],
    },
    zoho: {
      label: 'Zoho Desk',
      vars: [
        { key: 'ZOHO_DESK_ORG_ID', label: 'Org ID', secret: false },
        { key: 'ZOHO_DESK_CLIENT_ID', label: 'OAuth Client ID', secret: false },
        { key: 'ZOHO_DESK_CLIENT_SECRET', label: 'OAuth Client Secret', secret: true },
        { key: 'ZOHO_DESK_REFRESH_TOKEN', label: 'OAuth Refresh Token', secret: true },
      ],
    },
    aws: {
      label: 'AWS (CodeBuild / CodePipeline)',
      vars: [
        { key: 'AWS_ACCESS_KEY_ID', label: 'Access Key ID', secret: false },
        { key: 'AWS_SECRET_ACCESS_KEY', label: 'Secret Access Key', secret: true },
        { key: 'AWS_REGION', label: 'Region', secret: false },
        { key: 'AWS_CROSS_ACCOUNT_ROLES', label: 'Cross-Account Roles (Customer:ARN,...)', secret: false },
      ],
    },
    bamboohr: {
      label: 'BambooHR (Who\'s Out + Holidays)',
      vars: [
        { key: 'BAMBOOHR_WHOSOUT_URL', label: 'Who\'s Out Feed URL', secret: true },
        { key: 'BAMBOOHR_HOLIDAYS_URL', label: 'Holidays Feed URL', secret: true },
      ],
    },
    release_artifacts: {
      label: 'S3 Release Artifacts',
      vars: [
        { key: 'RELEASE_ARTIFACTS_BUCKET', label: 'S3 Bucket', secret: false },
        { key: 'RELEASE_ARTIFACTS_REGION', label: 'Region', secret: false },
        { key: 'RELEASE_ARTIFACTS_AWS_ACCESS_KEY_ID', label: 'AWS Access Key ID', secret: false },
        { key: 'RELEASE_ARTIFACTS_AWS_SECRET_ACCESS_KEY', label: 'AWS Secret Access Key', secret: true },
      ],
    },
  };

  /** Read .env file into a Map of key → value */
  function readEnvFile() {
    try {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      const entries = new Map();
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        entries.set(key, val);
      }
      return entries;
    } catch {
      return new Map();
    }
  }

  /** Write an updated Map back to .env, preserving comments and ordering */
  function writeEnvFile(updates) {
    let content = '';
    try {
      content = fs.readFileSync(ENV_PATH, 'utf8');
    } catch { /* file doesn't exist yet */ }

    const lines = content.split('\n');
    const written = new Set();
    const result = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        result.push(line);
        continue;
      }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) {
        result.push(line);
        continue;
      }
      const key = trimmed.slice(0, eqIdx).trim();
      if (updates.has(key)) {
        result.push(`${key}=${updates.get(key)}`);
        written.add(key);
      } else {
        result.push(line);
      }
    }

    // Append any new keys not already in the file
    for (const [key, val] of updates) {
      if (!written.has(key)) {
        result.push(`${key}=${val}`);
      }
    }

    fs.writeFileSync(ENV_PATH, result.join('\n'));
  }

  /** Mask a secret value: show last 3 chars, mask the rest */
  function maskSecret(val) {
    if (!val) return '';
    if (val.length <= 3) return '***';
    return '****' + val.slice(-3);
  }

  // GET /api/config/integrations — admin only
  router.get('/config/integrations', requireAdmin, (req, res) => {
    const env = readEnvFile();
    const result = {};

    for (const [name, def] of Object.entries(INTEGRATIONS)) {
      const vars = {};
      let configured = true;

      for (const v of def.vars) {
        const raw = env.get(v.key) || '';
        const hasValue = !!raw;
        if (v.type !== 'boolean' && !hasValue) configured = false;
        vars[v.key] = {
          label: v.label,
          secret: v.secret,
          type: v.type || 'string',
          value: v.secret ? maskSecret(raw) : raw,
          hasValue,
        };
      }

      result[name] = {
        name,
        label: def.label,
        configured,
        vars,
      };
    }

    res.json(result);
  });

  // POST /api/config/integrations/:name — admin only
  router.post('/config/integrations/:name', requireAdmin, (req, res) => {
    const def = INTEGRATIONS[req.params.name];
    if (!def) return res.status(404).json({ error: 'Unknown integration' });

    const updates = new Map();
    const body = req.body || {};

    for (const v of def.vars) {
      if (body[v.key] !== undefined) {
        // Don't overwrite with masked value — only update if it's a real new value
        const val = body[v.key];
        if (v.secret && typeof val === 'string' && val.startsWith('****')) {
          continue; // Skip masked values — user didn't change it
        }
        updates.set(v.key, String(val));
      }
    }

    if (updates.size === 0) {
      return res.status(400).json({ error: 'No values to update' });
    }

    try {
      writeEnvFile(updates);
      // Reload env vars into process.env so they take effect
      for (const [key, val] of updates) {
        process.env[key] = val;
      }
      log.info(`Integration config updated: ${req.params.name} (${Array.from(updates.keys()).join(', ')})`);
      res.json({ ok: true, updated: Array.from(updates.keys()) });
    } catch (err) {
      res.status(500).json({ error: `Failed to write .env: ${err.message}` });
    }
  });

  // POST /api/config/integrations/:name/test — admin only
  router.post('/config/integrations/:name/test', requireAdmin, asyncHandler(async (req, res) => {
    const name = req.params.name;
    const def = INTEGRATIONS[name];
    if (!def) return res.status(404).json({ error: 'Unknown integration' });

    try {
      let result;

      switch (name) {
        case 'jira': {
          const url = process.env.JIRA_URL || process.env.JIRA_BASE_URL;
          const user = process.env.JIRA_USERNAME;
          const token = process.env.JIRA_API_TOKEN;
          if (!url || !user || !token) throw new Error('JIRA is not fully configured');
          const resp = await fetch(`${url.replace(/\/$/, '')}/rest/api/3/myself`, {
            headers: {
              'Authorization': `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
              'Accept': 'application/json',
            },
          });
          if (!resp.ok) throw new Error(`JIRA API returned ${resp.status}`);
          const data = await resp.json();
          result = { ok: true, detail: `Connected as ${data.displayName || data.emailAddress || 'unknown'}` };
          break;
        }
        case 'github': {
          const token = process.env.GITHUB_TOKEN;
          if (!token) throw new Error('GitHub token not configured');
          const resp = await fetch('https://api.github.com/user', {
            headers: {
              'Authorization': `token ${token}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'nectar',
            },
          });
          if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
          const data = await resp.json();
          result = { ok: true, detail: `Connected as ${data.login}` };
          break;
        }
        case 'jenkins': {
          const baseUrl = process.env.JENKINS_BASE_URL;
          const user = process.env.JENKINS_USER;
          const token = process.env.JENKINS_TOKEN;
          if (!baseUrl || !user || !token) throw new Error('Jenkins is not fully configured');
          const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/json`, {
            headers: {
              'Authorization': `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
              'Accept': 'application/json',
            },
          });
          if (!resp.ok) throw new Error(`Jenkins API returned ${resp.status}`);
          result = { ok: true, detail: 'Connected to Jenkins' };
          break;
        }
        case 'slack': {
          const botToken = process.env.SLACK_BOT_TOKEN;
          if (!botToken) throw new Error('Slack bot token not configured');
          const resp = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${botToken}`,
              'Content-Type': 'application/json',
            },
          });
          const data = await resp.json();
          if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
          result = { ok: true, detail: `Connected as ${data.user} in ${data.team}` };
          break;
        }
        case 'google_sso': {
          const enabled = process.env.ENABLE_GOOGLE_SSO;
          const clientId = process.env.GOOGLE_CLIENT_ID;
          if (enabled === 'true' && !clientId) throw new Error('SSO enabled but no Client ID set');
          result = { ok: true, detail: enabled === 'true' ? `SSO enabled (Client ID: ${clientId.slice(0, 20)}...)` : 'SSO is disabled' };
          break;
        }
        case 'gamma': {
          const apiKey = process.env.GAMMA_API_KEY;
          if (!apiKey) throw new Error('Gamma API key not configured');
          result = { ok: true, detail: 'API key is set (no test endpoint available)' };
          break;
        }
        case 'datadog': {
          if (!datadog || !datadog.isConfigured()) throw new Error('Datadog is not configured');
          result = await datadog.testConnection();
          break;
        }
        case 'zoho': {
          const zohoClient = services.zoho;
          if (!zohoClient || !zohoClient.isConfigured()) throw new Error('Zoho Desk is not configured');
          const tickets = await zohoClient.listTickets({ limit: 1 });
          result = { ok: true, detail: `Connected to Zoho Desk (org ${zohoClient.orgId})` };
          break;
        }
        case 'aws': {
          const accessKey = process.env.AWS_ACCESS_KEY_ID;
          const region = process.env.AWS_REGION || 'us-east-1';
          if (!accessKey || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error('AWS credentials not configured');
          // Test by listing CodeBuild projects
          const { CodeBuildClient, ListProjectsCommand } = require('@aws-sdk/client-codebuild');
          const cb = new CodeBuildClient({ region });
          const resp = await cb.send(new ListProjectsCommand({}));
          const count = (resp.projects || []).length;
          result = { ok: true, detail: `Connected to AWS ${region} — ${count} CodeBuild projects found` };
          break;
        }
        case 'bamboohr': {
          const feeds = [
            { name: 'Who\'s Out', url: process.env.BAMBOOHR_WHOSOUT_URL },
            { name: 'Holidays', url: process.env.BAMBOOHR_HOLIDAYS_URL },
          ].filter(f => f.url);

          if (feeds.length === 0) throw new Error('No BambooHR feed URLs configured');

          const checkFeed = async ({ name, url }) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            try {
              const resp = await fetch(url, { signal: controller.signal });
              if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
              const text = await resp.text();
              if (!text.includes('BEGIN:VCALENDAR')) throw new Error(`${name}: not an iCal feed`);
              const eventCount = (text.match(/BEGIN:VEVENT/g) || []).length;
              return `${name}: ${eventCount} event${eventCount !== 1 ? 's' : ''}`;
            } finally {
              clearTimeout(timeout);
            }
          };

          const details = await Promise.all(feeds.map(checkFeed));
          result = { ok: true, detail: details.join(' · ') };
          break;
        }
        default:
          return res.status(400).json({ error: `No test available for ${name}` });
      }

      res.json(result);
    } catch (err) {
      res.json({ ok: false, detail: err.message });
    }
  }));

  // ── Build alert history (for Builds page badges) ────────

  router.get('/admin/build-alerts', (req, res) => {
    const { notificationEngine } = services;
    if (!notificationEngine) return res.json({});
    res.json(notificationEngine.getBuildAlertHistory());
  });

  // ── Admin — Logs ────────────────────────────────────────

  router.get('/admin/logs', requireAdmin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const level = req.query.level || null; // 'ERROR', 'WARN', 'INFO', or comma-separated
    const levelFilter = level ? level.split(',').map(l => l.trim().toUpperCase()) : null;
    const search = (req.query.q || '').toLowerCase().trim();

    let entries = log.getRecentLogs(limit, levelFilter);
    if (search) {
      entries = entries.filter(e => e.message.toLowerCase().includes(search));
    }
    res.json({ entries, total: entries.length });
  });

  // ── Admin — Version & Update ──────────────────────────

  router.get('/admin/version', requireAdmin, (req, res) => {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: NECTAR_ROOT, encoding: 'utf8' }).trim();
      const commit = execSync('git rev-parse --short HEAD', { cwd: NECTAR_ROOT, encoding: 'utf8' }).trim();
      const commitMessage = execSync('git log -1 --format=%s', { cwd: NECTAR_ROOT, encoding: 'utf8' }).trim();
      const commitDate = execSync('git log -1 --format=%aI', { cwd: NECTAR_ROOT, encoding: 'utf8' }).trim();
      res.json({ branch, commit, commitMessage, commitDate });
    } catch (err) {
      res.status(500).json({ error: `Failed to read git info: ${err.message}` });
    }
  });

  router.post('/admin/pull', requireAdmin, asyncHandler(async (req, res) => {
    try {
      const output = execSync('git pull 2>&1', {
        cwd: NECTAR_ROOT,
        encoding: 'utf8',
        timeout: 30000,
      });
      log.info(`Admin pull: ${output.trim()}`);
      res.json({ ok: true, output: output.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message, output: err.stdout || '' });
    }
  }));

  router.post('/admin/restart', requireAdmin, (req, res) => {
    log.info('Admin restart requested — exiting process');
    res.json({ ok: true, message: 'Restarting...' });
    // Give the response time to flush before exiting
    setTimeout(() => {
      process.exit(0);
    }, 500);
  });

  // ── Global search ─────────────────────────────────────

  router.get('/search', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) {
      return res.json({ query: req.query.q || '', results: [], total: 0 });
    }

    const MAX_PER_CATEGORY = 5;
    const MAX_TOTAL = 20;
    const results = [];

    // Search releases — match version or branch
    const allReleases = releases.list();
    let releaseCount = 0;
    for (const r of allReleases) {
      if (releaseCount >= MAX_PER_CATEGORY) break;
      const matchVersion = (r.version || '').toLowerCase().includes(q);
      const matchBranch = (r.branch || '').toLowerCase().includes(q);
      if (matchVersion || matchBranch) {
        results.push({
          type: 'release',
          version: r.version,
          repo: r.repo || null,
          state: r.state,
          branch: r.branch || null,
        });
        releaseCount++;
      }
    }

    // Search tickets — match key or summary across all releases
    const seenTickets = new Set();
    let ticketCount = 0;
    for (const r of allReleases) {
      if (ticketCount >= MAX_PER_CATEGORY) break;
      for (const t of r.tickets || []) {
        if (ticketCount >= MAX_PER_CATEGORY) break;
        if (seenTickets.has(t.key)) continue;
        const matchKey = (t.key || '').toLowerCase().includes(q);
        const matchSummary = (t.summary || '').toLowerCase().includes(q);
        if (matchKey || matchSummary) {
          seenTickets.add(t.key);
          results.push({
            type: 'ticket',
            key: t.key,
            summary: t.summary || '',
            jiraStatus: t.jiraStatus || t.state || null,
            version: r.version,
          });
          ticketCount++;
        }
      }
    }

    // Search environments — match id, name, or customerId
    const allEnvs = customerStore.listEnvironments();
    let envCount = 0;
    for (const e of allEnvs) {
      if (envCount >= MAX_PER_CATEGORY) break;
      const matchId = (e.id || '').toLowerCase().includes(q);
      const matchName = (e.name || '').toLowerCase().includes(q);
      const matchCustomer = (e.customerId || '').toLowerCase().includes(q);
      if (matchId || matchName || matchCustomer) {
        results.push({
          type: 'environment',
          id: e.id,
          customerId: e.customerId,
          tier: e.tier || null,
          currentVersion: e.currentVersion || null,
        });
        envCount++;
      }
    }

    // Search customers — match id or name
    const allCustomers = customerStore.listCustomers();
    let customerCount = 0;
    for (const c of allCustomers) {
      if (customerCount >= MAX_PER_CATEGORY) break;
      const matchId = (c.id || '').toLowerCase().includes(q);
      const matchName = (c.name || '').toLowerCase().includes(q);
      if (matchId || matchName) {
        results.push({
          type: 'customer',
          id: c.id,
          name: c.name,
        });
        customerCount++;
      }
    }

    // Trim to MAX_TOTAL
    const total = results.length;
    res.json({
      query: req.query.q || '',
      results: results.slice(0, MAX_TOTAL),
      total,
    });
  });

  // ── Meta ──────────────────────────────────────────────

  router.get('/states', (req, res) => {
    res.json({
      states: ReleaseManager.STATES,
      transitions: ReleaseManager.TRANSITIONS,
    });
  });

  // ── Global error handler ─────────────────────────────
  // Catches unhandled errors from asyncHandler and any throw in sync routes
  router.use((err, req, res, _next) => {
    const status = err.statusCode || 500;
    const message = err.message || 'Internal server error';
    if (status >= 500) {
      log.error(`API error [${req.method} ${req.path}]:`, message);
      if (err.stack) log.error(err.stack);
    }
    res.status(status).json({ error: message });
  });

  return router;
};
