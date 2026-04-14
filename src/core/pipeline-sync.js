const { EventEmitter } = require('events');
const log = require('./log');
const JiraClient = require('../integrations/jira');

/**
 * AWS Pipeline sync — polls CodeBuild + CodePipeline and maps
 * build/deploy status to Nectar releases.
 *
 * Unified model: each release has a "pipeline" with:
 *   - build: { status, buildNumber, startTime, endTime, duration, commitSha, commits[], jiraKeys[] }
 *   - deploys: [{ name, customer, env, status, lastUpdated }]
 *
 * Events:
 *   sync:started
 *   sync:completed ({ builds, deploys, releasesUpdated, durationMs })
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
    // Cache: project name → parsed release info
    this._projectMap = null;
    // Cache: pipeline name → parsed deploy info
    this._pipelineMap = null;
  }

  start() {
    if (!this.aws.isConfigured()) {
      log.warn('Pipeline sync disabled (AWS not configured)');
      return;
    }

    const interval = (this.config.polling && this.config.polling.pipelineSync) || 3 * 60 * 1000; // 3 min
    log.info(`Pipeline sync started (polling every ${interval / 60000}m)`);

    // Initial sync after short delay
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

    const results = {
      buildsChecked: 0,
      deploysChecked: 0,
      releasesUpdated: 0,
      errors: 0,
    };

    try {
      // Step 1: Discover CodeBuild projects → map to releases
      await this._ensureProjectMap();

      // Step 2: For each active release, fetch build status
      const activeReleases = this.releases.list().filter(r =>
        r.state !== 'done' && !r.jiraArchived && r.repo === 'webplatform'
      );

      for (const release of activeReleases) {
        try {
          const updated = await this._syncReleasePipeline(release);
          if (updated) results.releasesUpdated++;
          results.buildsChecked++;
        } catch (err) {
          results.errors++;
          log.warn(`Pipeline sync: failed for ${release.version}: ${err.message}`);
        }
      }

      // Deploy status comes from Nectar's environment poller (which envs run which version)
      // — not from CodePipeline, which tracks deployment actions not release-specific state.

    } catch (err) {
      results.errors++;
      log.error('Pipeline sync error:', err.message);
    }

    results.durationMs = Date.now() - startTime;
    this.lastRun = new Date().toISOString();
    this.lastResults = results;
    this._running = false;

    log.info(`Pipeline sync complete: ${results.buildsChecked} builds, ${results.deploysChecked} deploys, ${results.releasesUpdated} releases updated in ${results.durationMs}ms`);
    this.emit('sync:completed', results);

    return results;
  }

  /**
   * Build the CodeBuild project → release mapping (cached).
   */
  async _ensureProjectMap() {
    if (this._projectMap) return;

    try {
      const projects = await this.aws.listProjects();
      this._projectMap = new Map();
      const AwsClient = require('../integrations/aws');

      for (const name of projects) {
        const parsed = AwsClient.parseProjectName(name);
        if (parsed && parsed.version) {
          this._projectMap.set(parsed.version, name);
        }
      }
      // Log which active releases have matching projects
      const activeVersions = this.releases.list()
        .filter(r => r.state !== 'done' && !r.jiraArchived && r.repo === 'webplatform')
        .map(r => r.version);
      const matched = activeVersions.filter(v => this._projectMap.has(v));
      const unmatched = activeVersions.filter(v => !this._projectMap.has(v));
      log.info(`Pipeline sync: mapped ${this._projectMap.size} CodeBuild projects to releases (${matched.length} active matched, ${unmatched.length} unmatched: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? '...' : ''})`);
    } catch (err) {
      log.error('Pipeline sync: failed to list CodeBuild projects:', err.message);
      this._projectMap = new Map();
    }
  }

  /**
   * Sync build + commit data for a single release.
   */
  async _syncReleasePipeline(release) {
    // Try exact match first, then strip customer suffix (e.g., 4.1.0.4-ck → 4.1.0.4)
    let projectName = this._projectMap.get(release.version);
    if (!projectName) {
      const baseVersion = release.version.replace(/-[a-z]+$/i, '');
      if (baseVersion !== release.version) {
        projectName = this._projectMap.get(baseVersion);
      }
    }
    if (!projectName) return false;

    // Get recent builds
    const builds = await this.aws.getBuildsForProject(projectName, 5);
    if (builds.length === 0) return false;

    const latest = builds[0];
    const previous = builds.find(b => b.status === 'SUCCEEDED' && b.id !== latest.id);

    // Get new commits since last successful build using local git
    let newCommits = [];
    let jiraKeys = [];
    if (latest.resolvedSourceVersion) {
      const baseSha = previous?.resolvedSourceVersion || null;
      try {
        if (baseSha) {
          // Commits between last successful build and current
          newCommits = await this.repoManager.log(
            'webplatform',
            `${baseSha}..${latest.resolvedSourceVersion}`,
            { limit: 50 }
          );
        } else {
          // No previous build — just show last few commits on the branch
          newCommits = await this.repoManager.log(
            'webplatform',
            latest.resolvedSourceVersion,
            { limit: 10 }
          );
        }
        // Extract JIRA keys from commit messages
        const allText = newCommits.map(c => c.message).join(' ');
        jiraKeys = JiraClient.extractKeys(allText);
      } catch (err) {
        // Git operation failed — branch might not be fetched yet
        log.warn(`Pipeline sync: git log failed for ${release.version}: ${err.message}`);
      }
    }

    // Store on release
    const key = this.releases._key(release.repo, release.version);
    const rel = this.releases.releases.get(key);
    if (!rel) return false;

    rel.pipeline = {
      projectName,
      builds: builds.map(b => ({
        buildNumber: b.buildNumber,
        status: b.status,
        startTime: b.startTime,
        endTime: b.endTime,
        durationSec: b.durationSec,
        commitSha: b.resolvedSourceVersion,
        initiator: b.initiator,
      })),
      latest: {
        buildNumber: latest.buildNumber,
        status: latest.status,
        startTime: latest.startTime,
        endTime: latest.endTime,
        durationSec: latest.durationSec,
        commitSha: latest.resolvedSourceVersion,
      },
      newCommits,
      jiraKeys,
      syncedAt: new Date().toISOString(),
    };

    this.releases._debounceSave();
    return true;
  }

  /**
   * Sync CodePipeline deploy states.
   * Stores a global deploy status map, and also attaches to releases.
   */
  async _syncDeploys(results) {
    try {
      if (!this._pipelineMap) {
        const pipelines = await this.aws.listPipelines();
        const AwsClient = require('../integrations/aws');
        this._pipelineMap = new Map();
        for (const name of pipelines) {
          const parsed = AwsClient.parsePipelineName(name);
          if (parsed) {
            this._pipelineMap.set(name, parsed);
          }
        }
        log.info(`Pipeline sync: mapped ${this._pipelineMap.size} deploy pipelines`);
      }

      // Fetch state for each deploy pipeline
      const deployStates = [];
      for (const [name, parsed] of this._pipelineMap) {
        try {
          const state = await this.aws.getPipelineState(name);
          const sourceStage = state.stages.find(s => s.stageName === 'Source');
          const deployStage = state.stages.find(s =>
            s.stageName === 'Deploy' || s.stageName === 'deploy'
          ) || state.stages[state.stages.length - 1];

          deployStates.push({
            pipelineName: name,
            customer: parsed.customer,
            env: parsed.env,
            status: deployStage?.status || null,
            lastUpdated: deployStage?.lastUpdated || sourceStage?.lastUpdated || null,
            sourceStatus: sourceStage?.status || null,
            stages: state.stages,
          });
          results.deploysChecked++;

          // Small delay between API calls
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          log.warn(`Pipeline sync: failed to get state for ${name}: ${err.message}`);
        }
      }

      // Store deploy states globally on all active webplatform releases
      const activeReleases = this.releases.list().filter(r =>
        r.state !== 'done' && !r.jiraArchived && r.repo === 'webplatform'
      );
      for (const release of activeReleases) {
        const key = this.releases._key(release.repo, release.version);
        const rel = this.releases.releases.get(key);
        if (rel) {
          if (!rel.pipeline) rel.pipeline = {};
          rel.pipeline.deploys = deployStates;
          rel.pipeline.deploySyncedAt = new Date().toISOString();
        }
      }

      if (deployStates.length > 0) {
        this.releases._debounceSave();
      }
    } catch (err) {
      results.errors++;
      log.error('Pipeline sync: deploy sync failed:', err.message);
    }
  }

  getStatus() {
    return {
      running: this._running,
      lastRun: this.lastRun,
      lastResults: this.lastResults,
      configured: this.aws.isConfigured(),
      projectCount: this._projectMap?.size || 0,
      pipelineCount: this._pipelineMap?.size || 0,
    };
  }
}

module.exports = PipelineSync;
