const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');

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

      // Step 2: Fetch builds for each project
      const buildCards = [];
      for (const projectName of (this._projectList || [])) {
        try {
          const card = await this._fetchBuildCard(projectName);
          if (card) buildCards.push(card);
          results.builds++;
        } catch (err) {
          log.warn(`Pipeline sync: build fetch failed for ${projectName}: ${err.message}`);
          results.errors++;
        }
      }

      // Sort: IN_PROGRESS first, then FAILED, then SUCCEEDED, then rest
      const statusOrder = { IN_PROGRESS: 0, FAILED: 1, SUCCEEDED: 2, STOPPED: 3 };
      buildCards.sort((a, b) => {
        const ao = statusOrder[a.latestStatus] ?? 4;
        const bo = statusOrder[b.latestStatus] ?? 4;
        if (ao !== bo) return ao - bo;
        // Within same status, most recent first
        return (b.latestStartTime || '').localeCompare(a.latestStartTime || '');
      });

      this.buildProjects = buildCards;

      // Step 3: Fetch deploy pipeline states
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
          });
          results.deploys++;
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          log.warn(`Pipeline sync: deploy state failed for ${name}: ${err.message}`);
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
    // Filter to ECR-Build_ projects only
    this._projectList = projects.filter(p => p.startsWith('ECR-Build_'));
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
    const previousSuccess = builds.find(b => b.status === 'SUCCEEDED' && b.id !== latest.id);

    // Get new commits from local git
    let newCommits = [];
    let jiraKeys = [];
    if (latest.resolvedSourceVersion && parsed.repo === 'webplatform') {
      try {
        const baseSha = previousSuccess?.resolvedSourceVersion || null;
        if (baseSha) {
          newCommits = await this.repoManager.log('webplatform', `${baseSha}..${latest.resolvedSourceVersion}`, { limit: 30 });
        } else {
          newCommits = await this.repoManager.log('webplatform', latest.resolvedSourceVersion, { limit: 10 });
        }
        jiraKeys = JiraClient.extractKeys(newCommits.map(c => c.message).join(' '));
      } catch { /* branch not fetched yet */ }
    }

    // Find which deploy targets use this build's image tag
    const imageTag = parsed.version || parsed.branch || parsed.custom || null;

    return {
      projectName,
      branch: parsed.branch || parsed.custom || projectName,
      version: parsed.version,
      repo: parsed.repo,
      isCustom: !!parsed.custom,
      imageTag,
      latestStatus: latest.status,
      latestStartTime: latest.startTime,
      builds: builds.map(b => ({
        buildNumber: b.buildNumber,
        status: b.status,
        startTime: b.startTime,
        endTime: b.endTime,
        durationSec: b.durationSec,
        commitSha: b.resolvedSourceVersion,
      })),
      newCommits,
      jiraKeys,
    };
  }

  /**
   * Get the full builds page data for the API.
   */
  getBuildsPageData() {
    return {
      builds: this.buildProjects,
      deployTargets: this.deployTargets,
      lastRun: this.lastRun,
    };
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
