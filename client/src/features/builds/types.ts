export interface BuildInfo {
  buildNumber: number;
  status: string;
  startTime: string | null;
  endTime: string | null;
  durationSec: number | null;
  commitSha: string | null;
  jiraKeys?: string[];
}

export interface BuildCard {
  projectName: string;
  branch: string;
  version: string | null;
  repo: string;
  isCustom: boolean;
  imageTag: string | null;
  account: string | null;
  customerKey: string;
  latestStatus: string;
  latestStartTime: string | null;
  builds: BuildInfo[];
  newCommits: Array<{ sha: string; message: string }>;
  jiraKeys: string[];
  prUrl: string | null;
  githubBranchUrl: string;
  ecrRepo?: string | null;
}

export interface DeployTarget {
  pipelineName: string;
  customer: string;
  env: string;
  status: string | null;
  lastUpdated: string | null;
  account?: string;
  ecrRepo?: string | null;
}

export interface CustomerGroup {
  key: string;
  label: string;
  account: string;
  pinnedBuild: BuildCard | null;
  recentBuilds: BuildCard[];
  allBuilds: BuildCard[];
}

export interface BuildsPageData {
  customers: CustomerGroup[];
  deployTargets: Record<string, DeployTarget[]>;
  lastRun: string | null;
}
