const { Router } = require('express');
const ReleaseManager = require('../core/release');

/**
 * REST API routes — primary consumer is Hive.
 * @param {object} services - All initialized services
 * @param {object} config
 */
module.exports = function createRoutes(services, config) {
  const { releases, repoManager, risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth, customerStore, webplatformScanner, envPoller } = services;
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
    res.json(releases.list(filter));
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
  router.post('/releases/:version/cherry-pick/sync', async (req, res) => {
    try {
      const count = await cherryPickWatcher.syncRelease(req.params.version);
      res.json({ ok: true, synced: count });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

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

  router.get('/releases/:version/risk', async (req, res) => {
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
  });

  // ── Validation ────────────────────────────────────────

  router.get('/releases/:version/validate', async (req, res) => {
    try {
      const report = await validator.validate(req.params.version);
      res.json(report);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

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

  router.post('/webplatform/scan', async (req, res) => {
    try {
      const scanResults = await webplatformScanner.scan();
      const applied = customerStore.applyScanResults(scanResults);
      res.json({ ok: true, ...applied, scanStatus: webplatformScanner.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/webplatform/scan/status', (req, res) => {
    res.json(webplatformScanner.getStatus() || { neverRun: true });
  });

  // ── Environment poller ────────────────────────────────

  router.post('/environments/poll', async (req, res) => {
    try {
      const results = await envPoller.run();
      res.json({ ok: true, ...results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/environments/poll/status', (req, res) => {
    res.json(envPoller.getStatus());
  });

  // ── Upgrade script content (from local webplatform clone) ─
  // Reads the actual script file from master so users can see the code.
  // Extracts the JIRA key from the git commit message (reliable, not filename).
  router.get('/upgrades/:upgradeName/source', async (req, res) => {
    try {
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
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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

  router.post('/discover', async (req, res) => {
    try {
      const results = await discovery.run();
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Release Truth ──────────────────────────────────────

  router.get('/releases/:repo/:version/truth', async (req, res) => {
    try {
      const truth = await releaseTruth.compute(req.params.repo, req.params.version);
      res.json(truth);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── JIRA Sync ──────────────────────────────────────────

  router.get('/jira/status', (req, res) => {
    res.json(jiraSync.getStatus());
  });

  router.post('/jira/sync', async (req, res) => {
    try {
      const results = await jiraSync.run();
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Config (safe values exposed to frontend) ──────────

  router.get('/config', (req, res) => {
    res.json({
      jiraBaseUrl: (process.env.JIRA_BASE_URL || process.env.JIRA_URL || '').replace(/\/$/, ''),
      githubRepo: (config.repos || []).map(r => ({ name: r.name, github: r.github })),
    });
  });

  // ── Meta ──────────────────────────────────────────────

  router.get('/states', (req, res) => {
    res.json({
      states: ReleaseManager.STATES,
      transitions: ReleaseManager.TRANSITIONS,
    });
  });

  return router;
};
