const { Router } = require('express');
const log = require('../core/log');
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
  const { releases, repoManager, github, risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth, customerStore, webplatformScanner, envPoller, themeConfig } = services;

  // Nectar's own repo — used by the Issues page so users can file bugs/feedback.
  const NECTAR_REPO = 'mavencare/nectar';
  const router = Router();

  // ── Token auth middleware (optional) ────────────────────
  const token = process.env.WEB_TOKEN;
  router.use((req, res, next) => {
    if (!token) return next();
    const auth = req.headers.authorization;
    if (auth === `Bearer ${token}`) return next();
    if (req.query.token === token) return next();
    res.status(401).json({ error: 'Unauthorized' });
  });

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

  // Release calendar — all releases with jiraReleaseDate, annotated with
  // effective status (shipped/in-flight/upcoming/overdue) using prod env data
  router.get('/releases/calendar', (req, res) => {
    const { repo, from, to } = req.query;
    let list = releases.list();
    if (repo) list = list.filter(r => r.repo === repo);
    list = list.filter(r => r.jiraReleaseDate && !r.jiraArchived);
    if (from) list = list.filter(r => r.jiraReleaseDate >= from);
    if (to) list = list.filter(r => r.jiraReleaseDate <= to);
    list.sort((a, b) => (a.jiraReleaseDate || '').localeCompare(b.jiraReleaseDate || ''));
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

  // ── Release notes (Phase 2 stub) ─────────────────────

  router.get('/releases/:version/notes', (req, res) => {
    const release = releases.get(req.params.version);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    res.json({
      version: release.version,
      tickets: release.tickets.map(t => ({ key: t.key, summary: t.summary })),
      generated: false,
      notes: release.notes,
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

  // ── Theme configuration (roadmap) ─────────────────────

  router.get('/config/themes', (req, res) => {
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

  router.put('/config/themes', (req, res) => {
    try {
      themeConfig.setConfig(req.body);
      res.json(themeConfig.getConfig());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
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
