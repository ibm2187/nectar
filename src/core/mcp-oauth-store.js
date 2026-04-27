/**
 * McpOAuthStore — persistence for OAuth 2.1 clients, authorization
 * codes, and tokens used by the /mcp-oauth Streamable HTTP MCP.
 *
 * Tables: mcp_oauth_clients, mcp_oauth_codes, mcp_oauth_tokens.
 *
 * Tokens are never stored in plaintext — we keep the SHA-256 of the
 * opaque token string the client holds. Lookup is by hashing the
 * incoming bearer token and comparing.
 */

const crypto = require('crypto');
const { getDb } = require('./db');

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;            // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;                // 5 minutes

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Length-aware constant-time string compare. timingSafeEqual throws on
 * mismatched length, so guard first; also short-circuits when either
 * side is null/undefined. Used wherever we compare a user-supplied
 * value against a server-stored hash/challenge.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function randomToken(prefix, bytes = 32) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

class McpOAuthStore {
  /**
   * @param {object} [opts]
   * @param {import('better-sqlite3').Database} [opts.db]
   * @param {() => number} [opts.now] - injectable for tests
   */
  constructor(opts = {}) {
    this.db = opts.db || getDb();
    this.now = opts.now || (() => Date.now());
  }

  // ── Clients ────────────────────────────────────────────────

  /**
   * Register a new OAuth client. For DCR, leave registeredByEmail null.
   * For human-registered (admin UI) clients, pass the admin email.
   *
   * @param {object} input
   * @returns {{ clientId: string, clientSecret: string|null, ...meta }}
   */
  registerClient(input = {}) {
    const clientId = randomToken('mcpc', 16);
    const isPublic = input.tokenEndpointAuthMethod === 'none' || !input.tokenEndpointAuthMethod;
    const clientSecret = isPublic ? null : randomToken('mcps', 24);
    const clientSecretHash = clientSecret ? sha256(clientSecret) : null;

    const redirectUris = Array.isArray(input.redirectUris) ? input.redirectUris : [];
    if (redirectUris.length === 0) throw new Error('redirectUris is required');

    const row = {
      clientId,
      clientSecretHash,
      clientName: input.clientName || 'Unnamed MCP client',
      redirectUris: JSON.stringify(redirectUris),
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod || 'none',
      grantTypes: JSON.stringify(input.grantTypes || ['authorization_code', 'refresh_token']),
      responseTypes: JSON.stringify(input.responseTypes || ['code']),
      scope: input.scope || 'mcp',
      registeredByEmail: input.registeredByEmail || null,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.db.prepare(`
      INSERT INTO mcp_oauth_clients
        (clientId, clientSecretHash, clientName, redirectUris,
         tokenEndpointAuthMethod, grantTypes, responseTypes, scope,
         registeredByEmail, createdAt)
      VALUES
        (@clientId, @clientSecretHash, @clientName, @redirectUris,
         @tokenEndpointAuthMethod, @grantTypes, @responseTypes, @scope,
         @registeredByEmail, @createdAt)
    `).run(row);

    return {
      ...this._rowToClient(row),
      clientSecret, // returned ONCE — caller is responsible for forwarding
    };
  }

  getClient(clientId) {
    const row = this.db.prepare('SELECT * FROM mcp_oauth_clients WHERE clientId = ?').get(clientId);
    return row ? this._rowToClient(row) : null;
  }

  /** Verify a client_secret against the stored hash, in constant time. */
  verifyClientSecret(clientId, secret) {
    const row = this.db.prepare('SELECT clientSecretHash FROM mcp_oauth_clients WHERE clientId = ?').get(clientId);
    if (!row || !row.clientSecretHash) return false;
    return safeEqual(row.clientSecretHash, sha256(secret));
  }

  touchClient(clientId) {
    this.db.prepare('UPDATE mcp_oauth_clients SET lastUsedAt = ? WHERE clientId = ?')
      .run(new Date(this.now()).toISOString(), clientId);
  }

  _rowToClient(row) {
    return {
      clientId: row.clientId,
      clientName: row.clientName,
      redirectUris: JSON.parse(row.redirectUris),
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
      grantTypes: JSON.parse(row.grantTypes),
      responseTypes: JSON.parse(row.responseTypes),
      scope: row.scope,
      registeredByEmail: row.registeredByEmail,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      isPublic: !row.clientSecretHash,
    };
  }

  // ── Authorization codes ────────────────────────────────────

  /**
   * Issue a fresh authorization code for a (client, user) pair. The
   * code itself is opaque — the client receives it via 302 redirect to
   * its registered redirect_uri.
   *
   * @returns {string} the code value
   */
  issueCode({ clientId, userEmail, redirectUri, codeChallenge, scope }) {
    // S256 is the only method we issue with — discovery doc advertises
    // S256-only; the consent POST's body method field is ignored to
    // prevent client-controlled downgrade to "plain".
    if (!codeChallenge) throw new Error('PKCE codeChallenge is required');
    const code = randomToken('mcpcode', 24);
    this.db.prepare(`
      INSERT INTO mcp_oauth_codes
        (code, clientId, userEmail, redirectUri, codeChallenge,
         codeChallengeMethod, scope, expiresAt, createdAt)
      VALUES (?, ?, ?, ?, ?, 'S256', ?, ?, ?)
    `).run(
      code, clientId, userEmail, redirectUri, codeChallenge,
      scope || null,
      new Date(this.now() + AUTH_CODE_TTL_MS).toISOString(),
      new Date(this.now()).toISOString(),
    );
    return code;
  }

  /**
   * Redeem an authorization code. Single-use: subsequent calls return
   * an error. Verifies PKCE (S256). Rejects expired codes.
   *
   * @returns {object} the code record (without the code value)
   * @throws {Error} on any validation failure
   */
  redeemCode({ code, clientId, redirectUri, codeVerifier }) {
    const row = this.db.prepare('SELECT * FROM mcp_oauth_codes WHERE code = ?').get(code);
    if (!row) throw oauthErr('invalid_grant', 'Unknown or expired code');
    if (row.usedAt) throw oauthErr('invalid_grant', 'Authorization code already redeemed');
    if (new Date(row.expiresAt).getTime() < this.now()) throw oauthErr('invalid_grant', 'Authorization code expired');
    if (row.clientId !== clientId) throw oauthErr('invalid_grant', 'client_id mismatch');
    if (row.redirectUri !== redirectUri) throw oauthErr('invalid_grant', 'redirect_uri mismatch');
    if (!codeVerifier) throw oauthErr('invalid_request', 'code_verifier is required (PKCE)');

    // Always S256 — issueCode hardcodes it; legacy 'plain' rows would
    // have been impossible to create. Compute and compare in constant
    // time even though both inputs are fixed-length base64url.
    const expectedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    if (!safeEqual(expectedChallenge, row.codeChallenge)) {
      throw oauthErr('invalid_grant', 'PKCE verifier mismatch');
    }

    // Mark used (one-shot)
    this.db.prepare('UPDATE mcp_oauth_codes SET usedAt = ? WHERE code = ?')
      .run(new Date(this.now()).toISOString(), code);

    return {
      clientId: row.clientId,
      userEmail: row.userEmail,
      scope: row.scope,
    };
  }

  /** Sweep expired codes (called opportunistically). */
  cleanupExpired() {
    const cutoff = new Date(this.now() - 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM mcp_oauth_codes WHERE expiresAt < ?').run(cutoff);
    this.db.prepare('DELETE FROM mcp_oauth_tokens WHERE expiresAt < ? AND revokedAt IS NULL').run(cutoff);
  }

  // ── Tokens ─────────────────────────────────────────────────

  /**
   * Issue an access + refresh token pair for the (client, user) pair.
   * Returns both raw token strings to the caller (only chance — we
   * only store hashes).
   */
  issueTokenPair({ clientId, userEmail, scope }) {
    const accessToken = randomToken('mcpat', 32);
    const refreshToken = randomToken('mcprt', 32);
    const accessHash = sha256(accessToken);
    const refreshHash = sha256(refreshToken);
    const nowIso = new Date(this.now()).toISOString();

    const insert = this.db.prepare(`
      INSERT INTO mcp_oauth_tokens
        (tokenHash, tokenType, clientId, userEmail, scope, expiresAt, parentTokenHash, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(refreshHash, 'refresh', clientId, userEmail, scope || null,
      new Date(this.now() + REFRESH_TOKEN_TTL_MS).toISOString(), null, nowIso);
    insert.run(accessHash, 'access', clientId, userEmail, scope || null,
      new Date(this.now() + ACCESS_TOKEN_TTL_MS).toISOString(), refreshHash, nowIso);

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: scope || null,
    };
  }

  /**
   * Validate a presented access token. Returns the principal context
   * if valid, or null otherwise. Rejects expired and revoked tokens.
   */
  resolveAccessToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = sha256(rawToken);
    const row = this.db.prepare(`
      SELECT * FROM mcp_oauth_tokens WHERE tokenHash = ? AND tokenType = 'access'
    `).get(tokenHash);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (new Date(row.expiresAt).getTime() < this.now()) return null;
    return {
      clientId: row.clientId,
      userEmail: row.userEmail,
      scope: row.scope,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Refresh an access token. Revokes the prior access token in the
   * chain and issues a fresh access token. The refresh token itself
   * stays valid until its own expiry.
   */
  refreshAccessToken(rawRefreshToken, clientId) {
    const refreshHash = sha256(rawRefreshToken);
    const row = this.db.prepare(`
      SELECT * FROM mcp_oauth_tokens WHERE tokenHash = ? AND tokenType = 'refresh'
    `).get(refreshHash);
    if (!row) throw oauthErr('invalid_grant', 'Unknown refresh token');
    if (row.revokedAt) throw oauthErr('invalid_grant', 'Refresh token revoked');
    if (new Date(row.expiresAt).getTime() < this.now()) throw oauthErr('invalid_grant', 'Refresh token expired');
    if (row.clientId !== clientId) throw oauthErr('invalid_grant', 'client_id mismatch');

    // Revoke any outstanding access tokens chained to this refresh
    const revokedAt = new Date(this.now()).toISOString();
    this.db.prepare(`
      UPDATE mcp_oauth_tokens SET revokedAt = ?
      WHERE parentTokenHash = ? AND tokenType = 'access' AND revokedAt IS NULL
    `).run(revokedAt, refreshHash);

    // Mint a fresh access token bound to the same refresh chain
    const accessToken = randomToken('mcpat', 32);
    const accessHash = sha256(accessToken);
    this.db.prepare(`
      INSERT INTO mcp_oauth_tokens
        (tokenHash, tokenType, clientId, userEmail, scope, expiresAt, parentTokenHash, createdAt)
      VALUES (?, 'access', ?, ?, ?, ?, ?, ?)
    `).run(accessHash, row.clientId, row.userEmail, row.scope,
      new Date(this.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshHash, revokedAt);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: row.scope,
    };
  }

  /** List a user's active (unrevoked, unexpired) tokens — for the
   *  Connected Apps UI. Groups by client. */
  listConnectionsForUser(email) {
    const rows = this.db.prepare(`
      SELECT t.clientId, c.clientName, MIN(t.createdAt) AS firstIssuedAt,
             MAX(t.createdAt) AS lastIssuedAt
      FROM mcp_oauth_tokens t
      LEFT JOIN mcp_oauth_clients c ON c.clientId = t.clientId
      WHERE t.userEmail = ? AND t.revokedAt IS NULL AND t.expiresAt > ?
      GROUP BY t.clientId, c.clientName
      ORDER BY MAX(t.createdAt) DESC
    `).all(email, new Date(this.now()).toISOString());
    return rows;
  }

  /** Revoke every outstanding token for a (user, client) pair. */
  revokeUserClient(email, clientId) {
    const result = this.db.prepare(`
      UPDATE mcp_oauth_tokens SET revokedAt = ?
      WHERE userEmail = ? AND clientId = ? AND revokedAt IS NULL
    `).run(new Date(this.now()).toISOString(), email, clientId);
    return result.changes;
  }
}

function oauthErr(code, description) {
  const err = new Error(description || code);
  err.oauthError = code;
  err.oauthErrorDescription = description || undefined;
  return err;
}

module.exports = { McpOAuthStore, sha256, randomToken, safeEqual };
