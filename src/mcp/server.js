const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const log = require('../core/log');

/**
 * Nectar MCP Server — exposes customer, environment, release, and truth
 * data as MCP tools that Hive's Claude sessions can call.
 *
 * Mounted on the existing Express app at /mcp.
 */
function createNectarMcpServer({ customerStore, releases, releaseTruth }) {
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
      const customers = customerStore.getCustomers();
      const customer = customers.find(c => c.id === customerId);
      if (!customer) {
        return { content: [{ type: 'text', text: `Customer "${customerId}" not found. Available: ${customers.map(c => c.id).join(', ')}` }] };
      }
      const envs = customerStore.getEnvironments().filter(e => e.customerId === customerId);
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
    'Get full environment state including version, features, integrations, and upgrades',
    { envId: z.string().describe('Environment ID (e.g., "ck-615", "bayada-production", "ck-staging")') },
    async ({ envId }) => {
      const envs = customerStore.getEnvironments();
      const env = envs.find(e => e.id === envId);
      if (!env) {
        return { content: [{ type: 'text', text: `Environment "${envId}" not found` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(env, null, 2) }] };
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
      let envs = customerStore.getEnvironments();
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

  log.info('MCP server initialized with 6 tools');
  return server;
}

/**
 * Mount the MCP server on an Express app at the given path.
 */
async function mountMcp(app, path, deps) {
  const server = createNectarMcpServer(deps);

  // Stateless Streamable HTTP — each request gets its own transport
  app.post(path, async (req, res) => {
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
