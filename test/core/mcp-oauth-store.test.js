import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';

const { McpOAuthStore } = require('../../src/core/mcp-oauth-store');
const { createTestDb } = require('../../src/core/db');

/**
 * Build a store on a fresh in-memory DB with controllable time so we
 * can reliably test expiry / TTL behavior without sleeping.
 */
function setup() {
  const db = createTestDb();
  let now = Date.parse('2026-04-26T00:00:00Z');
  const store = new McpOAuthStore({ db, now: () => now });
  const advanceMs = (ms) => { now += ms; };
  return { db, store, advanceMs };
}

function s256(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

describe('McpOAuthStore — clients', () => {
  it('registers a public PKCE client (no secret)', () => {
    const { store } = setup();
    const c = store.registerClient({
      clientName: 'Claude Desktop',
      redirectUris: ['http://localhost:1234/cb'],
      tokenEndpointAuthMethod: 'none',
    });
    expect(c.clientId).toMatch(/^mcpc_/);
    expect(c.clientSecret).toBeNull();
    expect(c.isPublic).toBe(true);
    expect(c.redirectUris).toEqual(['http://localhost:1234/cb']);
  });

  it('registers a confidential client and returns a one-shot secret', () => {
    const { store } = setup();
    const c = store.registerClient({
      clientName: 'Hive',
      redirectUris: ['https://hive.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    });
    expect(c.clientSecret).toMatch(/^mcps_/);
    expect(c.isPublic).toBe(false);
    expect(store.verifyClientSecret(c.clientId, c.clientSecret)).toBe(true);
    expect(store.verifyClientSecret(c.clientId, 'wrong')).toBe(false);
  });

  it('rejects registration without redirect_uris', () => {
    const { store } = setup();
    expect(() => store.registerClient({ clientName: 'x', redirectUris: [] })).toThrow(/redirectUris/);
  });
});

describe('McpOAuthStore — authorization code flow', () => {
  it('issues a one-time-use code that survives PKCE verification', () => {
    const { store } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'verifier-1234567890123456789012345678901234567890';
    const code = store.issueCode({
      clientId: c.clientId, userEmail: 'a@b.com', redirectUri: 'http://x/cb',
      codeChallenge: s256(verifier), codeChallengeMethod: 'S256', scope: 'mcp',
    });

    const redeemed = store.redeemCode({
      code, clientId: c.clientId, redirectUri: 'http://x/cb', codeVerifier: verifier,
    });
    expect(redeemed.userEmail).toBe('a@b.com');
    expect(redeemed.scope).toBe('mcp');

    // Second redemption fails
    expect(() => store.redeemCode({
      code, clientId: c.clientId, redirectUri: 'http://x/cb', codeVerifier: verifier,
    })).toThrow(/already redeemed/);
  });

  it('rejects PKCE verifier that does not hash to the stored challenge', () => {
    const { store } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'real-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const code = store.issueCode({
      clientId: c.clientId, userEmail: 'a@b.com', redirectUri: 'http://x/cb',
      codeChallenge: s256(verifier), codeChallengeMethod: 'S256',
    });
    expect(() => store.redeemCode({
      code, clientId: c.clientId, redirectUri: 'http://x/cb', codeVerifier: 'wrong-verifier-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
    })).toThrow(/PKCE verifier mismatch/);
  });

  it('rejects redemption with mismatched redirect_uri', () => {
    const { store } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'v0123456789012345678901234567890123456789012345';
    const code = store.issueCode({
      clientId: c.clientId, userEmail: 'a@b.com', redirectUri: 'http://x/cb',
      codeChallenge: s256(verifier), codeChallengeMethod: 'S256',
    });
    expect(() => store.redeemCode({
      code, clientId: c.clientId, redirectUri: 'http://different/cb', codeVerifier: verifier,
    })).toThrow(/redirect_uri mismatch/);
  });

  it('expires codes after 5 minutes', () => {
    const { store, advanceMs } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const verifier = 'v0123456789012345678901234567890123456789012345';
    const code = store.issueCode({
      clientId: c.clientId, userEmail: 'a@b.com', redirectUri: 'http://x/cb',
      codeChallenge: s256(verifier), codeChallengeMethod: 'S256',
    });
    advanceMs(6 * 60 * 1000);
    expect(() => store.redeemCode({
      code, clientId: c.clientId, redirectUri: 'http://x/cb', codeVerifier: verifier,
    })).toThrow(/expired/);
  });
});

describe('McpOAuthStore — tokens', () => {
  it('issues access + refresh tokens that resolve to the same user', () => {
    const { store } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const t = store.issueTokenPair({ clientId: c.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    expect(t.accessToken).toMatch(/^mcpat_/);
    expect(t.refreshToken).toMatch(/^mcprt_/);

    const principal = store.resolveAccessToken(t.accessToken);
    expect(principal.userEmail).toBe('a@b.com');
    expect(principal.clientId).toBe(c.clientId);
    expect(principal.scope).toBe('mcp');
  });

  it('rejects expired access tokens', () => {
    const { store, advanceMs } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const t = store.issueTokenPair({ clientId: c.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    advanceMs(2 * 60 * 60 * 1000); // 2 hours > 1 hour TTL
    expect(store.resolveAccessToken(t.accessToken)).toBeNull();
  });

  it('refresh issues a fresh access token and revokes the old one', () => {
    const { store } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const orig = store.issueTokenPair({ clientId: c.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    expect(store.resolveAccessToken(orig.accessToken)).toBeTruthy();

    const fresh = store.refreshAccessToken(orig.refreshToken, c.clientId);
    expect(fresh.accessToken).not.toBe(orig.accessToken);
    expect(store.resolveAccessToken(fresh.accessToken)).toBeTruthy();
    // Old access token now revoked (refresh-rotation cascade)
    expect(store.resolveAccessToken(orig.accessToken)).toBeNull();
  });

  it('rejects refresh after the refresh token expires', () => {
    const { store, advanceMs } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const t = store.issueTokenPair({ clientId: c.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    advanceMs(31 * 24 * 60 * 60 * 1000); // 31 days > 30 day TTL
    expect(() => store.refreshAccessToken(t.refreshToken, c.clientId)).toThrow(/expired/);
  });

  it('revokeUserClient kills future requests for that user/client pair', () => {
    const { store } = setup();
    const c = store.registerClient({ clientName: 't', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const t = store.issueTokenPair({ clientId: c.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    expect(store.resolveAccessToken(t.accessToken)).toBeTruthy();

    const revoked = store.revokeUserClient('a@b.com', c.clientId);
    expect(revoked).toBeGreaterThan(0);
    expect(store.resolveAccessToken(t.accessToken)).toBeNull();
    expect(() => store.refreshAccessToken(t.refreshToken, c.clientId)).toThrow(/revoked/);
  });

  it('rejects an unknown bearer token', () => {
    const { store } = setup();
    expect(store.resolveAccessToken('mcpat_garbage')).toBeNull();
    expect(store.resolveAccessToken(null)).toBeNull();
    expect(store.resolveAccessToken('')).toBeNull();
  });
});

describe('McpOAuthStore — connections list', () => {
  it('lists active client connections for a user', () => {
    const { store } = setup();
    const c1 = store.registerClient({ clientName: 'Claude Desktop', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const c2 = store.registerClient({ clientName: 'Hive', redirectUris: ['http://y/cb'], tokenEndpointAuthMethod: 'none' });
    store.issueTokenPair({ clientId: c1.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    store.issueTokenPair({ clientId: c2.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    store.issueTokenPair({ clientId: c2.clientId, userEmail: 'other@b.com', scope: 'mcp' });

    const conns = store.listConnectionsForUser('a@b.com');
    expect(conns).toHaveLength(2);
    expect(conns.map(c => c.clientName).sort()).toEqual(['Claude Desktop', 'Hive']);
  });

  it('hides revoked connections', () => {
    const { store } = setup();
    const c1 = store.registerClient({ clientName: 'X', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    store.issueTokenPair({ clientId: c1.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    store.revokeUserClient('a@b.com', c1.clientId);
    expect(store.listConnectionsForUser('a@b.com')).toHaveLength(0);
  });
});
