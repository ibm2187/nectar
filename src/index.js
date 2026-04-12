#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const log = require('./core/log');

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  log.error(`[uncaught] ${err.message}`);
  if (err.stack) log.error(err.stack);
});

// ── Load .env ─────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.substring(0, eq);
      let value = trimmed.substring(eq + 1);
      // Strip surrounding quotes (single or double)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// ── Load config ───────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'nectar.config.js');
if (!fs.existsSync(configPath)) {
  log.error('Missing nectar.config.js');
  process.exit(1);
}
const config = require(configPath);

// ── Initialize core services ──────────────────────────────
const Audit = require('./core/audit');
const audit = new Audit();

const ReleaseManager = require('./core/release');
const releases = new ReleaseManager(audit);
log.info(`Release manager initialized (${releases.releases.size} releases loaded)`);

// ── Initialize repo manager ─────────────────────────────
const RepoManager = require('./core/repo-manager');
const repoManager = new RepoManager(config);

// ── Initialize integrations ─────────────────────────────
const JiraClient = require('./integrations/jira');
const jira = new JiraClient();
if (jira.isConfigured()) log.info('JIRA client configured');

const GitHubClient = require('./integrations/github');
const github = new GitHubClient(config);
if (github.isConfigured()) log.info('GitHub client configured');

const JenkinsClient = require('./integrations/jenkins');
const jenkins = new JenkinsClient(config);

const SlackNotifier = require('./integrations/slack');
const slack = new SlackNotifier(config);


// ── Initialize core feature engines ─────────────────────
const RiskAssessor = require('./core/risk');
const risk = new RiskAssessor(releases, github, jenkins, config);

const ReleaseValidator = require('./core/validators');
const validator = new ReleaseValidator(releases, jira, github, jenkins, config);

const ApprovalEngine = require('./core/approvals');
const approvals = new ApprovalEngine(releases, config);

// Legacy CustomerPoller kept for backwards compat but no longer started;
// replaced by EnvironmentPoller which operates on CustomerStore environments.
const CustomerPoller = require('./core/customers');
const customers = new CustomerPoller(config);

const CherryPickWatcher = require('./core/cherry-pick');
const cherryPickWatcher = new CherryPickWatcher(releases, github, config);

const Discovery = require('./core/discovery');
const discovery = new Discovery(releases, repoManager, config);

const JiraSync = require('./core/jira-sync');
const jiraSync = new JiraSync(releases, jira, config);

const ReleaseTruth = require('./core/release-truth');
const releaseTruth = new ReleaseTruth(releases, repoManager, github, jira, config);


const CustomerStore = require('./core/customer-store');
const customerStore = new CustomerStore();

const WebplatformScanner = require('./core/webplatform-scanner');
const webplatformScanner = new WebplatformScanner(repoManager, config);

const EnvironmentPoller = require('./core/environment-poller');
const envPoller = new EnvironmentPoller(customerStore, config);

const ThemeConfig = require('./core/theme-config');
const themeConfig = new ThemeConfig();

const ApiKeyManager = require('./core/api-keys');
const apiKeys = new ApiKeyManager();
log.info(`API key manager initialized (${apiKeys.keys.size} keys loaded)`);

const UserStore = require('./core/user-store');
const userStore = new UserStore();
log.info(`User store initialized (${userStore.users.size} users loaded)`);

const TaskQueue = require('./core/task-queue');
const taskQueue = new TaskQueue();
log.info(`Task queue initialized (${taskQueue.tasks.size} tasks loaded)`);

// ── Wire Slack lifecycle notifications ──────────────────
// Skip notifications for automated actions (discovery, jira-sync)
const AUTOMATED_USERS = new Set(['discovery', 'jira-sync', 'cherry-pick-watcher', 'cherry-pick-sync', 'github-webhook', 'jira-webhook', 'risk-assessor']);

releases.on('release:transition', (release, { from, to, user }) => {
  if (AUTOMATED_USERS.has(user)) return;
  slack.notifyTransition(release, from, to);
  if (to === 'cutting') {
    slack.notifyReleaseCut(release);
  }
});

releases.on('approval:added', (release, approval) => {
  slack.notifyApprovalAdded(release, approval);
  if (approvals.isFullyApproved(release)) {
    slack.notifyAllApproved(release);
  }
});

releases.on('deployment:added', (release, deployment) => {
  slack.notifyDeployment(release, deployment);
});

releases.on('deployment:updated', (release, deployment) => {
  if (deployment.status === 'failed') {
    slack.notifyDeployFailed(release, deployment);
  } else {
    slack.notifyDeployment(release, deployment);
  }
});

cherryPickWatcher.on('cherry-pick:conflict', (release, parsed) => {
  slack.notifyCherryPickConflict(release, parsed, parsed.author);
});

// ── Start services ──────────────────────────────────────
const { createWebServer } = require('./web/server');
const services = {
  releases, repoManager, jira, github, jenkins, slack,
  risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth,
  customerStore, webplatformScanner, envPoller, themeConfig,
  apiKeys, taskQueue, userStore,
};
const webServer = createWebServer(services, config);

// Start async services
(async () => {
  // Clone repos first (may take a while on first run)
  log.info('Initializing repo clones...');
  await repoManager.init();

  await slack.start();
  cherryPickWatcher.start();

  // Start JIRA sync (primary source of truth for releases)
  jiraSync.start();

  // Start git discovery (cross-references JIRA with git branches)
  discovery.start();

  // Run initial webplatform scan to seed customers/environments
  try {
    const scanResults = await webplatformScanner.scan();
    customerStore.applyScanResults(scanResults);
  } catch (err) {
    log.error('Initial webplatform scan failed:', err.message);
  }

  // Re-scan periodically (customers get added continuously)
  setInterval(async () => {
    try {
      const scanResults = await webplatformScanner.scan();
      customerStore.applyScanResults(scanResults);
    } catch (err) {
      log.warn('Webplatform scan failed:', err.message);
    }
  }, 30 * 60 * 1000); // every 30 min

  // Start environment version poller (hits /api/status/version on each env)
  envPoller.start();
})();

// ── Graceful shutdown ─────────────────────────────────────
function shutdown() {
  log.info('Shutting down...');
  jiraSync.stop();
  discovery.stop();
  cherryPickWatcher.stop();
  envPoller.stop();
  slack.stop().catch(() => {});
  releases.flush();
  customerStore.flush();
  taskQueue.flush();
  userStore.flush();
  if (webServer) webServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
