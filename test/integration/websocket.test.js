import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import http from 'http';
import { EventEmitter } from 'events';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');

// Create lightweight services once for all tests in this suite
function createMinimalServices() {
  const audit = new Audit();
  const releases = new ReleaseManager(audit);
  // Clear disk-loaded state
  releases.releases.clear();
  audit.entries = [];

  const customerStore = new EventEmitter();
  customerStore.listCustomers = () => [];
  customerStore.listEnvironments = () => [];
  customerStore.customers = new Map();
  customerStore.environments = new Map();

  const discovery = new EventEmitter();
  discovery.getStatus = () => ({});

  const jiraSync = new EventEmitter();
  jiraSync.getStatus = () => ({});

  const envPoller = new EventEmitter();
  envPoller.getStatus = () => ({});

  return {
    releases,
    repoManager: { getStatus: () => [] },
    jira: { isConfigured: () => false },
    github: { isConfigured: () => false },
    jenkins: { isConfigured: () => false },
    slack: { isConfigured: () => false },
    risk: { assess: vi.fn() },
    validator: { validate: vi.fn() },
    approvals: { approve: vi.fn(), getStatus: vi.fn() },
    customers: {},
    cherryPickWatcher: { syncRelease: vi.fn() },
    discovery,
    jiraSync,
    releaseTruth: { compute: vi.fn(), computeImpact: vi.fn() },
    customerStore,
    webplatformScanner: { scan: vi.fn(), getStatus: () => null },
    envPoller,
    themeConfig: {
      themes: [],
      unmappedLabel: 'Other',
      resolveComponent: () => 'Other',
      autoGenerate: vi.fn(),
      getConfig: () => ({ themes: [], unmappedLabel: 'Other', updatedAt: null }),
      setConfig: vi.fn(),
    },
  };
}

describe('WebSocket Integration', () => {
  let server, port;

  beforeAll(async () => {
    delete process.env.WEB_TOKEN;
    // Use a random high port to avoid conflicts with running Nectar instance
    process.env.WEB_PORT = String(40000 + Math.floor(Math.random() * 20000));
    const { createWebServer } = require('../../src/web/server');
    const services = createMinimalServices();
    const config = {};
    const webServer = createWebServer(services, config);
    server = webServer;

    await new Promise((resolve) => {
      const addr = webServer.httpServer.address();
      if (addr) { port = addr.port; return resolve(); }
      webServer.httpServer.on('listening', () => {
        port = webServer.httpServer.address().port;
        resolve();
      });
    });
  }, 30000);

  afterAll(() => {
    if (server) server.close();
  });

  it('sends init message on connection', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    const msg = await new Promise((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data)));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    expect(msg.type).toBe('init');
    expect(msg.releases).toBeDefined();
    expect(Array.isArray(msg.releases)).toBe(true);
    expect(msg.customers).toBeDefined();
    expect(msg.environments).toBeDefined();
    ws.close();
  });

  it('responds to ping with pong', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);

    // Wait for init
    await new Promise((resolve) => {
      ws.on('message', () => resolve());
    });

    ws.send(JSON.stringify({ type: 'ping' }));

    const pong = await new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'pong') resolve(msg);
      });
      setTimeout(() => reject(new Error('timeout')), 5000);
    });

    expect(pong.type).toBe('pong');
    ws.close();
  });

  it('health check returns status', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }).on('error', reject);
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptime).toBeGreaterThan(0);
    expect(res.body.integrations).toBeDefined();
    expect(res.body.memory).toBeDefined();
    expect(res.body.lastSync).toBeDefined();
  });
});
