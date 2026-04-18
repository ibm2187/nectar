#!/usr/bin/env node

/**
 * Nectar Web Server — serves HTTP, WebSocket, and MCP.
 *
 * Reads all data from SQLite. Handles user writes (transitions,
 * approvals, comments) directly. Delegates sync triggers and Slack
 * notifications to the sync worker via TaskQueue.
 *
 * Does NOT run: JiraSync, PipelineSync, PrSync, Discovery,
 * EnvironmentPoller, ZohoSync, CherryPickWatcher, Slack, RepoManager.
 */
const { config, db, log } = require('./bootstrap');

// ── Initialize stores (read from SQLite) ──────────────────
const Audit = require('./core/audit');
const audit = new Audit();

const ReleaseManager = require('./core/release');
const releases = new ReleaseManager(audit);
log.info(`[web] Release manager: ${releases.releases.size} releases`);

const CustomerStore = require('./core/customer-store');
const customerStore = new CustomerStore();

const UserStore = require('./core/user-store');
const userStore = new UserStore();
log.info(`[web] User store: ${userStore.users.size} users`);

const ApiKeyManager = require('./core/api-keys');
const apiKeys = new ApiKeyManager();

const TaskQueue = require('./core/task-queue');
const taskQueue = new TaskQueue();

const ThemeConfig = require('./core/theme-config');
const themeConfig = new ThemeConfig();

const NotificationSettings = require('./core/notification-settings');
const notificationSettings = new NotificationSettings();

const PeopleDirectory = require('./core/people-directory');
const peopleDirectory = new PeopleDirectory(config);
peopleDirectory.load();

const Availability = require('./core/availability');
const availability = new Availability();

// ── Data stores (read from SQLite, written by sync worker) ──
const TicketStore = require('./core/ticket-store');
const ticketStore = new TicketStore();
log.info(`[web] Ticket store: ${ticketStore.count()} tickets`);
releases.setTicketStore(ticketStore);

const PrStore = require('./core/pr-store');
const prStore = new PrStore();
log.info(`[web] PR store: ${prStore.count()} PRs`);

// ── Lightweight integrations (no sync engines) ─────────────
const JiraClient = require('./integrations/jira');
const jira = new JiraClient();

const GitHubClient = require('./integrations/github');
const github = new GitHubClient(config);

const JenkinsClient = require('./integrations/jenkins');
const jenkins = new JenkinsClient(config);

const DatadogClient = require('./integrations/datadog');
const datadog = new DatadogClient();

const DatadogPoller = require('./core/datadog-poller');
const datadogPoller = new DatadogPoller(datadog);

// Slack — connected in web server for user-triggered notifications (notify dialog).
// Cron-based notifications (daily digest, build alerts) still run in sync worker.
const SlackNotifier = require('./integrations/slack');
const slack = new SlackNotifier(config);
slack.notificationSettings = notificationSettings;
slack.start().catch(err => log.warn(`[web] Slack start failed: ${err.message}`));

const ZohoClient = require('./integrations/zoho');
const zoho = new ZohoClient();

// ── Feature engines (used by API routes) ────────────────────
const VelocityEngine = require('./core/velocity-engine');
const velocityEngine = new VelocityEngine({ db, releases, availability, config });

const RiskAssessor = require('./core/risk');
const risk = new RiskAssessor(releases, github, jenkins, config);

const ReleaseValidator = require('./core/validators');
const validator = new ReleaseValidator(releases, jira, github, jenkins, config);

const ApprovalEngine = require('./core/approvals');
const approvals = new ApprovalEngine(releases, config);

// Legacy poller — routes reference it but we don't start it
const CustomerPoller = require('./core/customers');
const customers = new CustomerPoller(config);

// ReleaseTruth — used by /api/releases/:version/truth endpoint
const RepoManager = require('./core/repo-manager');
const repoManager = new RepoManager(config);

const ReleaseTruth = require('./core/release-truth');
const releaseTruth = new ReleaseTruth(releases, repoManager, github, jira, config);

// PipelineSync stub — getBuildsPageData reads from SQLite, no sync running
const PipelineSync = require('./core/pipeline-sync');
const AwsClient = require('./integrations/aws');
const aws = new AwsClient();
const pipelineSync = new PipelineSync(releases, aws, repoManager, config);
pipelineSync.setCustomerStore(customerStore);

// PrSync stub — not running, but routes check getStatus()
const PrSync = require('./core/pr-sync');
const prSync = new PrSync(releases, github, config);

const ZohoSync = require('./core/zoho-sync');
const zohoSync = new ZohoSync(releases, zoho, config);

// Discovery + CherryPickWatcher — not started, but routes check status
const Discovery = require('./core/discovery');
const discovery = new Discovery(releases, repoManager, config);

const CherryPickWatcher = require('./core/cherry-pick');
const cherryPickWatcher = new CherryPickWatcher(releases, github, config);

const ReleaseNotifier = require('./core/release-notifier');
const releaseNotifier = new ReleaseNotifier(releases, slack, config, notificationSettings);

const NotificationEngine = require('./core/notification-engine');
const notificationEngine = new NotificationEngine({
  slack, releases, releaseNotifier, peopleDirectory, userStore, notificationSettings, availability, config,
});

// Stub envPoller for routes that check status
const EnvironmentPoller = require('./core/environment-poller');
const envPoller = new EnvironmentPoller(customerStore, config);

// ── Slack notifications for user actions → TaskQueue ────────
// Instead of sending Slack directly, create tasks for the sync worker.
const AUTOMATED_USERS = new Set(['discovery', 'jira-sync', 'cherry-pick-watcher', 'cherry-pick-sync', 'github-webhook', 'jira-webhook', 'risk-assessor']);

releases.on('release:transition', (release, { from, to, user }) => {
  if (AUTOMATED_USERS.has(user)) return;
  if (!notificationSettings.get('transitions')) return;
  taskQueue.createTask('slack-notify', {
    template: 'transition',
    releaseVersion: release.version,
    releaseRepo: release.repo,
    from, to, user,
  }, 'web-server');
});

releases.on('approval:added', (release, approval) => {
  if (!notificationSettings.get('transitions')) return;
  taskQueue.createTask('slack-notify', {
    template: 'approval',
    releaseVersion: release.version,
    releaseRepo: release.repo,
    approval,
    fullyApproved: approvals.isFullyApproved(release),
  }, 'web-server');
});

releases.on('deployment:added', (release, deployment) => {
  if (!notificationSettings.get('deploys')) return;
  taskQueue.createTask('slack-notify', {
    template: 'deployment',
    releaseVersion: release.version,
    releaseRepo: release.repo,
    deployment,
  }, 'web-server');
});

releases.on('deployment:updated', (release, deployment) => {
  if (!notificationSettings.get('deploys')) return;
  taskQueue.createTask('slack-notify', {
    template: 'deployment-updated',
    releaseVersion: release.version,
    releaseRepo: release.repo,
    deployment,
  }, 'web-server');
});

// ── Create web server ──────────────────────────────────────
const { createWebServer } = require('./web/server');
const { EventEmitter } = require('events');

// Stub sync engines for web-only mode. Routes call .getStatus(), .run(),
// .getBuildsPageData() etc. Stubs delegate triggers to TaskQueue and
// read persisted data from SQLite where available.
function makeSyncStub(name, extra = {}) {
  const stub = Object.assign(new EventEmitter(), {
    getStatus: () => ({ running: false, lastRun: null, configured: false, mode: 'web-only' }),
    run: async () => {
      taskQueue.createTask('trigger-sync', { target: name }, 'web-server');
      return { triggered: true };
    },
    ...extra,
  });
  return stub;
}

const jiraSyncStub = makeSyncStub('jira', {
  jira, // routes check jiraSync.jira.isConfigured()
  getStatus: () => ({ running: false, lastRun: null, configured: jira.isConfigured(), mode: 'web-only' }),
  _syncVersionTickets: async (v) => {
    taskQueue.createTask('trigger-sync', { target: 'jira', version: v }, 'web-server');
    return { triggered: true };
  },
});

const pipelineSyncStub = makeSyncStub('pipeline', {
  getStatus: () => ({ running: false, lastRun: null, configured: aws.isConfigured(), mode: 'web-only' }),
  getBuildsPageData: () => pipelineSync.getBuildsPageDataFromDb(),
});

const services = {
  releases, repoManager, jira, github, jenkins, slack,
  risk, validator, approvals, customers, cherryPickWatcher, discovery,
  jiraSync: jiraSyncStub,
  releaseTruth,
  customerStore,
  webplatformScanner: makeSyncStub('webplatformScan', {
    getStatus: () => ({ neverRun: true, mode: 'web-only' }),
    scan: async () => {
      taskQueue.createTask('trigger-sync', { target: 'webplatformScan' }, 'web-server');
      return { triggered: true };
    },
  }),
  envPoller, themeConfig,
  apiKeys, taskQueue, userStore,
  datadog, datadogPoller,
  zoho,
  zohoSync: makeSyncStub('zoho'),
  prSync: makeSyncStub('pr'),
  aws, pipelineSync: pipelineSyncStub,
  releaseNotifier,
  peopleDirectory, notificationSettings, notificationEngine, availability,
  ticketStore, prStore, velocityEngine,
};

const webServer = createWebServer(services, config);

// ── Memory monitoring ──────────────────────────────────────
setInterval(() => {
  const mem = process.memoryUsage();
  log.info(`[web] Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
}, 60000);

// ── SQLite change detection → lightweight WebSocket signals ──
// The sync worker writes to SQLite; we poll for changes, reload in-memory
// state, and notify connected clients with a lightweight signal so they
// can re-fetch only the data they need.  We never serialize the full
// release list here — that was causing 791MB+ memory spikes and OOM kills.
let lastReleasesAt = null;
let lastEnvsAt = null;
let lastBuildsAt = null;

setInterval(() => {
  try {
    const relAt = db.prepare("SELECT MAX(updatedAt) as t FROM releases").get()?.t;
    const envAt = db.prepare("SELECT MAX(updatedAt) as t FROM environments").get()?.t;
    const buildsAt = db.prepare("SELECT MAX(updatedAt) as t FROM build_cards").get()?.t;

    if (relAt && relAt !== lastReleasesAt) {
      lastReleasesAt = relAt;
      releases._loadState();
      if (webServer.broadcast) {
        webServer.broadcast({ type: 'jira:sync-completed' });
      }
    }

    if (envAt && envAt !== lastEnvsAt) {
      lastEnvsAt = envAt;
      customerStore._loadState();
      if (webServer.broadcast) {
        webServer.broadcast({ type: 'webplatform:scan-completed' });
      }
    }

    if (buildsAt && buildsAt !== lastBuildsAt) {
      lastBuildsAt = buildsAt;
      if (webServer.broadcast) {
        webServer.broadcast({ type: 'pipeline:sync-completed' });
      }
    }
  } catch (err) {
    log.warn(`[web] Change detection error: ${err.message}`);
  }
}, 5000);

// ── Initialize repo manager (for release truth) ────────────
(async () => {
  try {
    await repoManager.init();
    log.info('[web] Repo manager initialized');
  } catch (err) {
    log.warn(`[web] Repo manager init failed: ${err.message}`);
  }

  availability.start().catch(err => log.warn(`[web] Availability start failed: ${err.message}`));
  datadogPoller.start();
})();

// ── Graceful shutdown ──────────────────────────────────────
function shutdown() {
  log.info('[web] Shutting down...');
  notificationSettings.flush();
  releases.flush();
  customerStore.flush();
  taskQueue.flush();
  userStore.flush();
  availability.stop();
  datadogPoller.stop();
  if (webServer) webServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info('[web] Nectar web server started');
