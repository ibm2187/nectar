const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');
const { getDb } = require('./db');

const CUSTOMER_LABELS = {
  viv: 'Viv',
  ck: 'Comfort Keepers',
  bayada: 'Bayada',
  tribute: 'Tribute',
  lumen: 'Lumen',
  haven: 'Haven',
  qualitycare: 'Quality Care',
};
const CUSTOMER_ORDER = ['viv', 'ck', 'bayada', 'tribute', 'lumen', 'haven', 'qualitycare'];

// Some build projects produce images tagged multiple ways (e.g. master → 'master' + 'latest').
// Mirrors client/src/features/builds/shared.ts.
const TAG_ALIASES = { master: ['master', 'latest'] };

/**
 * AWS Pipeline sync — polls CodeBuild + CodePipeline and builds a unified
 * view of all CI/CD activity for the Builds page.
 *
 * Two-tier polling:
 *   Hot (every ~60s):  pinned builds, recent builds, in-progress builds
 *   Full (every ~60m): all projects + full deploy state refresh
 *
 * Events:
 *   sync:started
 *   sync:completed ({ ... })
 */
class PipelineSync extends EventEmitter {
  constructor(releases, aws, repoManager, config, opts = {}) {
    super();
    this.releases = releases;
    this.aws = aws;
    this.repoManager = repoManager;
    this.config = config;
    this.db = opts.db || getDb();
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;

    // In-memory write caches — populated during sync, flushed to SQLite
    this.buildProjects = [];   // full list of build cards
    this.deployTargets = {};   // imageTag → deploy pipeline states
    this._projectList = null;  // raw project names (main account)
    this._deployMap = null;    // pipelineName → { ecrRepo, imageTag, customer, env }
    this.prSync = null;

    // Tiered polling state
    this._inProgressTimer = null;
    this._recentTimer = null;
    this._fullTimer = null;
    this._hotEntries = [];                   // [{ projectName, account, roleArn }]
    this._hotTags = new Set();               // imageTag values for hot builds
    this._cardsByProject = new Map();        // projectName → card
    this._crossAccountProjects = new Map();  // projectName → { customer, roleArn }
    this._deployPipelinesByRole = new Map(); // roleArn → [pipelineName] (cached during full sync)
    this._deployConfigByRole = new Map();    // `${roleArn}:${pipelineName}` → { ecrImageTag, ecrRepo }
  }

  setPrSync(prSync) {
    this.prSync = prSync;
  }

  start() {
    if (!this.aws.isConfigured()) {
      log.warn('Pipeline sync disabled (AWS not configured)');
      return;
    }

    const inProgressInterval = (this.config.polling && this.config.polling.pipelineSyncInProgress) || 60 * 1000;  // 1 min
    const recentInterval = (this.config.polling && this.config.polling.pipelineSyncRecent) || 5 * 60 * 1000;      // 5 min
    const fullInterval = (this.config.polling && this.config.polling.pipelineSyncFull) || 10 * 60 * 1000;          // 10 min

    log.info(`Pipeline sync started (in-progress: ${inProgressInterval / 1000}s, recent: ${recentInterval / 60000}m, full: ${fullInterval / 60000}m)`);

    // First full sync 15s after boot
    setTimeout(() => {
      this.run().then(() => {
        // Tier 1: In-progress builds only (fast, frequent)
        this._inProgressTimer = setInterval(() => {
          this.runInProgress().catch(err => log.error('Pipeline in-progress sync error:', err.message));
        }, inProgressInterval);

        // Tier 2: Pinned + recent builds
        this._recentTimer = setInterval(() => {
          this.runHot().catch(err => log.error('Pipeline recent-sync error:', err.message));
        }, recentInterval);
      }).catch(err => log.error('Pipeline sync error:', err.message));
    }, 15000);

    // Tier 3: Full reconciliation
    this._fullTimer = setInterval(() => {
      this.run().catch(err => log.error('Pipeline full-sync error:', err.message));
    }, fullInterval);
  }

  stop() {
    if (this._inProgressTimer) { clearInterval(this._inProgressTimer); this._inProgressTimer = null; }
    if (this._recentTimer) { clearInterval(this._recentTimer); this._recentTimer = null; }
    if (this._fullTimer) { clearInterval(this._fullTimer); this._fullTimer = null; }
  }

  // ── Full sync ──────────────────────────────────────────────
  async run() {
    if (this._running) {
      log.warn('Pipeline sync already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    this.emit('sync:started');

    const results = { builds: 0, deploys: 0, errors: 0, mode: 'full' };

    try {
      await this._ensureDiscovery();

      // Full sync rebuilds all caches from scratch
      this._cardsByProject.clear();
      this._deployPipelinesByRole.clear();
      this._deployConfigByRole.clear();

      // Step 2: Fetch builds for main account projects (parallel, concurrency 5)
      const FULL_CONCURRENCY = 5;
      const buildCards = [];
      const mainProjects = this._projectList || [];
      for (let i = 0; i < mainProjects.length; i += FULL_CONCURRENCY) {
        const batch = mainProjects.slice(i, i + FULL_CONCURRENCY);
        const outcomes = await Promise.allSettled(
          batch.map(async (projectName) => {
            const card = await this._fetchBuildCard(projectName);
            if (card) {
              card.account = 'Viv';
              buildCards.push(card);
              this._cardsByProject.set(projectName, card);
            }
            results.builds++;
          })
        );
        for (const o of outcomes) {
          if (o.status === 'rejected') {
            results.errors++;
            log.warn(`Pipeline sync: build fetch failed: ${o.reason?.message || 'unknown'}`);
          }
        }
      }

      // Step 2b: Fetch builds from cross-account roles (parallel, concurrency 3 + delay)
      this._crossAccountProjects.clear();
      const CROSS_CONCURRENCY = 3; // lower than main account to avoid rate limits
      const crossAccounts = this.aws.getCrossAccountRoles();
      for (const { customer, roleArn } of crossAccounts) {
        try {
          const projects = await this.aws.listProjectsForRole(roleArn);
          const ecrProjects = projects.filter(p => p.startsWith('ECR-Build_') && !p.match(/-3_\d/));
          log.info(`Pipeline sync: ${customer} account has ${ecrProjects.length} build projects`);

          for (const projectName of ecrProjects) {
            this._crossAccountProjects.set(projectName, { customer, roleArn });
          }

          for (let i = 0; i < ecrProjects.length; i += CROSS_CONCURRENCY) {
            const batch = ecrProjects.slice(i, i + CROSS_CONCURRENCY);
            const outcomes = await Promise.allSettled(
              batch.map(async (projectName) => {
                const card = await this._fetchBuildCardForRole(roleArn, projectName);
                if (card) {
                  card.account = customer;
                  buildCards.push(card);
                  this._cardsByProject.set(projectName, card);
                }
                results.builds++;
              })
            );
            for (const o of outcomes) {
              if (o.status === 'rejected') {
                results.errors++;
                log.warn(`Pipeline sync: build fetch failed for ${customer}: ${o.reason?.message || 'unknown'}`);
              }
            }
            // Pause between batches — longer for large accounts to avoid rate limits
            if (i + CROSS_CONCURRENCY < ecrProjects.length) {
              const delay = ecrProjects.length > 40 ? 1000 : 500;
              await new Promise(r => setTimeout(r, delay));
            }
          }
        } catch (err) {
          log.warn(`Pipeline sync: cross-account failed for ${customer}: ${err.message}`);
          results.errors++;
        }
      }

      this._sortCards(buildCards);
      this.buildProjects = buildCards;
      this._writeBuildByJiraKey(buildCards);

      // Step 3: Fetch deploy pipeline states (all)
      this.deployTargets = await this._fetchAllDeployStates(results);

    } catch (err) {
      results.errors++;
      log.error('Pipeline sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`Pipeline sync complete: ${results.builds} builds, ${results.deploys} deploys in ${results.durationMs}ms`);
    this._computeHotSet();
    this._persistToDb();
    this.emit('sync:completed', results);
    return results;
  }

  // ── Hot sync ───────────────────────────────────────────────
  async runHot() {
    if (this._running) return this.lastResults;
    if (this._hotEntries.length === 0) return this.lastResults;

    this._running = true;
    const startTime = Date.now();

    const results = { builds: 0, deploys: 0, errors: 0, mode: 'hot' };

    try {
      // Fetch builds in parallel (concurrency 5) — was sequential with 200ms delays
      const HOT_CONCURRENCY = 5;
      for (let i = 0; i < this._hotEntries.length; i += HOT_CONCURRENCY) {
        const batch = this._hotEntries.slice(i, i + HOT_CONCURRENCY);
        const outcomes = await Promise.allSettled(
          batch.map(async ({ projectName, account, roleArn }) => {
            const card = roleArn
              ? await this._fetchBuildCardForRole(roleArn, projectName)
              : await this._fetchBuildCard(projectName);
            if (card) {
              card.account = account;
              this._cardsByProject.set(projectName, card);
            }
            results.builds++;
          })
        );
        for (const o of outcomes) {
          if (o.status === 'rejected') {
            results.errors++;
            log.warn(`Pipeline hot-sync: ${o.reason?.message || 'unknown error'}`);
          }
        }
      }

      // Rebuild full list from cache
      const allCards = [...this._cardsByProject.values()];
      this._sortCards(allCards);
      this.buildProjects = allCards;
      this._writeBuildByJiraKey(allCards);

      // Refresh deploy states only for hot tags
      this.deployTargets = await this._fetchDeployStatesForTags(this._hotTags, results);

    } catch (err) {
      results.errors++;
      log.error('Pipeline hot-sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`Pipeline hot-sync: ${results.builds} builds, ${results.deploys} deploys in ${results.durationMs}ms`);
    this._computeHotSet();
    this._persistToDb();
    this.emit('sync:completed', results);
    return results;
  }

  // ── In-progress sync (tier 1) ─────────────────────────────

  /**
   * Tier 1: Only re-fetch builds that are currently IN_PROGRESS.
   * Typically 0-3 builds — sub-second when idle.
   */
  async runInProgress() {
    if (this._running) return this.lastResults;

    // Find in-progress builds from DB
    const inProgress = this.db.prepare(
      "SELECT projectName, account, data FROM build_cards WHERE latestStatus = 'IN_PROGRESS'"
    ).all();

    if (inProgress.length === 0) return this.lastResults;

    this._running = true;
    const startTime = Date.now();
    const results = { builds: 0, deploys: 0, errors: 0, mode: 'in-progress' };

    try {
      for (const row of inProgress) {
        try {
          const card = JSON.parse(row.data);
          const cross = this._crossAccountProjects.get(row.projectName);
          const fetchFn = cross
            ? () => this.aws.getBuildsForProjectInRole(cross.roleArn, row.projectName, 5)
            : () => this.aws.getBuildsForProject(row.projectName, 5);

          const fetched = await fetchFn();
          if (fetched.length > 0) {
            const latest = fetched[0];
            card.latestStatus = latest.status;
            card.latestStartTime = latest.startTime;
            card.builds = fetched.slice(0, 5).map(b => ({
              buildNumber: b.buildNumber,
              status: b.status,
              startTime: b.startTime,
              endTime: b.endTime,
              durationSec: b.durationSec,
              commitSha: b.resolvedSourceVersion,
              jiraKeys: card.builds?.find(ob => ob.buildNumber === b.buildNumber)?.jiraKeys || [],
            }));
            this._cardsByProject.set(row.projectName, card);
          }
          results.builds++;
        } catch (err) {
          results.errors++;
          log.warn(`Pipeline in-progress sync: failed for ${row.projectName}: ${err.message}`);
        }
      }

      // Rebuild and persist
      const allCards = [...this._cardsByProject.values()];
      this._sortCards(allCards);
      this.buildProjects = allCards;
      this._persistToDb();
    } catch (err) {
      results.errors++;
      log.error('Pipeline in-progress sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this._running = false;

    if (results.builds > 0) {
      log.info(`Pipeline in-progress sync: ${results.builds} builds in ${results.durationMs}ms`);
      this.emit('sync:completed', results);
    }
    return results;
  }

  // ── SQLite persistence ────────────────────────────────────

  _persistToDb() {
    const now = new Date().toISOString();
    const upsertCard = this.db.prepare(`
      INSERT INTO build_cards (projectName, account, imageTag, latestStatus, latestStartTime, data, updatedAt)
      VALUES (@projectName, @account, @imageTag, @latestStatus, @latestStartTime, @data, @updatedAt)
      ON CONFLICT(projectName) DO UPDATE SET
        account = excluded.account, imageTag = excluded.imageTag,
        latestStatus = excluded.latestStatus, latestStartTime = excluded.latestStartTime,
        data = excluded.data, updatedAt = excluded.updatedAt
    `);
    const upsertDeploy = this.db.prepare(`
      INSERT INTO deploy_states (pipelineName, imageTag, customer, env, account, status, data, updatedAt)
      VALUES (@pipelineName, @imageTag, @customer, @env, @account, @status, @data, @updatedAt)
      ON CONFLICT(pipelineName) DO UPDATE SET
        imageTag = excluded.imageTag, customer = excluded.customer, env = excluded.env,
        account = excluded.account, status = excluded.status,
        data = excluded.data, updatedAt = excluded.updatedAt
    `);

    const persistAll = this.db.transaction(() => {
      for (const card of this.buildProjects) {
        upsertCard.run({
          projectName: card.projectName,
          account: card.account || null,
          imageTag: card.imageTag || null,
          latestStatus: card.latestStatus || null,
          latestStartTime: card.latestStartTime || null,
          data: JSON.stringify(card),
          updatedAt: now,
        });
      }
      for (const [tag, targets] of Object.entries(this.deployTargets)) {
        for (const target of targets) {
          upsertDeploy.run({
            pipelineName: target.pipelineName,
            imageTag: tag,
            customer: target.customer || null,
            env: target.env || null,
            account: target.account || null,
            status: target.status || null,
            data: JSON.stringify(target),
            updatedAt: now,
          });
        }
      }
    });

    try {
      persistAll();
    } catch (err) {
      log.warn(`Pipeline sync: failed to persist to DB: ${err.message}`);
    }
  }

  /**
   * Read builds page data from SQLite (for two-process mode where
   * the web process reads from DB instead of in-memory arrays).
   */
  getBuildsPageDataFromDb() {
    const cardRows = this.db.prepare('SELECT data FROM build_cards ORDER BY latestStartTime DESC').all();
    const cards = cardRows.map(r => JSON.parse(r.data));

    const deployRows = this.db.prepare('SELECT imageTag, data FROM deploy_states').all();
    const deployTargets = {};
    for (const row of deployRows) {
      const tag = row.imageTag || 'unknown';
      if (!deployTargets[tag]) deployTargets[tag] = [];
      deployTargets[tag].push(JSON.parse(row.data));
    }

    // Temporarily set deployTargets so _groupByCustomer/_hasTargetsForCustomer
    // can filter correctly (they read from this.deployTargets)
    const prevTargets = this.deployTargets;
    this.deployTargets = deployTargets;
    const customers = this._groupByCustomer(cards);
    this.deployTargets = prevTargets;

    return { customers, deployTargets, lastRun: this.lastRun };
  }

  // ── Hot set computation ────────────────────────────────────

  _computeHotSet() {
    const customers = this._groupByCustomer(this.buildProjects);
    const hotNames = new Set();

    for (const c of customers) {
      if (c.pinnedBuild) hotNames.add(c.pinnedBuild.projectName);
      for (const b of c.recentBuilds) hotNames.add(b.projectName);
    }

    // Any IN_PROGRESS build is also hot
    for (const card of this.buildProjects) {
      if (card.latestStatus === 'IN_PROGRESS') hotNames.add(card.projectName);
    }

    // Build entries with account/roleArn info
    const entries = [];
    const tags = new Set();
    for (const projectName of hotNames) {
      const card = this._cardsByProject.get(projectName);
      if (!card) continue;

      const cross = this._crossAccountProjects.get(projectName);
      entries.push({
        projectName,
        account: card.account || 'Viv',
        roleArn: cross ? cross.roleArn : null,
      });

      // Collect tags for deploy state filtering
      if (card.imageTag) {
        tags.add(card.imageTag);
        const aliases = TAG_ALIASES[card.imageTag];
        if (aliases) aliases.forEach(a => tags.add(a));
      }
    }

    this._hotEntries = entries;
    this._hotTags = tags;
    log.info(`Pipeline sync: ${entries.length} hot projects, ${tags.size} hot tags (of ${this.buildProjects.length} total)`);
  }

  /**
   * Called by env-poll when a version change is detected.
   * Promotes any project matching the imageTag into the hot set
   * so the next hot cycle picks it up.
   */
  promoteToHot(imageTag) {
    if (!imageTag) return;

    const newEntries = [];
    for (const [projectName, card] of this._cardsByProject) {
      if (card.imageTag !== imageTag) continue;
      if (this._hotEntries.some(e => e.projectName === projectName)) continue;

      const cross = this._crossAccountProjects.get(projectName);
      newEntries.push({
        projectName,
        account: card.account || 'Viv',
        roleArn: cross ? cross.roleArn : null,
      });
    }

    if (newEntries.length > 0) {
      this._hotEntries = [...this._hotEntries, ...newEntries];
      this._hotTags.add(imageTag);
      log.info(`Pipeline sync: promoted ${newEntries.length} project(s) to hot for tag ${imageTag}`);
    }
  }

  // ── Deploy state fetching ──────────────────────────────────

  async _fetchAllDeployStates(results) {
    return this._fetchDeployStatesForTags(null, results);
  }

  async _fetchDeployStatesForTags(tagFilter, results) {
    const AwsClient = require('../integrations/aws');

    // Start with existing deploy targets if this is a partial (hot) refresh,
    // so cold tags' states aren't wiped out.
    const deployTargets = tagFilter ? { ...this.deployTargets } : {};

    // Clear entries for tags we're about to refresh
    if (tagFilter) {
      for (const tag of tagFilter) {
        delete deployTargets[tag];
      }
    }

    // Main account deploy states (parallel, concurrency 5)
    const DEPLOY_CONCURRENCY = 5;
    const mainDeployEntries = Object.entries(this._deployMap || {})
      .filter(([, info]) => !tagFilter || tagFilter.has(info.imageTag || 'unknown'));
    for (let i = 0; i < mainDeployEntries.length; i += DEPLOY_CONCURRENCY) {
      const batch = mainDeployEntries.slice(i, i + DEPLOY_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async ([name, info]) => {
          try {
            const tag = info.imageTag || 'unknown';
            const state = await this.aws.getPipelineState(name);
            const deployStage = state.stages.find(s =>
              s.stageName === 'Deploy' || s.stageName === 'deploy'
            ) || state.stages[state.stages.length - 1];

            if (!deployTargets[tag]) deployTargets[tag] = [];
            deployTargets[tag].push({
              pipelineName: name,
              customer: info.customer,
              env: info.env,
              status: deployStage?.status || null,
              lastUpdated: deployStage?.lastUpdated || null,
              account: 'Viv',
              ecrRepo: info.ecrRepo || null,
            });
            results.deploys++;
          } catch (err) {
            log.warn(`Pipeline sync: deploy state failed for ${name}: ${err.message}`);
          }
        })
      );
    }

    // Cross-account deploy states (parallel, concurrency 5)
    const crossAccounts = this.aws.getCrossAccountRoles();
    for (const { customer, roleArn } of crossAccounts) {
      try {
        let deployPipelines = this._deployPipelinesByRole.get(roleArn);
        if (!deployPipelines) {
          const pipelines = await this.aws.listPipelinesForRole(roleArn);
          deployPipelines = pipelines.filter(p => p.startsWith('Deploy-'));
          this._deployPipelinesByRole.set(roleArn, deployPipelines);
        }

        for (let i = 0; i < deployPipelines.length; i += DEPLOY_CONCURRENCY) {
          const batch = deployPipelines.slice(i, i + DEPLOY_CONCURRENCY);
          await Promise.allSettled(
            batch.map(async (name) => {
              try {
                const cacheKey = `${roleArn}:${name}`;
                let config = this._deployConfigByRole.get(cacheKey);
                if (!config) {
                  config = await this.aws.getPipelineConfigForRole(roleArn, name);
                  this._deployConfigByRole.set(cacheKey, config);
                }
                const tag = config.ecrImageTag || 'unknown';
                if (tagFilter && !tagFilter.has(tag)) return;

                const state = await this.aws.getPipelineStateForRole(roleArn, name);
                const parsed = AwsClient.parsePipelineName(name);
                const deployStage = state.stages.find(s =>
                  s.stageName === 'Deploy' || s.stageName === 'deploy'
                ) || state.stages[state.stages.length - 1];

                if (!deployTargets[tag]) deployTargets[tag] = [];
                deployTargets[tag].push({
                  pipelineName: name,
                  customer: parsed?.customer || customer,
                  env: parsed?.env || name,
                  status: deployStage?.status || null,
                  lastUpdated: deployStage?.lastUpdated || null,
                  account: customer,
                  ecrRepo: config.ecrRepo || null,
                });
                results.deploys++;
              } catch (err) {
                log.warn(`Pipeline sync: ${customer} deploy failed for ${name}: ${err.message}`);
              }
            })
          );
        }
      } catch (err) {
        log.warn(`Pipeline sync: ${customer} deploy list failed: ${err.message}`);
      }
    }

    return deployTargets;
  }

  // ── Shared helpers ─────────────────────────────────────────

  _sortCards(cards) {
    const statusOrder = { IN_PROGRESS: 0, FAILED: 1, SUCCEEDED: 2, STOPPED: 3 };
    cards.sort((a, b) => {
      const ao = statusOrder[a.latestStatus] ?? 4;
      const bo = statusOrder[b.latestStatus] ?? 4;
      if (ao !== bo) return ao - bo;
      return (b.latestStartTime || '').localeCompare(a.latestStartTime || '');
    });
  }

  _writeBuildByJiraKey(cards) {
    try {
      for (const card of cards) {
        if (!card.version || !card.buildByJiraKey) continue;
        const release = this.releases.get?.(card.version, card.repo);
        if (release) {
          release.buildByJiraKey = card.buildByJiraKey;
          release.buildSyncedAt = new Date().toISOString();
          this.releases.persist?.(release);
        }
      }
    } catch (err) {
      log.warn(`Pipeline sync: failed to write buildByJiraKey: ${err.message}`);
    }
  }

  /**
   * Discover CodeBuild projects and CodePipeline → ECR mappings.
   * Only runs once (cached).
   */
  async _ensureDiscovery() {
    // Re-discover if previous discovery found no deploy mappings (likely a network failure)
    if (this._projectList && Object.keys(this._deployMap || {}).length > 0) return;

    const AwsClient = require('../integrations/aws');

    // CodeBuild projects
    const projects = await this.aws.listProjects();
    this._projectList = projects.filter(p => {
      if (!p.startsWith('ECR-Build_')) return false;
      if (p.match(/-3_\d/)) return false;
      return true;
    });
    log.info(`Pipeline sync: found ${this._projectList.length} build projects`);

    // CodePipeline → ECR mapping
    const pipelines = await this.aws.listPipelines();
    const deployPipelines = pipelines.filter(p => p.startsWith('Deploy-'));
    this._deployMap = {};

    for (const name of deployPipelines) {
      try {
        const config = await this.aws.getPipelineConfig(name);
        const parsed = AwsClient.parsePipelineName(name);
        if (parsed && config.ecrImageTag) {
          this._deployMap[name] = {
            ...parsed,
            ecrRepo: config.ecrRepo,
            imageTag: config.ecrImageTag,
          };
        }
      } catch (err) {
        log.warn(`Pipeline sync: failed to read config for ${name}: ${err.message}`);
      }
    }

    log.info(`Pipeline sync: mapped ${Object.keys(this._deployMap).length} deploy pipelines`);
  }

  /**
   * Build a card for a single CodeBuild project.
   */
  async _fetchBuildCard(projectName) {
    const AwsClient = require('../integrations/aws');
    const parsed = AwsClient.parseProjectName(projectName);
    if (!parsed) return null;

    const builds = await this.aws.getBuildsForProject(projectName, 5);
    if (builds.length === 0) return null;

    const latest = builds[0];

    // Compute JIRA keys per build by diffing consecutive commit SHAs
    const enrichedBuilds = [];
    for (let i = 0; i < builds.length; i++) {
      const b = builds[i];
      let buildJiraKeys = [];
      let buildCommits = [];

      if (b.resolvedSourceVersion && parsed.repo === 'webplatform') {
        const olderBuild = builds.slice(i + 1).find(ob => ob.resolvedSourceVersion && ob.resolvedSourceVersion !== b.resolvedSourceVersion);
        const baseSha = olderBuild?.resolvedSourceVersion || null;

        try {
          if (baseSha) {
            buildCommits = await this.repoManager.log('webplatform', `${baseSha}..${b.resolvedSourceVersion}`, { limit: 30 });
          } else if (i === builds.length - 1) {
            buildCommits = await this.repoManager.log('webplatform', b.resolvedSourceVersion, { limit: 10 });
          }
          buildJiraKeys = JiraClient.extractKeys(buildCommits.map(c => c.message).join(' '));
        } catch { /* git log failed — branch not fetched */ }
      }

      enrichedBuilds.push({
        buildNumber: b.buildNumber,
        status: b.status,
        startTime: b.startTime,
        endTime: b.endTime,
        durationSec: b.durationSec,
        commitSha: b.resolvedSourceVersion,
        jiraKeys: buildJiraKeys,
        commits: buildCommits,
      });
    }

    const newCommits = enrichedBuilds[0]?.commits || [];
    const jiraKeys = enrichedBuilds[0]?.jiraKeys || [];

    const buildByJiraKey = {};
    for (let i = enrichedBuilds.length - 1; i >= 0; i--) {
      const b = enrichedBuilds[i];
      for (const key of b.jiraKeys) {
        buildByJiraKey[key] = {
          buildNumber: b.buildNumber,
          status: b.status,
          startTime: b.startTime,
          branch: parsed.branch || parsed.custom || projectName,
        };
      }
    }

    const imageTag = parsed.version || parsed.branch || parsed.custom || null;

    const rawSourceVersion = latest?.sourceVersion || null;
    const realBranch = rawSourceVersion
      ? rawSourceVersion.replace(/^refs\/heads\//, '')
      : (parsed.branch || parsed.custom || projectName);

    return {
      projectName,
      branch: realBranch,
      version: parsed.version,
      repo: parsed.repo,
      isCustom: !!parsed.custom,
      imageTag,
      ecrRepo: parsed.ecrRepo || null,
      latestStatus: latest.status,
      latestStartTime: latest.startTime,
      builds: enrichedBuilds.map(b => ({
        buildNumber: b.buildNumber,
        status: b.status,
        startTime: b.startTime,
        endTime: b.endTime,
        durationSec: b.durationSec,
        commitSha: b.commitSha,
        jiraKeys: b.jiraKeys,
      })),
      newCommits,
      jiraKeys,
      buildByJiraKey,
    };
  }

  /**
   * Build a card for a cross-account CodeBuild project.
   */
  async _fetchBuildCardForRole(roleArn, projectName) {
    const AwsClient = require('../integrations/aws');
    const parsed = AwsClient.parseProjectName(projectName);
    if (!parsed) return null;

    const builds = await this.aws.getBuildsForProjectInRole(roleArn, projectName, 5);
    if (builds.length === 0) return null;

    const latest = builds[0];
    const previousSuccess = builds.find(b => b.status === 'SUCCEEDED' && b.id !== latest.id);
    const imageTag = parsed.version || parsed.branch || parsed.custom || null;

    const rawSourceVersion = latest?.sourceVersion || previousSuccess?.sourceVersion || null;
    const realBranch = rawSourceVersion
      ? rawSourceVersion.replace(/^refs\/heads\//, '')
      : (parsed.branch || parsed.custom || projectName);

    const enrichedBuilds = [];
    for (let i = 0; i < builds.length; i++) {
      const b = builds[i];
      let buildJiraKeys = [];
      let buildCommits = [];

      if (b.resolvedSourceVersion && parsed.repo === 'webplatform') {
        const olderBuild = builds.slice(i + 1).find(
          ob => ob.resolvedSourceVersion && ob.resolvedSourceVersion !== b.resolvedSourceVersion,
        );
        const baseSha = olderBuild?.resolvedSourceVersion || null;
        try {
          if (baseSha) {
            buildCommits = await this.repoManager.log('webplatform', `${baseSha}..${b.resolvedSourceVersion}`, { limit: 30 });
          } else if (i === builds.length - 1) {
            buildCommits = await this.repoManager.log('webplatform', b.resolvedSourceVersion, { limit: 10 });
          }
          buildJiraKeys = JiraClient.extractKeys(buildCommits.map(c => c.message).join(' '));
        } catch { /* commits not in local clone */ }
      }

      enrichedBuilds.push({
        buildNumber: b.buildNumber,
        status: b.status,
        startTime: b.startTime,
        endTime: b.endTime,
        durationSec: b.durationSec,
        commitSha: b.resolvedSourceVersion,
        jiraKeys: buildJiraKeys,
        commits: buildCommits,
      });
    }

    const newCommits = enrichedBuilds[0]?.commits || [];
    const jiraKeys = enrichedBuilds[0]?.jiraKeys || [];

    const buildByJiraKey = {};
    for (let i = enrichedBuilds.length - 1; i >= 0; i--) {
      const b = enrichedBuilds[i];
      for (const key of b.jiraKeys) {
        buildByJiraKey[key] = {
          buildNumber: b.buildNumber,
          status: b.status,
          startTime: b.startTime,
          branch: realBranch,
        };
      }
    }

    return {
      projectName,
      branch: realBranch,
      version: parsed.version,
      repo: parsed.repo,
      isCustom: !!parsed.custom,
      imageTag,
      ecrRepo: parsed.ecrRepo || null,
      latestStatus: latest.status,
      latestStartTime: latest.startTime,
      builds: enrichedBuilds.map(b => ({
        buildNumber: b.buildNumber,
        status: b.status,
        startTime: b.startTime,
        endTime: b.endTime,
        durationSec: b.durationSec,
        commitSha: b.commitSha,
        jiraKeys: b.jiraKeys,
      })),
      newCommits,
      jiraKeys,
      buildByJiraKey,
    };
  }

  /**
   * Get the full builds page data for the API.
   */
  getBuildsPageData() {
    const customers = this._groupByCustomer(this.buildProjects);
    return {
      customers,
      deployTargets: this.deployTargets,
      lastRun: this.lastRun,
    };
  }

  _pickPinned(customerKey, cards) {
    if (customerKey === 'viv') {
      return cards.find(c => c.ecrRepo === 'viv-master' || c.branch === 'master') || null;
    }
    const repo = `viv-release-${customerKey}`;
    const candidates = cards.filter(c => c.ecrRepo === repo);
    if (candidates.length === 0) return null;
    return candidates.slice().sort((a, b) =>
      (b.latestStartTime || '').localeCompare(a.latestStartTime || '')
    )[0] || null;
  }

  _pickRecent(pinned, cards) {
    const pinnedName = pinned && pinned.projectName;
    return cards
      .filter(c => c.projectName !== pinnedName)
      .slice()
      .sort((a, b) => (b.latestStartTime || '').localeCompare(a.latestStartTime || ''))
      .slice(0, 4);
  }

  _normalizeAccount(card) {
    const raw = card && card.account;
    if (!raw) return 'viv';
    const key = String(raw).toLowerCase();
    if (key === 'viv') return 'viv';
    return key;
  }

  _enrichCard(card) {
    const pr = this.prSync ? this.prSync.findPRByBranch(card.branch) : null;
    return {
      ...card,
      prUrl: pr ? pr.prUrl : null,
      githubBranchUrl: `https://github.com/mavencare/webplatform/tree/${encodeURIComponent(card.branch || '')}`,
      customerKey: this._normalizeAccount(card),
    };
  }

  _hasTargetsForCustomer(card, customerKey) {
    if (!card?.imageTag) return false;
    const tagAliases = TAG_ALIASES[card.imageTag] || [card.imageTag];
    for (const tag of tagAliases) {
      const list = this.deployTargets?.[tag];
      if (!list) continue;
      for (const t of list) {
        if ((t.account || '').toLowerCase() !== customerKey) continue;
        if (card.ecrRepo && t.ecrRepo && t.ecrRepo !== card.ecrRepo) continue;
        return true;
      }
    }
    return false;
  }

  _groupByCustomer(cards) {
    const buckets = new Map();
    for (const rawCard of cards || []) {
      const enriched = this._enrichCard(rawCard);
      const key = this._normalizeAccount(enriched);
      if (!this._hasTargetsForCustomer(enriched, key)) continue;
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          label: CUSTOMER_LABELS[key] || key,
          account: key,
          allBuilds: [],
          pinnedBuild: null,
          recentBuilds: [],
        });
      }
      buckets.get(key).allBuilds.push(enriched);
    }

    for (const bucket of buckets.values()) {
      bucket.pinnedBuild = this._pickPinned(bucket.key, bucket.allBuilds);
      bucket.recentBuilds = this._pickRecent(bucket.pinnedBuild, bucket.allBuilds);
    }

    const result = Array.from(buckets.values()).filter(b => b.allBuilds.length > 0);
    result.sort((a, b) => {
      const ai = CUSTOMER_ORDER.indexOf(a.key);
      const bi = CUSTOMER_ORDER.indexOf(b.key);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.key.localeCompare(b.key);
    });
    return result;
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.aws.isConfigured(),
      projectCount: this._projectList?.length || 0,
      deployCount: Object.keys(this._deployMap || {}).length,
      hotProjectCount: this._hotEntries.length,
    };
  }
}

module.exports = PipelineSync;
