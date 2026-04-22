#!/usr/bin/env node

/**
 * Nectar Sync Worker — runs all sync engines and writes to SQLite.
 *
 * Handles: JiraSync, Discovery, PrSync, PipelineSync, ZohoSync,
 * EnvironmentPoller, CherryPickWatcher, Slack notifications,
 * WebplatformScanner, NotificationEngine.
 *
 * No HTTP port. No WebSocket. No MCP.
 * Polls TaskQueue for trigger-sync and slack-notify tasks.
 */
const { config, db, log } = require('./bootstrap');

// ── Initialize stores ───────────────────────────────────────
const Audit = require('./core/audit');
const audit = new Audit();

const ReleaseManager = require('./core/release');
const releases = new ReleaseManager(audit);
log.info(`[sync] Release manager: ${releases.releases.size} releases`);

const RepoManager = require('./core/repo-manager');
const repoManager = new RepoManager(config);

const CustomerStore = require('./core/customer-store');
const customerStore = new CustomerStore();

const UserStore = require('./core/user-store');
const userStore = new UserStore();

const TaskQueue = require('./core/task-queue');
const taskQueue = new TaskQueue();

const ApiKeyManager = require('./core/api-keys');
const apiKeys = new ApiKeyManager();

const NotificationSettings = require('./core/notification-settings');
const notificationSettings = new NotificationSettings();

// Alerting — the sync worker runs the envPoller, so it hosts the
// AlertRouter. Incident lifecycle actions originate in the web
// process (which also has its own router for thread-replies); both
// share state via the shared SQLite DB.
const AlertRuleStore = require('./core/alert-rule-store');
const alertRules = new AlertRuleStore();
const IncidentStore = require('./core/incident-store');
const incidents = new IncidentStore();
// alertRouter is constructed later once slack is initialized

const PeopleDirectory = require('./core/people-directory');
const peopleDirectory = new PeopleDirectory(config);

const Availability = require('./core/availability');
const availability = new Availability();

const VelocityEngine = require('./core/velocity-engine');
const velocityEngine = new VelocityEngine({ db, releases, availability, config });

// ── Initialize integrations ─────────────────────────────────
const JiraClient = require('./integrations/jira');
const jira = new JiraClient();
if (jira.isConfigured()) log.info('[sync] JIRA configured');

const GitHubClient = require('./integrations/github');
const github = new GitHubClient(config);
if (github.isConfigured()) log.info('[sync] GitHub configured');

const JenkinsClient = require('./integrations/jenkins');
const jenkins = new JenkinsClient(config);

const SlackNotifier = require('./integrations/slack');
const slack = new SlackNotifier(config);
slack.notificationSettings = notificationSettings;

const AlertRouter = require('./core/alert-router');
const alertRouter = new AlertRouter({
  alertRules, incidents, slack, notificationSettings,
});

const ZohoClient = require('./integrations/zoho');
const zoho = new ZohoClient();
if (zoho.isConfigured()) log.info('[sync] Zoho configured');

const DatadogClient = require('./integrations/datadog');
const datadog = new DatadogClient();
if (datadog.isConfigured()) log.info('[sync] Datadog configured');

const DatadogPoller = require('./core/datadog-poller');
const datadogPoller = new DatadogPoller(datadog);

const AwsClient = require('./integrations/aws');
const aws = new AwsClient();
if (aws.isConfigured()) log.info(`[sync] AWS configured (region: ${aws.region})`);

// ── Initialize sync engines ─────────────────────────────────
const ApprovalEngine = require('./core/approvals');
const approvals = new ApprovalEngine(releases, config);

const CherryPickWatcher = require('./core/cherry-pick');
const cherryPickWatcher = new CherryPickWatcher(releases, github, config);

const Discovery = require('./core/discovery');
const discovery = new Discovery(releases, repoManager, config);

const TicketStore = require('./core/ticket-store');
const ticketStore = new TicketStore();
log.info(`[sync] Ticket store: ${ticketStore.count()} tickets`);
releases.setTicketStore(ticketStore);

const JiraSync = require('./core/jira-sync');
const jiraSync = new JiraSync(releases, jira, config);
jiraSync.setTicketStore(ticketStore);

const ReleaseTruth = require('./core/release-truth');
const releaseTruth = new ReleaseTruth(releases, repoManager, github, jira, config);

const ZohoSync = require('./core/zoho-sync');
const zohoSync = new ZohoSync(releases, zoho, config);

const CommitStore = require('./core/commit-store');
const commitStore = new CommitStore();
log.info(`[sync] Commit store: ${commitStore.count()} commits`);

const TruthSync = require('./core/truth-sync');

const PrStore = require('./core/pr-store');
const prStore = new PrStore();
log.info(`[sync] PR store: ${prStore.count()} PRs`);

const PrSync = require('./core/pr-sync');
const prSync = new PrSync(releases, github, config);
prSync.setPrStore(prStore);

const PipelineSync = require('./core/pipeline-sync');
const pipelineSync = new PipelineSync(releases, aws, repoManager, config);
pipelineSync.setPrSync(prSync);
jiraSync.setCustomerStore(customerStore);
pipelineSync.setCustomerStore(customerStore);

const ReleaseNotifier = require('./core/release-notifier');
const releaseNotifier = new ReleaseNotifier(releases, slack, config, notificationSettings);

const NotificationEngine = require('./core/notification-engine');
const notificationEngine = new NotificationEngine({
  slack, releases, releaseNotifier, peopleDirectory, userStore, notificationSettings, availability, config,
});

const WebplatformScanner = require('./core/webplatform-scanner');
const webplatformScanner = new WebplatformScanner(repoManager, config);

const EnvironmentPoller = require('./core/environment-poller');
const envPoller = new EnvironmentPoller(customerStore, config);

// ── Wire Slack notifications ────────────────────────────────
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
    // Tier-2 alerting: feed into AlertRouter so custom rules can post
    // to their own channels / mention specific groups.
    alertRouter.handleTrigger({
      triggerType: 'deploy-failed',
      subjectKey: `deploy-failed:${release.version}:${deployment.customer}:${deployment.env}`,
      customerId: deployment.customer,
      envId: `${deployment.customer}-${deployment.env}`,
      envTier: deployment.env === 'prod' || deployment.env === 'production' ? 'production' : 'staging',
      summary: `Deploy of ${release.version} failed on ${deployment.customer} ${deployment.env}`,
      payload: { version: release.version, customer: deployment.customer, env: deployment.env, at: deployment.at },
    }).catch(err => log.warn(`[sync] AlertRouter(deploy-failed) failed: ${err.message}`));
  } else {
    slack.notifyDeployment(release, deployment);
  }
});

cherryPickWatcher.on('cherry-pick:conflict', (release, parsed) => {
  if (!notificationSettings.get('cherryPickConflicts')) return;
  slack.notifyCherryPickConflict(release, parsed, parsed.author);
});

// ── Memory monitoring ──────────────────────────────────────
setInterval(() => {
  const mem = process.memoryUsage();
  log.info(`[sync] Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
}, 60000);

// ── Poll TaskQueue for sync triggers + Slack notifications ──
setInterval(() => {
  try {
    // Reload from DB (web process may have created tasks or changed settings)
    taskQueue._loadState();
    notificationSettings.reload();

    const pending = [...taskQueue.tasks.values()].filter(t => t.status === 'pending');

    for (const task of pending) {
      if (task.type === 'trigger-sync') {
        taskQueue.claim(task.id);
        const target = task.input?.target;
        log.info(`[sync] Trigger received: ${target}`);
        const runFn = {
          jira: () => jiraSync.run(),
          pr: () => prSync.run(),
          pipeline: () => pipelineSync.run(),
          discovery: () => discovery.run(),
          zoho: () => zohoSync.run(),
          envPoll: () => envPoller.run(),
          webplatformScan: async () => {
            const scanResults = await webplatformScanner.scan();
            customerStore.applyScanResults(scanResults);
            return scanResults;
          },
        }[target];
        if (runFn) {
          runFn()
            .then(() => taskQueue.complete(task.id, {}))
            .catch(err => taskQueue.fail(task.id, err.message));
        } else {
          taskQueue.fail(task.id, `Unknown sync target: ${target}`);
        }
      }

      if (task.type === 'slack-notify') {
        taskQueue.claim(task.id);
        try {
          const { template, releaseVersion, releaseRepo } = task.input;
          const release = releases.get(releaseVersion, releaseRepo);
          if (!release) {
            taskQueue.fail(task.id, `Release not found: ${releaseVersion}`);
            continue;
          }
          if (template === 'transition' && notificationSettings.get('transitions')) {
            slack.notifyTransition(release, task.input.from, task.input.to);
            if (task.input.to === 'cutting') slack.notifyReleaseCut(release);
          } else if (template === 'approval' && notificationSettings.get('transitions')) {
            slack.notifyApprovalAdded(release, task.input.approval);
            if (task.input.fullyApproved) slack.notifyAllApproved(release);
          } else if (template === 'deployment' && notificationSettings.get('deploys')) {
            slack.notifyDeployment(release, task.input.deployment);
          } else if (template === 'deployment-updated' && notificationSettings.get('deploys')) {
            if (task.input.deployment.status === 'failed') {
              slack.notifyDeployFailed(release, task.input.deployment);
            } else {
              slack.notifyDeployment(release, task.input.deployment);
            }
          }
          taskQueue.complete(task.id, {});
        } catch (err) {
          taskQueue.fail(task.id, err.message);
        }
      }
    }
  } catch (err) {
    log.warn(`[sync] Task poll error: ${err.message}`);
  }
}, 5000);

// ── Start services ──────────────────────────────────────────
(async () => {
  log.info('[sync] Initializing repo clones...');
  await repoManager.init();

  await slack.start();
  cherryPickWatcher.start();

  jiraSync.on('release:date-changed', (release, { oldDate, newDate }) => {
    if (!notificationSettings.get('dateChanges')) return;
    const SlackNotifier = require('./integrations/slack');
    const channel = SlackNotifier.releaseChannelName(release.version);
    const text = `\u{1f4c5} *Release ${release.version}* date changed: ~${oldDate}~ \u2192 *${newDate}*`;
    slack.postMessage(channel, text);
    log.info(`Release date changed: ${release.version} ${oldDate} \u2192 ${newDate}`);
  });
  jiraSync.start();

  discovery.start();
  zohoSync.start();
  prSync.start();

  peopleDirectory.load();
  jiraSync.on('sync:version-tickets', (version, changes) => {
    notificationEngine.bufferTicketChanges(version, changes);
  });
  pipelineSync.on('sync:completed', () => {
    notificationEngine.checkBuildTransitions(pipelineSync.buildProjects);
  });
  notificationEngine.start();
  releaseNotifier.start();

  availability.start().catch(err => log.error(`[sync] Availability failed: ${err.message}`));
  pipelineSync.start();

  try {
    const scanResults = await webplatformScanner.scan();
    customerStore.applyScanResults(scanResults);
    customerStore.seedDisplayDefaults();
  } catch (err) {
    log.error('[sync] Initial webplatform scan failed:', err.message);
  }

  setInterval(async () => {
    try {
      const scanResults = await webplatformScanner.scan();
      customerStore.applyScanResults(scanResults);
    } catch (err) {
      log.warn('[sync] Webplatform scan failed:', err.message);
    }
  }, 30 * 60 * 1000);

  envPoller.on('env:version-changed', ({ envName, customerId, newVersion, previousVersion }) => {
    const customer = customerStore.getCustomer ? customerStore.getCustomer(customerId) : null;
    const customerName = customer?.name || customerId;
    if (notificationSettings.get('envDeployments')) {
      slack.notifyReleaseDeployment(newVersion, envName, customerName, previousVersion);
    }
    pipelineSync.promoteToHot(newVersion);
  });

  // ── Alerting: wire envPoller events → alertRouter ────────
  envPoller.on('env:health-observed', (obs) => {
    alertRouter.observeEnvHealth(obs).catch(err =>
      log.warn(`[sync] AlertRouter.observeEnvHealth failed for ${obs.envId}: ${err.message}`)
    );
  });

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
    }).catch(err => log.warn(`[sync] AlertRouter(feature-flag-changed) failed: ${err.message}`));
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
    }).catch(err => log.warn(`[sync] AlertRouter(integration-config-changed) failed: ${err.message}`));
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
    }).catch(err => log.warn(`[sync] AlertRouter(upgrade-failed) failed: ${err.message}`));
  });

  envPoller.on('env:upgrade-recovered', (ev) => {
    try {
      const active = incidents.findActiveBySubject(`upgrade-failed:${ev.envId}:${ev.upgradeName}`);
      if (active) incidents.resolve(active.id, { resolution: 'auto' });
    } catch (err) {
      log.warn(`[sync] Auto-resolve upgrade incident failed: ${err.message}`);
    }
  });

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
      log.warn(`[sync] AlertRouter.checkSustained failed: ${err.message}`)
    );
  });

  envPoller.start();

  datadogPoller.start();

  // ── Truth Sync: git commits + per-ticket truth ─────────
  const truthSync = new TruthSync(releases, repoManager, commitStore, ticketStore, prStore, config);

  // Sync git commits for active release branches, then compute truth.
  // Runs after a short delay to let JIRA/PR syncs finish on startup,
  // then every 15 minutes staggered from JIRA sync.
  const runTruthSync = async () => {
    try {
      // 1. Fetch latest from git
      for (const repoConfig of config.repos || []) {
        try {
          await repoManager.fetch(repoConfig.name);
        } catch (err) {
          log.warn(`[truth-sync] Fetch failed for ${repoConfig.name}: ${err.message}`);
        }
      }

      // 2. Sync commits for active release branches
      const activeReleases = releases.active().filter(r => r.branch && r.repo);
      for (const release of activeReleases) {
        const repoConfig = config.repos.find(r => r.name === release.repo);
        const jiraProject = repoConfig?.jiraProject || 'DEV';
        await truthSync.syncCommitsForBranch(release.repo, release.branch, jiraProject);
      }

      // 3. Compute truth for all active releases
      await truthSync.run();
    } catch (err) {
      log.error(`[truth-sync] Error: ${err.message}`);
    }
  };

  // Initial run after 30s to let other syncs complete
  setTimeout(runTruthSync, 30000);

  // Then every 15 minutes
  setInterval(runTruthSync, 15 * 60 * 1000);

  log.info('[sync] All sync engines started');
})();

// ── Graceful shutdown ──────────────────────────────────────
function shutdown() {
  log.info('[sync] Shutting down...');
  jiraSync.stop();
  discovery.stop();
  cherryPickWatcher.stop();
  pipelineSync.stop();
  envPoller.stop();
  datadogPoller.stop();
  notificationEngine.stop();
  notificationSettings.flush();
  availability.stop();
  releaseNotifier.stop();
  slack.stop().catch(() => {});
  releases.flush();
  customerStore.flush();
  taskQueue.flush();
  userStore.flush();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
