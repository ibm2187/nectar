const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
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
  const { releases, customers, discovery, jiraSync, customerStore, envPoller, apiKeys, taskQueue, userStore } = services;
  const port = parseInt(process.env.WEB_PORT) || 4000;
  const token = process.env.WEB_TOKEN;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ── Auth routes (before auth middleware) ──────────────
  const { createAuthRoutes, createAuthMiddleware } = require('../api/auth');
  app.use('/api/auth', createAuthRoutes({ userStore }));

  // ── Auth middleware (conditional on ENABLE_GOOGLE_SSO) ─
  const authMiddleware = createAuthMiddleware(apiKeys, userStore);
  app.use(authMiddleware);

  // ── Rate limiting ────────────────────────────────────
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 200,              // 200 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
  app.use('/api/', apiLimiter);

  // Stricter limit for mutation endpoints
  const mutateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many write requests, please slow down' },
  });
  app.use('/api/releases', (req, res, next) => {
    if (req.method !== 'GET') return mutateLimiter(req, res, next);
    next();
  });

  // ── REST API ──────────────────────────────────────────
  const apiRoutes = require('../api/routes');
  app.use('/api', apiRoutes(services, config));

  // ── Webhooks (no auth) ────────────────────────────────
  const webhookRoutes = require('../api/webhooks');
  app.use('/api/webhooks', webhookRoutes(releases, services.github, config));

  // ── Health check ──────────────────────────────────────
  app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      releases: releases.releases.size,
      customers: customerStore ? customerStore.customers.size : 0,
      environments: customerStore ? customerStore.environments.size : 0,
      wsClients: clients.size,
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      },
      integrations: {
        jira: services.jira.isConfigured(),
        github: services.github.isConfigured(),
        jenkins: services.jenkins.isConfigured(),
        slack: services.slack.isConfigured(),
      },
      lastSync: {
        jira: jiraSync ? jiraSync.getStatus() : null,
        discovery: discovery ? discovery.getStatus() : null,
        envPoller: envPoller ? envPoller.getStatus() : null,
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
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws') || req.path.startsWith('/mcp')) return next();
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

  // Server-side heartbeat: ping every 30s, terminate unresponsive clients
  const HEARTBEAT_INTERVAL = 30000;
  const heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (ws._nectarAlive === false) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws._nectarAlive = false;
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('connection', (ws) => {
    let authenticated = !token;
    ws._nectarAlive = true;

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

      ws._nectarAlive = true;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      if (msg.type === 'pong') {
        // Client responded to our heartbeat — already marked alive above
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
        jiraProject: (config.jira && config.jira.project) || 'DEV',
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

  // ── Task queue events → WebSocket broadcasts ──────────
  if (taskQueue) {
    taskQueue.on('task:created', (task) =>
      broadcast({ type: 'task:created', task })
    );
    taskQueue.on('task:claimed', (task) =>
      broadcast({ type: 'task:updated', task })
    );
    taskQueue.on('task:completed', (task) =>
      broadcast({ type: 'task:updated', task })
    );
    taskQueue.on('task:failed', (task) =>
      broadcast({ type: 'task:updated', task })
    );
  }

  // ── MCP server (for Hive integration) ─────────────────
  const { mountMcp } = require('../mcp/server');
  mountMcp(app, '/mcp', {
    customerStore,
    releases,
    releaseTruth: services.releaseTruth,
    taskQueue,
    apiKeys,
  });

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
      clearInterval(heartbeatTimer);
      httpServer.close();
      for (const ws of clients) ws.close();
    },
  };
}

module.exports = { createWebServer };
