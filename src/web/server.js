const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const log = require('../core/log');

/**
 * Create and start the web server (Express + WebSocket).
 *
 * @param {object} services - All initialized services
 * @param {object} config - nectar.config.js
 * @returns {{ app, httpServer, wss, close }}
 */
function createWebServer(services, config) {
  const { releases, customers, discovery, jiraSync, customerStore, envPoller } = services;
  const port = parseInt(process.env.WEB_PORT) || 4000;
  const token = process.env.WEB_TOKEN;

  const app = express();
  app.use(express.json());

  // ── REST API ──────────────────────────────────────────
  const apiRoutes = require('../api/routes');
  app.use('/api', apiRoutes(services, config));

  // ── Webhooks (no auth) ────────────────────────────────
  const webhookRoutes = require('../api/webhooks');
  app.use('/api/webhooks', webhookRoutes(releases, services.github, config));

  // ── Health check ──────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      releases: releases.releases.size,
      integrations: {
        jira: services.jira.isConfigured(),
        github: services.github.isConfigured(),
        jenkins: services.jenkins.isConfigured(),
        slack: services.slack.isConfigured(),
      },
    });
  });

  // ── Static files ──────────────────────────────────────
  // Serve React build from client/dist if it exists, otherwise serve legacy public/
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  const legacyPublic = path.join(__dirname, 'public');
  const staticDir = fs.existsSync(clientDist) ? clientDist : legacyPublic;

  app.use(express.static(staticDir, {
    setHeaders: (res, filePath) => {
      if (/\.(html|js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  // SPA fallback — serve index.html for client-side routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    const indexPath = path.join(staticDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });

  // ── WebSocket ─────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  wss.on('connection', (ws) => {
    let authenticated = !token;

    const authTimeout = token ? setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth timeout' }));
        ws.close();
      }
    }, 5000) : null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (!authenticated) {
        if (msg.type === 'auth' && msg.token === token) {
          authenticated = true;
          if (authTimeout) clearTimeout(authTimeout);
          clients.add(ws);
          ws.send(JSON.stringify({ type: 'auth', ok: true }));
          sendInitialState(ws);
        } else {
          ws.send(JSON.stringify({ type: 'auth', ok: false }));
          ws.close();
        }
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (authTimeout) clearTimeout(authTimeout);
    });

    if (authenticated) {
      clients.add(ws);
      sendInitialState(ws);
    }
  });

  function sendInitialState(ws) {
    ws.send(JSON.stringify({
      type: 'init',
      releases: releases.list(),
      customers: customerStore ? customerStore.listCustomers() : [],
      environments: customerStore ? customerStore.listEnvironments() : [],
      config: {
        jiraBaseUrl: (process.env.JIRA_BASE_URL || process.env.JIRA_URL || '').replace(/\/$/, ''),
      },
    }));
  }

  // ── Bridge events → WebSocket broadcasts ──────────────
  releases.on('release:created', (release) =>
    broadcast({ type: 'release:created', release })
  );
  releases.on('release:updated', (release) =>
    broadcast({ type: 'release:updated', release })
  );
  releases.on('release:transition', (release, transition) =>
    broadcast({ type: 'release:transition', release, transition })
  );
  releases.on('release:deleted', (version) =>
    broadcast({ type: 'release:deleted', version })
  );
  releases.on('cherry-pick:added', (release) =>
    broadcast({ type: 'release:updated', release })
  );
  releases.on('approval:added', (release) =>
    broadcast({ type: 'release:updated', release })
  );
  releases.on('deployment:added', (release) =>
    broadcast({ type: 'release:updated', release })
  );
  releases.on('deployment:updated', (release) =>
    broadcast({ type: 'release:updated', release })
  );
  releases.audit.on('entry', (entry) =>
    broadcast({ type: 'audit:entry', entry })
  );
  if (customerStore) {
    customerStore.on('customer:updated', (customer) =>
      broadcast({ type: 'customer:updated', customer })
    );
    customerStore.on('environment:updated', (env) =>
      broadcast({ type: 'environment:updated', environment: env })
    );
    customerStore.on('environment:version', (env, change) =>
      broadcast({ type: 'environment:version', environment: env, change })
    );
    customerStore.on('deployment:recorded', (deployment) =>
      broadcast({ type: 'deployment:recorded', deployment })
    );
    customerStore.on('scan:completed', (results) =>
      broadcast({
        type: 'webplatform:scan-completed',
        results,
        customers: customerStore.listCustomers(),
        environments: customerStore.listEnvironments(),
      })
    );
  }
  if (discovery) {
    discovery.on('discovery:completed', (results) =>
      broadcast({ type: 'discovery:completed', results, releases: releases.list() })
    );
  }
  if (jiraSync) {
    jiraSync.on('sync:completed', (results) =>
      broadcast({ type: 'jira:sync-completed', results, releases: releases.list() })
    );
  }
  if (envPoller) {
    envPoller.on('poll:completed', (results) =>
      broadcast({
        type: 'env:poll-completed',
        results,
        environments: customerStore.listEnvironments(),
      })
    );
  }

  // ── HTTP server with WebSocket upgrade ────────────────
  const httpServer = http.createServer(app);

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(port, () => {
    log.info(`Dashboard: http://localhost:${port}`);
    log.info(`WebSocket: ws://localhost:${port}/ws`);
    log.info(`API:       http://localhost:${port}/api/releases`);
  });

  return {
    app,
    httpServer,
    wss,
    broadcast,
    close: () => {
      httpServer.close();
      for (const ws of clients) ws.close();
    },
  };
}

module.exports = { createWebServer };
