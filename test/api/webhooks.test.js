import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import express from 'express';

const Audit = require('../../src/core/audit');
const ReleaseManager = require('../../src/core/release');
const createWebhookRoutes = require('../../src/api/webhooks');
const { createTestDb } = require('../../src/core/db');

async function request(app, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const bodyStr = JSON.stringify(body);
      const opts = {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

describe('Webhook Routes', () => {
  let app, releases, audit;

  beforeEach(() => {
    const db = createTestDb();
    audit = new Audit({ db });
    releases = new ReleaseManager(audit, { db });
    const github = {
      isConfigured: () => true,
      cherryPickLabel: 'cherry-pick',
      extractVersionFromBranch: (ref) => {
        const match = ref.match(/release\/(.+)/);
        return match ? match[1] : null;
      },
      parseCherryPickPR: (pr) => ({
        sha: pr.head?.sha || 'abc',
        prNumber: pr.number,
        jiraKeys: (pr.title || '').match(/\b(DEV|MAV)-\d+\b/g) || [],
      }),
    };
    const config = {};

    app = express();
    app.use(express.json());
    app.use('/api/webhooks', createWebhookRoutes(releases, github, config));
  });

  describe('POST /api/webhooks/github', () => {
    it('accepts PR events and returns ok', async () => {
      releases.create({ version: '4.2.0' });
      releases.update('4.2.0', { branch: 'release/4.2.0' });

      const body = {
        action: 'opened',
        pull_request: {
          number: 123,
          title: 'DEV-100 Fix bug',
          head: { sha: 'abc123' },
          base: { ref: 'release/4.2.0' },
          merged: false,
          labels: [{ name: 'cherry-pick' }],
        },
      };

      const res = await request(app, 'POST', '/api/webhooks/github', body, {
        'x-github-event': 'pull_request',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('rejects invalid signature when secret is set', async () => {
      // Set the secret env var
      const origSecret = process.env.GITHUB_WEBHOOK_SECRET;
      process.env.GITHUB_WEBHOOK_SECRET = 'mysecret';

      try {
        const body = { action: 'opened', pull_request: {} };
        const res = await request(app, 'POST', '/api/webhooks/github', body, {
          'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=wrong',
        });
        expect(res.status).toBe(401);
      } finally {
        if (origSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
        else process.env.GITHUB_WEBHOOK_SECRET = origSecret;
      }
    });

    it('accepts valid signature', async () => {
      const origSecret = process.env.GITHUB_WEBHOOK_SECRET;
      process.env.GITHUB_WEBHOOK_SECRET = 'mysecret';

      try {
        const body = { action: 'ping' };
        const bodyStr = JSON.stringify(body);
        const sig = 'sha256=' + crypto.createHmac('sha256', 'mysecret').update(bodyStr).digest('hex');

        const res = await request(app, 'POST', '/api/webhooks/github', body, {
          'x-github-event': 'ping',
          'x-hub-signature-256': sig,
        });
        expect(res.status).toBe(200);
      } finally {
        if (origSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
        else process.env.GITHUB_WEBHOOK_SECRET = origSecret;
      }
    });
  });

  describe('POST /api/webhooks/jira', () => {
    it('accepts issue updated events', async () => {
      releases.create({ version: '4.2.0' });
      releases.addTicket('4.2.0', { key: 'DEV-100', summary: 'Test', state: 'pending' });

      const body = {
        webhookEvent: 'jira:issue_updated',
        issue: {
          key: 'DEV-100',
          fields: {
            status: { name: 'Done' },
          },
        },
      };

      const res = await request(app, 'POST', '/api/webhooks/jira', body);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
