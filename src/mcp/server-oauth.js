/**
 * Parallel MCP server protected by OAuth 2.1 bearer tokens.
 *
 * This file deliberately duplicates the tool registration logic from
 * src/mcp/server.js so the production stdio/api-key MCP at /mcp is
 * untouched by this PR. The intent is to DRY both servers later once
 * the OAuth path is proven in production — see PR description.
 *
 * Differences from src/mcp/server.js:
 *   - Authentication: OAuth bearer (mcp_oauth_tokens) instead of api_keys.
 *   - Principal: req.user.email (resolved from token) instead of req.apiKey.
 *     authz.extractPrincipal already handles both shapes natively.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const log = require('../core/log');
const { aggregateFeatureFlags, aggregateIntegrations } = require('../core/feature-aggregator');
const { getArtifactsS3 } = require('../core/s3-artifacts');
const { authorizeMcpTool } = require('../core/authz');
const { isValidCapability } = require('../core/capabilities');
const { findCustomer } = require('./server');

function createNectarOAuthMcpServer({ customerStore, releases, releaseTruth, taskQueue }) {
  // Icon URL that Claude Desktop and other MCP clients display next to
  // the connector name (MCP spec 2025-06-18 Implementation.icons). The
  // asset is served by the OAuth router at /mcp-oauth/icon.svg.
  const baseUrl = (process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com').replace(/\/$/, '');
  const iconSrc = `${baseUrl}/mcp-oauth/icon.svg`;
  const server = new McpServer({
    name: 'nectar-oauth',
    title: 'Nectar',
    version: '1.0.0',
    description: 'Nectar release-intelligence MCP — customer/env/release data and incident tools.',
    websiteUrl: baseUrl,
    icons: [
      { src: iconSrc, mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  });

  // Per-request principal context. Uses AsyncLocalStorage so concurrent
  // MCP requests each see their own user (no shared-closure race).
  const { AsyncLocalStorage } = require('async_hooks');
  const mcpAuthStore = new AsyncLocalStorage();

  // Proxy that the authz engine sees as a "request" — exposes
  // req.user.email so extractPrincipal returns { type: 'user', email }.
  const reqCtx = {
    get user() {
      const store = mcpAuthStore.getStore();
      return store?.userEmail ? { email: store.userEmail } : undefined;
    },
  };

  // ── Tool: get_customer ──────────────────────────────────
  server.tool(
    'get_customer',
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
        return { content: [{ type: 'text', text: `Customer "${customerId}" not found. Available: ${available}` }] };
      }
      const envs = customerStore.listEnvironments().filter(e => e.customerId === customer.id);
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
      if (!env) return { content: [{ type: 'text', text: `Environment "${envId}" not found` }] };
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
      customer: z.string().optional().describe('Filter by customer ID, short name, or full name (case-insensitive)'),
      version: z.string().optional().describe('Filter by current deployed version'),
      tier: z.string().optional().describe('Filter by tier (production, staging, uat, etc.)'),
      query: z.string().optional().describe('Free text search across env ID and name'),
    },
    async ({ customer, version, tier, query }) => {
      let envs = customerStore.listEnvironments();
      if (customer) {
        const allCustomers = customerStore.listCustomers();
        const resolved = findCustomer(allCustomers, customer);
        if (!resolved) {
          return { content: [{ type: 'text', text: `Customer "${customer}" not found. Available: ${allCustomers.map(c => c.id).join(', ')}` }] };
        }
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
            ticketCount: releases.getTickets(release).length,
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
    'Compute deployment impact — what changes when deploying targetVersion to environments currently running prodVersion.',
    {
      version: z.string().describe('Target release version to deploy'),
      prodVersion: z.string().describe('Current production version to compare against'),
      repo: z.string().default('webplatform').describe('Repository name'),
    },
    async ({ version, prodVersion, repo }) => {
      try {
        const impact = await releaseTruth.computeImpact(repo, version, prodVersion);
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
        tickets: releases.getTickets(r).length,
        jiraReleaseDate: r.jiraReleaseDate,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ count: summary.length, releases: summary }, null, 2) }] };
    }
  );

  // ── Tool: aggregate_feature_flags ──────────────────────
  server.tool(
    'aggregate_feature_flags',
    'Aggregate all DB feature flags across production environments and bucket them by rollout state.',
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
    'Aggregate DB integrations across production environments and bucket them by rollout state.',
    {
      bucket: z.enum(['all', 'everywhere-on', 'mixed', 'everywhere-off', 'dev-only']).default('all'),
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

  // ── Tool: get_pending_tasks / claim_task / complete_task ──
  if (taskQueue) {
    server.tool(
      'get_pending_tasks',
      'Get pending tasks from the Nectar task queue.',
      { type: z.string().optional().describe('Filter by task type') },
      async ({ type }) => {
        const tasks = taskQueue.getPending(type || undefined);
        return { content: [{ type: 'text', text: JSON.stringify({ count: tasks.length, tasks }, null, 2) }] };
      }
    );

    server.tool(
      'claim_task',
      'Claim a pending task — marks it as in-progress. Requires task.write capability.',
      { taskId: z.string().describe('Task ID to claim') },
      async ({ taskId }) => {
        try {
          authorizeMcpTool(reqCtx, 'task.write');
          const task = taskQueue.claim(taskId);
          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
        }
      }
    );

    server.tool(
      'complete_task',
      'Complete a task — deposit results. Requires task.write capability.',
      {
        taskId: z.string().describe('Task ID to complete'),
        gammaUrl: z.string().optional().describe('URL to the generated Gamma presentation'),
        notes: z.string().optional().describe('Generated release notes markdown'),
        perTicketSummaries: z.record(z.string(), z.string()).optional().describe('Per-ticket summaries keyed by JIRA key'),
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
          return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
        }
      }
    );
  }

  // ── Tool: check_capability ──────────────────────────────
  server.tool(
    'check_capability',
    'Check whether the authenticated user holds a given capability. Use this before attempting an action to avoid wasted turns on 403 errors.',
    { capability: z.string().describe('Capability ID (e.g. "release.write", "task.write")') },
    async ({ capability }) => {
      if (!isValidCapability(capability)) {
        return { content: [{ type: 'text', text: JSON.stringify({ allowed: false, capability, error: 'Unknown capability' }, null, 2) }] };
      }
      try {
        authorizeMcpTool(reqCtx, capability);
        return { content: [{ type: 'text', text: JSON.stringify({ allowed: true, capability }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ allowed: false, capability }, null, 2) }] };
      }
    }
  );

  // ── Tool: whoami ────────────────────────────────────────
  // OAuth-specific helper: tells the calling MCP client which user is
  // authenticated and what capabilities they hold. Useful for debugging
  // a stuck connector ("am I really logged in?").
  server.tool(
    'whoami',
    'Return the authenticated user (email, name, capabilities) for the current OAuth session.',
    {},
    async () => {
      const store = mcpAuthStore.getStore();
      const email = store?.userEmail || null;
      if (!email) return { content: [{ type: 'text', text: JSON.stringify({ authenticated: false }, null, 2) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ authenticated: true, email, clientId: store.clientId, scope: store.scope }, null, 2) }] };
    }
  );

  log.info(`MCP OAuth server initialized (${taskQueue ? 17 : 14} tools)`);
  return { server, mcpAuthStore };
}

/**
 * Mount the OAuth-protected MCP server on an Express app.
 *
 * Wraps the standard Streamable HTTP transport with a Bearer-token
 * middleware that resolves access tokens via McpOAuthStore.
 */
async function mountMcpOAuth(app, path, deps) {
  const { server, mcpAuthStore } = createNectarOAuthMcpServer(deps);
  const { oauthStore } = deps;
  if (!oauthStore) throw new Error('mountMcpOAuth: oauthStore is required');

  const baseUrl = (process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com').replace(/\/$/, '');
  const challenge = `Bearer realm="nectar-mcp", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp-oauth"`;

  const oauthAuth = (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.set('WWW-Authenticate', challenge);
      return res.status(401).json({ error: 'invalid_token', error_description: 'Bearer token required' });
    }
    const token = auth.slice(7).trim();
    const principal = oauthStore.resolveAccessToken(token);
    if (!principal) {
      res.set('WWW-Authenticate', challenge);
      return res.status(401).json({ error: 'invalid_token', error_description: 'Token expired or revoked' });
    }
    req.user = { email: principal.userEmail };
    req.mcpOAuth = principal;
    req.authenticated = true;
    next();
  };

  app.post(path, oauthAuth, async (req, res) => {
    mcpAuthStore.run({
      userEmail: req.user.email,
      clientId: req.mcpOAuth.clientId,
      scope: req.mcpOAuth.scope,
    }, async () => {
      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error('MCP OAuth request error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'MCP error' });
      }
    });
  });

  app.get(path, oauthAuth, (req, res) => {
    res.status(405).json({ error: 'Use POST for MCP requests (stateless mode)' });
  });
  app.delete(path, oauthAuth, (req, res) => {
    res.status(405).json({ error: 'Session management not supported (stateless mode)' });
  });

  log.info(`MCP OAuth server mounted at ${path}`);
}

module.exports = { mountMcpOAuth, createNectarOAuthMcpServer };
