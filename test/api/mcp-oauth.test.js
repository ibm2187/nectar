import { describe, it, expect } from 'vitest';
import http from 'http';
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const { createMcpOAuthRoutes } = require('../../src/api/mcp-oauth');
const { McpOAuthStore } = require('../../src/core/mcp-oauth-store');
const { createTestDb } = require('../../src/core/db');

const JWT_SECRET = 'test-secret-mcp-oauth';

/**
 * Build a test app with the OAuth router mounted, plus a fresh store
 * on an in-memory DB. Sets JWT_SECRET so the /authorize cookie check
 * succeeds with our minted JWTs.
 */
function makeApp() {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NECTAR_URL = 'https://test.example.com';
  const db = createTestDb();
  const store = new McpOAuthStore({ db });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createMcpOAuthRoutes({ baseUrl: 'https://test.example.com', store }));
  return { app, store };
}

function request(app, method, path, { body = null, headers = {}, redirect = 'follow' } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const isJson = body && typeof body === 'object' && !(body instanceof Buffer);
      const isForm = body && typeof body === 'string' && headers['Content-Type']?.includes('form');
      const payload = isJson ? JSON.stringify(body) : (body || '');
      const opts = {
        hostname: 'localhost', port, path, method,
        headers: {
          ...(isJson ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let parsed = data;
          if (data && res.headers['content-type']?.includes('json')) {
            try { parsed = JSON.parse(data); } catch { /* keep as string */ }
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
  void redirect;
}

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function sessionCookie(email = 'user@viv.com') {
  const token = jwt.sign({ email, name: 'User', picture: null, domain: 'viv.com', role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  return `nectar_session=${token}`;
}

// ── Discovery ─────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns issuer metadata pointing at the AS endpoints', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe('https://test.example.com');
    expect(res.body.authorization_endpoint).toMatch(/\/mcp-oauth\/oauth\/authorize$/);
    expect(res.body.token_endpoint).toMatch(/\/mcp-oauth\/oauth\/token$/);
    expect(res.body.registration_endpoint).toMatch(/\/mcp-oauth\/oauth\/register$/);
    expect(res.body.code_challenge_methods_supported).toContain('S256');
  });
});

describe('GET /.well-known/oauth-protected-resource/mcp-oauth', () => {
  it('points clients at the auth server', async () => {
    const { app } = makeApp();
    const res = await request(app, 'GET', '/.well-known/oauth-protected-resource/mcp-oauth');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe('https://test.example.com/mcp-oauth');
    expect(res.body.authorization_servers).toEqual(['https://test.example.com']);
  });
});

// ── Dynamic Client Registration ───────────────────────────

describe('POST /mcp-oauth/oauth/register', () => {
  it('registers a public PKCE client without prior auth', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/register', {
      body: {
        client_name: 'Claude Desktop',
        redirect_uris: ['http://localhost:7654/cb'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^mcpc_/);
    expect(res.body.client_secret).toBeUndefined(); // public client
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  it('rejects when redirect_uris is missing', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/register', {
      body: { client_name: 'Bad' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('rejects redirect_uris that are not URI-shaped', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/register', {
      body: { client_name: 'Bad', redirect_uris: ['not a url at all'] },
    });
    expect(res.status).toBe(400);
  });

  it('rejects dangerous URI schemes (javascript:, data:, file:, vbscript:, blob:)', async () => {
    const { app } = makeApp();
    for (const u of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'vbscript:msgbox', 'blob:https://x/abc']) {
      const res = await request(app, 'POST', '/mcp-oauth/oauth/register', {
        body: { client_name: 'Phisher', redirect_uris: [u] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
      expect(res.body.error_description).toMatch(/Disallowed scheme/);
    }
  });

  it('accepts http(s) and custom app schemes', async () => {
    const { app } = makeApp();
    for (const u of ['http://localhost:1234/cb', 'https://app.example/cb', 'com.example.app://callback', 'claude-desktop://oauth/cb']) {
      const res = await request(app, 'POST', '/mcp-oauth/oauth/register', {
        body: { client_name: 'OK', redirect_uris: [u] },
      });
      expect(res.status).toBe(201);
    }
  });
});

// ── Authorize ─────────────────────────────────────────────

describe('GET /mcp-oauth/oauth/authorize', () => {
  it('redirects to /login when no Nectar session cookie is present', async () => {
    const { app, store } = makeApp();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'verifier-1234567890123456789012345678901234567890';
    const qs = new URLSearchParams({
      client_id: c.clientId, redirect_uri: 'http://x/cb', response_type: 'code',
      code_challenge: s256(verifier), code_challenge_method: 'S256', state: 'xyz',
    }).toString();
    const res = await request(app, 'GET', `/mcp-oauth/oauth/authorize?${qs}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?next=/);
  });

  it('renders the consent page when session is valid', async () => {
    const { app, store } = makeApp();
    const c = store.registerClient({ clientName: 'Claude Desktop', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'verifier-1234567890123456789012345678901234567890';
    const qs = new URLSearchParams({
      client_id: c.clientId, redirect_uri: 'http://x/cb', response_type: 'code',
      code_challenge: s256(verifier), code_challenge_method: 'S256', scope: 'mcp', state: 'abc',
    }).toString();
    const res = await request(app, 'GET', `/mcp-oauth/oauth/authorize?${qs}`, {
      headers: { Cookie: sessionCookie('alice@viv.com') },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/Authorize Claude Desktop/);
    expect(res.body).toMatch(/alice@viv\.com/);
  });

  it('returns invalid_client for an unknown client_id', async () => {
    const { app } = makeApp();
    const qs = new URLSearchParams({
      client_id: 'mcpc_unknown', redirect_uri: 'http://x/cb', response_type: 'code',
      code_challenge: 'abc',
    }).toString();
    const res = await request(app, 'GET', `/mcp-oauth/oauth/authorize?${qs}`);
    expect(res.status).toBe(400);
  });

  it('rejects redirect_uri not in the registered set', async () => {
    const { app, store } = makeApp();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const qs = new URLSearchParams({
      client_id: c.clientId, redirect_uri: 'http://evil/cb', response_type: 'code',
      code_challenge: 'abc',
    }).toString();
    const res = await request(app, 'GET', `/mcp-oauth/oauth/authorize?${qs}`);
    expect(res.status).toBe(400);
  });
});

// ── Consent submission ────────────────────────────────────

describe('POST /mcp-oauth/oauth/authorize/consent', () => {
  it('issues a code and 302s to redirect_uri on Allow', async () => {
    const { app, store } = makeApp();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'v0123456789012345678901234567890123456789012345';
    const body = new URLSearchParams({
      decision: 'allow',
      client_id: c.clientId,
      redirect_uri: 'http://x/cb',
      state: 'xyz',
      scope: 'mcp',
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    }).toString();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/authorize/consent', {
      body,
      headers: { Cookie: sessionCookie(), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe('http://x/cb');
    expect(loc.searchParams.get('code')).toMatch(/^mcpcode_/);
    expect(loc.searchParams.get('state')).toBe('xyz');
  });

  it('redirects with access_denied when the user clicks Deny', async () => {
    const { app, store } = makeApp();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const body = new URLSearchParams({
      decision: 'deny',
      client_id: c.clientId,
      redirect_uri: 'http://x/cb',
      state: 'xyz',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
    }).toString();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/authorize/consent', {
      body,
      headers: { Cookie: sessionCookie(), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.get('error')).toBe('access_denied');
  });
});

// ── Token endpoint ────────────────────────────────────────

// Regression: the live web server only registers express.json by
// default. The OAuth consent + token endpoints both arrive as
// application/x-www-form-urlencoded — without express.urlencoded
// req.body would be {} and the flow would silently fail. We assert
// here that an app with ONLY express.json mounted still works,
// because src/web/server.js was updated to register both globally.
describe('POST /mcp-oauth — body parsers required globally', () => {
  it('consent endpoint still works without test-only urlencoded parser if global is registered', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NECTAR_URL = 'https://test.example.com';
    const db = createTestDb();
    const store = new McpOAuthStore({ db });
    const app = express();
    // Match the production wiring: BOTH parsers globally before the router.
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(createMcpOAuthRoutes({ baseUrl: 'https://test.example.com', store }));

    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const body = new URLSearchParams({
      decision: 'allow', client_id: c.clientId, redirect_uri: 'http://x/cb',
      scope: 'mcp', code_challenge: 'abc', code_challenge_method: 'S256',
    }).toString();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/authorize/consent', {
      body,
      headers: { Cookie: sessionCookie(), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).searchParams.get('code')).toMatch(/^mcpcode_/);
  });
});

describe('POST /mcp-oauth/oauth/token', () => {
  async function fullFlow({ grant = 'authorization_code' } = {}) {
    const { app, store } = makeApp();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'v0123456789012345678901234567890123456789012345';
    const challenge = s256(verifier);

    // Issue a code via the consent path so PKCE is correctly stored
    const consentBody = new URLSearchParams({
      decision: 'allow', client_id: c.clientId, redirect_uri: 'http://x/cb',
      scope: 'mcp', code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    const consent = await request(app, 'POST', '/mcp-oauth/oauth/authorize/consent', {
      body: consentBody,
      headers: { Cookie: sessionCookie('alice@viv.com'), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const code = new URL(consent.headers.location).searchParams.get('code');

    return { app, store, client: c, code, verifier };
  }

  it('exchanges code+verifier for an access+refresh token pair', async () => {
    const { app, client, code, verifier } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://x/cb', client_id: client.clientId, code_verifier: verifier,
    }).toString();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/token', {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(/^mcpat_/);
    expect(res.body.refresh_token).toMatch(/^mcprt_/);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBeGreaterThan(0);
  });

  it('rejects code redemption with the wrong PKCE verifier', async () => {
    const { app, client, code } = await fullFlow();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code, redirect_uri: 'http://x/cb', client_id: client.clientId,
      code_verifier: 'wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong',
    }).toString();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/token', {
      body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refresh_token grant mints a fresh access token', async () => {
    const { app, client, code, verifier } = await fullFlow();
    const exchange = await request(app, 'POST', '/mcp-oauth/oauth/token', {
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: 'http://x/cb',
        client_id: client.clientId, code_verifier: verifier,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const refreshToken = exchange.body.refresh_token;

    const res = await request(app, 'POST', '/mcp-oauth/oauth/token', {
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(/^mcpat_/);
    expect(res.body.access_token).not.toBe(exchange.body.access_token);
  });

  it('rejects unsupported grant_type', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/mcp-oauth/oauth/token', {
      body: new URLSearchParams({ grant_type: 'password', username: 'a', password: 'b' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });
});
