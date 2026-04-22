const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const log = require('../core/log');
const { requireCapability } = require('../core/authz');
const { createAccessRoutes } = require('./access-routes');
const ReleaseManager = require('../core/release');
const { annotateReleases } = require('../core/release-status');
const { aggregateFeatureFlags, aggregateIntegrations } = require('../core/feature-aggregator');
const { buildStandupData } = require('./standup');
const { sendTicketNotification, sendStandupReminder, CANNED_MESSAGES } = require('./ticket-notify');
const { computeMilestones, recomputeMilestones, refreshFromTemplate, hasGateActivity, autoComputeForRelease, inferReleaseType } = require('../core/milestone-engine');
const { getArtifactsS3 } = require('../core/s3-artifacts');

/**
 * Evaluate a gate's auto-check function against live release data.
 * Returns { passed: boolean, detail: string } or null if no auto-check.
 */
function evaluateAutoCheck(gate, release, services) {
  if (!gate.autoCheck) return null;

  const today = new Date().toISOString().split('T')[0];

  switch (gate.autoCheck) {
    case 'branch-exists':
      return {
        passed: !!(release.branch && release.cutAt),
        detail: release.branch ? `Branch: ${release.branch}` : 'No branch set',
      };

    case 'time-based':
      return {
        passed: gate.effectiveDate ? today >= gate.effectiveDate : false,
        detail: gate.effectiveDate ? `Due: ${gate.effectiveDate}` : 'No date set',
      };

    case 'state-is-done':
      return {
        passed: release.state === 'done',
        detail: `State: ${release.state}`,
      };

    case 'all-prs-merged':
      // Check via truth engine if available
      return {
        passed: false,
        detail: 'Requires truth engine evaluation',
      };

    case 'truth-all-certified':
      return {
        passed: false,
        detail: 'Requires truth engine evaluation',
      };

    case 'migrations-approved':
      return {
        passed: true,
        detail: 'No migration tracking yet',
      };

    default:
      return null;
  }
}

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
  const { releases, repoManager, github, risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth, customerStore, webplatformScanner, envPoller, themeConfig, apiKeys, taskQueue, userStore, datadog, datadogPoller, ticketStore, prStore, velocityEngine, alertRules, incidents, slack, alertRouter } = services;

  // Nectar's own repo — used by the Issues page so users can file bugs/feedback.
  const NECTAR_REPO = 'mavencare/nectar';
  const router = Router();

  // ── Response cache for expensive endpoints ────────────────
  // Short TTL (10s) cache for /releases/home. Keyed by query string.
  // Invalidated when releases change (SQLite updatedAt check).
  const _homeCache = new Map(); // key → { data, expiresAt }
  const HOME_CACHE_TTL = 10_000; // 10 seconds

  function getHomeCached(cacheKey) {
    const entry = _homeCache.get(cacheKey);
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
  }

  function setHomeCached(cacheKey, data) {
    _homeCache.set(cacheKey, { data, expiresAt: Date.now() + HOME_CACHE_TTL });
    // Prevent unbounded growth — evict stale entries periodically
    if (_homeCache.size > 100) {
      const now = Date.now();
      for (const [k, v] of _homeCache) {
        if (now >= v.expiresAt) _homeCache.delete(k);
      }
    }
  }

  // Invalidate when releases are modified by user actions
  releases.on('release:updated', () => _homeCache.clear());
  releases.on('release:created', () => _homeCache.clear());
  releases.on('release:transition', () => _homeCache.clear());
  releases.on('release:deleted', () => _homeCache.clear());

  // ── Ticket helpers — get tickets from normalized TicketStore ──

  /**
   * Get tickets for a release from the normalized TicketStore.
   * Delegates to releases.getTickets() which queries by fixVersions/targetFixVersions.
   */
  function getTicketsForRelease(release) {
    return releases.getTickets(release);
  }

  /**
   * Enrich a ticket list response with PR data from PrStore.
   * Adds a `prs` array to each ticket with { prNumber, repo, status, baseBranch, prUrl }.
   */
  // NOTE: enrichWithPrs, enrichWithReleases, enrichWithTruth are no longer used.
  // Ticket queries now use SQL-level enrichment via TicketStore.ENRICH_COLUMNS
  // which joins releases, PRs, and truth in a single query.

  // Release identity key. Prefer the DB-unique id so two repo-less releases
  // sharing a version can't collide in a cache; fall back for test fixtures.
  function releaseCacheKey(r) {
    return r.id || `${r.repo || ''}:${r.version}`;
  }

  function enrichReleasesWithTickets(releaseList) {
    if (!ticketStore || releaseList.length === 0) return releaseList;

    const ticketsByKey = new Map();
    for (const r of releaseList) {
      const key = releaseCacheKey(r);
      if (ticketsByKey.has(key)) continue;
      ticketsByKey.set(key, getTicketsForRelease(r));
    }

    return releaseList.map(r => ({
      ...r,
      tickets: ticketsByKey.get(releaseCacheKey(r)) || [],
    }));
  }

  /**
   * Enrich a flat ticket list (from TicketStore) with release membership data.
   * Looks up each ticket's fixVersions/targetFixVersions against known releases
   * and adds a `releases[]` array (same shape as /tickets/home).
   * Also normalises the `status` field to `jiraStatus` for client consistency.
   */
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
    res.json(annotateReleases(enrichReleasesWithTickets(list), environments));
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
    const enriched = annotateReleases(enrichReleasesWithTickets(list), environments);
    // Slim down for the calendar view — only ticket key+state needed (counts & forecast)
    const slimmed = enriched.map(r => ({
      ...r,
      tickets: (r.tickets || []).map(t => ({ key: t.key, state: t.state })),
    }));
    res.json(slimmed);
  });

  router.get('/releases/active', (req, res) => {
    res.json(enrichReleasesWithTickets(releases.active()));
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
    if (range === 'nextweek') {
      const dayOfWeek = today.getDay();
      const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      const nextSunday = new Date(today.getTime() + (daysToSunday + 7) * 24 * 60 * 60 * 1000);
      return nextSunday.toISOString().slice(0, 10);
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
    // Check cache first
    const cacheKey = `${req.query.view || ''}:${req.query.person || ''}:${req.query.range || req.query.days || ''}`;
    const cached = getHomeCached(cacheKey);
    if (cached) return res.json(cached);

    const { view, person } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const horizon = computeHorizon(req.query);

    let list = releases.list();
    // Exclude done/archived
    list = list.filter(r => r.state !== 'done' && !r.jiraArchived);
    // Include: overdue (past release date) OR upcoming (within horizon)
    // Unscheduled releases (no date) are excluded from the home view
    list = list.filter(r => {
      if (!r.jiraReleaseDate) return false; // no date = not scheduled, hide
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

    // Batch PR + truth lookups across all tickets. Ticket fetch is still one
    // query per release (see getTicketsForRelease); keyed by release identity
    // so iOS 2026.4.0 and Android 2026.4.0 don't overwrite each other's lists.
    const ticketsByKey = new Map();
    const allTicketKeys = new Set();
    for (const release of annotated) {
      const tickets = getTicketsForRelease(release);
      ticketsByKey.set(releaseCacheKey(release), tickets);
      for (const t of tickets) allTicketKeys.add(t.key);
    }
    const uniqueKeys = [...allTicketKeys];
    const truthMap = ticketStore ? ticketStore.getTruthForTicketsSlim(uniqueKeys) : new Map();
    const prLookup = prStore ? prStore.findByJiraKeysSlim(uniqueKeys) : new Map();

    let result = annotated.map(release => {
      let tickets = ticketsByKey.get(releaseCacheKey(release)) || [];

      // Enrich tickets with PR data + build status + OOO annotations + truth
      const ticketKeys = tickets.map(t => t.key);
      const buildByJiraKey = release.buildByJiraKey || {};
      const releaseDate = release.jiraReleaseDate;
      const isImminentRelease = releaseDate && releaseDate <= tomorrow && release.state !== 'done';

      tickets = tickets.map(t => {
        const enriched = {
          ...t,
          prs: prLookup.get(t.key) || [],
          build: buildByJiraKey[t.key] || null,
          truth: truthMap.get(t.key) || [],
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

      // Compute delivery forecast from VelocityEngine simulation
      let forecast = null;
      if (velocityEngine) {
        try {
          const cached = velocityEngine.getCachedForecast();
          const releaseForecast = cached.releases?.get(release.version);
          if (releaseForecast) {
            forecast = { ...releaseForecast };
            // Convert any Map values for JSON serialization
            if (forecast.bottleneck instanceof Map) forecast.bottleneck = Object.fromEntries(forecast.bottleneck);
          }
        } catch {
          // Non-critical — don't block the response
        }
      }

      return {
        ...release,
        tickets,
        ticketCount: tickets.length,
        totalTicketCount: getTicketsForRelease(release).length,
        zohoTicketCount: (release.zohoTickets || []).length,
        zohoTickets: release.zohoTickets || [],
        pipeline: release.pipeline || null,
        isOverdue: release.jiraReleaseDate && release.jiraReleaseDate < today,
        oooRisk,
        forecast,
      };
    });

    // When filtering by person, hide releases with 0 matching tickets
    if (person && view && (view === 'dev' || view === 'qa' || view === 'pm')) {
      result = result.filter(r => r.ticketCount > 0);
    }

    setHomeCached(cacheKey, result);
    res.json(result);
  });

  /**
   * GET /api/tickets/home — flat list of tickets in immediate releases,
   * with full enrichment (releases, PRs, truth) done in SQL.
   *
   * Supports: ?view=dev|qa|pm&person=...&limit=50&offset=0&sort=created&sortDir=desc
   */
  router.get('/tickets/home', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const { view, person, sort, sortDir } = req.query;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const today = new Date().toISOString().slice(0, 10);
    const horizon = computeHorizon(req.query);

    const result = ticketStore.getForImmediateReleases({ today, horizon, view, person, sort, sortDir, limit, offset });
    res.json(result);
  });

  // ── Daily Standup ─────────────────────────────────────
  // Aggregates per-person data with priority buckets for the wizard-style standup page.
  // Default horizon: 5 business days (skips weekends + holidays via availability service).
  // Override with ?horizon=YYYY-MM-DD if needed.
  // Cached for 30s — standup data doesn't change mid-meeting.
  let _standupCache = { data: null, expiresAt: 0, key: null };

  router.get('/standup', (req, res) => {
    const cacheKey = req.query.horizon || 'default';
    if (_standupCache.key === cacheKey && Date.now() < _standupCache.expiresAt) {
      return res.json(_standupCache.data);
    }

    const opts = {};
    if (req.query.horizon) opts.horizon = req.query.horizon;
    const standupServices = {
      releases,
      ticketStore,
      prStore,
      availability: services.availability,
      peopleDirectory: services.peopleDirectory,
    };
    const data = buildStandupData(standupServices, opts);
    _standupCache = { data, expiresAt: Date.now() + 30_000, key: cacheKey };
    res.json(data);
  });

  // ── Ticket Notifications ──────────────────────────────────
  // Canned messages for the notify dialog
  router.get('/notify/canned-messages', (req, res) => {
    res.json(CANNED_MESSAGES);
  });

  // Send notification about specific tickets
  router.post('/notify/tickets', requireCapability('notify.send'), asyncHandler(async (req, res) => {
    const { ticketKeys, recipientType, channel, message, version, senderName } = req.body;
    if (!ticketKeys || !Array.isArray(ticketKeys) || ticketKeys.length === 0) {
      return res.status(400).json({ error: 'ticketKeys required (array of JIRA keys)' });
    }
    if (!['dev', 'qa', 'both'].includes(recipientType)) {
      return res.status(400).json({ error: 'recipientType must be dev, qa, or both' });
    }
    if (!['dm', 'release'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be dm or release' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message required' });
    }
    const notifyServices = {
      slack: services.slack,
      releases,
      peopleDirectory: services.peopleDirectory,
      ticketStore,
    };
    const result = await sendTicketNotification(
      { ticketKeys, recipientType, channel, message: message.trim(), version, senderName },
      notifyServices
    );
    res.json(result);
  }));

  // Send standup reminder to a specific person
  router.post('/notify/standup', requireCapability('notify.send'), asyncHandler(async (req, res) => {
    const { personName, message, senderName } = req.body;
    if (!personName) {
      return res.status(400).json({ error: 'personName required' });
    }
    // Build standup data to get this person's buckets
    const standupServices = {
      releases,
      ticketStore,
      prStore,
      availability: services.availability,
      peopleDirectory: services.peopleDirectory,
    };
    const standupData = buildStandupData(standupServices);
    const person = standupData.people.find(p => p.name === personName);
    if (!person) {
      return res.status(404).json({ error: `Person not found: ${personName}` });
    }
    const notifyServices = {
      slack: services.slack,
      peopleDirectory: services.peopleDirectory,
    };
    const result = await sendStandupReminder(
      { personName, message, senderName },
      person,
      notifyServices
    );
    res.json(result);
  }));

  router.get('/releases/:version', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    // Auto-compute milestones if missing but inferrable from version + JIRA date
    if ((!release.milestones || release.milestones.length === 0) && services.templateStore) {
      const auto = autoComputeForRelease(release, services.templateStore);
      if (auto) {
        releases.update(req.params.version, auto);
        Object.assign(release, auto);
      }
    }

    const pipeline = services.pipelineSync
      ? services.pipelineSync.getPipelineForRelease(release)
      : null;
    res.json({ ...release, tickets: getTicketsForRelease(release), pipeline });
  });

  // PR data for a release — returns prsByJiraKey for all tickets in the release.
  // Used by TruthView to show cherry-pick and PR columns.
  router.get('/releases/:version/prs', (req, res) => {
    if (!prStore) return res.json({});
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    const tickets = getTicketsForRelease(release);
    const keys = tickets.map(t => t.key);
    const prMap = prStore.findByJiraKeysSlim(keys);
    // Convert Map to plain object for JSON
    const result = {};
    for (const [key, prs] of prMap) {
      result[key] = prs.map(p => ({
        prNumber: p.prNumber,
        prTitle: null,
        prAuthor: p.prAuthor || null,
        prUrl: p.prUrl,
        prCreatedAt: null,
        status: p.status,
        baseBranch: p.baseBranch,
        reviewDecision: p.reviewDecision || null,
      }));
    }
    res.json(result);
  });

  // Notify release channel — sends status update to Slack
  router.post('/releases/:version/notify', requireCapability('notify.send'), asyncHandler(async (req, res) => {
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
  router.post('/releases/:version/refresh', requireCapability('release.write'), asyncHandler(async (req, res) => {
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
    res.json({ release: { ...updated, tickets: getTicketsForRelease(updated) }, refresh: results });
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

  router.post('/releases', requireCapability('release.write'), (req, res) => {
    try {
      const body = { ...req.body };

      // Auto-compute milestones when releaseType + shipDate are provided
      if (body.releaseType && body.shipDate && services.templateStore) {
        const template = services.templateStore.get(body.releaseType);
        if (template) {
          body.milestones = computeMilestones(body.shipDate, template);
          body.templateVersion = template.version;
        }
      }

      const release = releases.create(body);
      res.status(201).json(release);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Set up or update release train — inline edits of type and/or shipDate.
  // Accepts partial updates; recomputes milestones preserving existing overrides.
  router.patch('/releases/:version/train', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });

      const { templateStore } = services;
      if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });

      const newType = req.body.releaseType ?? release.releaseType;
      const newShipDate = req.body.shipDate ?? release.shipDate;

      if (!newType || !newShipDate) {
        return res.status(400).json({ error: 'releaseType and shipDate required to compute milestones' });
      }

      const template = templateStore.get(newType);
      if (!template) return res.status(400).json({ error: `Unknown release type: ${newType}` });

      const typeChanged = newType !== release.releaseType;
      let milestones;
      if (typeChanged || !release.milestones || release.milestones.length === 0) {
        // Type changed → start fresh from template
        milestones = computeMilestones(newShipDate, template);
      } else {
        // Only ship date changed → recompute preserving overrides + status
        milestones = recomputeMilestones(newShipDate, release.milestones, template);
      }

      releases.update(req.params.version, {
        releaseType: newType,
        shipDate: newShipDate,
        milestones,
        templateVersion: template.version,
      });
      res.json(releases.get(req.params.version));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Legacy endpoint — kept for backwards compat
  router.post('/releases/:version/setup-train', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });

      const { releaseType, shipDate } = req.body;
      if (!releaseType || !shipDate) {
        return res.status(400).json({ error: 'releaseType and shipDate are required' });
      }

      const { templateStore } = services;
      if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });

      const template = templateStore.get(releaseType);
      if (!template) return res.status(400).json({ error: `Unknown release type: ${releaseType}` });

      const milestones = computeMilestones(shipDate, template);
      releases.update(req.params.version, {
        releaseType,
        shipDate,
        milestones,
        templateVersion: template.version,
      });
      res.json(releases.get(req.params.version));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/releases/:version', requireCapability('release.write'), (req, res) => {
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
      res.json({ ...release, tickets: getTicketsForRelease(release) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/releases/:version', requireCapability('release.write'), (req, res) => {
    try {
      releases.delete(req.params.version, req.body.user);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── Tickets ───────────────────────────────────────────

  router.post('/releases/:version/tickets', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.addTicket(req.params.version, req.body, req.body.user);
      res.json({ ...release, tickets: getTicketsForRelease(release) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/releases/:version/tickets/:key', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.removeTicket(req.params.version, req.params.key, req.body.user);
      res.json({ ...release, tickets: getTicketsForRelease(release) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Cherry-picks ──────────────────────────────────────

  router.post('/releases/:version/cherry-pick', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.addCherryPick(req.params.version, req.body, req.body.user);
      res.json({ ...release, tickets: getTicketsForRelease(release) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/releases/:version/cherry-pick/sync — force-sync from GitHub
  router.post('/releases/:version/cherry-pick/sync', requireCapability('release.write'), asyncHandler(async (req, res) => {
    const count = await cherryPickWatcher.syncRelease(req.params.version);
    res.json({ ok: true, synced: count });
  }));

  // ── Approvals ─────────────────────────────────────────

  router.post('/releases/:version/approve', requireCapability('release.write'), (req, res) => {
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

  router.post('/releases/:version/deploy', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.addDeployment(req.params.version, req.body, req.body.user);
      res.json({ ...release, tickets: getTicketsForRelease(release) });
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

  router.put('/customers/:id', requireCapability('config.write'), (req, res) => {
    const customer = customerStore.getCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const allowed = ['name', 'shortName', 'color', 'hidden', 'sortOrder', 'notes'];
    const changes = {};
    for (const key of allowed) {
      if (key in req.body) changes[key] = req.body[key];
    }
    // Validate field types/formats
    if (changes.color != null && changes.color !== '' && !/^#[0-9a-fA-F]{6}$/.test(changes.color)) {
      return res.status(400).json({ error: 'color must be a 6-digit hex (e.g. #FF0000)' });
    }
    if (changes.sortOrder != null && (!Number.isInteger(changes.sortOrder) || changes.sortOrder < 0)) {
      return res.status(400).json({ error: 'sortOrder must be a non-negative integer' });
    }
    if (changes.hidden != null && typeof changes.hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden must be a boolean' });
    }
    const updated = customerStore.updateCustomer(req.params.id, changes);
    res.json(updated);
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
  router.patch('/environments/bulk/version', requireCapability('environment.write'), (req, res) => {
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
  router.patch('/environments/:id/version', requireCapability('environment.write'), (req, res) => {
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

  router.post('/webplatform/scan', requireCapability('environment.write'), asyncHandler(async (req, res) => {
    const scanResults = await webplatformScanner.scan();
    const applied = customerStore.applyScanResults(scanResults);
    res.json({ ok: true, ...applied, scanStatus: webplatformScanner.getStatus() });
  }));

  router.get('/webplatform/scan/status', (req, res) => {
    res.json(webplatformScanner.getStatus() || { neverRun: true });
  });

  // ── Environment poller ────────────────────────────────

  router.post('/environments/poll', requireCapability('environment.write'), asyncHandler(async (req, res) => {
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

  // ── Ticket database (jira_tickets) ─────────────────────

  router.get('/tickets/scope', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    res.json(ticketStore.getQAScope({ limit, offset }));
  });

  router.get('/tickets/cut-scope', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const { sort, sortDir, q, module, statusGroup, person } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    res.json(ticketStore.getCutScope({ sort, sortDir, search: q, module, statusGroup, person, limit, offset }));
  });

  router.get('/tickets/triage', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const since = req.query.since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    res.json(ticketStore.getTriage({ since, limit, offset }));
  });

  router.get('/tickets/sync-status', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const meta = ticketStore.getSyncMeta();
    const stats = ticketStore.getStats();
    res.json({ sync: meta, stats });
  });

  router.post('/tickets/sync', requireCapability('sync.trigger'), asyncHandler(async (req, res) => {
    if (!jiraSync) return res.status(503).json({ error: 'JIRA sync not available' });
    const result = await jiraSync.runTicketSync();
    res.json(result || { error: 'Sync already running or ticket store not configured' });
  }));

  router.get('/tickets/search', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const { q, statusCategory, assignee, type, module, component, customer, project, product, sort, sortDir, statusGroup, person } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const hasFixVersion = req.query.hasFixVersion === 'true' ? true : req.query.hasFixVersion === 'false' ? false : undefined;
    const createdSince = req.query.createdSince || undefined;
    const excludeStatuses = req.query.excludeStatuses ? req.query.excludeStatuses.split(',') : undefined;
    const excludeStatusCategory = req.query.excludeStatusCategory || undefined;
    if (q) {
      res.json(ticketStore.search(q, { limit, offset }));
    } else {
      res.json(ticketStore.getByFilter({ statusCategory, assignee, type, module, component, customer, project, product, person, hasFixVersion, createdSince, excludeStatuses, excludeStatusCategory, statusGroup, sort, sortDir, limit, offset }));
    }
  });

  router.get('/tickets/filter-options', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    res.json(ticketStore.getFilterOptions());
  });

  router.get('/tickets/by-module', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    res.json({ modules: ticketStore.getModules() });
  });

  router.get('/tickets/by-module/:module/components', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    res.json({ components: ticketStore.getComponentsForModule(req.params.module) });
  });

  // ── PR database (github_prs) ───────────────────────────

  router.get('/prs/by-ticket/:key', (req, res) => {
    if (!prStore) return res.status(503).json({ error: 'PR store not available' });
    const prs = prStore.findByJiraKey(req.params.key);
    res.json({ prs });
  });

  router.get('/prs/search', (req, res) => {
    if (!prStore) return res.status(503).json({ error: 'PR store not available' });
    const { q, repo, status, author } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    if (q) {
      res.json(prStore.search(q, { limit, offset }));
    } else {
      res.json(prStore.getByFilter({ repo, status, author, limit, offset }));
    }
  });

  router.get('/prs/sync-status', (req, res) => {
    if (!prStore) return res.status(503).json({ error: 'PR store not available' });
    res.json({ total: prStore.count(), ...prStore.getSyncMeta() });
  });

  // ── Ticket lookup ─────────────────────────────────────

  router.get('/tickets/:key/truth', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const key = req.params.key;
    const truth = ticketStore.getTruthForTicket(key);
    res.json({ key, truth });
  });

  router.get('/tickets/:key/releases', (req, res) => {
    const key = req.params.key;
    if (!ticketStore) return res.json([]);
    const ticket = ticketStore.get(key);
    if (!ticket) return res.json([]);
    const allVersions = new Set([...(ticket.fixVersions || []), ...(ticket.targetFixVersions || [])]);
    const result = [];
    for (const v of allVersions) {
      // Find ALL releases matching this version (multiple repos can share version numbers)
      const matching = releases.list().filter(r => r.version === v);
      for (const release of matching) {
        result.push({ repo: release.repo, version: release.version, state: release.state, ticketState: ticket.state });
      }
    }
    res.json(result);
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

  router.post('/discover', requireCapability('sync.trigger'), asyncHandler(async (req, res) => {
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

  // Persisted (cached) truth from ticket_truth table — instant, no computation needed.
  // Falls back to the persisted truth computed by TruthSync in the background.
  router.get('/releases/:repo/:version/truth/cached', (req, res) => {
    if (!ticketStore) return res.status(503).json({ error: 'Ticket store not available' });
    const { repo, version } = req.params;
    const verified = ticketStore.getTruthForRelease(repo, version);
    const rollup = ticketStore.getTruthRollup(repo, version);
    if (verified.length === 0) {
      return res.json({ status: 'none', message: 'No persisted truth — trigger a Refresh to compute.' });
    }
    return res.json({
      status: 'ready',
      result: { repo, version, verified, rollup },
      source: 'persisted',
    });
  });

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

  // ── Delivery Forecast ───────────────────────────────────

  // GET /api/releases/forecast — full simulation result for all releases
  router.get('/releases/forecast', (req, res) => {
    if (!velocityEngine) return res.status(503).json({ error: 'Velocity engine not available' });
    const result = velocityEngine.getCachedForecast();
    // Convert Maps to plain objects for JSON serialization
    res.json({
      releases: Object.fromEntries(result.releases || new Map()),
      people: Object.fromEntries(result.people || new Map()),
      globalVelocity: result.globalVelocity,
      teamAverages: result.teamAverages,
      simulation: result.simulation,
    });
  });

  // GET /api/releases/:repo/:version/forecast — per-release delivery risk forecast
  router.get('/releases/:repo/:version/forecast', (req, res) => {
    if (!velocityEngine) return res.status(503).json({ error: 'Velocity engine not available' });
    const result = velocityEngine.getCachedForecast();
    const releaseKey = req.params.version;
    const releaseForecast = result.releases?.get(releaseKey);
    // Return the per-release forecast with risk assessment
    if (!releaseForecast) return res.status(404).json({ error: 'Release not found in forecast' });
    res.json(releaseForecast);
  });

  // ── JIRA Sync ──────────────────────────────────────────

  router.get('/jira/status', (req, res) => {
    res.json(jiraSync.getStatus());
  });

  router.post('/jira/sync', requireCapability('sync.trigger'), asyncHandler(async (req, res) => {
    const results = await jiraSync.run();
    res.json(results);
  }));

  // ── People (extracted from synced JIRA tickets) ──────

  router.get('/people', (req, res) => {
    if (!ticketStore) return res.json([]);
    const people = ticketStore.getDistinctPeople();
    const availability = services.availability;
    const result = people.map(p => {
      const out = availability ? availability.getPersonOut(p.name) : null;
      return {
        name: p.name,
        roles: p.roles,
        out: out ? { startDate: out.startDate, endDate: out.endDate, summary: out.summary } : null,
      };
    });
    res.json(result);
  });

  // ── Availability (BambooHR Who's Out + Holidays) ──────

  router.get('/availability', (req, res) => {
    const availability = services.availability;
    if (!availability) return res.json({ loaded: false, currentlyOut: [], upcomingHolidays: [] });
    res.json(availability.snapshot());
  });

  router.post('/availability/refresh', requireCapability('config.write'), asyncHandler(async (req, res) => {
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

  router.post('/people/directory/reload', requireCapability('config.write'), asyncHandler(async (req, res) => {
    const { peopleDirectory } = services;
    const count = peopleDirectory.reload();
    res.json({ ok: true, loaded: count });
  }));

  // ── Notification Settings ─────────────────────────────

  router.get('/notifications/settings', (req, res) => {
    const { notificationSettings } = services;
    res.json({ ...notificationSettings.getAll(), schema: notificationSettings.getSchema() });
  });

  router.put('/notifications/settings', requireCapability('config.write'), (req, res) => {
    const { notificationSettings } = services;
    notificationSettings.update(req.body);
    res.json({ ...notificationSettings.getAll(), schema: notificationSettings.getSchema() });
  });

  router.put('/users/:email/notifications', (req, res) => {
    const { userStore } = services;
    const user = userStore.updateUser(req.params.email, { notificationPrefs: req.body });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ notificationPrefs: user.notificationPrefs });
  });

  router.post('/notifications/test-digest', requireCapability('config.write'), asyncHandler(async (req, res) => {
    const { notificationEngine } = services;
    const { slackId } = req.body || {};
    if (!slackId) return res.status(400).json({ error: 'slackId is required — select a person to send to' });
    const result = await notificationEngine.sendDailyDigestToUser(slackId);
    res.json(result);
  }));

  router.post('/notifications/test-ticket-changes', requireCapability('config.write'), asyncHandler(async (req, res) => {
    const { notificationEngine } = services;
    await notificationEngine.sendTicketChangeDigests();
    res.json({ ok: true, message: 'Ticket change digest triggered' });
  }));

  // Resolve an unresolved JIRA name by manually mapping it to a Slack user
  router.post('/people/directory/resolve', requireCapability('config.write'), asyncHandler(async (req, res) => {
    const { peopleDirectory } = services;
    const { jiraName, slackId } = req.body || {};
    if (!jiraName || !slackId) return res.status(400).json({ error: 'jiraName and slackId are required' });
    peopleDirectory.addOverride(jiraName, slackId);
    res.json({ ok: true, jiraName, slackId });
  }));

  // Search Slack users by name (for resolving unmatched names)
  router.post('/people/directory/search-slack', requireCapability('config.write'), asyncHandler(async (req, res) => {
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

  router.post('/pr/sync', requireCapability('sync.trigger'), asyncHandler(async (req, res) => {
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

  router.post('/pipeline/sync', requireCapability('sync.trigger'), asyncHandler(async (req, res) => {
    if (!services.pipelineSync) return res.status(503).json({ error: 'Pipeline sync not configured' });
    const results = await services.pipelineSync.run();
    res.json(results);
  }));

  // ── Zoho Sync ─────────────────────────────────────────

  router.get('/zoho/status', (req, res) => {
    if (!services.zohoSync) return res.json({ configured: false });
    res.json(services.zohoSync.getStatus());
  });

  router.post('/zoho/sync', requireCapability('sync.trigger'), asyncHandler(async (req, res) => {
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

    // Walk every active release, get tickets from TicketStore, dedupe by key,
    // accumulate per-release membership.
    const byKey = new Map();
    for (const release of activeReleases) {
      const releaseVersion = release.version;
      for (const ticket of getTicketsForRelease(release)) {
        const targetVersions = Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [];
        const fixVersions = Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [];
        const inTarget = targetVersions.includes(releaseVersion);
        const inFixVersion = fixVersions.includes(releaseVersion);
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
  router.post('/admin/datadog/backfill', requireCapability('system.admin'), asyncHandler(async (req, res) => {
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
    const projectFilter = req.query.project || null;
    const productFilter = req.query.product || null;
    const moduleFilter = req.query.module || null;
    const statusFilter = req.query.status || null; // 'done' or 'notdone'
    const labelFilter = req.query.label || null;
    const personFilter = req.query.person || null; // matches assignee OR qaAssignee
    const zoom = req.query.zoom || 'month'; // 'month' or 'week'
    const activeReleases = releases.active().filter(r => !r.jiraArchived);

    // ── Build time buckets ───
    const now = new Date();
    const months = [];

    if (zoom === 'week') {
      // Weekly buckets: 12 weeks forward
      // Find Monday of the current week
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7)); // back to Monday
      monday.setHours(0, 0, 0, 0);

      for (let i = 0; i < 12; i++) {
        const weekStart = new Date(monday);
        weekStart.setDate(monday.getDate() + i * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        // ISO week number
        const jan4 = new Date(weekStart.getFullYear(), 0, 4);
        const dayDiff = Math.floor((weekStart - jan4) / 86400000);
        const weekNum = Math.ceil((dayDiff + jan4.getDay() + 1) / 7);

        months.push({
          key: `${weekStart.getFullYear()}-W${String(weekNum).padStart(2, '0')}`,
          label: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          start: weekStart.toISOString().slice(0, 10),
          end: weekEnd.toISOString().slice(0, 10),
        });
      }
    } else {
      // Monthly buckets: 12 months forward (original behavior)
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        months.push({
          key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
          label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          start: d.toISOString().slice(0, 10),
          end: new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10),
        });
      }
    }

    function getTimeBucketKey(dateStr) {
      if (!dateStr) return null;
      if (zoom === 'week') {
        // Find which weekly bucket this date falls into
        const d = new Date(dateStr);
        for (const bucket of months) {
          if (d >= new Date(bucket.start) && d <= new Date(bucket.end)) return bucket.key;
        }
        return null; // date outside our 12-week window
      }
      return dateStr.slice(0, 7);
    }

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

    // ── Aggregate: module → component → month → release cards ──
    // Structure: { [module]: { components: { [comp]: { [month]: [card] } }, months: { [month]: [card] } } }
    const moduleGrid = new Map();
    const allCustomers = new Set();
    const allProjects = new Set();
    const allLabels = new Set();
    const allPeople = new Set();

    const allModules = new Set();

    for (const release of activeReleases) {
      const bucketKey = getTimeBucketKey(release.jiraReleaseDate);
      const effectiveMonth = bucketKey || 'unscheduled';
      const releaseCustomers = deriveCustomers(release);
      releaseCustomers.forEach(c => allCustomers.add(c));

      for (const ticket of getTicketsForRelease(release)) {
        // Customer filter: include tickets for this customer + tickets with no customer tag
        const ticketCustomers = Array.isArray(ticket.customerTags) ? ticket.customerTags : [];
        if (customerFilter && ticketCustomers.length > 0) {
          if (!ticketCustomers.some(c => c.toLowerCase() === customerFilter.toLowerCase())) continue;
        }

        // Project filter
        const ticketProjects = Array.isArray(ticket.projects) ? ticket.projects : [];
        ticketProjects.forEach(p => allProjects.add(p));
        if (projectFilter && !ticketProjects.some(p => p.toLowerCase() === projectFilter.toLowerCase())) continue;

        // Product filter
        const ticketProduct = Array.isArray(ticket.product) ? ticket.product : [];
        if (productFilter && !ticketProduct.some(p => p.toLowerCase() === productFilter.toLowerCase())) continue;

        // Label collection and filter
        const ticketLabels = Array.isArray(ticket.labels) ? ticket.labels : [];
        ticketLabels.forEach(l => allLabels.add(l));
        if (labelFilter && !ticketLabels.some(l => l.toLowerCase() === labelFilter.toLowerCase())) continue;

        // Person collection and filter (assignee OR qaAssignee)
        if (ticket.assignee) allPeople.add(ticket.assignee);
        if (ticket.qaAssignee) allPeople.add(ticket.qaAssignee);
        if (personFilter) {
          const pf = personFilter.toLowerCase();
          const matchesAssignee = ticket.assignee && ticket.assignee.toLowerCase() === pf;
          const matchesQa = ticket.qaAssignee && ticket.qaAssignee.toLowerCase() === pf;
          if (!matchesAssignee && !matchesQa) continue;
        }

        // Status filter: filter individual tickets by done/not-done
        if (statusFilter) {
          const ticketState = (ticket.state || '').toLowerCase();
          const isDone = ['done', 'cherry-picked'].includes(ticketState);
          if (statusFilter === 'done' && !isDone) continue;
          if (statusFilter === 'notdone' && isDone) continue;
        }

        const mod = ticket.module || 'Uncategorized';
        const comp = ticket.component || 'Other';
        allModules.add(mod);

        // Module filter: skip tickets not in the selected module
        if (moduleFilter && mod.toLowerCase() !== moduleFilter.toLowerCase()) continue;

        if (!moduleGrid.has(mod)) moduleGrid.set(mod, { components: new Map(), allTickets: [] });
        const modEntry = moduleGrid.get(mod);
        modEntry.allTickets.push({ ticket, release, effectiveMonth });

        if (!modEntry.components.has(comp)) modEntry.components.set(comp, []);
        modEntry.components.get(comp).push({ ticket, release, effectiveMonth });
      }
    }

    // Get filter options from ticket store
    const filterOptions = ticketStore ? ticketStore.getFilterOptions() : { modules: [], customers: [], projects: [], products: [] };
    // Merge release-derived customers with ticket-level customers
    for (const c of filterOptions.customers) allCustomers.add(c);
    for (const p of filterOptions.projects) allProjects.add(p);

    // ── Helper: classify ticket type into feature/bug/task ────
    const CUSTOMER_PRIORITY_ORDER = { 'urgent': 0, 'high': 1, 'medium': 2, 'low': 3, 'internal only': 4 };
    function classifyTicketType(type) {
      if (!type) return 'tasks';
      const t = type.toLowerCase();
      if (t === 'story' || t === 'feature' || t === 'epic') return 'features';
      if (t === 'bug') return 'bugs';
      return 'tasks';
    }

    // ── Helper: summarize a group of tickets per release ────
    function summarizeByRelease(entries) {
      const byRelease = new Map();
      for (const { ticket, release, effectiveMonth } of entries) {
        const rKey = releaseCacheKey(release);
        if (!byRelease.has(rKey)) {
          byRelease.set(rKey, {
            repo: release.repo,
            version: release.version,
            state: release.state,
            jiraReleaseDate: release.jiraReleaseDate || null,
            month: effectiveMonth,
            customers: deriveCustomers(release),
            tickets: [],
          });
        }
        byRelease.get(rKey).tickets.push(ticket);
      }

      const cards = [];
      for (const group of byRelease.values()) {
        const { tickets, ...meta } = group;
        const done = tickets.filter(t => ['done', 'cherry-picked'].includes((t.state || '').toLowerCase())).length;
        const inProgress = tickets.filter(t => (t.state || '').toLowerCase() === 'in-progress').length;

        // Ticket type breakdown
        const ticketBreakdown = { features: 0, tasks: 0, bugs: 0 };
        for (const t of tickets) {
          ticketBreakdown[classifyTicketType(t.type)]++;
        }

        // Top tickets: sorted by customer priority (urgent first), then type (features first)
        const topTickets = tickets
          .map(t => ({
            key: t.key,
            summary: t.summary || '',
            type: t.type || null,
            status: t.jiraStatus || t.status || 'Unknown',
            customerPriority: t.customerPriority || null,
            assignee: t.assignee || null,
          }))
          .sort((a, b) => {
            // Sort by customer priority ascending (urgent=0 first, null last)
            const aPri = a.customerPriority ? (CUSTOMER_PRIORITY_ORDER[a.customerPriority.toLowerCase()] ?? 5) : 99;
            const bPri = b.customerPriority ? (CUSTOMER_PRIORITY_ORDER[b.customerPriority.toLowerCase()] ?? 5) : 99;
            if (aPri !== bPri) return aPri - bPri;
            // Then by type: features first
            const aType = classifyTicketType(a.type);
            const bType = classifyTicketType(b.type);
            const typeOrder = { features: 0, tasks: 1, bugs: 2 };
            return (typeOrder[aType] || 1) - (typeOrder[bType] || 1);
          })
          .slice(0, 5);

        cards.push({
          ...meta,
          tickets: tickets.length,
          done,
          inProgress,
          pending: tickets.length - done - inProgress,
          progress: tickets.length > 0 ? Math.round((done / tickets.length) * 100) : 0,
          ticketBreakdown,
          topTickets,
        });
      }
      return cards;
    }

    // ── Build response: modules with nested components ──────
    const moduleNames = Array.from(moduleGrid.keys()).sort((a, b) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      return a.localeCompare(b);
    });

    const modules = moduleNames.map(mod => {
      const entry = moduleGrid.get(mod);
      const releaseCards = summarizeByRelease(entry.allTickets);

      // Group cards by month
      const monthEntries = {};
      let totalTickets = 0;
      let totalDone = 0;
      for (const card of releaseCards) {
        const m = card.month;
        if (!monthEntries[m]) monthEntries[m] = [];
        monthEntries[m].push(card);
        totalTickets += card.tickets;
        totalDone += card.done;
      }

      // Build component breakdown
      const components = Array.from(entry.components.entries())
        .map(([compName, compEntries]) => {
          const compCards = summarizeByRelease(compEntries);
          const compMonths = {};
          let compTotal = 0;
          let compDone = 0;
          for (const card of compCards) {
            if (!compMonths[card.month]) compMonths[card.month] = [];
            compMonths[card.month].push(card);
            compTotal += card.tickets;
            compDone += card.done;
          }
          return {
            name: compName,
            months: compMonths,
            totalTickets: compTotal,
            totalDone: compDone,
            progress: compTotal > 0 ? Math.round((compDone / compTotal) * 100) : 0,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        name: mod,
        months: monthEntries,
        components,
        totalTickets,
        totalDone,
        progress: totalTickets > 0 ? Math.round((totalDone / totalTickets) * 100) : 0,
      };
    });

    res.json({
      zoom,
      months,
      modules,
      customers: Array.from(allCustomers).sort(),
      projects: Array.from(allProjects).sort(),
      products: filterOptions.products || [],
      allModules: Array.from(allModules).sort(),
      allLabels: Array.from(allLabels).sort(),
      allPeople: Array.from(allPeople).sort(),
      stats: {
        totalModules: modules.length,
        totalReleases: activeReleases.length,
        totalTickets: modules.reduce((s, m) => s + m.totalTickets, 0),
      },
    });
  });

  // ── Roadmap drill-down: tickets for a theme × release ──

  router.get('/roadmap/:module/:version', (req, res) => {
    const moduleName = decodeURIComponent(req.params.module);
    const version = decodeURIComponent(req.params.version);
    const componentFilter = req.query.component || null;
    const typeFilter = req.query.type || null; // 'features', 'bugs', or 'tasks'

    const release = releases.get(version) || releases.active().find(r => r.version === version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const tickets = [];
    for (const ticket of getTicketsForRelease(release)) {
      const ticketModule = ticket.module || 'Uncategorized';
      if (ticketModule !== moduleName) continue;
      if (componentFilter && (ticket.component || 'Other') !== componentFilter) continue;

      // Type filter: classify ticket type and filter
      if (typeFilter) {
        const ticketType = (ticket.type || '').toLowerCase();
        if (typeFilter === 'features' && ticketType !== 'story' && ticketType !== 'feature' && ticketType !== 'epic') continue;
        if (typeFilter === 'bugs' && ticketType !== 'bug') continue;
        if (typeFilter === 'tasks' && (ticketType === 'story' || ticketType === 'feature' || ticketType === 'epic' || ticketType === 'bug')) continue;
      }

      const targetVersions = Array.isArray(ticket.targetFixVersions) ? ticket.targetFixVersions : [];
      const fixVersions = Array.isArray(ticket.fixVersions) ? ticket.fixVersions : [];
      const inTarget = targetVersions.includes(release.version);
      const inFixVersion = fixVersions.includes(release.version);

      tickets.push({
        key: ticket.key,
        summary: ticket.summary || '',
        jiraStatus: ticket.jiraStatus || ticket.status || 'Unknown',
        state: ticket.state || 'pending',
        type: ticket.type || null,
        priority: ticket.priority || null,
        customerPriority: ticket.customerPriority || null,
        assignee: ticket.assignee || null,
        module: ticket.module || null,
        component: ticket.component || null,
        customerTags: Array.isArray(ticket.customerTags) ? ticket.customerTags : [],
        projects: Array.isArray(ticket.projects) ? ticket.projects : [],
        product: Array.isArray(ticket.product) ? ticket.product : [],
        labels: Array.isArray(ticket.labels) ? ticket.labels : [],
        inTarget,
        inFixVersion,
      });
    }

    const done = tickets.filter(t => {
      const s = (t.state || '').toLowerCase();
      return s === 'done' || s === 'cherry-picked';
    }).length;

    res.json({
      module: moduleName,
      component: componentFilter,
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

  router.get('/config/themes', requireCapability('config.write'), (req, res) => {
    // If themes haven't been configured yet, auto-generate from observed data
    if (themeConfig.themes.length === 0) {
      const components = new Set();
      for (const release of releases.active()) {
        for (const ticket of getTicketsForRelease(release)) {
          if (ticket.component) components.add(ticket.component);
        }
      }
      if (components.size > 0) {
        themeConfig.autoGenerate(Array.from(components));
      }
    }
    res.json(themeConfig.getConfig());
  });

  router.put('/config/themes', requireCapability('config.write'), (req, res) => {
    try {
      themeConfig.setConfig(req.body);
      res.json(themeConfig.getConfig());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Auto-categorize: suggest theme groupings from all observed JIRA components
  router.post('/config/themes/auto', requireCapability('config.write'), (req, res) => {
    // Gather all observed components from active releases
    const components = new Set();
    for (const release of releases.list()) {
      for (const ticket of getTicketsForRelease(release)) {
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
    router.post('/keys', requireCapability('user.admin'), (req, res) => {
      try {
        const { label } = req.body || {};
        const createdBy = req.user ? req.user.email : null;
        const result = apiKeys.create(label, createdBy);
        res.status(201).json(result);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    router.get('/keys', requireCapability('user.admin'), (req, res) => {
      res.json(apiKeys.list());
    });

    router.delete('/keys/:id', requireCapability('user.admin'), (req, res) => {
      const deleted = apiKeys.revoke(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Key not found' });
      res.json({ ok: true });
    });
  }

  // ── Users — admin only ────────────────────────────────

  if (userStore) {
    router.get('/users', requireCapability('user.admin'), (req, res) => {
      const users = userStore.listUsers().map(u => ({
        email: u.email,
        name: u.name,
        picture: u.picture,
        role: userStore.getRole(u.email),
        capabilities: userStore.getCapabilities(u.email),
        roles: userStore.getRoles(u.email),
        isEnvAdmin: userStore.isEnvAdmin(u.email),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      }));
      res.json(users);
    });

    router.patch('/users/:email', requireCapability('user.admin'), (req, res) => {
      const email = decodeURIComponent(req.params.email);
      const { role } = req.body || {};
      const updated = userStore.updateUser(email, { role });
      if (!updated) return res.status(404).json({ error: 'User not found' });
      res.json({
        email: updated.email,
        name: updated.name,
        picture: updated.picture,
        role: userStore.getRole(updated.email),
        capabilities: userStore.getCapabilities(updated.email),
        roles: userStore.getRoles(updated.email),
        isEnvAdmin: userStore.isEnvAdmin(updated.email),
        lastLoginAt: updated.lastLoginAt,
        createdAt: updated.createdAt,
      });
    });
  }

  // ── Tasks ───────────────────────────────────────────

  if (taskQueue) {
    router.post('/tasks', requireCapability('task.write'), asyncHandler(async (req, res) => {
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
          tickets: truth ? truth.verified.map(mapTicket) : getTicketsForRelease(release).map(mapRawTicket),
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

    router.patch('/tasks/:id', requireCapability('task.write'), (req, res) => {
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

    const ALLOWED = ['release-notes.pdf', 'release-notes-draft.md'];
    if (!ALLOWED.includes(filename)) {
      return res.status(400).json({ error: `Unknown artifact: ${filename}` });
    }

    const s3 = getArtifactsS3();
    if (!s3) return res.status(503).json({ error: 'S3 release artifacts not configured' });

    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const key = `releases/${version}/${filename}`;

    try {
      const url = await getSignedUrl(s3.client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), {
        expiresIn: 900,
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

  // ── Draft editing + regeneration ───────────────────────
  // GET raw draft content from S3, PUT edited content back, trigger re-render.

  // Shared fallback: return release.notes as draft, or 404
  function sendNotesFallback(res, version) {
    const release = releases.get(version);
    if (release && release.notes) {
      return res.type('text/markdown').send(release.notes);
    }
    return res.status(404).json({ error: 'No draft found for this release. Generate release notes first.' });
  }

  router.get('/releases/:version/draft', asyncHandler(async (req, res) => {
    const { version } = req.params;
    const s3 = getArtifactsS3();
    if (!s3) return sendNotesFallback(res, version);

    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = `releases/${version}/release-notes-draft.md`;

    try {
      const resp = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
      const body = await resp.Body.transformToString('utf-8');
      res.type('text/markdown').send(body);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return sendNotesFallback(res, version);
      }
      log.error(`Failed to fetch draft: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch draft' });
    }
  }));

  // PUT /api/releases/:version/draft — save edited draft and trigger re-render
  router.put('/releases/:version/draft', requireCapability('release.write'), asyncHandler(async (req, res) => {
    const { version } = req.params;
    const { content, regenerate } = req.body || {};

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    if (content.length > 500000) {
      return res.status(400).json({ error: 'Draft too large (max 500KB)' });
    }

    // Always persist to release.notes so edits survive without S3
    const release = releases.get(version);
    if (!release) return res.status(404).json({ error: `Release not found: ${version}` });
    releases.update(version, { notes: content }, req.user ? req.user.email : 'draft-edit');

    const s3 = getArtifactsS3();
    if (s3) {
      // Also save to S3 when configured
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const key = `releases/${version}/release-notes-draft.md`;

      try {
        await s3.client.send(new PutObjectCommand({
          Bucket: s3.bucket,
          Key: key,
          Body: content,
          ContentType: 'text/markdown',
        }));
      } catch (err) {
        log.warn(`Failed to save draft to S3 (saved to release.notes): ${err.message}`);
      }
    }

    // Optionally trigger re-render
    if (regenerate !== false && taskQueue) {
      // Cancel any existing pending/in-progress task for this release
      const existing = taskQueue.findByRelease('release-notes', version);
      const promptFromPrev = existing?.input?.prompt;

      if (existing && (existing.status === 'pending' || existing.status === 'in-progress')) {
        taskQueue.fail(existing.id, 'Superseded by draft edit');
      }

      // Create a new task with editedDraft flag
      const draftKey = `releases/${version}/release-notes-draft.md`;
      const input = {
        version,
        editedDraft: true,
        draftS3Key: draftKey,
      };

      // Include prompt from previous task if available
      if (promptFromPrev) {
        input.prompt = promptFromPrev;
      }

      const requestedBy = req.user ? req.user.email : null;
      const task = taskQueue.createTask('release-notes', input, requestedBy, {});
      res.json({ saved: true, task });
    } else {
      res.json({ saved: true, task: null });
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
  router.get('/config/integrations', requireCapability('config.write'), (req, res) => {
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
  router.post('/config/integrations/:name', requireCapability('config.write'), (req, res) => {
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
  router.post('/config/integrations/:name/test', requireCapability('config.write'), asyncHandler(async (req, res) => {
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

  router.get('/admin/logs', requireCapability('config.write'), (req, res) => {
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

  const isProduction = process.env.NODE_ENV === 'production';

  function git(cmd) {
    return execSync(`git ${cmd}`, { cwd: NECTAR_ROOT, encoding: 'utf8', timeout: 60000 }).trim();
  }

  router.get('/admin/version', requireCapability('system.admin'), (req, res) => {
    try {
      const branch = git('rev-parse --abbrev-ref HEAD');
      const commit = git('rev-parse --short HEAD');
      const commitMessage = git('log -1 --format=%s');
      const commitDate = git('log -1 --format=%aI');
      res.json({ branch, commit, commitMessage, commitDate });
    } catch (err) {
      res.status(500).json({ error: `Failed to read git info: ${err.message}` });
    }
  });

  router.post('/admin/pull', requireCapability('system.admin'), asyncHandler(async (req, res) => {
    const steps = [];
    try {
      // 1. Record current HEAD
      const oldHead = git('rev-parse HEAD');
      steps.push(`Current HEAD: ${oldHead.slice(0, 7)}`);

      // 2. Fetch
      steps.push('Fetching...');
      git('fetch origin');

      // 3. Stash dirty worktree (runtime-generated files like cache)
      let stashed = false;
      try {
        git('diff --quiet');
      } catch {
        steps.push('Stashing dirty worktree...');
        git('stash --quiet');
        stashed = true;
      }

      // 4. Pull (fast-forward only)
      steps.push('Pulling...');
      const pullOutput = git('pull --ff-only 2>&1');
      steps.push(pullOutput);

      // 5. Reapply stash
      if (stashed) {
        steps.push('Reapplying stash...');
        try {
          git('stash pop --quiet');
        } catch {
          steps.push('Stash pop conflict (discarding stale runtime files)');
        }
      }

      // 6. Detect what changed
      const newHead = git('rev-parse HEAD');
      if (oldHead === newHead) {
        steps.push('Already up to date. Nothing to do.');
        log.info('Admin pull: already up to date');
        return res.json({ ok: true, output: steps.join('\n'), changed: false });
      }

      steps.push(`Updated: ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)}`);
      const changed = git(`diff --name-only ${oldHead} ${newHead}`);

      // 7. Reinstall server deps if package files changed
      if (/^package(-lock)?\.json$/m.test(changed)) {
        steps.push('Server deps changed — running npm install...');
        execSync('npm install', { cwd: NECTAR_ROOT, encoding: 'utf8', timeout: 120000 });
        steps.push('npm install complete.');
      }

      // 8. Reinstall client deps and rebuild if client/ changed
      if (/^client\//m.test(changed)) {
        const clientDir = path.join(NECTAR_ROOT, 'client');
        if (/^client\/package(-lock)?\.json$/m.test(changed)) {
          steps.push('Client deps changed — running npm install in client/...');
          execSync('npm install', { cwd: clientDir, encoding: 'utf8', timeout: 120000 });
        }
        steps.push('Rebuilding client...');
        execSync('npm run build', { cwd: clientDir, encoding: 'utf8', timeout: 120000 });
        steps.push('Client build complete.');
      }

      log.info(`Admin pull: ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)}`);
      res.json({ ok: true, output: steps.join('\n'), changed: true });
    } catch (err) {
      steps.push(`ERROR: ${err.message}`);
      log.error(`Admin pull failed: ${err.message}`);
      res.status(500).json({ error: err.message, output: steps.join('\n') });
    }
  }));

  router.post('/admin/restart', requireCapability('system.admin'), (req, res) => {
    log.info('Admin restart requested');
    res.json({ ok: true, message: 'Restarting...' });

    setTimeout(() => {
      if (isProduction) {
        // Production: restart both systemd services
        try {
          execSync('sudo systemctl restart nectar-web nectar-sync', {
            encoding: 'utf8',
            timeout: 30000,
          });
        } catch (err) {
          log.error(`systemctl restart failed: ${err.message}`);
          process.exit(1);
        }
      } else {
        // Local: spawn a replacement process after a delay (so the port
        // is freed after this process exits), then exit immediately.
        const entryPoint = path.join(NECTAR_ROOT, 'src', 'index.js');
        spawn('bash', ['-c', `sleep 1 && exec node "${entryPoint}"`], {
          cwd: NECTAR_ROOT,
          detached: true,
          stdio: 'ignore',
          env: process.env,
        }).unref();
        process.exit(0);
      }
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

    // Search tickets from TicketStore
    if (ticketStore) {
      const ticketResults = ticketStore.search(q, { limit: MAX_PER_CATEGORY });
      for (const t of ticketResults.tickets) {
        results.push({
          type: 'ticket',
          key: t.key,
          summary: t.summary || '',
          jiraStatus: t.status || t.state || null,
          version: (t.fixVersions && t.fixVersions[0]) || null,
        });
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

  // ── Release Train Process ─────────────────────────────

  // Templates
  router.get('/settings/release-templates', (req, res) => {
    const { templateStore } = services;
    if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });
    res.json(templateStore.list());
  });

  router.get('/settings/release-templates/:key', (req, res) => {
    const { templateStore } = services;
    if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });
    const tmpl = templateStore.get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: `Template not found: ${req.params.key}` });
    res.json(tmpl);
  });

  router.put('/settings/release-templates/:key', requireCapability('config.write'), (req, res) => {
    const { templateStore } = services;
    if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });
    try {
      const updated = templateStore.update(req.params.key, req.body, req.body.updatedBy || 'api');
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // List releases that could be affected by a template update.
  // Returns releases matching the template's type, grouped by impact category.
  router.get('/settings/release-templates/:key/affected-releases', (req, res) => {
    const { templateStore } = services;
    if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });

    const template = templateStore.get(req.params.key);
    if (!template) return res.status(404).json({ error: `Template not found: ${req.params.key}` });

    const matches = releases.list({ repo: undefined })
      .filter(r => r.releaseType === template.key && Array.isArray(r.milestones) && r.milestones.length > 0);

    const enriched = matches.map(r => {
      const acted = hasGateActivity(r.milestones);
      const shipped = r.state === 'done';
      const stale = (r.templateVersion || 0) < template.version;
      return {
        version: r.version,
        repo: r.repo,
        state: r.state,
        shipDate: r.shipDate,
        templateVersion: r.templateVersion || 0,
        gatesActed: (r.milestones || []).filter(m => m.gate && (m.status === 'met' || m.status === 'missed' || m.status === 'skipped')).length,
        gatesTotal: (r.milestones || []).filter(m => m.gate).length,
        impact: shipped ? 'shipped' : acted ? 'active' : 'untouched',
        stale,
      };
    }).sort((a, b) => {
      // Untouched first, then active, then shipped
      const order = { untouched: 0, active: 1, shipped: 2 };
      if (order[a.impact] !== order[b.impact]) return order[a.impact] - order[b.impact];
      return (b.shipDate || '').localeCompare(a.shipDate || '');
    });

    res.json({
      template: { key: template.key, label: template.label, version: template.version },
      releases: enriched,
    });
  });

  // Apply current template to a release. Preserves gate activity + overrides.
  router.post('/releases/:version/refresh-template', requireCapability('release.write'), (req, res) => {
    const { templateStore } = services;
    if (!templateStore) return res.status(501).json({ error: 'Template store not initialized' });

    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });
      if (!release.releaseType) return res.status(400).json({ error: 'Release has no releaseType — configure it first' });
      if (!release.shipDate) return res.status(400).json({ error: 'Release has no shipDate' });

      const template = templateStore.get(release.releaseType);
      if (!template) return res.status(400).json({ error: `Unknown release type: ${release.releaseType}` });

      const { milestones, changes } = refreshFromTemplate(release.shipDate, release.milestones || [], template);

      releases.update(req.params.version, {
        milestones,
        templateVersion: template.version,
      });

      res.json({
        release: releases.get(req.params.version),
        changes,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Milestones on a release
  router.get('/releases/:version/milestones', (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });
      res.json({
        version: release.version,
        releaseType: release.releaseType,
        shipDate: release.shipDate,
        templateVersion: release.templateVersion,
        milestones: release.milestones || [],
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/releases/:version/milestones/:milestoneKey', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });

      const milestones = [...(release.milestones || [])];
      const idx = milestones.findIndex(m => m.key === req.params.milestoneKey);
      if (idx === -1) return res.status(404).json({ error: `Milestone not found: ${req.params.milestoneKey}` });

      const { overrideDate, status } = req.body;
      const VALID_STATUSES = ['pending', 'met', 'missed', 'skipped'];

      if (status !== undefined && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}` });
      }

      if (overrideDate !== undefined) {
        milestones[idx] = {
          ...milestones[idx],
          overrideDate: overrideDate || null,
          effectiveDate: overrideDate || milestones[idx].computedDate,
        };
      }

      if (status !== undefined) {
        milestones[idx] = {
          ...milestones[idx],
          status,
          // Reset completion metadata when reopening
          ...(status === 'pending' ? { completedAt: null, completedBy: null } : {}),
        };
      }

      releases.update(req.params.version, { milestones });
      const updated = releases.get(req.params.version);
      res.json({ milestones: updated.milestones });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/releases/:version/milestones/:milestoneKey/complete', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });

      const milestones = [...(release.milestones || [])];
      const idx = milestones.findIndex(m => m.key === req.params.milestoneKey);
      if (idx === -1) return res.status(404).json({ error: `Milestone not found: ${req.params.milestoneKey}` });

      milestones[idx] = {
        ...milestones[idx],
        status: 'met',
        completedAt: new Date().toISOString(),
        completedBy: req.body.user || 'unknown',
      };

      releases.update(req.params.version, { milestones });
      const updated = releases.get(req.params.version);
      res.json({ milestone: updated.milestones[idx] });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/releases/:version/milestones/:milestoneKey/skip', requireCapability('release.write'), (req, res) => {
    try {
      const release = releases.get(req.params.version);
      if (!release) return res.status(404).json({ error: 'Release not found' });

      const milestones = [...(release.milestones || [])];
      const idx = milestones.findIndex(m => m.key === req.params.milestoneKey);
      if (idx === -1) return res.status(404).json({ error: `Milestone not found: ${req.params.milestoneKey}` });

      milestones[idx] = {
        ...milestones[idx],
        status: 'skipped',
        completedAt: new Date().toISOString(),
        completedBy: req.body.user || 'unknown',
      };

      releases.update(req.params.version, { milestones });
      const updated = releases.get(req.params.version);
      res.json({ milestone: updated.milestones[idx] });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Gates — milestones with live auto-check status
  router.get('/releases/:version/gates', asyncHandler(async (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const milestones = release.milestones || [];
    const gates = milestones.filter(m => m.gate);

    // Evaluate auto-checks
    const evaluated = gates.map(gate => {
      const autoResult = evaluateAutoCheck(gate, release, services);
      const now = new Date().toISOString().split('T')[0];
      const overdue = gate.status === 'pending' && gate.effectiveDate && gate.effectiveDate < now;

      return {
        ...gate,
        autoCheckResult: autoResult,
        overdue,
      };
    });

    res.json({ version: release.version, gates: evaluated });
  }));

  // Scorecard
  router.get('/releases/:version/scorecard', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });

    const milestones = release.milestones || [];
    const gates = milestones.filter(m => m.gate);
    const met = gates.filter(g => g.status === 'met');
    const missed = gates.filter(g => g.status === 'missed');
    const skipped = gates.filter(g => g.status === 'skipped');
    const scorable = gates.length - skipped.length;
    const gateHitRate = scorable > 0 ? met.length / scorable : null;
    const shipRef = release.shippedAt || release.updatedAt;

    const scorecard = {
      version: release.version,
      releaseType: release.releaseType,
      shipDate: release.shipDate,
      state: release.state,
      gateHitRate,
      totalGates: gates.length,
      gatesMet: met.length,
      gatesMissed: missed.length,
      gatesSkipped: skipped.length,
      onTimeShip: release.state === 'done' && release.shipDate && shipRef
        ? shipRef.split('T')[0] <= release.shipDate
        : null,
      shippedAt: release.shippedAt || null,
      milestones: milestones.map(m => ({
        key: m.key,
        label: m.label,
        effectiveDate: m.effectiveDate,
        status: m.status,
        completedAt: m.completedAt,
        gate: m.gate,
      })),
    };

    res.json(scorecard);
  });

  // Process health — cross-release trends
  router.get('/reports/process-health', (req, res) => {
    const limit = parseInt(req.query.releases) || 10;
    const allReleases = releases.list()
      .filter(r => r.milestones && r.milestones.length > 0)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit);

    const trends = allReleases.map(r => {
      const gates = (r.milestones || []).filter(m => m.gate);
      const met = gates.filter(g => g.status === 'met').length;
      const skipped = gates.filter(g => g.status === 'skipped').length;
      const scorable = gates.length - skipped;
      const shipRef = r.shippedAt || r.updatedAt;

      return {
        version: r.version,
        releaseType: r.releaseType,
        shipDate: r.shipDate,
        state: r.state,
        gateHitRate: scorable > 0 ? met / scorable : null,
        totalGates: gates.length,
        gatesMet: met,
        gatesMissed: gates.filter(g => g.status === 'missed').length,
        onTimeShip: r.state === 'done' && r.shipDate && shipRef
          ? shipRef.split('T')[0] <= r.shipDate
          : null,
        shippedAt: r.shippedAt || null,
        createdAt: r.createdAt,
      };
    });

    res.json({ releases: trends });
  });

  // Upcoming milestones across all active releases
  router.get('/reports/upcoming-milestones', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const daysAhead = parseInt(req.query.days) || 14;
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);
    const maxDate = futureDate.toISOString().split('T')[0];

    const activeReleases = releases.list().filter(r =>
      r.state !== 'done' && r.milestones && r.milestones.length > 0
    );

    const upcoming = [];
    for (const r of activeReleases) {
      for (const m of r.milestones) {
        if (m.status === 'pending' && m.effectiveDate && m.effectiveDate >= today && m.effectiveDate <= maxDate) {
          upcoming.push({
            version: r.version,
            releaseType: r.releaseType,
            milestone: m.key,
            label: m.label,
            date: m.effectiveDate,
            owner: m.owner,
            gate: m.gate,
          });
        }
      }
    }

    upcoming.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ upcoming });
  });

  // ── Meta ──────────────────────────────────────────────

  router.get('/states', (req, res) => {
    res.json({
      states: ReleaseManager.STATES,
      transitions: ReleaseManager.TRANSITIONS,
    });
  });

  // ── Alerts (rules + incidents) ───────────────────────
  if (alertRules && incidents) {
    const createAlertsRouter = require('./alerts');
    router.use('/alerts', createAlertsRouter({ alertRules, incidents, slack, alertRouter }));
  }

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

  // ── Access control routes (after error handler setup) ──
  const accessRouter = createAccessRoutes(services, {
    audit: services.audit,
    broadcastTo: services.broadcastTo,
  });
  router.use(accessRouter);

  return router;
};
