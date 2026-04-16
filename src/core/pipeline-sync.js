const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');

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
 * Data model stored on release manager as `_pipelineData`:
 *   builds: [{ projectName, branch, status, builds[], newCommits[], jiraKeys[] }]
 *   deployTargets: { imageTag → [{ pipelineName, customer, env, status, lastUpdated }] }
 *
 * Events:
 *   sync:started
 *   sync:completed ({ ... })
 */
class PipelineSync extends EventEmitter {
  constructor(releases, aws, repoManager, config) {
    super();
    this.releases = releases;
    this.aws = aws;
    this.repoManager = repoManager;
    this.config = config;
    this._timer = null;
    this._running = false;
    this.lastRun = null;
    this.lastResults = null;

    // Cached data — exposed to API
    this.buildProjects = [];   // full list of build cards
    this.deployTargets = {};   // imageTag → deploy pipeline states
    this._projectList = null;  // raw project names
    this._deployMap = null;    // pipelineName → { ecrRepo, imageTag, customer, env }
    this.prSync = null;
  }

  setPrSync(prSync) {
    this.prSync = prSync;
  }

  start() {
    if (!this.aws.isConfigured()) {
      log.warn('Pipeline sync disabled (AWS not configured)');
      return;
    }

    const interval = (this.config.polling && this.config.polling.pipelineSync) || 3 * 60 * 1000;
    log.info(`Pipeline sync started (polling every ${interval / 60000}m)`);

    setTimeout(() => {
      this.run().catch(err => log.error('Pipeline sync error:', err.message));
    }, 15000);

    this._timer = setInterval(() => {
      this.run().catch(err => log.error('Pipeline sync error:', err.message));
    }, interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async run() {
    if (this._running) {
      log.warn('Pipeline sync already running, skipping');
      return this.lastResults;
    }

    this._running = true;
    const startTime = Date.now();
    this.emit('sync:started');

    const results = { builds: 0, deploys: 0, errors: 0 };

    try {
      // Step 1: Discover projects and deploy mappings (cached after first run)
      await this._ensureDiscovery();

      // Step 2: Fetch builds for main account projects
      const buildCards = [];
      for (const projectName of (this._projectList || [])) {
        try {
          const card = await this._fetchBuildCard(projectName);
          if (card) { card.account = 'Viv'; buildCards.push(card); }
          results.builds++;
          await new Promise(r => setTimeout(r, 500)); // rate limit
        } catch (err) {
          log.warn(`Pipeline sync: build fetch failed for ${projectName}: ${err.message}`);
          results.errors++;
        }
      }

      // Step 2b: Fetch builds from cross-account roles
      const crossAccounts = this.aws.getCrossAccountRoles();
      for (const { customer, roleArn } of crossAccounts) {
        try {
          const projects = await this.aws.listProjectsForRole(roleArn);
          const ecrProjects = projects.filter(p => p.startsWith('ECR-Build_') && !p.match(/-3_\d/));
          log.info(`Pipeline sync: ${customer} account has ${ecrProjects.length} build projects`);

          for (const projectName of ecrProjects) {
            try {
              const card = await this._fetchBuildCardForRole(roleArn, projectName);
              if (card) { card.account = customer; buildCards.push(card); }
              results.builds++;
              await new Promise(r => setTimeout(r, 500)); // rate limit
            } catch (err) {
              log.warn(`Pipeline sync: build fetch failed for ${customer}/${projectName}: ${err.message}`);
              results.errors++;
            }
          }
        } catch (err) {
          log.warn(`Pipeline sync: cross-account failed for ${customer}: ${err.message}`);
          results.errors++;
        }
      }

      // Each CodeBuild project is its own card — no cross-account dedup.
      const deduped = buildCards;

      // Sort: IN_PROGRESS first, then FAILED, then SUCCEEDED, then rest
      const statusOrder = { IN_PROGRESS: 0, FAILED: 1, SUCCEEDED: 2, STOPPED: 3 };
      deduped.sort((a, b) => {
        const ao = statusOrder[a.latestStatus] ?? 4;
        const bo = statusOrder[b.latestStatus] ?? 4;
        if (ao !== bo) return ao - bo;
        return (b.latestStartTime || '').localeCompare(a.latestStartTime || '');
      });

      this.buildProjects = deduped;

      // Store buildByJiraKey on matching releases
      try {
        for (const card of deduped) {
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

      // Step 3: Fetch deploy pipeline states (main account)
      const deployTargets = {};
      for (const [name, info] of Object.entries(this._deployMap || {})) {
        try {
          const state = await this.aws.getPipelineState(name);
          const deployStage = state.stages.find(s =>
            s.stageName === 'Deploy' || s.stageName === 'deploy'
          ) || state.stages[state.stages.length - 1];

          const tag = info.imageTag || 'unknown';
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
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          log.warn(`Pipeline sync: deploy state failed for ${name}: ${err.message}`);
        }
      }

      // Step 3b: Fetch deploy pipelines from cross-accounts
      const AwsClient = require('../integrations/aws');
      for (const { customer, roleArn } of crossAccounts) {
        try {
          const pipelines = await this.aws.listPipelinesForRole(roleArn);
          const deployPipelines = pipelines.filter(p => p.startsWith('Deploy-'));

          for (const name of deployPipelines) {
            try {
              const config = await this.aws.getPipelineConfigForRole(roleArn, name);
              const state = await this.aws.getPipelineStateForRole(roleArn, name);
              const parsed = AwsClient.parsePipelineName(name);
              const deployStage = state.stages.find(s =>
                s.stageName === 'Deploy' || s.stageName === 'deploy'
              ) || state.stages[state.stages.length - 1];

              const tag = config.ecrImageTag || 'unknown';
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
              await new Promise(r => setTimeout(r, 100));
            } catch (err) {
              log.warn(`Pipeline sync: ${customer} deploy failed for ${name}: ${err.message}`);
            }
          }
        } catch (err) {
          log.warn(`Pipeline sync: ${customer} deploy list failed: ${err.message}`);
        }
      }

      this.deployTargets = deployTargets;

    } catch (err) {
      results.errors++;
      log.error('Pipeline sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`Pipeline sync complete: ${results.builds} builds, ${results.deploys} deploys in ${results.durationMs}ms`);
    this.emit('sync:completed', results);
    return results;
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
    // Filter to ECR-Build_ projects, skip ancient versions (3.x)
    this._projectList = projects.filter(p => {
      if (!p.startsWith('ECR-Build_')) return false;
      // Skip very old releases (3.x.x) to reduce API calls
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
        await new Promise(r => setTimeout(r, 100));
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
        // Find the next older build with a different SHA as the base
        const olderBuild = builds.slice(i + 1).find(ob => ob.resolvedSourceVersion && ob.resolvedSourceVersion !== b.resolvedSourceVersion);
        const baseSha = olderBuild?.resolvedSourceVersion || null;

        try {
          if (baseSha) {
            buildCommits = await this.repoManager.log('webplatform', `${baseSha}..${b.resolvedSourceVersion}`, { limit: 30 });
          } else if (i === builds.length - 1) {
            // Oldest build in our window — show last few commits
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

    // Latest build's commits/keys for the card display
    const newCommits = enrichedBuilds[0]?.commits || [];
    const jiraKeys = enrichedBuilds[0]?.jiraKeys || [];

    // Build reverse index: JIRA key → build info (first successful build containing it)
    const buildByJiraKey = {};
    // Walk from oldest to newest so the latest build wins
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

    // Prefer the real branch from CodeBuild over parsed.branch (parseProjectName
    // only guesses from the project name). `sourceVersion` is the ref requested
    // at build time — strip `refs/heads/` if present.
    const rawSourceVersion = latest?.sourceVersion || previousSuccess?.sourceVersion || null;
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

    // Compute JIRA keys per build by diffing consecutive commit SHAs.
    // Mirrors _fetchBuildCard. Cross-account builds often share the webplatform
    // repo so the local git clone usually has the commits.
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

    // Reverse index: JIRA key → build info (latest build containing it wins)
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
        // If the build has a known ecrRepo, the pipeline must consume from
        // the same repo. Different brands can share a tag (e.g. 4.2.0-cktribute
        // appears in viv-release-tribute, viv-release-haven, viv-release-qualitycare).
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
    };
  }
}

module.exports = PipelineSync;
