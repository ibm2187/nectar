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

// ── Startup warnings ─────────────────────────────────────
if (process.env.ENABLE_GOOGLE_SSO === 'true') {
  const admins = (process.env.NECTAR_ADMINS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (admins.length === 0) {
    log.warn('⚠ ENABLE_GOOGLE_SSO is true but NECTAR_ADMINS is empty — capability system is bypassed, ALL users get full access. Set NECTAR_ADMINS to at least one email to enable access control.');
  }
}

// ── Load config ───────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'nectar.config.js');
if (!fs.existsSync(configPath)) {
  log.error('Missing nectar.config.js');
  process.exit(1);
}
const config = require(configPath);

// ── Open SQLite DB + migrate from legacy JSON if needed ──
// This must happen BEFORE any store is constructed, since store
// constructors eagerly load from the DB.
const { getDb } = require('./core/db');
const { migrateFromJson } = require('./core/migrate');
const db = getDb();
try {
  const migrated = migrateFromJson(db, path.join(__dirname, '..'));
  const totalMoved = Object.values(migrated).reduce((a, b) => a + b, 0);
  if (totalMoved === 0) {
    log.info('DB migration: up to date (no JSON records to import)');
  }
} catch (err) {
  log.error(`DB migration failed: ${err.message}`);
  if (err.stack) log.error(err.stack);
}

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

const NotificationSettings = require('./core/notification-settings');
const notificationSettings = new NotificationSettings();
slack.notificationSettings = notificationSettings;

const AlertRuleStore = require('./core/alert-rule-store');
const alertRules = new AlertRuleStore();

const IncidentStore = require('./core/incident-store');
const incidents = new IncidentStore();

const AlertRouter = require('./core/alert-router');
const alertRouter = new AlertRouter({
  alertRules, incidents, slack, notificationSettings,
});

// Round-trip: Nectar incident lifecycle actions → Slack thread replies
incidents.on('incident:acknowledged', (inc, ev) => {
  alertRouter.onIncidentAcknowledged(inc, ev).catch(err =>
    log.warn(`AlertRouter.onIncidentAcknowledged failed: ${err.message}`)
  );
});
incidents.on('incident:resolved', (inc, ev) => {
  alertRouter.onIncidentResolved(inc, ev).catch(err =>
    log.warn(`AlertRouter.onIncidentResolved failed: ${err.message}`)
  );
});
incidents.on('incident:reopened', (inc, ev) => {
  alertRouter.onIncidentReopened(inc, ev).catch(err =>
    log.warn(`AlertRouter.onIncidentReopened failed: ${err.message}`)
  );
});
incidents.on('incident:assigned', (inc, ev) => {
  alertRouter.onIncidentAssigned(inc, ev).catch(err =>
    log.warn(`AlertRouter.onIncidentAssigned failed: ${err.message}`)
  );
});
incidents.on('incident:note-added', (inc, ev) => {
  alertRouter.onIncidentNoteAdded(inc, ev).catch(err =>
    log.warn(`AlertRouter.onIncidentNoteAdded failed: ${err.message}`)
  );
});

const ZohoClient = require('./integrations/zoho');
const zoho = new ZohoClient();
if (zoho.isConfigured()) log.info('Zoho Desk client configured');

const DatadogClient = require('./integrations/datadog');
const datadog = new DatadogClient();
if (datadog.isConfigured()) log.info('Datadog client configured');

const DatadogPoller = require('./core/datadog-poller');
const datadogPoller = new DatadogPoller(datadog);

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

const TicketStore = require('./core/ticket-store');
const ticketStore = new TicketStore();
log.info(`Ticket store initialized (${ticketStore.count()} tickets)`);
releases.setTicketStore(ticketStore);

const JiraSync = require('./core/jira-sync');
const jiraSync = new JiraSync(releases, jira, config);
jiraSync.setTicketStore(ticketStore);

const ReleaseTruth = require('./core/release-truth');
const releaseTruth = new ReleaseTruth(releases, repoManager, github, jira, config);

const ZohoSync = require('./core/zoho-sync');
const zohoSync = new ZohoSync(releases, zoho, config);

const PrStore = require('./core/pr-store');
const prStore = new PrStore();
log.info(`PR store initialized (${prStore.count()} PRs)`);

const PrSync = require('./core/pr-sync');
const prSync = new PrSync(releases, github, config);
prSync.setPrStore(prStore);

const AwsClient = require('./integrations/aws');
const aws = new AwsClient();
if (aws.isConfigured()) log.info(`AWS client configured (region: ${aws.region})`);

const PipelineSync = require('./core/pipeline-sync');
const pipelineSync = new PipelineSync(releases, aws, repoManager, config);
pipelineSync.setPrSync(prSync);

const ReleaseNotifier = require('./core/release-notifier');
const releaseNotifier = new ReleaseNotifier(releases, slack, config, notificationSettings);

const CustomerStore = require('./core/customer-store');
const customerStore = new CustomerStore();
customerStore.setDatadogClient(datadog);
jiraSync.setCustomerStore(customerStore);
pipelineSync.setCustomerStore(customerStore);

const WebplatformScanner = require('./core/webplatform-scanner');
const webplatformScanner = new WebplatformScanner(repoManager, config);

const EnvironmentPoller = require('./core/environment-poller');
const envPoller = new EnvironmentPoller(customerStore, config);

const ThemeConfig = require('./core/theme-config');
const themeConfig = new ThemeConfig();

const { TemplateStore } = require('./core/milestone-engine');
const templateStore = new TemplateStore();
log.info(`Template store initialized (${templateStore.list().length} templates loaded)`);

const ApiKeyManager = require('./core/api-keys');
const apiKeys = new ApiKeyManager();
log.info(`API key manager initialized (${apiKeys.keys.size} keys loaded)`);

const UserStore = require('./core/user-store');
const userStore = new UserStore();
log.info(`User store initialized (${userStore.users.size} users loaded)`);

const TeamStore = require('./core/team-store');
const teamStore = new TeamStore();
log.info(`Team store initialized (${teamStore.list().length} teams loaded)`);

const TaskQueue = require('./core/task-queue');
const taskQueue = new TaskQueue();
log.info(`Task queue initialized (${taskQueue.tasks.size} tasks loaded)`);

const PeopleDirectory = require('./core/people-directory');
const peopleDirectory = new PeopleDirectory(config);

const Availability = require('./core/availability');
const availability = new Availability();

const NotificationEngine = require('./core/notification-engine');
const notificationEngine = new NotificationEngine({
  slack, releases, releaseNotifier, peopleDirectory, userStore, notificationSettings, availability, config,
});

// ── Wire Slack lifecycle notifications ──────────────────
// Skip notifications for automated actions (discovery, jira-sync)
const AUTOMATED_USERS = new Set(['discovery', 'jira-sync', 'cherry-pick-watcher', 'cherry-pick-sync', 'github-webhook', 'jira-webhook', 'risk-assessor']);

releases.on('release:transition', (release, { from, to, user }) => {
  if (AUTOMATED_USERS.has(user)) return;
  if (!notificationSettings.get('transitions')) return;
  slack.notifyTransition(release, from, to);
  if (to === 'cutting') {
    slack.notifyReleaseCut(release);
  }
});

releases.on('approval:added', (release, approval) => {
  if (!notificationSettings.get('transitions')) return;
  slack.notifyApprovalAdded(release, approval);
  if (approvals.isFullyApproved(release)) {
    slack.notifyAllApproved(release);
  }
});

releases.on('deployment:added', (release, deployment) => {
  if (!notificationSettings.get('deploys')) return;
  slack.notifyDeployment(release, deployment);
});

releases.on('deployment:updated', (release, deployment) => {
  if (!notificationSettings.get('deploys')) return;
  if (deployment.status === 'failed') {
    slack.notifyDeployFailed(release, deployment);
    // Tier-2 trigger: feed into the AlertRouter so any configured
    // deploy-failed rules can post to their own channels too. The
    // subjectKey dedups so a multi-stage deploy that fails twice
    // doesn't open two incidents for the same version.
    alertRouter.handleTrigger({
      triggerType: 'deploy-failed',
      subjectKey: `deploy-failed:${release.version}:${deployment.customer}:${deployment.env}`,
      customerId: deployment.customer,
      envId: `${deployment.customer}-${deployment.env}`,
      envTier: deployment.env === 'prod' || deployment.env === 'production' ? 'production' : 'staging',
      summary: `Deploy of ${release.version} failed on ${deployment.customer} ${deployment.env}`,
      payload: { version: release.version, customer: deployment.customer, env: deployment.env, at: deployment.at },
    }).catch(err => log.warn(`AlertRouter.handleTrigger(deploy-failed) failed: ${err.message}`));
  } else {
    slack.notifyDeployment(release, deployment);
  }
});

cherryPickWatcher.on('cherry-pick:conflict', (release, parsed) => {
  if (!notificationSettings.get('cherryPickConflicts')) return;
  slack.notifyCherryPickConflict(release, parsed, parsed.author);
});

// ── Start services ──────────────────────────────────────
const { createWebServer } = require('./web/server');
const services = {
  releases, repoManager, jira, github, jenkins, slack,
  risk, validator, approvals, customers, cherryPickWatcher, discovery, jiraSync, releaseTruth,
  customerStore, webplatformScanner, envPoller, themeConfig,
  apiKeys, taskQueue, userStore, teamStore,
  datadog, datadogPoller,
  zoho, zohoSync,
  prSync,
  aws, pipelineSync,
  releaseNotifier,
  peopleDirectory, notificationSettings, notificationEngine, availability,
  ticketStore, prStore,
  templateStore,
  alertRules, incidents, alertRouter,
  audit,
};
const webServer = createWebServer(services, config);
// Thread broadcastTo back into services so access routes can use it
services.broadcastTo = webServer.broadcastTo;

// Memory monitoring — log RSS + heap every 60s for OOM observability
setInterval(() => {
  const mem = process.memoryUsage();
  log.info(`Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB external=${Math.round(mem.external / 1024 / 1024)}MB`);
}, 60000);

// Start async services
(async () => {
  // Clone repos first (may take a while on first run)
  log.info('Initializing repo clones...');
  await repoManager.init();

  await slack.start();
  cherryPickWatcher.start();

  // Start JIRA sync (primary source of truth for releases)
  jiraSync.on('release:date-changed', (release, { oldDate, newDate }) => {
    if (!notificationSettings.get('dateChanges')) return;
    const SlackNotifier = require('./integrations/slack');
    const channel = SlackNotifier.releaseChannelName(release.version);
    const text = `📅 *Release ${release.version}* date changed: ~${oldDate}~ → *${newDate}*`;
    slack.postMessage(channel, text);
    log.info(`Release date changed: ${release.version} ${oldDate} → ${newDate}`);
  });
  jiraSync.start();

  // Start git discovery (cross-references JIRA with git branches)
  discovery.start();

  // Start Zoho sync (finds Zoho tickets linked to JIRA issues)
  zohoSync.start();

  // Start PR sync (finds GitHub PRs linked to JIRA issues)
  prSync.start();

  // Start release channel notifier (9 AM + 2 PM ET for due releases)
  releaseNotifier.start();

  // Start notification engine (daily digest, build alerts, ticket changes)
  peopleDirectory.load();
  jiraSync.on('sync:version-tickets', (version, changes) => {
    notificationEngine.bufferTicketChanges(version, changes);
  });
  pipelineSync.on('sync:completed', () => {
    notificationEngine.checkBuildTransitions(pipelineSync.buildProjects);
  });
  notificationEngine.start();

  // Start availability (BambooHR Who's Out + Holidays, refreshed hourly)
  availability.start().catch(err => log.error(`Availability start failed: ${err.message}`));

  // Start pipeline sync (CodeBuild + CodePipeline status)
  pipelineSync.start();

  // Run initial webplatform scan to seed customers/environments
  try {
    const scanResults = await webplatformScanner.scan();
    customerStore.applyScanResults(scanResults);
    customerStore.seedDisplayDefaults();
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
  envPoller.on('env:version-changed', ({ envName, customerId, newVersion, previousVersion }) => {
    const customer = customerStore.getCustomer ? customerStore.getCustomer(customerId) : null;
    const customerName = customer?.name || customerId;
    if (notificationSettings.get('envDeployments')) {
      slack.notifyReleaseDeployment(newVersion, envName, customerName, previousVersion);
    }
    pipelineSync.promoteToHot(newVersion);
  });

  // Feed health observations into the AlertRouter for flap-guarded transitions
  envPoller.on('env:health-observed', (obs) => {
    alertRouter.observeEnvHealth(obs).catch(err =>
      log.warn(`AlertRouter.observeEnvHealth failed for ${obs.envId}: ${err.message}`)
    );
  });

  // Tier-2: feature flag / integration / upgrade change detection.
  // The poller emits discrete change events (one per flag/integration/upgrade
  // that transitioned). We fan them into the router's generic handler.

  envPoller.on('env:feature-flag-changed', (ev) => {
    alertRouter.handleTrigger({
      triggerType: 'feature-flag-changed',
      subjectKey: `flag:${ev.envId}:${ev.source}:${ev.key}`,
      customerId: ev.customerId,
      envId: ev.envId,
      envTier: ev.envTier,
      summary: `Feature flag "${ev.key}" ${ev.to === null ? 'removed' : ev.to ? 'enabled' : 'disabled'} on ${ev.envName || ev.envId}`,
      description: `Source: ${ev.source} · Previous: ${String(ev.from)} → Current: ${String(ev.to)}`,
      payload: { source: ev.source, key: ev.key, from: ev.from, to: ev.to },
    }).catch(err => log.warn(`AlertRouter.handleTrigger(feature-flag-changed) failed: ${err.message}`));
  });

  envPoller.on('env:integration-changed', (ev) => {
    alertRouter.handleTrigger({
      triggerType: 'integration-config-changed',
      subjectKey: `integration:${ev.envId}:${ev.source}:${ev.key}`,
      customerId: ev.customerId,
      envId: ev.envId,
      envTier: ev.envTier,
      summary: `Integration "${ev.key}" ${ev.to === null ? 'removed' : ev.to ? 'enabled' : 'disabled'} on ${ev.envName || ev.envId}`,
      description: `Source: ${ev.source} · Previous: ${String(ev.from)} → Current: ${String(ev.to)}`,
      payload: { source: ev.source, key: ev.key, from: ev.from, to: ev.to },
    }).catch(err => log.warn(`AlertRouter.handleTrigger(integration-config-changed) failed: ${err.message}`));
  });

  envPoller.on('env:upgrade-failed', (ev) => {
    alertRouter.handleTrigger({
      triggerType: 'upgrade-failed',
      subjectKey: `upgrade-failed:${ev.envId}:${ev.upgradeName}`,
      customerId: ev.customerId,
      envId: ev.envId,
      envTier: ev.envTier,
      summary: `Upgrade "${ev.upgradeName}" failed on ${ev.envName || ev.envId}`,
      payload: { upgradeName: ev.upgradeName },
    }).catch(err => log.warn(`AlertRouter.handleTrigger(upgrade-failed) failed: ${err.message}`));
  });

  // When a previously-failed upgrade recovers, auto-resolve any active
  // incident opened for it — same pattern as env-recovered.
  envPoller.on('env:upgrade-recovered', (ev) => {
    try {
      const subjectKey = `upgrade-failed:${ev.envId}:${ev.upgradeName}`;
      const active = incidents.findActiveBySubject(subjectKey);
      if (active) {
        incidents.resolve(active.id, { resolution: 'auto' });
      }
    } catch (err) {
      log.warn(`Auto-resolve upgrade incident failed: ${err.message}`);
    }
  });

  // After each poll cycle, check sustained-degradation thresholds.
  // The router reads firstFailedAt from its own alert_state table.
  envPoller.on('poll:completed', () => {
    const active = customerStore.listEnvironments()
      .filter(e => e.health && e.health.status === 'unhealthy')
      .map(e => ({
        envId: e.id,
        envName: e.name || e.id,
        customerId: e.customerId,
        envTier: e.tier,
        components: [],
      }));
    alertRouter.checkSustained(active).catch(err =>
      log.warn(`AlertRouter.checkSustained failed: ${err.message}`)
    );
  });

  envPoller.start();

  // Start Datadog monitor poller (every 2 minutes, if configured)
  datadogPoller.start();
})();

// ── Graceful shutdown ─────────────────────────────────────
function shutdown() {
  log.info('Shutting down...');
  jiraSync.stop();
  discovery.stop();
  cherryPickWatcher.stop();
  pipelineSync.stop();
  envPoller.stop();
  datadogPoller.stop();
  notificationEngine.stop();
  notificationSettings.flush();
  availability.stop();
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
