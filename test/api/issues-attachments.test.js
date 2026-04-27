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

// Mirror src/web/server.js parser layering: a 1mb global JSON parser that
// skips POST /api/issues so the route can apply its own larger parser.
// Without this mirror, route-scoped body limits are dead code and bugs
// like the per-route 8mb parser being shadowed by the 1mb global slip
// through the suite undetected.
function createTestApp(services) {
  const app = express();
  const defaultJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/issues') return next();
    return defaultJson(req, res, next);
  });
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
    expect(createCall.body).toContain('see attached');
    expect(createCall.body).toMatch(/!\[screenshot\.png\]\(https:\/\/raw\./);
    expect(createCall.body).toMatch(/!\[logo\.png\]\(https:\/\/raw\./);
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

  it('treats whitespace-only body the same as empty body', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      body: '   \n\t ',
      attachments: [{ filename: 'a.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 }],
    });
    expect(res.status).toBe(201);
    const createCall = services.github.createIssue.mock.calls[0][0];
    expect(createCall.body.startsWith('!')).toBe(true);
  });

  it('escapes filename characters that would break the markdown embed', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [
        { filename: 'evil](javascript:1)x.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
      ],
    });
    expect(res.status).toBe(201);
    const createCall = services.github.createIssue.mock.calls[0][0];
    // The `]` from the malicious filename must be backslash-escaped so it
    // can't close the markdown alt and inject a fake link target.
    expect(createCall.body).toMatch(/!\[evil\\\]\(javascript:1\)x\.png\]\(https:\/\/raw\./);
  });

  it('sanitizes filename in the upload path (rejects path traversal segments)', async () => {
    await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [
        { filename: '../../etc/passwd', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
      ],
    });
    const uploadCall = services.github.uploadContent.mock.calls[0][0];
    // Path must stay under uploads/ — no `..`, no `/etc/`.
    expect(uploadCall.path).toMatch(/^uploads\/\d{4}\/\d{2}\//);
    expect(uploadCall.path).not.toMatch(/\.\./);
    expect(uploadCall.path).not.toMatch(/\/etc\//);
  });

  it('does not call createIssue if a mid-batch upload fails', async () => {
    let calls = 0;
    services.github.uploadContent = vi.fn(async ({ path }) => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return { content: { download_url: `https://raw/${path}` } };
    });
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [
        { filename: 'a.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
        { filename: 'b.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
        { filename: 'c.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 },
      ],
    });
    expect(res.status).toBe(500);
    expect(services.github.createIssue).not.toHaveBeenCalled();
  });

  it('rejects when uploadContent returns no download_url', async () => {
    services.github.uploadContent = vi.fn(async () => ({ content: {} }));
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [{ filename: 'a.png', contentType: 'image/png', dataBase64: TINY_PNG_B64 }],
    });
    expect(res.status).toBe(500);
    expect(services.github.createIssue).not.toHaveBeenCalled();
  });

  it('rejects non-array attachments', async () => {
    const res = await request(app, 'POST', '/api/issues', { title: 't', attachments: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/);
  });

  it('rejects attachment entries missing required fields', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [{ contentType: 'image/png', dataBase64: TINY_PNG_B64 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filename/);
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
    // 2 MB of base64 decodes to ~1.5 MB — over the 1 MB per-file cap.
    const huge = 'A'.repeat(2 * 1024 * 1024);
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

  it('accepts an attachment near the documented 1 MB cap (route-scoped parser is live)', async () => {
    // Build ~1 MB of valid base64. 1 MB = 1048576 bytes raw → 1398104 base64 chars
    // (must be a multiple of 4). 1398104 / 4 * 3 = 1048578 → just over the cap by
    // 2 bytes; trim to 1048572 bytes (1398096 base64 chars) to land safely under.
    const rawBytes = 1048572;
    const b64Len = Math.ceil(rawBytes / 3) * 4; // 1398096
    const dataBase64 = 'A'.repeat(b64Len);
    const res = await request(app, 'POST', '/api/issues', {
      title: 'big attachment',
      attachments: [{ filename: 'big.png', contentType: 'image/png', dataBase64 }],
    });
    expect(res.status).toBe(201);
    expect(services.github.uploadContent).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed base64 payload', async () => {
    const res = await request(app, 'POST', '/api/issues', {
      title: 't',
      attachments: [{ filename: 'a.png', contentType: 'image/png', dataBase64: 'not!valid base64@@@' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base64/);
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
