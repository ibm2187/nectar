const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
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
  const {
    releases, customers, discovery, jiraSync, customerStore, envPoller,
    apiKeys, taskQueue, userStore, teamStore, ticketStore,
    incidents, alertRules, alertRouter,
    zohoStore, prStore, risk,
  } = services;
  const port = parseInt(process.env.WEB_PORT) || 4000;
  const token = process.env.WEB_TOKEN;

  const app = express();
  app.set('trust proxy', 1); // Trust first proxy (ALB) for X-Forwarded-For
  // Default 1mb JSON parser for the entire app — except POST /api/issues,
  // which carries base64 image attachments and applies its own larger
  // parser inside the route. Express body-parser is idempotent (sets
  // req._body on first run), so the global parser must not run for that
  // route or the route-scoped limit becomes dead code.
  const defaultJson = express.json({ limit: '1mb' });
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/issues') return next();
    return defaultJson(req, res, next);
  });
  // application/x-www-form-urlencoded — required by the MCP OAuth
  // consent form POST and by RFC 6749 token endpoints. Harmless for
  // every other route since they don't read req.body for form posts.
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── Gzip compression for API responses ────────────────
  // JSON responses (especially /releases/home) can be 1-2MB uncompressed.
  // Gzip typically reduces this 10x, cutting content download from 8s to <1s.
  app.use((req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes('gzip')) return next();

    const origJson = res.json.bind(res);
    res.json = function (body) {
      const raw = JSON.stringify(body);
      // Only compress responses larger than 1KB
      if (raw.length < 1024) {
        res.setHeader('Content-Type', 'application/json');
        return res.send(raw);
      }
      zlib.gzip(Buffer.from(raw), (err, compressed) => {
        if (err) {
          res.setHeader('Content-Type', 'application/json');
          return res.send(raw);
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', compressed.length);
        res.end(compressed);
      });
    };
    next();
  });

  // ── Auth routes (before auth middleware) ──────────────
  const { createAuthRoutes, createAuthMiddleware } = require('../api/auth');
  app.use('/api/auth', createAuthRoutes({ userStore, teamStore, ticketStore }));

  // ── MCP OAuth routes (before auth middleware) ─────────
  // The OAuth surface (.well-known + /mcp-oauth/oauth/*) MUST be
  // reachable without prior Nectar auth — the whole point is to bootstrap
  // identity for an external MCP client. /authorize enforces the Nectar
  // SSO session itself; everything else is intentionally public.
  const { createMcpOAuthRoutes } = require('../api/mcp-oauth');
  const { McpOAuthStore } = require('../core/mcp-oauth-store');
  const mcpOAuthStore = new McpOAuthStore();
  // Anonymous DCR + token endpoints could be flooded — a tighter limit
  // than the regular /api/ rate avoids filling mcp_oauth_clients with
  // bogus registrations. Same window as /api/ (60s) but lower ceiling.
  const mcpOAuthLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Slow down — try again in a minute' },
  });
  app.use('/mcp-oauth/oauth/', mcpOAuthLimiter);
  app.use(createMcpOAuthRoutes({ baseUrl: process.env.NECTAR_URL, store: mcpOAuthStore }));

  // ── Auth middleware (conditional on ENABLE_GOOGLE_SSO) ─
  const authMiddleware = createAuthMiddleware(apiKeys, userStore);
  app.use(authMiddleware);

  // ── Rate limiting ────────────────────────────────────
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 600,              // 600 requests per minute per IP
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
  const IssueNotifier = require('../api/issue-notifications');
  const issueNotifier =
    services.slack && services.peopleDirectory && services.notificationSettings
      ? new IssueNotifier({
          slack: services.slack,
          github: services.github,
          userStore: services.userStore,
          peopleDirectory: services.peopleDirectory,
          notificationSettings: services.notificationSettings,
          db: require('../core/db').getDb(),
          channel: process.env.NECTAR_SLACK_CHANNEL,
        })
      : null;
  app.use('/api/webhooks', webhookRoutes(releases, services.github, config, { issueNotifier }));

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
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws') ||
        req.path.startsWith('/mcp') || req.path.startsWith('/mcp-oauth') ||
        req.path.startsWith('/.well-known/')) return next();
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

  /**
   * Send a message only to WebSocket clients whose authenticated email
   * is in the given set. Clients without a resolved email (e.g. dev mode
   * with no JWT cookie) will not receive targeted messages — this is
   * intentional for access-control events which should only reach
   * identified users.
   *
   * @param {string[]} emails - target email addresses
   * @param {object} data - message payload
   */
  function broadcastTo(emails, data) {
    const targets = new Set(emails.map(e => e.toLowerCase()));
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === 1 && ws._nectarEmail && targets.has(ws._nectarEmail)) {
        ws.send(msg);
      }
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

  // Helper: resolve user email from JWT cookie in a WS upgrade request
  const jwt = require('jsonwebtoken');
  const jwtSecret = process.env.JWT_SECRET || 'nectar-default-jwt-secret';

  function resolveWsEmail(request) {
    // Try JWT cookie from the upgrade request
    try {
      const cookieHeader = request.headers && request.headers.cookie;
      if (cookieHeader) {
        const match = cookieHeader.split(';').find(c => c.trim().startsWith('nectar_session='));
        if (match) {
          const token = match.split('=').slice(1).join('=').trim();
          const payload = jwt.verify(token, jwtSecret);
          return payload.email ? payload.email.toLowerCase() : null;
        }
      }
    } catch { /* invalid JWT — ignore */ }
    return null;
  }

  wss.on('connection', (ws, upgradeRequest) => {
    let authenticated = !token;
    ws._nectarAlive = true;
    ws._nectarEmail = null;

    // Try to resolve email immediately from the upgrade request cookie
    ws._nectarEmail = resolveWsEmail(upgradeRequest);

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
          // Auth message may include email
          if (msg.email) ws._nectarEmail = msg.email.toLowerCase();
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

  // enrichRelease — slim version for WebSocket event broadcasts.
  // Individual release events don't need tickets or heavy enrichment.
  function enrichRelease(r) {
    return slimRelease(r);
  }

  // Slim release for WebSocket payloads — only fields the client needs
  // for list views, dropdowns, and routing. Drops heavy enrichment data
  // (prsByJiraKey 483KB, pipeline 473KB, buildByJiraKey 42KB, risk 46KB).
  function slimRelease(r) {
    return {
      id: r.id, repo: r.repo, version: r.version, state: r.state,
      branch: r.branch, jiraVersionId: r.jiraVersionId,
      jiraVersionName: r.jiraVersionName, jiraReleased: r.jiraReleased,
      jiraReleaseDate: r.jiraReleaseDate, jiraArchived: r.jiraArchived,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      notes: r.notes, cutFrom: r.cutFrom, cutAt: r.cutAt, cutBy: r.cutBy,
      cherryPicks: r.cherryPicks || [], deployments: r.deployments || [],
      approvals: r.approvals || [], comments: r.comments || [],
      tickets: r.tickets || [], risk: r.risk || null, ci: r.ci || null,
      targetCustomers: r.targetCustomers,
      targetCustomerSource: r.targetCustomerSource,
      releaseType: r.releaseType,
      shipDate: r.shipDate,
      milestones: r.milestones || [],
      templateVersion: r.templateVersion,
    };
  }

  function sendInitialState(ws) {
    // Send slim releases (no tickets, no heavy enrichment) to keep init small.
    // Individual pages fetch their own data via API calls.
    ws.send(JSON.stringify({
      type: 'init',
      releases: releases.list().map(slimRelease),
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
    broadcast({ type: 'release:created', release: enrichRelease(release) })
  );
  releases.on('release:updated', (release) =>
    broadcast({ type: 'release:updated', release: enrichRelease(release) })
  );
  releases.on('release:transition', (release, transition) =>
    broadcast({ type: 'release:transition', release: enrichRelease(release), transition })
  );
  releases.on('release:deleted', (release) =>
    broadcast({ type: 'release:deleted', id: release.id, version: release.version, repo: release.repo })
  );
  releases.on('cherry-pick:added', (release) =>
    broadcast({ type: 'release:updated', release: enrichRelease(release) })
  );
  releases.on('approval:added', (release) =>
    broadcast({ type: 'release:updated', release: enrichRelease(release) })
  );
  releases.on('deployment:added', (release) =>
    broadcast({ type: 'release:updated', release: enrichRelease(release) })
  );
  releases.on('deployment:updated', (release) =>
    broadcast({ type: 'release:updated', release: enrichRelease(release) })
  );
  releases.on('comment:added', (release, comment) =>
    broadcast({ type: 'comment:added', release: enrichRelease(release), comment })
  );
  releases.on('comment:deleted', (release, commentId) =>
    broadcast({ type: 'comment:deleted', release: enrichRelease(release), commentId })
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
      broadcast({ type: 'discovery:completed', results })
    );
  }
  if (jiraSync) {
    jiraSync.on('sync:completed', (results) =>
      broadcast({ type: 'jira:sync-completed', results })
    );
  }
  if (services.zohoSync) {
    services.zohoSync.on('sync:completed', (results) =>
      broadcast({ type: 'zoho:sync-completed', results })
    );
  }
  if (services.prSync) {
    services.prSync.on('sync:completed', (results) =>
      broadcast({ type: 'pr:sync-completed', results })
    );
  }
  if (services.pipelineSync) {
    services.pipelineSync.on('sync:completed', (results) =>
      broadcast({ type: 'pipeline:sync-completed', results })
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

  // ── MCP servers (Hive + Claude Desktop) ───────────────
  // Both endpoints share tool defs from src/mcp/tools.js. /mcp uses
  // api-key auth (Hive + Claude Code stdio bridge); /mcp-oauth uses
  // OAuth bearer (Claude Desktop custom connector).
  const mcpDeps = {
    customerStore,
    releases,
    releaseTruth: services.releaseTruth,
    taskQueue,
    incidents,
    alertRules,
    alertRouter,
    zohoStore,
    ticketStore,
    prStore,
    userStore,
    risk,
  };
  const { mountMcp } = require('../mcp/server');
  mountMcp(app, '/mcp', { ...mcpDeps, apiKeys });

  const { mountMcpOAuth } = require('../mcp/server-oauth');
  mountMcpOAuth(app, '/mcp-oauth', { ...mcpDeps, oauthStore: mcpOAuthStore });

  // ── HTTP server with WebSocket upgrade ────────────────
  const httpServer = http.createServer(app);

  // Must be larger than the ALB idle_timeout (60s) so the ALB never
  // tries to reuse a pooled connection that Node has just FIN'd —
  // that race shows up as random ALB 502s with no app log.
  // headersTimeout must be > keepAliveTimeout.
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

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
    broadcastTo,
    close: () => {
      clearInterval(heartbeatTimer);
      httpServer.close();
      for (const ws of clients) ws.close();
    },
  };
}

module.exports = { createWebServer };
