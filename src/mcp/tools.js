/**
 * Shared MCP tool registration. Both /mcp (api-key) and /mcp-oauth
 * (Bearer) call registerTools(server, deps, reqCtx) so tool defs live
 * in exactly one place.
 *
 * Each tool returns text content with JSON inside — the SDK doesn't
 * yet support structured content widely, and JSON-in-text plays well
 * with Claude's reasoning. Tools should:
 *   - Default to summary/list responses with sensible page sizes.
 *   - Accept narrowing parameters (id, key, customerId) before broad
 *     queries.
 *   - Never return raw secrets, full Slack post payloads, etc.
 *
 * `reqCtx` exposes the per-request principal — both `req.apiKey` and
 * `req.user.email` styles are supported transparently via authz's
 * extractPrincipal helper.
 *
 * `deps` shape (caller-provided; missing stores degrade gracefully):
 *   {
 *     customerStore, releases, releaseTruth,        // required-ish
 *     taskQueue, incidents, alertRules, alertRouter,
 *     zohoStore, ticketStore, prStore, userStore,
 *     risk,
 *   }
 */

const { z } = require('zod');
const log = require('./../core/log');
const { aggregateFeatureFlags, aggregateIntegrations } = require('../core/feature-aggregator');
const { getArtifactsS3 } = require('../core/s3-artifacts');
const { authorizeMcpTool } = require('../core/authz');
const { isValidCapability } = require('../core/capabilities');

// ── Local helpers ─────────────────────────────────────────

/**
 * Resolve a customer by id, shortName, or full name (case-insensitive).
 * Agents pass display names ("Lumen", "Help at Home") almost as often
 * as canonical IDs.
 */
function findCustomer(customers, needle) {
  if (!needle || typeof needle !== 'string') return null;
  const n = needle.trim().toLowerCase();
  if (!n) return null;
  return customers.find(c =>
    c.id?.toLowerCase() === n ||
    c.shortName?.toLowerCase() === n ||
    c.name?.toLowerCase() === n
  ) || null;
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const errText = (msg) => text(`Error: ${msg}`);

/**
 * Register every Nectar MCP tool on `server`. Returns the count of
 * registered tools so the caller can log it.
 */
function registerTools(server, deps, reqCtx) {
  const {
    customerStore, releases, releaseTruth, taskQueue,
    incidents, alertRules, alertRouter,
    zohoStore, ticketStore, prStore, userStore,
    risk,
  } = deps;

  let count = 0;
  const t = (...args) => { server.tool(...args); count++; };

  // ══════════════════════════════════════════════════════
  // CUSTOMERS + ENVIRONMENTS
  // ══════════════════════════════════════════════════════

  t('get_customer',
    'Get customer metadata and environment summary',
    { customerId: z.string().describe('Customer ID, short name, or full name (case-insensitive). E.g. "lumen", "Lumen", or "Help at Home" all resolve to the same customer.') },
    async ({ customerId }) => {
      const customers = customerStore.listCustomers();
      const customer = findCustomer(customers, customerId);
      if (!customer) {
        const available = customers
          .map(c => {
            const aliases = [c.shortName, c.name].filter(a => a && a !== c.id);
            return aliases.length ? `${c.id} (aka ${aliases.join(', ')})` : c.id;
          })
          .join('; ');
        return text(`Customer "${customerId}" not found. Available: ${available}`);
      }
      const envs = customerStore.listEnvironments().filter(e => e.customerId === customer.id);
      const prodEnvs = envs.filter(e => e.tier === 'production');
      return text({
        ...customer,
        environmentCount: envs.length,
        productionCount: prodEnvs.length,
        productionVersion: prodEnvs[0]?.currentVersion || null,
      });
    }
  );

  t('get_environment',
    'Get environment overview — version, tier, reachability, and config metadata. Does NOT include features/integrations/upgrades (use dedicated tools for those).',
    { envId: z.string().describe('Environment ID (e.g., "ck-615", "bayada-production", "ck-staging")') },
    async ({ envId }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return text(`Environment "${envId}" not found`);
      const { features, integrations, upgrades, ...overview } = env;
      overview.hasFeatures = !!features;
      overview.hasIntegrations = !!integrations;
      overview.upgradeCount = upgrades?.items?.length || 0;
      return text(overview);
    }
  );

  t('get_environment_features',
    'Get feature flags for an environment — both DB runtime flags and static config flags',
    { envId: z.string().describe('Environment ID') },
    async ({ envId }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return text(`Environment "${envId}" not found`);
      if (!env.features) return text(`No feature data available for "${envId}" — endpoint may not be deployed yet`);
      return text(env.features);
    }
  );

  t('get_environment_integrations',
    'Get integration states for an environment — DB integrations (QuickBooks, Salesforce, etc.) and config integrations (Ascend, SQS, etc.)',
    { envId: z.string().describe('Environment ID') },
    async ({ envId }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return text(`Environment "${envId}" not found`);
      if (!env.integrations) return text(`No integration data available for "${envId}"`);
      return text(env.integrations);
    }
  );

  t('get_environment_upgrades',
    'Get upgrade status for an environment. Use summary=true for an overview, or filter by status.',
    {
      envId: z.string().describe('Environment ID'),
      status: z.enum(['pending', 'applied', 'inProgress', 'failed', 'skipped', 'all']).default('all'),
      summary: z.boolean().default(true).describe('Return only counts (true) or full item list (false)'),
    },
    async ({ envId, status, summary }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return text(`Environment "${envId}" not found`);
      if (!env.upgrades) return text(`No upgrade data available for "${envId}"`);

      const items = env.upgrades.items || [];
      const buckets = { pending: 0, applied: 0, inProgress: 0, failed: 0, skipped: 0 };
      const bucketedItems = { pending: [], applied: [], inProgress: [], failed: [], skipped: [] };
      for (const item of items) {
        const h = item.history;
        let bucket = 'pending';
        if (!h) bucket = 'pending';
        else if (h.inProgress) bucket = 'inProgress';
        else if (h.completedAt && h.verificationStatus === 'FAILED') bucket = 'failed';
        else if (h.completedAt) bucket = 'applied';
        else if (h.skipped) bucket = 'skipped';
        buckets[bucket]++;
        bucketedItems[bucket].push(item);
      }

      if (summary) return text({ totalInPool: items.length, ...buckets });

      const filtered = status === 'all' ? items : (bucketedItems[status] || []);
      return text({
        totalInPool: items.length,
        counts: buckets,
        items: filtered.map(i => ({
          upgradeName: i.upgradeName,
          desiredEnvs: i.desiredEnvs,
          status: i.history?.completedAt ? 'applied' : i.history?.inProgress ? 'inProgress' : i.history?.skipped ? 'skipped' : 'pending',
          completedAt: i.history?.completedAt || null,
          verificationStatus: i.history?.verificationStatus || null,
        })),
      });
    }
  );

  t('search_environments',
    'Search environments by customer, version, tier, or name. Returns a summary list.',
    {
      customer: z.string().optional().describe('Filter by customer ID, short name, or full name (case-insensitive)'),
      version: z.string().optional(),
      tier: z.string().optional(),
      query: z.string().optional().describe('Free text across env ID and name'),
    },
    async ({ customer, version, tier, query }) => {
      let envs = customerStore.listEnvironments();
      if (customer) {
        const allCustomers = customerStore.listCustomers();
        const resolved = findCustomer(allCustomers, customer);
        if (!resolved) return text(`Customer "${customer}" not found. Available: ${allCustomers.map(c => c.id).join(', ')}`);
        envs = envs.filter(e => e.customerId === resolved.id);
      }
      if (version) envs = envs.filter(e => e.currentVersion === version);
      if (tier) envs = envs.filter(e => e.tier === tier);
      if (query) {
        const q = query.toLowerCase();
        envs = envs.filter(e => e.id.toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q));
      }
      const summary = envs.map(e => ({
        id: e.id,
        customer: e.customerId,
        tier: e.tier,
        version: e.currentVersion,
        reachable: e.reachable,
      }));
      return text({ count: summary.length, environments: summary });
    }
  );

  // ══════════════════════════════════════════════════════
  // RELEASES
  // ══════════════════════════════════════════════════════

  t('get_release',
    'Get release metadata including state, branch, JIRA info, and ticket count',
    {
      version: z.string().describe('Release version (e.g., "4.1.2", "4.2.2-lumen")'),
      repo: z.string().default('webplatform'),
    },
    async ({ version, repo }) => {
      const release = releases.get(version, repo);
      if (!release) return text(`Release ${repo}:${version} not found`);
      return text({
        version: release.version,
        repo: release.repo,
        state: release.state,
        branch: release.branch,
        jiraVersionName: release.jiraVersionName,
        jiraReleased: release.jiraReleased,
        jiraReleaseDate: release.jiraReleaseDate,
        ticketCount: releases.getTickets(release).length,
        cherryPickCount: (release.cherryPicks || []).length,
      });
    }
  );

  t('get_release_truth',
    'Compute the full release truth — per-ticket health verification against JIRA + Git + GitHub. EXPENSIVE — queries JIRA live. For a quick overview use get_release_truth_summary first.',
    {
      version: z.string().describe('Release version'),
      repo: z.string().default('webplatform'),
    },
    async ({ version, repo }) => {
      try { return text(await releaseTruth.compute(repo, version)); }
      catch (err) { return errText(err.message); }
    }
  );

  t('get_release_truth_summary',
    'Health rollup for a release without per-ticket detail — counts by health bucket, owner-of-rogues, and the cached timestamp. Cheap; uses the cached truth if recent.',
    {
      version: z.string().describe('Release version'),
      repo: z.string().default('webplatform'),
    },
    async ({ version, repo }) => {
      try {
        const truth = await releaseTruth.compute(repo, version);
        return text({
          version: truth.version,
          repo: truth.repo,
          rollup: truth.rollup,
          ticketCount: (truth.tickets || []).length,
          rogueCount: (truth.rogues || []).length,
          computedAt: truth.computedAt,
          durationMs: truth.durationMs,
        });
      } catch (err) { return errText(err.message); }
    }
  );

  t('get_release_impact',
    'Compute deployment impact — what changes when deploying targetVersion to environments currently running prodVersion.',
    {
      version: z.string().describe('Target release version to deploy'),
      prodVersion: z.string().describe('Current production version to compare against'),
      repo: z.string().default('webplatform'),
    },
    async ({ version, prodVersion, repo }) => {
      try {
        const impact = await releaseTruth.computeImpact(repo, version, prodVersion);
        return text({
          target: impact.target,
          prod: impact.prod,
          delta: {
            commits: impact.delta.commits.total,
            newTickets: impact.delta.tickets.total,
            rollup: impact.delta.rollup,
            rogueCount: impact.delta.rogues.length,
          },
          tickets: impact.delta.tickets.new.map(t => ({
            key: t.key,
            summary: t.summary,
            jiraStatus: t.jiraStatus,
            health: t.health,
            healthMessage: t.healthMessage,
            onBranch: t.onBranch,
          })),
          computedAt: impact.computedAt,
          durationMs: impact.durationMs,
        });
      } catch (err) { return errText(err.message); }
    }
  );

  t('list_releases',
    'List releases with optional filters. Returns version, state, repo, branch, and ticket count.',
    {
      repo: z.string().optional(),
      state: z.string().optional().describe('planning, cutting, stabilizing, approved, deploying, done'),
      active: z.boolean().default(true).describe('Only show active (non-done, non-jiraReleased) releases'),
    },
    async ({ repo, state, active }) => {
      let list = releases.list();
      if (repo) list = list.filter(r => r.repo === repo);
      if (state) list = list.filter(r => r.state === state);
      if (active) list = list.filter(r => r.state !== 'done' && !r.jiraReleased);
      return text({
        count: list.length,
        releases: list.map(r => ({
          version: r.version, repo: r.repo, state: r.state, branch: r.branch,
          tickets: releases.getTickets(r).length, jiraReleaseDate: r.jiraReleaseDate,
        })),
      });
    }
  );

  t('get_release_prs',
    'Get the pull requests merged for a release. Returns PR number, title, author, mergedAt.',
    {
      version: z.string().describe('Release version'),
      repo: z.string().default('webplatform'),
    },
    async ({ version, repo }) => {
      if (!prStore) return errText('PR data unavailable in this MCP context');
      const release = releases.get(version, repo);
      if (!release) return text(`Release ${repo}:${version} not found`);
      const tickets = releases.getTickets(release);
      const prs = [];
      for (const tk of tickets) {
        const list = prStore.getByTicket(tk.key) || [];
        for (const p of list) {
          prs.push({
            number: p.number, title: p.title, author: p.author,
            mergedAt: p.mergedAt, ticketKey: tk.key, repo: p.repo || repo,
          });
        }
      }
      return text({ version, repo, count: prs.length, prs });
    }
  );

  t('get_release_risk',
    'Risk assessment for a release — checks branch hygiene, ticket health distribution, build status, late cherry-picks. Returns score + flagged items.',
    {
      version: z.string().describe('Release version'),
      repo: z.string().default('webplatform'),
    },
    async ({ version, repo }) => {
      if (!risk) return errText('Risk engine unavailable in this MCP context');
      const release = releases.get(version, repo);
      if (!release) return text(`Release ${repo}:${version} not found`);
      try { return text(await risk.assess(release)); }
      catch (err) { return errText(err.message); }
    }
  );

  // ══════════════════════════════════════════════════════
  // FEATURE-FLAG + INTEGRATION AGGREGATIONS
  // ══════════════════════════════════════════════════════

  t('aggregate_feature_flags',
    'Aggregate DB feature flags across production environments and bucket by rollout state. Use bucket=mixed/dev-only to find outliers.',
    {
      bucket: z.enum(['all', 'everywhere-on', 'mixed', 'everywhere-off', 'dev-only']).default('all'),
      scope: z.enum(['all', 'portal', 'mobile']).default('all'),
    },
    async ({ bucket, scope }) => {
      const environments = customerStore.listEnvironments();
      const result = aggregateFeatureFlags(environments);
      let flags = result.flags;
      if (bucket !== 'all') flags = flags.filter(f => f.bucket === bucket);
      if (scope === 'portal') flags = flags.filter(f => !f.isMobileFeature);
      if (scope === 'mobile') flags = flags.filter(f => f.isMobileFeature);
      return text({
        stats: result.stats,
        customers: result.customers,
        flags: flags.map(f => ({
          key: f.key, bucket: f.bucket, isMobileFeature: f.isMobileFeature,
          customerStates: f.customerStates, outlierCount: f.outliers.length,
        })),
      });
    }
  );

  t('aggregate_integrations',
    'Aggregate DB integrations across production environments and bucket by rollout state.',
    { bucket: z.enum(['all', 'everywhere-on', 'mixed', 'everywhere-off', 'dev-only']).default('all') },
    async ({ bucket }) => {
      const environments = customerStore.listEnvironments();
      const result = aggregateIntegrations(environments);
      let items = result.integrations;
      if (bucket !== 'all') items = items.filter(i => i.bucket === bucket);
      return text({
        stats: result.stats,
        customers: result.customers,
        integrations: items.map(i => ({
          type: i.type, bucket: i.bucket,
          customerStates: i.customerStates,
          customerConfigured: i.customerConfigured,
          outlierCount: i.outliers.length,
        })),
      });
    }
  );

  // ══════════════════════════════════════════════════════
  // HEALTH OVERVIEW
  // ══════════════════════════════════════════════════════

  t('get_health_overview',
    'Cross-customer health rollup. Returns counts of healthy/degraded/unhealthy/unreachable envs, plus per-customer breakdown.',
    {},
    async () => {
      const customers = customerStore.listCustomers();
      const envs = customerStore.listEnvironments().filter(e => !e.disabled);
      const allHealth = envs.filter(e => e.health).map(e => e.health.status);
      const stats = {
        total: allHealth.length,
        healthy: allHealth.filter(s => s === 'healthy').length,
        degraded: allHealth.filter(s => s === 'degraded').length,
        unhealthy: allHealth.filter(s => s === 'unhealthy').length,
        unreachable: allHealth.filter(s => s === 'unreachable').length,
      };
      const byCustomer = customers.map(c => {
        const cEnvs = envs.filter(e => e.customerId === c.id);
        const cStats = cEnvs.reduce((acc, e) => {
          const s = e.health?.status || 'unknown';
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});
        return { id: c.id, name: c.name, envCount: cEnvs.length, ...cStats };
      });
      return text({ stats, customers: byCustomer });
    }
  );

  t('get_customer_health',
    'Per-customer health detail — every environment with current version, reachability, and last health probe.',
    { customerId: z.string().describe('Customer ID, short name, or full name') },
    async ({ customerId }) => {
      const customer = findCustomer(customerStore.listCustomers(), customerId);
      if (!customer) return text(`Customer "${customerId}" not found`);
      const envs = customerStore.listEnvironments({ customerId: customer.id })
        .filter(e => !e.disabled)
        .map(e => ({
          id: e.id, name: e.name, tier: e.tier, url: e.url,
          currentVersion: e.currentVersion, reachable: e.reachable,
          health: e.health?.status || null,
          lastChecked: e.lastChecked,
          failingComponents: e.health?.failingComponents || [],
        }));
      return text({ customer: { id: customer.id, name: customer.name }, environments: envs });
    }
  );

  // ══════════════════════════════════════════════════════
  // INCIDENTS
  // ══════════════════════════════════════════════════════

  if (incidents) {
    t('list_incidents',
      'List incidents. Defaults to open incidents — pass status=all/resolved to broaden. Filter by customerId or envId. Returns summary fields only; use get_incident for full detail.',
      {
        status: z.enum(['open', 'resolved', 'all']).default('open'),
        customerId: z.string().optional(),
        envId: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      async ({ status, customerId, envId, limit }) => {
        const filter = {};
        if (status !== 'all') filter.status = status;
        if (customerId) filter.customerId = customerId;
        if (envId) filter.envId = envId;
        const list = incidents.list(filter).slice(0, limit);
        return text({
          count: list.length,
          incidents: list.map(i => ({
            id: i.id, status: i.status, severity: i.severity,
            triggerType: i.triggerType, summary: i.summary,
            customerId: i.customerId, envId: i.envId,
            openedAt: i.openedAt, resolvedAt: i.resolvedAt,
            assigneeUserId: i.assigneeUserId,
            slackPostCount: (i.slackPosts || []).length,
          })),
        });
      }
    );

    t('get_incident',
      'Get a single incident with full record (severity, slackPosts, assignee, payload). Use list_incident_events for the timeline.',
      { incidentId: z.string() },
      async ({ incidentId }) => {
        const inc = incidents.get(incidentId);
        if (!inc) return text(`Incident ${incidentId} not found`);
        return text(inc);
      }
    );

    t('list_incident_events',
      'Get the timeline events for an incident (acknowledged, resolved, dispatch-failed, sustained, notes, etc.) in chronological order.',
      { incidentId: z.string() },
      async ({ incidentId }) => {
        const inc = incidents.get(incidentId);
        if (!inc) return text(`Incident ${incidentId} not found`);
        return text({ incidentId, events: incidents.listEvents(incidentId) });
      }
    );

    t('acknowledge_incident',
      'Acknowledge an open incident. Threads a Slack reply if Slack posts exist. Requires incident.write capability.',
      { incidentId: z.string(), note: z.string().optional() },
      async ({ incidentId, note }) => {
        try { authorizeMcpTool(reqCtx, 'incident.write'); }
        catch (err) { return errText(err.message); }
        const principal = principalLabel(reqCtx);
        const acked = incidents.acknowledge(incidentId, { actorName: principal, note: note || null });
        if (!acked) return text(`Incident ${incidentId} not found or already acknowledged`);
        return text({ ok: true, status: acked.status });
      }
    );

    t('resolve_incident',
      'Resolve an open or acknowledged incident. resolution defaults to "manual". Requires incident.write capability.',
      {
        incidentId: z.string(),
        resolution: z.enum(['manual', 'auto', 'wontfix']).default('manual'),
        note: z.string().optional(),
      },
      async ({ incidentId, resolution, note }) => {
        try { authorizeMcpTool(reqCtx, 'incident.write'); }
        catch (err) { return errText(err.message); }
        const principal = principalLabel(reqCtx);
        const resolved = incidents.resolve(incidentId, { actorName: principal, resolution, note: note || null });
        if (!resolved) return text(`Incident ${incidentId} not found`);
        return text({ ok: true, status: resolved.status, resolution: resolved.resolution });
      }
    );

    t('reopen_incident',
      'Reopen a resolved incident. Requires incident.write capability.',
      { incidentId: z.string(), note: z.string().optional() },
      async ({ incidentId, note }) => {
        try { authorizeMcpTool(reqCtx, 'incident.write'); }
        catch (err) { return errText(err.message); }
        const principal = principalLabel(reqCtx);
        const reopened = incidents.reopen(incidentId, { actorName: principal, note: note || null });
        if (!reopened) return text(`Incident ${incidentId} not found`);
        return text({ ok: true, status: reopened.status });
      }
    );

    t('add_incident_note',
      'Add a note to an incident timeline. broadcast=true (default) also threads to Slack; false keeps it internal.',
      {
        incidentId: z.string(),
        text: z.string().describe('Note body'),
        broadcast: z.boolean().default(true),
      },
      async ({ incidentId, text: noteText, broadcast }) => {
        try { authorizeMcpTool(reqCtx, 'incident.write'); }
        catch (err) { return errText(err.message); }
        const principal = principalLabel(reqCtx);
        const updated = incidents.addNote(incidentId, { text: noteText, broadcast, actorName: principal });
        if (!updated) return text(`Incident ${incidentId} not found`);
        return text({ ok: true });
      }
    );

    t('assign_incident',
      'Assign an incident to a user (by email). Requires incident.write capability.',
      {
        incidentId: z.string(),
        assigneeEmail: z.string().describe('Email of the Nectar user to assign'),
      },
      async ({ incidentId, assigneeEmail }) => {
        try { authorizeMcpTool(reqCtx, 'incident.write'); }
        catch (err) { return errText(err.message); }
        const principal = principalLabel(reqCtx);
        const user = userStore?.getUser(assigneeEmail) || null;
        const assigned = incidents.assign(incidentId, {
          assigneeUserId: assigneeEmail,
          assigneeName: user?.name || assigneeEmail,
          actorName: principal,
        });
        if (!assigned) return text(`Incident ${incidentId} not found`);
        return text({ ok: true, assigneeUserId: assigned.assigneeUserId });
      }
    );
  }

  // ══════════════════════════════════════════════════════
  // ALERT RULES
  // ══════════════════════════════════════════════════════

  if (alertRules) {
    t('list_alert_rules',
      'List configured alert rules. Filter by triggerType or enabled state.',
      {
        triggerType: z.string().optional().describe('e.g. env-unhealthy, env-recovered, deploy-failed'),
        enabled: z.boolean().optional(),
      },
      async ({ triggerType, enabled }) => {
        const filter = {};
        if (triggerType) filter.triggerType = triggerType;
        if (enabled !== undefined) filter.enabled = enabled;
        const list = alertRules.list(filter);
        return text({
          count: list.length,
          rules: list.map(r => ({
            id: r.id, name: r.name, triggerType: r.triggerType,
            channels: r.channels, severity: r.severity, enabled: r.enabled,
            lastFiredAt: r.lastFiredAt, filter: r.filter,
          })),
        });
      }
    );

    t('get_alert_rule',
      'Get full alert-rule record by id.',
      { ruleId: z.string() },
      async ({ ruleId }) => {
        const rule = alertRules.get(ruleId);
        if (!rule) return text(`Alert rule ${ruleId} not found`);
        return text(rule);
      }
    );

    if (alertRouter) {
      t('evaluate_alert_rule_now',
        'Force-evaluate an alert rule against current state (bypasses the flap-guard ratchet). Rate-limited per rule (~30s). Useful when an env is stuck unhealthy after a manual resolve.',
        { ruleId: z.string() },
        async ({ ruleId }) => {
          try {
            const result = await alertRouter.evaluateNow(ruleId);
            return text(result);
          } catch (err) { return errText(err.message); }
        }
      );
    }
  }

  // ══════════════════════════════════════════════════════
  // SUPPORT TICKETS (Zoho mirror)
  // ══════════════════════════════════════════════════════

  if (zohoStore) {
    t('search_support_tickets',
      'Search Zoho support tickets in the local mirror. Defaults to open tickets. Returns summary list.',
      {
        query: z.string().optional().describe('Free text across subject, ticketNumber, contact name'),
        status: z.enum(['open', 'closed', 'all']).default('open'),
        accountId: z.string().optional().describe('Zoho account id'),
        deptPrefix: z.string().optional().describe('Department prefix (VHC, BYD, THC, VIV)'),
        assigneeEmail: z.string().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      },
      async ({ query, status, accountId, deptPrefix, assigneeEmail, page, pageSize }) => {
        const opts = { limit: pageSize, offset: (page - 1) * pageSize };
        if (query) opts.search = query;
        if (status === 'open') opts.openOnly = true;
        if (status === 'closed') opts.closedOnly = true;
        if (accountId) opts.accountId = accountId;
        if (deptPrefix) opts.deptPrefix = deptPrefix;
        if (assigneeEmail) opts.assigneeEmail = assigneeEmail;
        const total = zohoStore.countTickets(opts);
        const list = zohoStore.listTickets(opts);
        return text({
          page, pageSize, total, hasMore: page * pageSize < total,
          tickets: list.map(t => ({
            id: t.id, ticketNumber: t.ticketNumber, subject: t.subject,
            status: t.status, statusType: t.statusType, priority: t.priority,
            accountId: t.accountId, assigneeEmail: t.assigneeEmail,
            createdAt: t.createdAt, modifiedAt: t.modifiedAt,
            webUrl: t.webUrl,
          })),
        });
      }
    );

    t('get_support_ticket',
      'Get a single support ticket by Zoho ticket number (e.g. "VHC-12345").',
      { ticketNumber: z.string() },
      async ({ ticketNumber }) => {
        const t = zohoStore.getTicketByNumber(ticketNumber);
        if (!t) return text(`Support ticket ${ticketNumber} not found`);
        return text(t);
      }
    );

    t('list_support_departments',
      'List Zoho departments (deptPrefix → counts). Use the prefix as a filter for search_support_tickets.',
      {},
      async () => text({ departments: zohoStore.listDeptPrefixes() })
    );
  }

  // ══════════════════════════════════════════════════════
  // JIRA TICKETS
  // ══════════════════════════════════════════════════════

  if (ticketStore) {
    t('search_jira_tickets',
      'Search JIRA tickets in the local mirror. Returns summary fields with pagination. Combine `query` (text search) with structured filters. statusGroup is the easiest way to narrow to a lifecycle stage (e.g. "in-qa", "in-dev", "not-done").',
      {
        query: z.string().optional().describe('Free text across key/summary/assignee'),
        assignee: z.string().optional().describe('Match assignee or qaAssignee (display name)'),
        statusGroup: z.string().optional().describe('Lifecycle bucket — e.g. "in-qa", "in-dev", "not-done", "done"'),
        statusCategory: z.string().optional().describe('"To Do", "In Progress", or "Done"'),
        module: z.string().optional(),
        component: z.string().optional(),
        project: z.string().optional(),
        product: z.string().optional(),
        customer: z.string().optional().describe('Customer tag (e.g. "bayada")'),
        type: z.string().optional().describe('Issue type (Bug, Story, Task, etc.)'),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(25),
      },
      async ({ query, assignee, statusGroup, statusCategory, module, component, project, product, customer, type, page, pageSize }) => {
        const limit = pageSize;
        const offset = (page - 1) * pageSize;

        // Two backends. Use search() when there's a free-text query
        // (it scans key/summary/assignee). Use getByFilter() otherwise
        // for structured filters. Both return { tickets, total, hasMore }.
        let result;
        if (query) {
          result = ticketStore.search(query, { limit, offset });
        } else {
          const opts = { limit, offset };
          if (assignee) opts.person = assignee;
          if (statusGroup) opts.statusGroup = statusGroup;
          if (statusCategory) opts.statusCategory = statusCategory;
          if (module) opts.module = module;
          if (component) opts.component = component;
          if (project) opts.project = project;
          if (product) opts.product = product;
          if (customer) opts.customer = customer;
          if (type) opts.type = type;
          result = ticketStore.getByFilter(opts);
        }

        const tickets = (result?.tickets || []).map(t => ({
          key: t.key, summary: t.summary, status: t.status,
          statusCategory: t.statusCategory,
          assignee: t.assignee, qaAssignee: t.qaAssignee,
          fixVersions: t.fixVersions, targetFixVersions: t.targetFixVersions,
          module: t.module, component: t.component,
          projects: t.projects, product: t.product, customerTags: t.customerTags,
          type: t.type, priority: t.priority,
          created: t.created, updated: t.updated,
        }));

        return text({
          page, pageSize,
          total: result?.total ?? tickets.length,
          hasMore: !!result?.hasMore,
          count: tickets.length,
          tickets,
        });
      }
    );

    t('get_jira_ticket',
      'Get a single JIRA ticket by key.',
      { key: z.string().describe('Ticket key (e.g. DEV-12345)') },
      async ({ key }) => {
        const tk = ticketStore.get(key);
        if (!tk) return text(`Ticket ${key} not found`);
        return text(tk);
      }
    );

    t('list_releases_for_ticket',
      'Find all releases that include a JIRA ticket (across repos and platforms).',
      { key: z.string().describe('Ticket key (e.g. DEV-12345)') },
      async ({ key }) => {
        const all = releases.list();
        const matches = all.filter(r => releases.getTickets(r).some(t => t.key === key));
        return text({
          key,
          count: matches.length,
          releases: matches.map(r => ({
            version: r.version, repo: r.repo, state: r.state,
            jiraReleaseDate: r.jiraReleaseDate,
          })),
        });
      }
    );

    t('get_jira_ticket_truth',
      'Per-ticket truth — is the ticket actually merged where it claims to be? Returns one row per (repo, version) the ticket is targeted at, with jiraStatus, branchStatus, PR info, healthCategory (done/inQa/awaitingCp/inDev/attention/rogue), and healthMessage. Reads cached truth — no live JIRA call.',
      { key: z.string().describe('Ticket key (e.g. DEV-12345)') },
      async ({ key }) => {
        if (typeof ticketStore.getTruthForTicket !== 'function') {
          return errText('Ticket truth not available in this MCP context');
        }
        const ticket = ticketStore.get(key);
        if (!ticket) return text(`Ticket ${key} not found`);
        const rows = ticketStore.getTruthForTicket(key);
        return text({
          key,
          jiraStatus: ticket.status,
          summary: ticket.summary,
          fixVersions: ticket.fixVersions || [],
          targetFixVersions: ticket.targetFixVersions || [],
          truthCount: rows.length,
          truth: rows,
        });
      }
    );

    t('get_release_truth_rollup',
      'Counts-by-health-category for every ticket in a release. Reads CACHED truth — no JIRA/Git/GitHub calls — so it returns instantly (unlike get_release_truth which is expensive).',
      {
        version: z.string().describe('Release version'),
        repo: z.string().default('webplatform'),
      },
      async ({ version, repo }) => {
        if (typeof ticketStore.getTruthRollup !== 'function') {
          return errText('Truth rollup not available in this MCP context');
        }
        return text({
          repo, version,
          rollup: ticketStore.getTruthRollup(repo, version),
        });
      }
    );
  }

  // ══════════════════════════════════════════════════════
  // PEOPLE / DIRECTORY
  // ══════════════════════════════════════════════════════

  if (userStore) {
    t('list_people',
      'List Nectar users (Viv-internal directory). Returns email, name, team, jiraName.',
      {},
      async () => {
        const users = userStore.listUsers ? userStore.listUsers() : [];
        return text({
          count: users.length,
          users: users.map(u => ({
            email: u.email, name: u.name, teamId: u.teamId, jiraName: u.jiraName,
          })),
        });
      }
    );
  }

  // ══════════════════════════════════════════════════════
  // DEPLOYMENTS
  // ══════════════════════════════════════════════════════

  t('list_deployments',
    'List recent deployments. Filter by customer or environment. Returns version, branch, detected/ended timestamps.',
    {
      customerId: z.string().optional(),
      envId: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ customerId, envId, limit }) => {
      const filter = { limit };
      if (customerId) filter.customerId = customerId;
      if (envId) filter.environmentId = envId;
      const list = (customerStore.listDeployments ? customerStore.listDeployments(filter) : []).slice(0, limit);
      return text({ count: list.length, deployments: list });
    }
  );

  // ══════════════════════════════════════════════════════
  // TASKS (Hive ↔ Nectar)
  // ══════════════════════════════════════════════════════

  if (taskQueue) {
    t('get_pending_tasks',
      'Get pending tasks from the Nectar task queue. Hive NectarPM polls this to discover work.',
      { type: z.string().optional().describe('Filter by task type (release-notes, release-presentation)') },
      async ({ type }) => {
        const tasks = taskQueue.getPending(type || undefined);
        return text({ count: tasks.length, tasks });
      }
    );

    t('claim_task',
      'Claim a pending task — marks it as in-progress so no other worker picks it up. Requires task.write capability.',
      { taskId: z.string() },
      async ({ taskId }) => {
        try {
          authorizeMcpTool(reqCtx, 'task.write');
          return text(taskQueue.claim(taskId));
        } catch (err) { return errText(err.message); }
      }
    );

    t('complete_task',
      'Complete a task — deposit results (gammaUrl, notes, perTicketSummaries). Triggers completion callback. Requires task.write capability.',
      {
        taskId: z.string(),
        gammaUrl: z.string().optional(),
        notes: z.string().optional(),
        perTicketSummaries: z.record(z.string(), z.string()).optional(),
      },
      async ({ taskId, gammaUrl, notes, perTicketSummaries }) => {
        try {
          authorizeMcpTool(reqCtx, 'task.write');
          const output = {};
          if (gammaUrl) output.gammaUrl = gammaUrl;
          if (notes) output.notes = notes;
          if (perTicketSummaries) output.perTicketSummaries = perTicketSummaries;

          const taskSnap = taskQueue.getTask(taskId);
          if (notes && taskSnap?.input?.version) {
            const s3 = getArtifactsS3();
            if (s3) {
              try {
                const { PutObjectCommand } = require('@aws-sdk/client-s3');
                const key = `releases/${taskSnap.input.version}/release-notes-draft.md`;
                await s3.client.send(new PutObjectCommand({
                  Bucket: s3.bucket, Key: key, Body: notes, ContentType: 'text/markdown',
                }));
                output.artifacts = [{ type: 'draft', filename: 'release-notes-draft.md' }];
              } catch (s3Err) {
                log.warn(`Failed to upload draft to S3 (non-fatal): ${s3Err.message}`);
              }
            }
          }
          const task = taskQueue.complete(taskId, output);
          if (task.input && task.input.version) {
            const release = releases.get(task.input.version);
            if (release) {
              const updates = {};
              if (output.gammaUrl) updates.presentationUrl = output.gammaUrl;
              if (output.notes) updates.notes = output.notes;
              if (Object.keys(updates).length > 0) {
                releases.update(task.input.version, updates, 'task-queue');
              }
            }
          }
          return text(task);
        } catch (err) { return errText(err.message); }
      }
    );
  }

  // ══════════════════════════════════════════════════════
  // CAPABILITY HELPERS
  // ══════════════════════════════════════════════════════

  t('check_capability',
    'Check whether the authenticated principal holds a given capability. Use this before attempting an action to avoid wasted turns on 403 errors.',
    { capability: z.string().describe('Capability ID (e.g. "release.write", "task.write", "incident.write")') },
    async ({ capability }) => {
      if (!isValidCapability(capability)) {
        return text({ allowed: false, capability, error: 'Unknown capability' });
      }
      try {
        authorizeMcpTool(reqCtx, capability);
        return text({ allowed: true, capability });
      } catch {
        return text({ allowed: false, capability });
      }
    }
  );

  return count;
}

/**
 * Best-effort label for who's calling — used as actorName when we
 * write incident events. Falls back to a generic 'mcp' so the row
 * is never null.
 */
function principalLabel(reqCtx) {
  if (reqCtx?.user?.email) return reqCtx.user.email;
  if (reqCtx?.apiKey?.label) return `apikey:${reqCtx.apiKey.label}`;
  if (reqCtx?.apiKey?.keyId) return `apikey:${reqCtx.apiKey.keyId}`;
  return 'mcp';
}

module.exports = { registerTools, findCustomer };
