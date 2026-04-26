const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const log = require('../core/log');
const { registerTools, findCustomer } = require('./tools');

/**
 * Nectar MCP Server — exposes customer, environment, release, incident,
 * support, and truth data as MCP tools that Hive's Claude sessions can call.
 *
 * Mounted on the existing Express app at /mcp.
 *
 * Tool definitions live in src/mcp/tools.js so the OAuth-protected
 * /mcp-oauth endpoint shares the exact same surface.
 */
function createNectarMcpServer(deps) {
  const server = new McpServer({
    name: 'nectar',
    version: '1.0.0',
  });

  // Per-request auth context. Uses AsyncLocalStorage so concurrent MCP
  // requests each see their own principal (no shared-closure race).
  const { AsyncLocalStorage } = require('async_hooks');
  const mcpAuthStore = new AsyncLocalStorage();

  // Tools read this proxy. Both `apiKey` (this endpoint) and `user.email`
  // (the OAuth endpoint) are exposed via getters — `extractPrincipal`
  // picks whichever is set on the active async-local store.
  const reqCtx = {
    get apiKey() { return mcpAuthStore.getStore()?.apiKey || null; },
    get user() {
      const e = mcpAuthStore.getStore()?.userEmail;
      return e ? { email: e } : undefined;
    },
  };

  const toolCount = registerTools(server, deps, reqCtx);
  log.info(`MCP server initialized with ${toolCount} tools`);
  return { server, mcpAuthStore };
}

/**
 * Mount the MCP server on an Express app at the given path.
 */
async function mountMcp(app, path, deps) {
  const { server, mcpAuthStore } = createNectarMcpServer(deps);
  const { apiKeys } = deps;

  // MCP auth check — validates API key or WEB_TOKEN in the Authorization header.
  // When SSO is disabled and no WEB_TOKEN is set, MCP is open (dev mode).
  const mcpAuth = (req, res, next) => {
    const ssoEnabled = process.env.ENABLE_GOOGLE_SSO === 'true';
    const webToken = process.env.WEB_TOKEN;

    if (req.authenticated) return next();

    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      if (apiKeys && token.startsWith('nectar_')) {
        const result = apiKeys.validate(token);
        if (result.valid) {
          req.apiKey = { keyId: result.keyId, label: result.label };
          req.authenticated = true;
          return next();
        }
      }
      if (webToken && token === webToken) {
        req.authenticated = true;
        return next();
      }
    }

    if (!ssoEnabled && !webToken) return next();
    res.status(401).json({ error: 'MCP authentication required' });
  };

  app.post(path, mcpAuth, async (req, res) => {
    mcpAuthStore.run({ apiKey: req.apiKey || null }, async () => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
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
  });

  app.get(path, (req, res) => {
    res.status(405).json({ error: 'Use POST for MCP requests (stateless mode)' });
  });
  app.delete(path, (req, res) => {
    res.status(405).json({ error: 'Session management not supported (stateless mode)' });
  });

  log.info(`MCP server mounted at ${path}`);
}

module.exports = { mountMcp, findCustomer, createNectarMcpServer };
