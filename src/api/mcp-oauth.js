/**
 * OAuth 2.1 endpoints for the /mcp-oauth Streamable HTTP MCP.
 *
 * Implements the minimum surface that Claude Desktop's custom-connector
 * flow expects:
 *
 *   - GET  /.well-known/oauth-protected-resource/mcp-oauth
 *         RFC 9728 metadata pointing at the auth server.
 *   - GET  /.well-known/oauth-authorization-server
 *         RFC 8414 issuer metadata for the AS.
 *   - POST /mcp-oauth/oauth/register
 *         RFC 7591 Dynamic Client Registration. Anonymous (no auth).
 *   - GET  /mcp-oauth/oauth/authorize
 *         Authorization request. Requires a Nectar JWT cookie — if
 *         missing, redirects to /login?return=<authorize-url>.
 *         When session is good, renders a small consent HTML page.
 *   - POST /mcp-oauth/oauth/authorize/consent
 *         Receives the user's Allow/Deny click; on Allow, issues an
 *         authorization code and 302s to the client's redirect_uri.
 *   - POST /mcp-oauth/oauth/token
 *         Exchanges code → access+refresh OR refresh_token → fresh
 *         access token. PKCE (S256) required for the code path.
 *
 * Authorization is identity-only: the AS proves the user's identity to
 * the MCP server. Per-tool capabilities still flow through the existing
 * authz engine (user_roles → roles → capabilities), keyed by email.
 */

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const log = require('../core/log');
const { McpOAuthStore } = require('../core/mcp-oauth-store');

const COOKIE_NAME = 'nectar_session';

/**
 * Build the OAuth router. Mount BEFORE the global auth middleware —
 * /authorize enforces session auth itself, all other endpoints are
 * intentionally unauthenticated (DCR is anonymous; /token authenticates
 * via the code/refresh token, not the session).
 *
 * @param {object} opts
 * @param {string} opts.baseUrl       - Public base URL (e.g. https://nectar.vivtechnologies.com)
 * @param {object} [opts.userStore]   - For role lookups in the consent screen (optional)
 * @param {McpOAuthStore} [opts.store] - Injectable for tests
 */
function createMcpOAuthRoutes(opts = {}) {
  const baseUrl = (opts.baseUrl || process.env.NECTAR_URL || 'https://nectar.vivtechnologies.com').replace(/\/$/, '');
  const jwtSecret = process.env.JWT_SECRET || 'nectar-default-jwt-secret';
  const store = opts.store || new McpOAuthStore();

  const router = Router();

  // ── Static icon ──────────────────────────────────────────
  // Served from this router so it's reachable on a fresh deploy without
  // depending on the SPA build, and so MCP clients can pull it without
  // chasing through the React static handler. Cached aggressively —
  // the asset is content-immutable (we'll bump the URL if it changes).
  const ICON_URL = `${baseUrl}/mcp-oauth/icon.svg`;
  const ICON_PATH = path.join(__dirname, '..', '..', 'client', 'public', 'nectar-icon.svg');
  let iconBuf = null;
  try { iconBuf = fs.readFileSync(ICON_PATH); }
  catch { log.warn(`MCP OAuth: icon asset missing at ${ICON_PATH}`); }
  router.get('/mcp-oauth/icon.svg', (req, res) => {
    if (!iconBuf) return res.status(404).send('icon not found');
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.send(iconBuf);
  });

  // ── Discovery: protected resource metadata (RFC 9728) ────
  // Tells MCP clients which authorization server to use for /mcp-oauth.
  router.get('/.well-known/oauth-protected-resource/mcp-oauth', (req, res) => {
    res.json({
      resource: `${baseUrl}/mcp-oauth`,
      resource_name: 'Nectar',
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      // Non-standard but a few MCP clients (and the consent screen) read it.
      logo_uri: ICON_URL,
    });
  });

  // ── Discovery: authorization server metadata (RFC 8414) ──
  router.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/mcp-oauth/oauth/authorize`,
      token_endpoint: `${baseUrl}/mcp-oauth/oauth/token`,
      registration_endpoint: `${baseUrl}/mcp-oauth/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['mcp'],
      service_documentation: `${baseUrl}/`,
      op_policy_uri: `${baseUrl}/`,
      logo_uri: ICON_URL,
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ───────────────
  // Anonymous — any MCP client can self-register. We accept the bare
  // minimum (redirect_uris + client_name) and default the rest. Public
  // PKCE clients (Claude Desktop) get null secret; confidential clients
  // get a one-shot secret in the response.
  router.post('/mcp-oauth/oauth/register', (req, res) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
    }
    // Reject dangerous schemes outright. The previous regex accepted
    // anything URI-shaped (javascript:, data:, vbscript:, file:, blob:)
    // — turning the consent + 302 chain into a phishing landing page if
    // an attacker socially engineered a logged-in user to click a
    // hand-crafted authorize URL. Allow http/https + custom schemes a
    // native MCP client would actually use.
    const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob']);
    for (const u of redirectUris) {
      if (typeof u !== 'string') {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri must be a string' });
      }
      const m = u.match(/^([a-z][a-z0-9+.-]*):/i);
      if (!m) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `Bad redirect_uri: ${u}` });
      }
      if (FORBIDDEN_SCHEMES.has(m[1].toLowerCase())) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `Disallowed scheme "${m[1]}" in redirect_uri` });
      }
    }

    const created = store.registerClient({
      clientName: body.client_name || 'Anonymous MCP client',
      redirectUris,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method || 'none',
      grantTypes: body.grant_types,
      responseTypes: body.response_types,
      scope: body.scope || 'mcp',
    });

    res.status(201).json({
      client_id: created.clientId,
      client_secret: created.clientSecret || undefined,
      client_id_issued_at: Math.floor(Date.parse(created.createdAt) / 1000),
      client_name: created.clientName,
      redirect_uris: created.redirectUris,
      grant_types: created.grantTypes,
      response_types: created.responseTypes,
      token_endpoint_auth_method: created.tokenEndpointAuthMethod,
      scope: created.scope,
      // RFC 7591 — some MCP clients display this in the connector UI
      // alongside the server name.
      logo_uri: ICON_URL,
    });
  });

  // ── Authorize: identity check + consent ─────────────────
  // Validates the request, ensures Nectar SSO session, then renders a
  // small consent screen. The user's Allow click POSTs back here below.
  router.get('/mcp-oauth/oauth/authorize', (req, res) => {
    const { client_id, redirect_uri, response_type, state, scope,
            code_challenge, code_challenge_method } = req.query;

    // Validate the request shape early — return errors via the OAuth
    // redirect for invalid_scope / unsupported_response_type, but for
    // anything that breaks redirect-uri trust we render a plain error.
    if (!client_id || !redirect_uri || !response_type) {
      return renderError(res, 400, 'invalid_request', 'Missing required parameters');
    }
    const client = store.getClient(client_id);
    if (!client) return renderError(res, 400, 'invalid_client', 'Unknown client_id');
    if (!client.redirectUris.includes(redirect_uri)) {
      return renderError(res, 400, 'invalid_redirect_uri', 'redirect_uri is not registered for this client');
    }
    if (response_type !== 'code') {
      return redirectError(res, redirect_uri, state, 'unsupported_response_type', 'Only "code" is supported');
    }
    if (!code_challenge) {
      return redirectError(res, redirect_uri, state, 'invalid_request', 'code_challenge is required (PKCE)');
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      return redirectError(res, redirect_uri, state, 'invalid_request', 'Only S256 PKCE is supported');
    }

    // Identity check: do we have a valid Nectar JWT cookie?
    const cookieToken = parseCookie(req, COOKIE_NAME);
    let user = null;
    if (cookieToken) {
      try { user = jwt.verify(cookieToken, jwtSecret); } catch { user = null; }
    }
    if (!user) {
      // Bounce through Nectar's Google SSO. After a successful login,
      // /api/auth/google/callback redirects to '/', so we add a
      // continuation query param '?next=<authorize-url>' that the
      // client-side login page can honor. (For now, the user just
      // re-clicks the Connector add button — the second attempt sees
      // the cookie and proceeds. Documented in PR.)
      const target = `${baseUrl}/mcp-oauth/oauth/authorize?${new URLSearchParams(req.query).toString()}`;
      return res.redirect(`/login?next=${encodeURIComponent(target)}`);
    }

    // Render the consent screen (server-rendered HTML — no React build
    // dependency for this single page).
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderConsentPage({
      clientName: client.clientName,
      clientId: client.clientId,
      userEmail: user.email,
      userName: user.name || user.email,
      scope: scope || client.scope || 'mcp',
      redirectUri: redirect_uri,
      formAction: `${baseUrl}/mcp-oauth/oauth/authorize/consent`,
      query: req.query,
      iconUrl: ICON_URL,
    }));
  });

  // ── Consent submission ──────────────────────────────────
  router.post('/mcp-oauth/oauth/authorize/consent', (req, res) => {
    const body = req.body || {};
    const decision = body.decision; // 'allow' | 'deny'
    const { client_id, redirect_uri, state, scope, code_challenge,
            code_challenge_method } = body;

    // Re-check session — the user might have logged out between GET and POST.
    const cookieToken = parseCookie(req, COOKIE_NAME);
    let user = null;
    if (cookieToken) {
      try { user = jwt.verify(cookieToken, jwtSecret); } catch { user = null; }
    }
    if (!user) return renderError(res, 401, 'login_required', 'Session expired — please sign in again');

    const client = store.getClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      return renderError(res, 400, 'invalid_request', 'Bad client/redirect');
    }

    if (decision !== 'allow') {
      return redirectError(res, redirect_uri, state, 'access_denied', 'User denied the request');
    }

    const code = store.issueCode({
      clientId: client_id,
      userEmail: user.email,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
      scope: scope || client.scope || 'mcp',
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    log.info(`MCP OAuth: code issued for ${user.email} → ${client.clientName} (${client.clientId})`);
    res.redirect(url.toString());
  });

  // ── Token endpoint ──────────────────────────────────────
  router.post('/mcp-oauth/oauth/token', (req, res) => {
    const body = req.body || {};
    const grant = body.grant_type;

    try {
      if (grant === 'authorization_code') {
        const { code, redirect_uri, client_id, client_secret, code_verifier } = body;
        if (!code || !redirect_uri || !client_id) {
          throw oauthErr('invalid_request', 'Missing parameters');
        }
        const client = store.getClient(client_id);
        if (!client) throw oauthErr('invalid_client', 'Unknown client');
        if (!client.isPublic) {
          if (!client_secret || !store.verifyClientSecret(client_id, client_secret)) {
            throw oauthErr('invalid_client', 'Bad client_secret');
          }
        }
        const redeemed = store.redeemCode({ code, clientId: client_id, redirectUri: redirect_uri, codeVerifier: code_verifier });
        const tokens = store.issueTokenPair({ clientId: client_id, userEmail: redeemed.userEmail, scope: redeemed.scope });
        store.touchClient(client_id);
        return res.json({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          token_type: tokens.tokenType,
          expires_in: tokens.expiresIn,
          scope: tokens.scope || undefined,
        });
      }

      if (grant === 'refresh_token') {
        const { refresh_token, client_id, client_secret } = body;
        if (!refresh_token || !client_id) throw oauthErr('invalid_request', 'Missing parameters');
        const client = store.getClient(client_id);
        if (!client) throw oauthErr('invalid_client', 'Unknown client');
        if (!client.isPublic) {
          if (!client_secret || !store.verifyClientSecret(client_id, client_secret)) {
            throw oauthErr('invalid_client', 'Bad client_secret');
          }
        }
        const minted = store.refreshAccessToken(refresh_token, client_id);
        store.touchClient(client_id);
        return res.json({
          access_token: minted.accessToken,
          token_type: minted.tokenType,
          expires_in: minted.expiresIn,
          scope: minted.scope || undefined,
        });
      }

      throw oauthErr('unsupported_grant_type', `Grant "${grant}" is not supported`);
    } catch (err) {
      const code = err.oauthError || 'server_error';
      const status = code === 'server_error' ? 500 : 400;
      log.warn(`MCP OAuth /token error: ${code} - ${err.oauthErrorDescription || err.message}`);
      res.status(status).json({ error: code, error_description: err.oauthErrorDescription || err.message });
    }
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────

function parseCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').find(c => c.trim().startsWith(`${name}=`));
  if (!match) return null;
  return match.split('=').slice(1).join('=').trim();
}

function oauthErr(code, description) {
  const err = new Error(description || code);
  err.oauthError = code;
  err.oauthErrorDescription = description;
  return err;
}

function redirectError(res, redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

function renderError(res, status, error, description) {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(`
<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title>
<style>body{font:14px system-ui;padding:40px;max-width:520px;margin:auto}
h1{font-size:20px;color:#b91c1c}code{background:#f1f5f9;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>OAuth error</h1>
<p><code>${escapeHtml(error)}</code></p>
<p>${escapeHtml(description || '')}</p>
</body></html>`);
}

/**
 * Server-side consent page. Single static HTML — keeps this whole
 * feature deployable without a React build refresh. Form posts the
 * decision (and the original PKCE/redirect params, hidden) back to
 * /authorize/consent.
 */
function renderConsentPage({ clientName, clientId, userEmail, userName, scope, redirectUri, formAction, query, iconUrl }) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'response_type']
    .map(k => query[k] != null ? `<input type="hidden" name="${k}" value="${escapeAttr(String(query[k]))}">` : '')
    .join('');
  // Every color is explicit — the previous version relied on the browser
  // default for body text/background, which rendered illegibly under
  // some user agent themes. CSS vars switch via prefers-color-scheme.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(clientName)} — Nectar</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:        #f8fafc;
    --card-bg:   #ffffff;
    --border:    #e2e8f0;
    --border-2:  #f1f5f9;
    --text:      #0f172a;
    --text-2:    #475569;
    --text-3:    #64748b;
    --accent-bg: #eff6ff;
    --accent-bd: #bfdbfe;
    --accent-fg: #1e40af;
    --code-bg:   #f1f5f9;
    --code-fg:   #0f172a;
    --primary:   #2563eb;
    --primary-h: #1d4ed8;
    --primary-fg:#ffffff;
    --btn-bg:    #ffffff;
    --btn-fg:    #0f172a;
    --btn-h-bg:  #f8fafc;
    --shadow:    0 1px 2px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:        #0b1120;
      --card-bg:   #111827;
      --border:    #1f2937;
      --border-2:  #1f293770;
      --text:      #e2e8f0;
      --text-2:    #94a3b8;
      --text-3:    #64748b;
      --accent-bg: #1e3a8a40;
      --accent-bd: #1e40af;
      --accent-fg: #93c5fd;
      --code-bg:   #1e293b;
      --code-fg:   #e2e8f0;
      --primary:   #3b82f6;
      --primary-h: #2563eb;
      --primary-fg:#ffffff;
      --btn-bg:    #1f2937;
      --btn-fg:    #e2e8f0;
      --btn-h-bg:  #283446;
      --shadow:    0 1px 2px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.25);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 16px;
  }
  .card {
    width: 100%;
    max-width: 460px;
    background: var(--card-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px 28px;
    box-shadow: var(--shadow);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }
  .brand img { width: 36px; height: 36px; border-radius: 8px; }
  .brand .label { color: var(--text-2); font-size: 12px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 600; }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 6px; color: var(--text); font-weight: 600; }
  p.meta { color: var(--text-2); font-size: 13px; margin: 0 0 20px; }
  .scope {
    background: var(--accent-bg);
    border: 1px solid var(--accent-bd);
    color: var(--accent-fg);
    padding: 12px 14px;
    border-radius: 10px;
    margin: 0 0 20px;
    font-size: 13px;
    line-height: 1.5;
  }
  .scope strong { color: var(--accent-fg); }
  .rows { border-top: 1px solid var(--border-2); margin: 0 0 20px; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-2);
    font-size: 13px;
    color: var(--text);
  }
  .row .k { color: var(--text-3); flex-shrink: 0; }
  .row .v { color: var(--text); text-align: right; word-break: break-all; min-width: 0; }
  code {
    background: var(--code-bg);
    color: var(--code-fg);
    padding: 2px 6px;
    border-radius: 4px;
    font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .actions { display: flex; gap: 10px; margin-top: 8px; }
  button {
    flex: 1;
    padding: 11px 16px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--btn-bg);
    color: var(--btn-fg);
    font: 600 14px/1 inherit;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  button:hover { background: var(--btn-h-bg); }
  button.primary {
    background: var(--primary);
    color: var(--primary-fg);
    border-color: var(--primary);
  }
  button.primary:hover { background: var(--primary-h); border-color: var(--primary-h); }
</style></head><body>
<div class="card">
  <div class="brand">
    ${iconUrl ? `<img src="${escapeAttr(iconUrl)}" alt="Nectar" />` : ''}
    <span class="label">Nectar · Authorize connector</span>
  </div>
  <h1>Allow ${escapeHtml(clientName)} to access Nectar?</h1>
  <p class="meta">It will be able to call Nectar MCP tools as <strong>${escapeHtml(userEmail)}</strong>.</p>

  <div class="scope">
    <strong>Requested scope:</strong> ${escapeHtml(scope)}.
    Per-tool capability checks still apply — the connector only gets what your Nectar role grants.
  </div>

  <div class="rows">
    <div class="row"><span class="k">Signed in as</span><span class="v">${escapeHtml(userName)} &lt;${escapeHtml(userEmail)}&gt;</span></div>
    <div class="row"><span class="k">Client ID</span><span class="v"><code>${escapeHtml(clientId)}</code></span></div>
    <div class="row"><span class="k">Redirect URI</span><span class="v"><code>${escapeHtml(redirectUri)}</code></span></div>
  </div>

  <form method="POST" action="${escapeAttr(formAction)}">
    ${hidden}
    <div class="actions">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="allow" class="primary">Allow</button>
    </div>
  </form>
</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

module.exports = { createMcpOAuthRoutes };
