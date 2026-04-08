const { Router } = require('express');
const ReleaseManager = require('../core/release');

/**
 * REST API routes — primary consumer is Hive.
 * @param {object} services - All initialized services
 * @param {object} config
 */
module.exports = function createRoutes(services, config) {
  const { releases, repoManager, risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth } = services;
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
    res.json(customers.getMap());
  });

  router.get('/customers/:name', (req, res) => {
    const customer = customers.getCustomer(req.params.name);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  });

  router.get('/customers/version/:version', (req, res) => {
    res.json(customers.getCustomersOnVersion(req.params.version));
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
