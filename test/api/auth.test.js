import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We test the auth middleware and auth route creation logic directly,
// without spinning up an actual HTTP server.

describe('Auth', () => {
  let originalEnv;

  beforeEach(() => {
    // Preserve original env
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;
    vi.restoreAllMocks();
    // Clear require cache so modules pick up new env values
    delete require.cache[require.resolve('../../src/api/auth')];
  });

  describe('SSO disabled behavior', () => {
    // TESTING: When ENABLE_GOOGLE_SSO is not set, auth routes report SSO disabled
    //
    // SETUP: No ENABLE_GOOGLE_SSO env var
    //
    // EXPECTED: /api/auth/me returns { authenticated: false, ssoEnabled: false }
    it('/api/auth/me reports SSO disabled', () => {
      delete process.env.ENABLE_GOOGLE_SSO;
      const { createAuthRoutes } = require('../../src/api/auth');
      const router = createAuthRoutes();

      // Find the /me route handler
      const meRoute = router.stack.find(
        layer => layer.route && layer.route.path === '/me'
      );
      expect(meRoute).toBeTruthy();

      // Simulate request
      const req = { headers: {} };
      const res = {
        _json: null,
        json(data) { this._json = data; return this; },
      };

      meRoute.route.stack[0].handle(req, res);

      expect(res._json).toEqual({ authenticated: false, ssoEnabled: false });
    });
  });

  describe('SSO enabled behavior', () => {
    // TESTING: When ENABLE_GOOGLE_SSO is set, auth routes include Google OAuth
    //
    // SETUP: ENABLE_GOOGLE_SSO=true with required credentials
    //
    // EXPECTED: Router has /google, /google/callback, /me, and /logout routes
    it('creates Google OAuth routes when SSO is enabled', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';
      process.env.GOOGLE_CLIENT_ID = 'test-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
      process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/auth/google/callback';
      process.env.JWT_SECRET = 'test-secret';

      const { createAuthRoutes } = require('../../src/api/auth');
      const router = createAuthRoutes();

      const paths = router.stack
        .filter(layer => layer.route)
        .map(layer => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

      expect(paths).toContain('GET /google');
      expect(paths).toContain('GET /google/callback');
      expect(paths).toContain('GET /me');
      expect(paths).toContain('POST /logout');
    });

    // TESTING: /api/auth/me returns unauthenticated when no cookie
    // EXPECTED: { authenticated: false, ssoEnabled: true }
    it('/api/auth/me returns unauthenticated without cookie', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';
      process.env.GOOGLE_CLIENT_ID = 'test-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
      process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/auth/google/callback';
      process.env.JWT_SECRET = 'test-secret';

      const { createAuthRoutes } = require('../../src/api/auth');
      const router = createAuthRoutes();

      const meRoute = router.stack.find(
        layer => layer.route && layer.route.path === '/me'
      );

      const req = { headers: {} };
      const res = {
        _json: null,
        json(data) { this._json = data; return this; },
      };

      meRoute.route.stack[0].handle(req, res);

      expect(res._json.authenticated).toBe(false);
      expect(res._json.ssoEnabled).toBe(true);
    });

    // TESTING: /api/auth/me returns authenticated with valid JWT cookie
    // EXPECTED: { authenticated: true, ssoEnabled: true, user: { email, name, ... } }
    it('/api/auth/me returns authenticated with valid JWT cookie', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';
      process.env.GOOGLE_CLIENT_ID = 'test-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
      process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/auth/google/callback';
      process.env.JWT_SECRET = 'test-secret-for-jwt';

      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        { email: 'user@vivtechnologies.com', name: 'Test User', picture: null, domain: 'vivtechnologies.com' },
        'test-secret-for-jwt',
        { expiresIn: '1h' }
      );

      const { createAuthRoutes } = require('../../src/api/auth');
      const router = createAuthRoutes();

      const meRoute = router.stack.find(
        layer => layer.route && layer.route.path === '/me'
      );

      const req = { headers: { cookie: `nectar_session=${token}` } };
      const res = {
        _json: null,
        json(data) { this._json = data; return this; },
      };

      meRoute.route.stack[0].handle(req, res);

      expect(res._json.authenticated).toBe(true);
      expect(res._json.ssoEnabled).toBe(true);
      expect(res._json.user.email).toBe('user@vivtechnologies.com');
      expect(res._json.user.name).toBe('Test User');
    });
  });

  describe('Auth middleware', () => {
    // TESTING: Middleware allows requests when SSO is disabled
    //
    // SETUP: No ENABLE_GOOGLE_SSO env var
    //
    // EXPECTED: next() is called for all requests
    it('allows all requests when SSO is disabled', () => {
      delete process.env.ENABLE_GOOGLE_SSO;
      delete process.env.WEB_TOKEN;

      const { createAuthMiddleware } = require('../../src/api/auth');
      const mw = createAuthMiddleware(null);

      const req = { path: '/api/releases', headers: {} };
      const res = {};
      let called = false;
      const next = () => { called = true; };

      mw(req, res, next);

      expect(called).toBe(true);
    });

    // TESTING: Middleware always allows auth routes, webhooks, and health
    // EXPECTED: next() is called regardless of auth state
    it('always allows auth routes', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';

      const { createAuthMiddleware } = require('../../src/api/auth');
      const mw = createAuthMiddleware(null);

      for (const path of ['/api/auth/me', '/api/auth/google', '/api/webhooks/github', '/health']) {
        const req = { path, headers: {} };
        const res = {};
        let called = false;
        const next = () => { called = true; };

        mw(req, res, next);
        expect(called).toBe(true);
      }
    });

    // TESTING: API key bypass — API keys always bypass SSO
    //
    // SETUP: SSO enabled, request with valid API key in Authorization header
    //
    // EXPECTED: Request is allowed and req.apiKey is set
    it('allows API key requests even with SSO enabled', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';

      const ApiKeyManager = require('../../src/core/api-keys');
      const { createTestDb } = require('../../src/core/db');
      const apiKeys = new ApiKeyManager({ db: createTestDb() });
      const { rawKey } = apiKeys.create('test-key');

      const { createAuthMiddleware } = require('../../src/api/auth');
      const mw = createAuthMiddleware(apiKeys);

      const req = {
        path: '/api/releases',
        headers: { authorization: `Bearer ${rawKey}` },
        query: {},
      };
      const res = {};
      let called = false;
      const next = () => { called = true; };

      mw(req, res, next);

      expect(called).toBe(true);
      expect(req.authenticated).toBe(true);
      expect(req.apiKey).toBeTruthy();

      // Cleanup
      apiKeys.keys.clear();
    });

    // TESTING: WEB_TOKEN still works as auth method
    //
    // SETUP: WEB_TOKEN set, request with WEB_TOKEN in Authorization header
    //
    // EXPECTED: Request is allowed
    it('allows WEB_TOKEN as auth', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';
      process.env.WEB_TOKEN = 'my-web-token';

      const { createAuthMiddleware } = require('../../src/api/auth');
      const mw = createAuthMiddleware(null);

      const req = {
        path: '/api/releases',
        headers: { authorization: 'Bearer my-web-token' },
        query: {},
      };
      const res = {};
      let called = false;
      const next = () => { called = true; };

      mw(req, res, next);

      expect(called).toBe(true);
      expect(req.authenticated).toBe(true);
    });

    // TESTING: Unauthenticated API request with SSO enabled
    //
    // SETUP: SSO enabled, no auth provided, API request
    //
    // EXPECTED: 401 response
    it('returns 401 for unauthenticated API requests when SSO is enabled', () => {
      process.env.ENABLE_GOOGLE_SSO = 'true';

      const { createAuthMiddleware } = require('../../src/api/auth');
      const mw = createAuthMiddleware(null);

      const req = {
        path: '/api/releases',
        headers: { accept: 'application/json' },
        query: {},
      };
      let statusCode = null;
      let body = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { body = data; return this; },
        redirect() {},
      };
      const next = vi.fn();

      mw(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });
});
