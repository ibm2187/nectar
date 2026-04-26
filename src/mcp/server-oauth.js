/**
 * Parallel MCP server protected by OAuth 2.1 bearer tokens.
 *
 * Tool definitions are shared with the production /mcp endpoint via
 * src/mcp/tools.js — this file only differs in:
 *   - Authentication: OAuth bearer (mcp_oauth_tokens) instead of api keys.
 *   - Per-request principal exposed as req.user.email; authz's
 *     extractPrincipal already handles both shapes natively.
 *   - Adds a `whoami` debugging tool that introspects the OAuth session.
 *   - Advertises Nectar branding via serverInfo (icons/title/etc.) so
 *     compatible MCP clients display the Nectar logo.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const log = require('../core/log');
const { registerTools } = require('./tools');

function createNectarOAuthMcpServer(deps) {
  const baseUrl = (process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com').replace(/\/$/, '');
  const iconSrc = `${baseUrl}/mcp-oauth/icon.svg`;
  const server = new McpServer({
    name: 'nectar-oauth',
    title: 'Nectar',
    version: '1.0.0',
    description: 'Nectar release-intelligence MCP — customer/env/release data and incident tools.',
    websiteUrl: baseUrl,
    icons: [{ src: iconSrc, mimeType: 'image/svg+xml', sizes: ['any'] }],
  });

  const { AsyncLocalStorage } = require('async_hooks');
  const mcpAuthStore = new AsyncLocalStorage();

  const reqCtx = {
    get apiKey() { return mcpAuthStore.getStore()?.apiKey || null; },
    get user() {
      const e = mcpAuthStore.getStore()?.userEmail;
      return e ? { email: e } : undefined;
    },
  };

  const toolCount = registerTools(server, deps, reqCtx);

  // OAuth-only debug helper. Lives here (not in shared tools.js) because
  // it reads OAuth-specific context (clientId, scope) from the store.
  server.tool(
    'whoami',
    'Return the authenticated user (email, OAuth client, scope) for the current session.',
    {},
    async () => {
      const store = mcpAuthStore.getStore();
      const email = store?.userEmail || null;
      if (!email) return { content: [{ type: 'text', text: JSON.stringify({ authenticated: false }, null, 2) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ authenticated: true, email, clientId: store.clientId, scope: store.scope }, null, 2) }] };
    }
  );

  log.info(`MCP OAuth server initialized (${toolCount + 1} tools)`);
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
