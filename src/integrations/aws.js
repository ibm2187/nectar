const log = require('../core/log');

let CodeBuildClient, ListProjectsCommand, ListBuildsForProjectCommand, BatchGetBuildsCommand;
let CodePipelineClient, ListPipelinesCommand, GetPipelineStateCommand;

// Lazy-load AWS SDK (heavy, only import when needed)
function loadSdk() {
  if (CodeBuildClient) return;
  const cb = require('@aws-sdk/client-codebuild');
  CodeBuildClient = cb.CodeBuildClient;
  ListProjectsCommand = cb.ListProjectsCommand;
  ListBuildsForProjectCommand = cb.ListBuildsForProjectCommand;
  BatchGetBuildsCommand = cb.BatchGetBuildsCommand;

  const cp = require('@aws-sdk/client-codepipeline');
  CodePipelineClient = cp.CodePipelineClient;
  ListPipelinesCommand = cp.ListPipelinesCommand;
  GetPipelineStateCommand = cp.GetPipelineStateCommand;
}

/**
 * AWS client for CodeBuild + CodePipeline.
 * Provides a unified view of build + deploy status.
 */
class AwsClient {
  constructor() {
    this.region = process.env.AWS_REGION || 'us-east-1';
    this._accessKey = process.env.AWS_ACCESS_KEY_ID || '';
    this._secretKey = process.env.AWS_SECRET_ACCESS_KEY || '';
    this._cb = null;
    this._cp = null;
  }

  isConfigured() {
    return !!(this._accessKey && this._secretKey);
  }

  _getCodeBuild() {
    if (this._cb) return this._cb;
    loadSdk();
    this._cb = new CodeBuildClient({ region: this.region });
    return this._cb;
  }

  _getCodePipeline() {
    if (this._cp) return this._cp;
    loadSdk();
    this._cp = new CodePipelineClient({ region: this.region });
    return this._cp;
  }

  // ── CodeBuild ──────────────────────────────────────────

  /**
   * List all CodeBuild project names.
   */
  async listProjects() {
    const cb = this._getCodeBuild();
    const projects = [];
    let nextToken;
    do {
      const resp = await cb.send(new ListProjectsCommand({ nextToken }));
      projects.push(...(resp.projects || []));
      nextToken = resp.nextToken;
    } while (nextToken);
    return projects;
  }

  /**
   * Get recent builds for a project.
   * @param {string} projectName
   * @param {number} limit - max builds to return (default 5)
   */
  async getBuildsForProject(projectName, limit = 5) {
    const cb = this._getCodeBuild();
    const resp = await cb.send(new ListBuildsForProjectCommand({
      projectName,
      sortOrder: 'DESCENDING',
    }));
    const buildIds = (resp.ids || []).slice(0, limit);
    if (buildIds.length === 0) return [];

    const detail = await cb.send(new BatchGetBuildsCommand({ ids: buildIds }));
    return (detail.builds || []).map(b => ({
      id: b.id,
      buildNumber: b.buildNumber,
      status: b.buildStatus, // SUCCEEDED, FAILED, IN_PROGRESS, STOPPED
      startTime: b.startTime?.toISOString() || null,
      endTime: b.endTime?.toISOString() || null,
      durationSec: b.startTime && b.endTime
        ? Math.round((b.endTime.getTime() - b.startTime.getTime()) / 1000)
        : null,
      sourceVersion: b.sourceVersion || null, // branch name
      resolvedSourceVersion: b.resolvedSourceVersion || null, // commit SHA
      initiator: b.initiator || null,
    }));
  }

  // ── CodePipeline ───────────────────────────────────────

  /**
   * List all pipeline names.
   */
  async listPipelines() {
    const cp = this._getCodePipeline();
    const pipelines = [];
    let nextToken;
    do {
      const resp = await cp.send(new ListPipelinesCommand({ nextToken }));
      pipelines.push(...(resp.pipelines || []).map(p => p.name));
      nextToken = resp.nextToken;
    } while (nextToken);
    return pipelines;
  }

  /**
   * Get the current state of a pipeline (stages + actions).
   */
  async getPipelineState(pipelineName) {
    const cp = this._getCodePipeline();
    const resp = await cp.send(new GetPipelineStateCommand({ name: pipelineName }));
    return {
      name: pipelineName,
      stages: (resp.stageStates || []).map(s => ({
        stageName: s.stageName,
        status: s.latestExecution?.status || null, // Succeeded, InProgress, Failed
        lastUpdated: s.latestExecution?.lastStatusChange?.toISOString() || null,
        actions: (s.actionStates || []).map(a => ({
          actionName: a.actionName,
          status: a.latestExecution?.status || null,
          lastUpdated: a.latestExecution?.lastStatusChange?.toISOString() || null,
          externalUrl: a.latestExecution?.externalExecutionUrl || null,
        })),
      })),
    };
  }

  // ── Helpers ────────────────────────────────────────────

  /**
   * Map a CodeBuild project name to a Nectar release version.
   * ECR-Build_viv-release-4_2_1 → { repo: 'webplatform', version: '4.2.1' }
   * ECR-Build_viv-master → { repo: 'webplatform', version: null, branch: 'master' }
   */
  static parseProjectName(name) {
    // Release builds: ECR-Build_viv-release-X_Y_Z or ECR-Build_viv-release-X_Y_Z-suffix
    const releaseMatch = name.match(/^ECR-Build_viv-release-(.+)$/);
    if (releaseMatch) {
      const raw = releaseMatch[1];
      // Convert underscores to dots for version, but preserve suffix after last hyphen-separated part
      // e.g., "4_2_0-cktribute" → version "4.2.0-cktribute"
      const version = raw.replace(/_/g, '.');
      return { repo: 'webplatform', version, branch: `releases/${version}` };
    }

    // Master build
    if (name === 'ECR-Build_viv-master') {
      return { repo: 'webplatform', version: null, branch: 'master' };
    }

    // Custom builds: ECR-Build_viv-custom-{name}
    const customMatch = name.match(/^ECR-Build_viv-custom-(.+)$/);
    if (customMatch) {
      return { repo: 'webplatform', version: null, branch: null, custom: customMatch[1] };
    }

    // Bayada release
    if (name === 'ECR-Build_viv-bayada-release') {
      return { repo: 'webplatform', version: null, branch: null, custom: 'bayada-release' };
    }

    return null;
  }

  /**
   * Map a CodePipeline name to a Nectar customer + environment.
   * Deploy-Bayada_Staging → { customer: 'Bayada', env: 'Staging' }
   * Deploy-Viv_Dev03 → { customer: 'Viv', env: 'Dev03' }
   */
  static parsePipelineName(name) {
    const match = name.match(/^Deploy-(.+?)_(.+)$/);
    if (!match) return null;
    return { customer: match[1], env: match[2] };
  }
}

module.exports = AwsClient;
