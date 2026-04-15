const log = require('../core/log');

// Customer slugs embedded in cross-account project names, e.g.
// `ECR-Build_viv-release-ck-4_2_0`. Stripped during parseProjectName.
const CUSTOMER_SLUGS = ['ck', 'bayada', 'tribute', 'haven', 'qualitycare', 'lumen'];

let CodeBuildClient, ListProjectsCommand, ListBuildsForProjectCommand, BatchGetBuildsCommand;
let CodePipelineClient, ListPipelinesCommand, GetPipelineStateCommand;
let STSClient, AssumeRoleCommand;

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

  const sts = require('@aws-sdk/client-sts');
  STSClient = sts.STSClient;
  AssumeRoleCommand = sts.AssumeRoleCommand;
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

  /**
   * Parse cross-account role config from env.
   * Format: "Customer1:arn:aws:iam::123:role/Name,Customer2:arn:aws:iam::456:role/Name"
   * Returns: [{ customer: 'Customer1', roleArn: 'arn:...' }, ...]
   */
  getCrossAccountRoles() {
    const raw = process.env.AWS_CROSS_ACCOUNT_ROLES || '';
    if (!raw.trim()) return [];
    return raw.split(',').map(entry => {
      const colonIdx = entry.indexOf(':');
      if (colonIdx < 1) return null;
      return {
        customer: entry.substring(0, colonIdx).trim(),
        roleArn: entry.substring(colonIdx + 1).trim(),
      };
    }).filter(Boolean);
  }

  /**
   * Assume a cross-account role and return temporary credentials.
   * Caches credentials for 50 min (roles last 60 min).
   */
  async assumeRole(roleArn) {
    loadSdk();
    // Check cache
    const cached = this._roleCredCache && this._roleCredCache[roleArn];
    if (cached && Date.now() < cached.expiry) return cached.credentials;

    const sts = new STSClient({ region: this.region });
    const resp = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'nectar-pipeline-sync',
      DurationSeconds: 3600,
    }));

    const credentials = {
      accessKeyId: resp.Credentials.AccessKeyId,
      secretAccessKey: resp.Credentials.SecretAccessKey,
      sessionToken: resp.Credentials.SessionToken,
    };

    if (!this._roleCredCache) this._roleCredCache = {};
    this._roleCredCache[roleArn] = {
      credentials,
      expiry: Date.now() + 50 * 60 * 1000, // 50 min cache
    };

    return credentials;
  }

  /**
   * Create a CodeBuild client for a cross-account role.
   */
  async getCodeBuildForRole(roleArn) {
    loadSdk();
    const creds = await this.assumeRole(roleArn);
    return new CodeBuildClient({
      region: this.region,
      credentials: creds,
    });
  }

  /**
   * Create a CodePipeline client for a cross-account role.
   */
  async getCodePipelineForRole(roleArn) {
    loadSdk();
    const creds = await this.assumeRole(roleArn);
    return new CodePipelineClient({
      region: this.region,
      credentials: creds,
    });
  }

  // ── Cross-account operations ───────────────────────────

  async listProjectsForRole(roleArn) {
    const cb = await this.getCodeBuildForRole(roleArn);
    const projects = [];
    let nextToken;
    do {
      const resp = await cb.send(new ListProjectsCommand({ nextToken }));
      projects.push(...(resp.projects || []));
      nextToken = resp.nextToken;
    } while (nextToken);
    return projects;
  }

  async getBuildsForProjectInRole(roleArn, projectName, limit = 5) {
    const cb = await this.getCodeBuildForRole(roleArn);
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
      status: b.buildStatus,
      startTime: b.startTime?.toISOString() || null,
      endTime: b.endTime?.toISOString() || null,
      durationSec: b.startTime && b.endTime
        ? Math.round((b.endTime.getTime() - b.startTime.getTime()) / 1000)
        : null,
      sourceVersion: b.sourceVersion || null,
      resolvedSourceVersion: b.resolvedSourceVersion || null,
      initiator: b.initiator || null,
    }));
  }

  async listPipelinesForRole(roleArn) {
    const cp = await this.getCodePipelineForRole(roleArn);
    const pipelines = [];
    let nextToken;
    do {
      const resp = await cp.send(new ListPipelinesCommand({ nextToken }));
      pipelines.push(...(resp.pipelines || []).map(p => p.name));
      nextToken = resp.nextToken;
    } while (nextToken);
    return pipelines;
  }

  async getPipelineConfigForRole(roleArn, pipelineName) {
    const cp = await this.getCodePipelineForRole(roleArn);
    const { GetPipelineCommand } = require('@aws-sdk/client-codepipeline');
    const resp = await cp.send(new GetPipelineCommand({ name: pipelineName }));
    const pipeline = resp.pipeline || {};
    const source = (pipeline.stages || []).find(s => s.name === 'Source');
    const ecrAction = source?.actions?.find(a => a.configuration?.RepositoryName);
    return {
      name: pipelineName,
      ecrRepo: ecrAction?.configuration?.RepositoryName || null,
      ecrImageTag: ecrAction?.configuration?.ImageTag || null,
    };
  }

  async getPipelineStateForRole(roleArn, pipelineName) {
    const cp = await this.getCodePipelineForRole(roleArn);
    const resp = await cp.send(new GetPipelineStateCommand({ name: pipelineName }));
    return {
      name: pipelineName,
      stages: (resp.stageStates || []).map(s => ({
        stageName: s.stageName,
        status: s.latestExecution?.status || null,
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
   * Get the full pipeline config (stages, actions, sources).
   * Used to discover ECR image tag → deploy target mapping.
   */
  async getPipelineConfig(pipelineName) {
    const cp = this._getCodePipeline();
    const { GetPipelineCommand } = require('@aws-sdk/client-codepipeline');
    const resp = await cp.send(new GetPipelineCommand({ name: pipelineName }));
    const pipeline = resp.pipeline || {};
    const source = (pipeline.stages || []).find(s => s.name === 'Source');
    const ecrAction = source?.actions?.find(a => a.configuration?.RepositoryName);
    return {
      name: pipelineName,
      ecrRepo: ecrAction?.configuration?.RepositoryName || null,
      ecrImageTag: ecrAction?.configuration?.ImageTag || null,
    };
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
      let raw = releaseMatch[1];
      // Detect customer slug to derive the ECR repo for cross-account release builds.
      // ECR-Build_viv-release-ck-X    → ecrRepo 'viv-release-ck'
      // ECR-Build_viv-release-X        → ecrRepo 'viv-release' (Viv root)
      const slugMatch = raw.match(new RegExp(`^(${CUSTOMER_SLUGS.join('|')})-(.+)$`));
      let ecrRepo;
      if (slugMatch) {
        ecrRepo = `viv-release-${slugMatch[1]}`;
        raw = slugMatch[2];
      } else {
        ecrRepo = 'viv-release';
      }
      // Convert underscores to dots for version, but preserve suffix after last hyphen-separated part
      // e.g., "4_2_0-cktribute" → version "4.2.0-cktribute"
      const version = raw.replace(/_/g, '.');
      return { repo: 'webplatform', version, branch: `releases/${version}`, ecrRepo };
    }

    // Master build
    if (name === 'ECR-Build_viv-master') {
      return { repo: 'webplatform', version: null, branch: 'master', ecrRepo: 'viv-master' };
    }

    // Custom builds: ECR-Build_viv-custom-{name}
    const customMatch = name.match(/^ECR-Build_viv-custom-(.+)$/);
    if (customMatch) {
      return { repo: 'webplatform', version: null, branch: null, custom: customMatch[1], ecrRepo: 'viv-custom' };
    }

    // Bayada release (legacy single-customer build)
    if (name === 'ECR-Build_viv-bayada-release') {
      return { repo: 'webplatform', version: null, branch: null, custom: 'bayada-release', ecrRepo: 'viv-bayada-release' };
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
