import { describe, it, expect } from 'vitest';
import http from 'http';
import express from 'express';

const { mountMcpOAuth } = require('../../src/mcp/server-oauth');
const { McpOAuthStore } = require('../../src/core/mcp-oauth-store');
const { createTestDb } = require('../../src/core/db');

function fakeStores() {
  return {
    customerStore: {
      listCustomers: () => [],
      listEnvironments: () => [],
    },
    releases: { list: () => [], get: () => null, getTickets: () => [] },
    releaseTruth: { compute: async () => ({}), computeImpact: async () => ({}) },
    taskQueue: null,
  };
}

async function makeApp() {
  const db = createTestDb();
  const oauthStore = new McpOAuthStore({ db });
  const app = express();
  app.use(express.json());
  await mountMcpOAuth(app, '/mcp-oauth', { ...fakeStores(), oauthStore });
  return { app, oauthStore };
}

function request(app, method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const isJson = body && typeof body === 'object';
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
          if (data) { try { parsed = JSON.parse(data); } catch { /* keep raw */ } }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('mountMcpOAuth — bearer enforcement', () => {
  it('returns 401 + WWW-Authenticate when no bearer is present', async () => {
    const { app } = await makeApp();
    const res = await request(app, 'POST', '/mcp-oauth', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata/);
  });

  it('returns 401 for an unknown bearer', async () => {
    const { app } = await makeApp();
    const res = await request(app, 'POST', '/mcp-oauth', {
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      headers: { Authorization: 'Bearer mcpat_garbage' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('accepts a valid bearer and processes an initialize call', async () => {
    const { app, oauthStore } = await makeApp();
    const c = oauthStore.registerClient({ clientName: 'Test', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const t = oauthStore.issueTokenPair({ clientId: c.clientId, userEmail: 'alice@viv.com', scope: 'mcp' });

    const res = await request(app, 'POST', '/mcp-oauth', {
      body: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBe(200);
    // SSE response — split out the data line
    const text = String(res.body);
    expect(text).toMatch(/serverInfo/);
    expect(text).toMatch(/nectar-oauth/);
  });

  it('GET returns 405 with auth, 401 without', async () => {
    const { app, oauthStore } = await makeApp();
    const noAuth = await request(app, 'GET', '/mcp-oauth');
    expect(noAuth.status).toBe(401);

    const c = oauthStore.registerClient({ clientName: 'T', redirectUris: ['http://x/cb'], tokenEndpointAuthMethod: 'none' });
    const t = oauthStore.issueTokenPair({ clientId: c.clientId, userEmail: 'a@b.com', scope: 'mcp' });
    const ok = await request(app, 'GET', '/mcp-oauth', { headers: { Authorization: `Bearer ${t.accessToken}` } });
    expect(ok.status).toBe(405);
  });
});
