import { describe, it, expect } from 'vitest';
const AwsClient = require('../src/integrations/aws');

describe('AwsClient.parseProjectName', () => {
  it('parses release project with dots→underscores', () => {
    const result = AwsClient.parseProjectName('ECR-Build_viv-release-4_2_1');
    expect(result).toEqual({
      repo: 'webplatform',
      version: '4.2.1',
      branch: 'releases/4.2.1',
      ecrRepo: 'viv-release',
    });
  });

  it('parses release project with suffix', () => {
    const result = AwsClient.parseProjectName('ECR-Build_viv-release-4_2_0-cktribute');
    expect(result).toEqual({
      repo: 'webplatform',
      version: '4.2.0-cktribute',
      branch: 'releases/4.2.0-cktribute',
      ecrRepo: 'viv-release',
    });
  });

  it('strips customer slug and derives per-customer ecrRepo', () => {
    expect(AwsClient.parseProjectName('ECR-Build_viv-release-ck-master')).toEqual({
      repo: 'webplatform',
      version: 'master',
      branch: 'releases/master',
      ecrRepo: 'viv-release-ck',
    });
    expect(AwsClient.parseProjectName('ECR-Build_viv-release-ck-4_2_0-cktribute')).toEqual({
      repo: 'webplatform',
      version: '4.2.0-cktribute',
      branch: 'releases/4.2.0-cktribute',
      ecrRepo: 'viv-release-ck',
    });
    expect(AwsClient.parseProjectName('ECR-Build_viv-release-bayada-4_2_0')).toEqual({
      repo: 'webplatform',
      version: '4.2.0',
      branch: 'releases/4.2.0',
      ecrRepo: 'viv-release-bayada',
    });
    expect(AwsClient.parseProjectName('ECR-Build_viv-release-tribute-4_1_3')).toEqual({
      repo: 'webplatform',
      version: '4.1.3',
      branch: 'releases/4.1.3',
      ecrRepo: 'viv-release-tribute',
    });
    expect(AwsClient.parseProjectName('ECR-Build_viv-release-lumen-4_2_5-lumen')).toEqual({
      repo: 'webplatform',
      version: '4.2.5-lumen',
      branch: 'releases/4.2.5-lumen',
      ecrRepo: 'viv-release-lumen',
    });
  });

  it('parses three-part version', () => {
    const result = AwsClient.parseProjectName('ECR-Build_viv-release-4_1_0_3');
    expect(result).toEqual({
      repo: 'webplatform',
      version: '4.1.0.3',
      branch: 'releases/4.1.0.3',
      ecrRepo: 'viv-release',
    });
  });

  it('parses master build', () => {
    const result = AwsClient.parseProjectName('ECR-Build_viv-master');
    expect(result).toEqual({
      repo: 'webplatform',
      version: null,
      branch: 'master',
      ecrRepo: 'viv-master',
    });
  });

  it('parses custom build', () => {
    const result = AwsClient.parseProjectName('ECR-Build_viv-custom-jeff');
    expect(result).toEqual({
      repo: 'webplatform',
      version: null,
      branch: null,
      custom: 'jeff',
      ecrRepo: 'viv-custom',
    });
  });

  it('parses bayada release', () => {
    const result = AwsClient.parseProjectName('ECR-Build_viv-bayada-release');
    expect(result).toEqual({
      repo: 'webplatform',
      version: null,
      branch: null,
      custom: 'bayada-release',
      ecrRepo: 'viv-bayada-release',
    });
  });

  it('returns null for template', () => {
    expect(AwsClient.parseProjectName('ECR-Build_TEMPLATE')).toBeNull();
  });

  it('returns null for lambda projects', () => {
    expect(AwsClient.parseProjectName('lambda-viv-mong-scripts-auto-patch')).toBeNull();
  });

  it('returns null for unrecognized names', () => {
    expect(AwsClient.parseProjectName('random-project')).toBeNull();
  });
});

describe('AwsClient.parsePipelineName', () => {
  it('parses deploy pipeline', () => {
    expect(AwsClient.parsePipelineName('Deploy-Bayada_Staging')).toEqual({
      customer: 'Bayada',
      env: 'Staging',
    });
  });

  it('parses Viv dev env', () => {
    expect(AwsClient.parsePipelineName('Deploy-Viv_Dev03')).toEqual({
      customer: 'Viv',
      env: 'Dev03',
    });
  });

  it('parses HAH sandbox', () => {
    expect(AwsClient.parsePipelineName('Deploy-HAH_Sandbox')).toEqual({
      customer: 'HAH',
      env: 'Sandbox',
    });
  });

  it('parses Bluesummit', () => {
    expect(AwsClient.parsePipelineName('Deploy-Bluesummit_Dev01')).toEqual({
      customer: 'Bluesummit',
      env: 'Dev01',
    });
  });

  it('returns null for test pipelines', () => {
    expect(AwsClient.parsePipelineName('viv-test-pipeline-5')).toBeNull();
  });

  it('returns null for non-deploy names', () => {
    expect(AwsClient.parsePipelineName('SomethingElse')).toBeNull();
  });
});

describe('AwsClient configuration', () => {
  it('isConfigured returns false without credentials', () => {
    const orig = { ...process.env };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const client = new AwsClient();
    expect(client.isConfigured()).toBe(false);
    Object.assign(process.env, orig);
  });
});
