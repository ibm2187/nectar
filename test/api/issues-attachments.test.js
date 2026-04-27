import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const ApprovalEngine = require('../../src/core/approvals');
const ThemeConfig = require('../../src/core/theme-config');
const TicketStore = require('../../src/core/ticket-store');
const createRoutes = require('../../src/api/routes');
const { createTestDb } = require('../../src/core/db');

// Minimal services + a configured GitHub mock that captures calls.
function createServicesWithGithub(githubOverrides = {}) {
  const db = createTestDb();
  const audit = new Audit({ db });
  const releases = new ReleaseManager(audit, { db });
  const ticketStore = new TicketStore({ db });
  releases.setTicketStore(ticketStore);
  const themeConfig = new ThemeConfig({ db });

  const github = {
    isConfigured: () => true,
    listIssues: vi.fn(),
    createIssue: vi.fn(async ({ title, body }) => ({
      number: 1,
      title,
      body,
      html_url: 'https://github.com/mavencare/nectar/issues/1',
      state: 'open',
      created_at: '2026-04-27T00:00:00Z',
    })),
    ensureBranch: vi.fn(async () => ({ created: false })),
    uploadContent: vi.fn(async ({ path }) => ({
      content: { download_url: `https://raw.githubusercontent.com/mavencare/nectar/issue-attachments/${path}` },
    })),
    ...githubOverrides,
  };

  return {
    releases,
    ticketStore,
    repoManager: { getStatus: () => [] },
    github,
    risk: { assess: vi.fn() },
    validator: { validate: vi.fn() },
    approvals: new ApprovalEngine(releases, {
      approvals: { required: ['engineering', 'qa'], highRiskAdditional: ['product'] },
    }),
    customers: {},
    cherryPickWatcher: { syncRelease: vi.fn() },
    discovery: { getStatus: () => ({}), run: vi.fn() },
    jiraSync: { getStatus: () => ({}), run: vi.fn() },
    releaseTruth: { compute: vi.fn(), computeImpact: vi.fn() },
    customerStore: {
      listCustomers: () => [],
      listVisibleCustomers: () => [],
      listEnvironments: () => [],
      getCustomer: () => null,
      updateCustomer: vi.fn(),
      getEnvironment: () => null,
      listDeployments: () => [],
      setManualVersionBulk: vi.fn(() => []),
      setManualVersion: vi.fn(),
    },
    webplatformScanner: { scan: vi.fn(), getStatus: () => null },
    envPoller: { run: vi.fn(), getStatus: () => ({}) },
    themeConfig,
  };
}

function createTestApp(services) {
  const app = express();
  app.use('/api', createRoutes(services, {}));
  return app;
}

async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// 1×1 transparent PNG, base64.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('POST /api/issues — attachments', () => {
  let services;
  let app;

  beforeEach(() => {
    services = createServicesWithGithub();
    app = createTestApp(services);
  });

  it('creates issue with no attachments unchanged', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 'plain issue',
      body: 'hello',
      labels: ['bug'],
    });
    expect(res.status).toBe(201);
    expect(services.github.ensureBranch).not.toHaveBeenCalled();
    expect(services.github.uploadContent).not.toHaveBeenCalled();
    expect(services.github.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'plain issue', body: 'hello', labels: ['bug'] })
    );
  });

  it('uploads each attachment and appends markdown image embeds to body', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 'with image',
      body: 'see attached',
      labels: [],
      attachments: [
        { filename: 'screenshot.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
        { filename: 'logo.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
      ],
    });
    expect(res.status).toBe(201);
    expect(services.github.ensureBranch).toHaveBeenCalledWith('issue-attachments', 'mavencare/nectar');
    expect(services.github.uploadContent).toHaveBeenCalledTimes(2);
    const createCall = services.github.createIssue.mock.calls[0][0];
    expect(createCall.body).toMatch(/^see attached\n\n!\[screenshot\.png\]\(https:\/\/raw\..+\)\n!\[logo\.png\]\(https:\/\/raw\..+\)$/);
  });

  it('uses embeds as the entire body when no description was given', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 'image only',
      body: '',
      attachments: [
        { filename: 'a.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
      ],
    });
    expect(res.status).toBe(201);
    const createCall = services.github.createIssue.mock.calls[0][0];
    expect(createCall.body).toMatch(/^!\[a\.png\]\(https:\/\/raw\..+\)$/);
  });

  it('rejects non-image MIME types', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [
        { filename: 'bad.exe', contentType: 'application/octet-stream', dataBase64: TINY_PNG_B64 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contentType/);
    expect(services.github.uploadContent).not.toHaveBeenCalled();
    expect(services.github.createIssue).not.toHaveBeenCalled();
  });

  it('rejects when more than 5 attachments are sent', async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      filename: `f${i}.png`, contentType: 'image/png', dataBase64: TINY_PNG_B64,
    }));
    const res = await request(app, 'POST', '/api/issues', { title: 't', attachments: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 5/);
  });

  it('rejects when an attachment exceeds the per-file size cap', async () => {
    // 6 MB of base64-encoded zeros decodes to ~4.5 MB — push over 5 MB by sending 8 MB of base64.
    const huge = 'A'.repeat(8 * 1024 * 1024);
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [{ filename: 'big.png', contentType: 'image/png', dataBase64: huge }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds/);
    expect(services.github.uploadContent).not.toHaveBeenCalled();
  });

  it('rejects when title is missing even if attachments are valid', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: '',
      attachments: [{ filename: 'a.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
    expect(services.github.uploadContent).not.toHaveBeenCalled();
  });

  it('returns 503 when GitHub is not configured', async () => {
    services.github.isConfigured = () => false;
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [{ filename: 'a.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 }],
    });
    expect(res.status).toBe(503);
  });
});
