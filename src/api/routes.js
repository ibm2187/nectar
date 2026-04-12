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

/**
 * REST API routes — primary consumer is Hive.
 * @param {object} services - All initialized services
 * @param {object} config
 */
module.exports = function createRoutes(services, config) {
  const { releases, repoManager, github, risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth, customerStore, webplatformScanner, envPoller, themeConfig, apiKeys, taskQueue } = services;

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

  router.get('/releases/:version', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    res.json(release);
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
    const truth = await releaseTruth.compute(req.params.repo, req.params.version);
    res.json(truth);
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

  // ── Tasks ───────────────────────────────────────────

  if (taskQueue) {
    router.post('/tasks', asyncHandler(async (req, res) => {
      const { type, version, slackUserId, compareVersion } = req.body || {};

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
        default:
          return res.status(400).json({ error: `No test available for ${name}` });
      }

      res.json(result);
    } catch (err) {
      res.json({ ok: false, detail: err.message });
    }
  }));

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
