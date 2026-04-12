const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const log = require('../core/log');
const { aggregateFeatureFlags, aggregateIntegrations } = require('../core/feature-aggregator');

/**
 * Nectar MCP Server — exposes customer, environment, release, and truth
 * data as MCP tools that Hive's Claude sessions can call.
 *
 * Mounted on the existing Express app at /mcp.
 */
function createNectarMcpServer({ customerStore, releases, releaseTruth, taskQueue }) {
  const server = new McpServer({
    name: 'nectar',
    version: '1.0.0',
  });

  // ── Tool: get_customer ──────────────────────────────────
  server.tool(
    'get_customer',
    'Get customer metadata and environment summary',
    { customerId: z.string().describe('Customer ID (e.g., "ck", "bayada", "tribute")') },
    async ({ customerId }) => {
      const customers = customerStore.listCustomers();
      const customer = customers.find(c => c.id === customerId);
      if (!customer) {
        return { content: [{ type: 'text', text: `Customer "${customerId}" not found. Available: ${customers.map(c => c.id).join(', ')}` }] };
      }
      const envs = customerStore.listEnvironments().filter(e => e.customerId === customerId);
      const prodEnvs = envs.filter(e => e.tier === 'production');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...customer,
            environmentCount: envs.length,
            productionCount: prodEnvs.length,
            productionVersion: prodEnvs[0]?.currentVersion || null,
          }, null, 2),
        }],
      };
    }
  );

  // ── Tool: get_environment ───────────────────────────────
  server.tool(
    'get_environment',
    'Get environment overview — version, tier, reachability, and config metadata. Does NOT include features/integrations/upgrades (use dedicated tools for those).',
    { envId: z.string().describe('Environment ID (e.g., "ck-615", "bayada-production", "ck-staging")') },
    async ({ envId }) => {
      const envs = customerStore.listEnvironments();
      const env = envs.find(e => e.id === envId);
      if (!env) {
        return { content: [{ type: 'text', text: `Environment "${envId}" not found` }] };
      }
      // Return overview without the large nested objects
      const { features, integrations, upgrades, ...overview } = env;
      overview.hasFeatures = !!features;
      overview.hasIntegrations = !!integrations;
      overview.upgradeCount = upgrades?.items?.length || 0;
      return { content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }] };
    }
  );

  // ── Tool: get_environment_features ──────────────────────
  server.tool(
    'get_environment_features',
    'Get feature flags for an environment — both DB runtime flags and static config flags',
    { envId: z.string().describe('Environment ID') },
    async ({ envId }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return { content: [{ type: 'text', text: `Environment "${envId}" not found` }] };
      if (!env.features) return { content: [{ type: 'text', text: `No feature data available for "${envId}" — endpoint may not be deployed yet` }] };
      return { content: [{ type: 'text', text: JSON.stringify(env.features, null, 2) }] };
    }
  );

  // ── Tool: get_environment_integrations ──────────────────
  server.tool(
    'get_environment_integrations',
    'Get integration states for an environment — DB integrations (QuickBooks, Salesforce, etc.) and config integrations (Ascend, SQS, etc.)',
    { envId: z.string().describe('Environment ID') },
    async ({ envId }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return { content: [{ type: 'text', text: `Environment "${envId}" not found` }] };
      if (!env.integrations) return { content: [{ type: 'text', text: `No integration data available for "${envId}"` }] };
      return { content: [{ type: 'text', text: JSON.stringify(env.integrations, null, 2) }] };
    }
  );

  // ── Tool: get_environment_upgrades ──────────────────────
  server.tool(
    'get_environment_upgrades',
    'Get upgrade status for an environment. Returns summary counts and optionally the full list. Use summary=true for an overview, or filter by status.',
    {
      envId: z.string().describe('Environment ID'),
      status: z.enum(['pending', 'applied', 'inProgress', 'failed', 'skipped', 'all']).default('all').describe('Filter upgrades by status'),
      summary: z.boolean().default(true).describe('Return only counts (true) or full item list (false)'),
    },
    async ({ envId, status, summary }) => {
      const env = customerStore.listEnvironments().find(e => e.id === envId);
      if (!env) return { content: [{ type: 'text', text: `Environment "${envId}" not found` }] };
      if (!env.upgrades) return { content: [{ type: 'text', text: `No upgrade data available for "${envId}"` }] };

      const items = env.upgrades.items || [];
      // Bucket the items
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

      if (summary) {
        return { content: [{ type: 'text', text: JSON.stringify({ totalInPool: items.length, ...buckets }, null, 2) }] };
      }

      const filtered = status === 'all' ? items : (bucketedItems[status] || []);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            totalInPool: items.length,
            counts: buckets,
            items: filtered.map(i => ({
              upgradeName: i.upgradeName,
              desiredEnvs: i.desiredEnvs,
              status: i.history?.completedAt ? 'applied' : i.history?.inProgress ? 'inProgress' : i.history?.skipped ? 'skipped' : 'pending',
              completedAt: i.history?.completedAt || null,
              verificationStatus: i.history?.verificationStatus || null,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ── Tool: search_environments ───────────────────────────
  server.tool(
    'search_environments',
    'Search environments by customer, version, tier, or name. Returns a summary list.',
    {
      customer: z.string().optional().describe('Filter by customer ID'),
      version: z.string().optional().describe('Filter by current deployed version'),
      tier: z.string().optional().describe('Filter by tier (production, staging, uat, etc.)'),
      query: z.string().optional().describe('Free text search across env ID and name'),
    },
    async ({ customer, version, tier, query }) => {
      let envs = customerStore.listEnvironments();
      if (customer) envs = envs.filter(e => e.customerId === customer);
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
      return { content: [{ type: 'text', text: JSON.stringify({ count: summary.length, environments: summary }, null, 2) }] };
    }
  );

  // ── Tool: get_release ───────────────────────────────────
  server.tool(
    'get_release',
    'Get release metadata including state, branch, JIRA info, and ticket count',
    {
      version: z.string().describe('Release version (e.g., "4.1.2", "4.2.2-lumen")'),
      repo: z.string().default('webplatform').describe('Repository name'),
    },
    async ({ version, repo }) => {
      const release = releases.get(version, repo);
      if (!release) {
        return { content: [{ type: 'text', text: `Release ${repo}:${version} not found` }] };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            version: release.version,
            repo: release.repo,
            state: release.state,
            branch: release.branch,
            jiraVersionName: release.jiraVersionName,
            jiraReleased: release.jiraReleased,
            jiraReleaseDate: release.jiraReleaseDate,
            ticketCount: (release.tickets || []).length,
            cherryPickCount: (release.cherryPicks || []).length,
          }, null, 2),
        }],
      };
    }
  );

  // ── Tool: get_release_truth ─────────────────────────────
  server.tool(
    'get_release_truth',
    'Compute the full release truth — per-ticket health verification against JIRA + Git + GitHub. This is an expensive operation that queries JIRA live.',
    {
      version: z.string().describe('Release version'),
      repo: z.string().default('webplatform').describe('Repository name'),
    },
    async ({ version, repo }) => {
      try {
        const truth = await releaseTruth.compute(repo, version);
        return { content: [{ type: 'text', text: JSON.stringify(truth, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── Tool: get_release_impact ────────────────────────────
  server.tool(
    'get_release_impact',
    'Compute deployment impact — what changes when deploying targetVersion to environments currently running prodVersion. Shows new tickets, commit delta, and health rollup.',
    {
      version: z.string().describe('Target release version to deploy'),
      prodVersion: z.string().describe('Current production version to compare against'),
      repo: z.string().default('webplatform').describe('Repository name'),
    },
    async ({ version, prodVersion, repo }) => {
      try {
        const impact = await releaseTruth.computeImpact(repo, version, prodVersion);
        // Return a summary — full truth is too large for most tool calls
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              target: impact.target,
              prod: impact.prod,
              delta: {
                commits: impact.delta.commits.total,
                newTickets: impact.delta.tickets.total,
                rollup: impact.delta.rollup,
                rogueCount: impact.delta.rogues.length,
              },
              // Include the new tickets with their health
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
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ── Tool: list_releases ─────────────────────────────────
  server.tool(
    'list_releases',
    'List releases with optional filters. Returns version, state, repo, branch, and ticket count.',
    {
      repo: z.string().optional().describe('Filter by repository'),
      state: z.string().optional().describe('Filter by state (planning, cutting, stabilizing, approved, deploying, done)'),
      active: z.boolean().default(true).describe('Only show active (non-done) releases'),
    },
    async ({ repo, state, active }) => {
      let list = releases.list();
      if (repo) list = list.filter(r => r.repo === repo);
      if (state) list = list.filter(r => r.state === state);
      if (active) list = list.filter(r => r.state !== 'done' && !r.jiraReleased);
      const summary = list.map(r => ({
        version: r.version,
        repo: r.repo,
        state: r.state,
        branch: r.branch,
        tickets: (r.tickets || []).length,
        jiraReleaseDate: r.jiraReleaseDate,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ count: summary.length, releases: summary }, null, 2) }] };
    }
  );

  // ── Tool: aggregate_feature_flags ──────────────────────
  server.tool(
    'aggregate_feature_flags',
    'Aggregate all DB feature flags across production environments and bucket them by rollout state. Use this to find flags that are enabled everywhere (candidates for removal) or nowhere (unused).',
    {
      bucket: z.enum(['all', 'everywhere-on', 'mixed', 'everywhere-off', 'dev-only']).default('all').describe('Filter to a specific bucket'),
      scope: z.enum(['all', 'portal', 'mobile']).default('all').describe('Filter by scope'),
    },
    async ({ bucket, scope }) => {
      const environments = customerStore.listEnvironments();
      const result = aggregateFeatureFlags(environments);
      let flags = result.flags;
      if (bucket !== 'all') flags = flags.filter(f => f.bucket === bucket);
      if (scope === 'portal') flags = flags.filter(f => !f.isMobileFeature);
      if (scope === 'mobile') flags = flags.filter(f => f.isMobileFeature);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stats: result.stats,
            customers: result.customers,
            flags: flags.map(f => ({
              key: f.key,
              bucket: f.bucket,
              isMobileFeature: f.isMobileFeature,
              customerStates: f.customerStates,
              outlierCount: f.outliers.length,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ── Tool: aggregate_integrations ───────────────────────
  server.tool(
    'aggregate_integrations',
    'Aggregate DB integrations (QuickBooks, Salesforce, DocuSign, etc.) across production environments and bucket them by rollout state. Shows which customers have each integration enabled and configured.',
    {
      bucket: z.enum(['all', 'everywhere-on', 'mixed', 'everywhere-off', 'dev-only']).default('all').describe('Filter to a specific bucket'),
    },
    async ({ bucket }) => {
      const environments = customerStore.listEnvironments();
      const result = aggregateIntegrations(environments);
      let items = result.integrations;
      if (bucket !== 'all') items = items.filter(i => i.bucket === bucket);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stats: result.stats,
            customers: result.customers,
            integrations: items.map(i => ({
              type: i.type,
              bucket: i.bucket,
              customerStates: i.customerStates,
              customerConfigured: i.customerConfigured,
              outlierCount: i.outliers.length,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ── Tool: get_pending_tasks ─────────────────────────────
  if (taskQueue) {
    server.tool(
      'get_pending_tasks',
      'Get pending tasks from the Nectar task queue. Hive NectarPM polls this to discover work.',
      {
        type: z.string().optional().describe('Filter by task type (release-notes, release-presentation)'),
      },
      async ({ type }) => {
        const tasks = taskQueue.getPending(type || undefined);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: tasks.length, tasks }, null, 2),
          }],
        };
      }
    );

    // ── Tool: claim_task ──────────────────────────────────
    server.tool(
      'claim_task',
      'Claim a pending task — marks it as in-progress so no other worker picks it up.',
      {
        taskId: z.string().describe('Task ID to claim'),
      },
      async ({ taskId }) => {
        try {
          const task = taskQueue.claim(taskId);
          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
        }
      }
    );

    // ── Tool: complete_task ───────────────────────────────
    server.tool(
      'complete_task',
      'Complete a task — deposit results (gammaUrl, notes, perTicketSummaries). Triggers completion callback (stores on release, notifies via Slack).',
      {
        taskId: z.string().describe('Task ID to complete'),
        gammaUrl: z.string().optional().describe('URL to the generated Gamma presentation'),
        notes: z.string().optional().describe('Generated release notes markdown'),
        perTicketSummaries: z.record(z.string(), z.string()).optional().describe('Per-ticket summaries keyed by JIRA key'),
      },
      async ({ taskId, gammaUrl, notes, perTicketSummaries }) => {
        try {
          const output = {};
          if (gammaUrl) output.gammaUrl = gammaUrl;
          if (notes) output.notes = notes;
          if (perTicketSummaries) output.perTicketSummaries = perTicketSummaries;

          const task = taskQueue.complete(taskId, output);

          // Store output on release if applicable
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

          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
        }
      }
    );
  }

  const toolCount = taskQueue ? 15 : 12;
  log.info(`MCP server initialized with ${toolCount} tools`);
  return server;
}

/**
 * Mount the MCP server on an Express app at the given path.
 */
async function mountMcp(app, path, deps) {
  const server = createNectarMcpServer(deps);
  const { apiKeys } = deps;

  // MCP auth check — validates API key or WEB_TOKEN in the Authorization header.
  // When SSO is disabled and no WEB_TOKEN is set, MCP is open (dev mode).
  const mcpAuth = (req, res, next) => {
    const ssoEnabled = process.env.ENABLE_GOOGLE_SSO === 'true';
    const webToken = process.env.WEB_TOKEN;

    // If already authenticated upstream (e.g., by auth middleware)
    if (req.authenticated) return next();

    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      // Check API key
      if (apiKeys && token.startsWith('nectar_')) {
        const result = apiKeys.validate(token);
        if (result.valid) {
          req.apiKey = { keyId: result.keyId, label: result.label };
          req.authenticated = true;
          return next();
        }
      }

      // Check WEB_TOKEN
      if (webToken && token === webToken) {
        req.authenticated = true;
        return next();
      }
    }

    // Dev mode: no auth required when SSO is off and no WEB_TOKEN
    if (!ssoEnabled && !webToken) {
      return next();
    }

    // Auth required but not provided
    res.status(401).json({ error: 'MCP authentication required' });
  };

  // Stateless Streamable HTTP — each request gets its own transport
  app.post(path, mcpAuth, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on('close', () => { transport.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('MCP request error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP error' });
      }
    }
  });

  // GET + DELETE for SSE/session management (required by spec but we're stateless)
  app.get(path, (req, res) => {
    res.status(405).json({ error: 'Use POST for MCP requests (stateless mode)' });
  });
  app.delete(path, (req, res) => {
    res.status(405).json({ error: 'Session management not supported (stateless mode)' });
  });

  log.info(`MCP server mounted at ${path}`);
}

module.exports = { mountMcp };
