const { Router } = require('express');
const crypto = require('crypto');
const https = require('https');
const jwt = require('jsonwebtoken');
const log = require('../core/log');

const COOKIE_NAME = 'nectar_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Parse admin emails from NECTAR_ADMINS env var.
 */
function getAdminEmails() {
  return (process.env.NECTAR_ADMINS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(email) {
  if (!email) return false;
  const admins = getAdminEmails();
  if (admins.length === 0) return true; // No admins configured = everyone is admin
  return admins.includes(email.toLowerCase());
}

/**
 * Google OAuth routes and auth middleware.
 *
 * When ENABLE_GOOGLE_SSO is not set or false, all auth is bypassed
 * and the system behaves exactly as before (open access or WEB_TOKEN only).
 */
function createAuthRoutes() {
  const router = Router();
  const ssoEnabled = process.env.ENABLE_GOOGLE_SSO === 'true';
  const jwtSecret = process.env.JWT_SECRET || 'nectar-default-jwt-secret';

  if (!ssoEnabled) {
    // Expose a minimal /api/auth/me that reports SSO is disabled
    router.get('/me', (req, res) => {
      res.json({ authenticated: false, ssoEnabled: false });
    });
    return router;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const allowedDomain = process.env.GOOGLE_ALLOWED_DOMAIN;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    log.error('ENABLE_GOOGLE_SSO is true but GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REDIRECT_URI is missing');
  }

  // ── GET /api/auth/google — redirect to Google consent screen ──
  router.get('/google', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      state,
      prompt: 'select_account',
    });
    if (allowedDomain) {
      params.set('hd', allowedDomain);
    }
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // ── GET /api/auth/google/callback — exchange code for tokens ──
  router.get('/google/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) {
      log.warn(`Google OAuth error: ${error}`);
      return res.redirect('/?auth_error=denied');
    }
    if (!code) {
      return res.redirect('/?auth_error=no_code');
    }

    try {
      // Exchange authorization code for tokens
      const tokenData = await exchangeCode(code, clientId, clientSecret, redirectUri);
      if (!tokenData.id_token) {
        throw new Error('No id_token in response');
      }

      // Decode the ID token (we trust Google's response since we just exchanged the code)
      const payload = decodeJwtPayload(tokenData.id_token);

      // Verify domain restriction
      if (allowedDomain && payload.hd !== allowedDomain) {
        log.warn(`Login rejected: ${payload.email} (domain ${payload.hd} != ${allowedDomain})`);
        return res.redirect('/?auth_error=domain');
      }

      // Issue a Nectar JWT session cookie
      const role = isAdmin(payload.email) ? 'admin' : 'user';
      const sessionToken = jwt.sign(
        {
          email: payload.email,
          name: payload.name || payload.email,
          picture: payload.picture || null,
          domain: payload.hd || null,
          role,
        },
        jwtSecret,
        { expiresIn: '7d' }
      );

      res.cookie(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
        path: '/',
      });

      log.info(`User logged in: ${payload.email}`);
      res.redirect('/');
    } catch (err) {
      log.error(`Google OAuth callback error: ${err.message}`);
      res.redirect('/?auth_error=exchange_failed');
    }
  });

  // ── GET /api/auth/me — return current user from JWT ──
  router.get('/me', (req, res) => {
    const token = parseCookie(req, COOKIE_NAME);
    if (!token) {
      return res.json({ authenticated: false, ssoEnabled: true });
    }

    try {
      const user = jwt.verify(token, jwtSecret);
      // Re-evaluate role on each /me call (in case NECTAR_ADMINS changed)
      const currentRole = isAdmin(user.email) ? 'admin' : 'user';
      res.json({
        authenticated: true,
        ssoEnabled: true,
        user: {
          email: user.email,
          name: user.name,
          picture: user.picture,
          domain: user.domain,
          role: currentRole,
        },
      });
    } catch {
      res.json({ authenticated: false, ssoEnabled: true });
    }
  });

  // ── POST /api/auth/logout — clear cookie ──
  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}

/**
 * Auth middleware — enforces authentication when ENABLE_GOOGLE_SSO is true.
 *
 * Auth priority chain:
 *   1. Authorization: Bearer nectar_... → API key (handled by apiKeys middleware upstream)
 *   2. Authorization: Bearer <WEB_TOKEN> → legacy shared token
 *   3. JWT cookie → Google SSO session
 *   4. No auth → allowed only if ENABLE_GOOGLE_SSO is not set
 *
 * @param {object} [apiKeys] - ApiKeyManager instance (optional)
 */
function createAuthMiddleware(apiKeys) {
  const ssoEnabled = process.env.ENABLE_GOOGLE_SSO === 'true';
  const jwtSecret = process.env.JWT_SECRET || 'nectar-default-jwt-secret';
  const webToken = process.env.WEB_TOKEN;

  return (req, res, next) => {
    // Always allow: auth routes, webhooks, health, login page, static assets, MCP
    if (req.path.startsWith('/api/auth/') ||
        req.path.startsWith('/api/webhooks/') ||
        req.path === '/health' ||
        req.path === '/mcp' ||
        req.path === '/login' ||
        req.path.startsWith('/assets/') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.ico') ||
        req.path.endsWith('.svg') ||
        req.path.endsWith('.png')) {
      return next();
    }

    // If already authenticated by API key middleware upstream
    if (req.authenticated) {
      return next();
    }

    // Check Authorization header
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7);

      // Check API key first
      if (apiKeys && token.startsWith('nectar_')) {
        const result = apiKeys.validate(token);
        if (result.valid) {
          req.apiKey = { keyId: result.keyId, label: result.label };
          req.authenticated = true;
          return next();
        }
        // Invalid API key — fall through to other checks
      }

      // Check WEB_TOKEN
      if (webToken && token === webToken) {
        req.authenticated = true;
        return next();
      }
    }

    // Check query param token (legacy)
    if (webToken && req.query.token === webToken) {
      req.authenticated = true;
      return next();
    }

    // Check JWT cookie
    const cookie = parseCookie(req, COOKIE_NAME);
    if (cookie) {
      try {
        const user = jwt.verify(cookie, jwtSecret);
        req.user = {
          email: user.email,
          name: user.name,
          picture: user.picture,
          domain: user.domain,
          role: isAdmin(user.email) ? 'admin' : 'user',
        };
        req.authenticated = true;
        return next();
      } catch {
        // Invalid/expired JWT — fall through
      }
    }

    // No auth provided
    if (!ssoEnabled) {
      // When SSO is disabled, allow everything (dev mode)
      return next();
    }

    // SSO is enabled but no valid auth — check if this is a browser or API request
    const accept = req.headers.accept || '';
    if (accept.includes('text/html') && !req.path.startsWith('/api/')) {
      // Browser request — redirect to login
      return res.redirect('/login');
    }

    // API request — return 401
    res.status(401).json({ error: 'Authentication required' });
  };
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Parse a cookie value from the request.
 */
function parseCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').find(c => c.trim().startsWith(`${name}=`));
  if (!match) return null;
  return match.split('=').slice(1).join('=').trim();
}

/**
 * Decode a JWT payload without verification (for Google's id_token
 * which we trust because we just exchanged the code directly with Google).
 */
function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}

/**
 * Exchange an authorization code for tokens via Google's token endpoint.
 */
function exchangeCode(code, clientId, clientSecret, redirectUri) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`Token exchange failed: ${parsed.error_description || parsed.error || res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (err) {
          reject(new Error(`Failed to parse token response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Middleware: require admin role.
 * API key requests bypass this (service-to-service is always admin).
 * When SSO is disabled, everyone is admin.
 */
function requireAdmin(req, res, next) {
  // API keys and WEB_TOKEN are always admin-level
  if (req.apiKey || !process.env.ENABLE_GOOGLE_SSO) return next();
  // Check user role
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

module.exports = { createAuthRoutes, createAuthMiddleware, requireAdmin };
