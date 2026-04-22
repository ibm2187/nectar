const os = require('os');
const path = require('path');

module.exports = {
  // ── Data directory (clones, cache) ──────────────────────
  dataDir: path.join(os.homedir(), '.nectar'),

  // ── Repos to track ─────────────────────────────────────
  repos: [
    {
      name: 'webplatform',
      github: 'mavencare/webplatform',
      releaseBranchPrefix: 'releases/',
      versionSource: { type: 'file', path: '.version' },
      cherryPick: {
        label: 'CHERRY_PICK',
        // Matches: CHERRY_PICK [DEV-43254, DEV-43915] ... to 4.1.1
        titlePattern: /CHERRY_PICK/i,
        commitPattern: /CHERRY_PICK\s*\[([^\]]+)\]/i,
      },
      ci: { type: 'github-actions' },
      jiraProject: 'DEV',
      risk: {
        migrationPath: 'server/upgrade/',
        billingPath: 'server/api/rcm_v2/engine/',
        modelPattern: '.model.js',
      },
    },
    {
      name: 'android',
      github: 'mavencare/android',
      releaseBranchPrefix: 'release/',
      versionSource: { type: 'gradle-toml', path: 'gradle/libs.versions.toml', key: 'versionName' },
      cherryPick: null,
      ci: { type: 'bitrise' },
      jiraProject: 'DEV',
      risk: {},
    },
    {
      name: 'ios',
      github: 'mavencare/iOS',
      releaseBranchPrefix: 'release/',
      versionSource: { type: 'plist', pattern: 'MARKETING_VERSION' },
      cherryPick: null,
      ci: { type: 'bitrise' },
      jiraProject: 'DEV',
      risk: {},
    },
    {
      name: 'bluesummit',
      github: 'mavencare/bluesummit',
      releaseBranchPrefix: 'VIV/',
      versionSource: null, // No .version file — version derived from branch name
      cherryPick: null,
      ci: null,
      jiraProject: 'DEV',
      risk: {},
    },
  ],

  // ── JIRA ────────────────────────────────────────────────
  jira: {
    project: 'DEV',
    cherryPickedStatus: 'Cherry Picked',
    readyForTestingStatus: 'Ready For Testing',
    maxVersionsPerSync: 50,  // Must cover all unreleased versions (null-date ones sort last)
  },

  // ── Risk scoring weights (defaults, repos can override) ─
  risk: {
    thresholds: { low: 30, medium: 60 },
    weights: {
      migration: 10,
      billingEngine: 30,
      modelChange: 5,
      authChange: 25,
      apiRoute: 10,
      untestedTicket: 5,
      largeDiff: 5,
      ciFailure: 50,
      dependencyChange: 10,
    },
  },

  // ── Approval chains ─────────────────────────────────────
  approvals: {
    required: ['engineering', 'qa'],
    highRiskAdditional: ['product'],
  },

  // ── Customer environments ───────────────────────────────
  customers: [
    // { name: 'bayada', staging: 'https://staging.bayada.vivplatform.com', production: 'https://bayada.vivplatform.com' },
  ],

  // ── Polling intervals ───────────────────────────────────
  polling: {
    discovery: 5 * 60 * 1000,           // 5 min — git repo discovery
    jiraSync: 10 * 60 * 1000,           // 10 min — JIRA version/ticket sync
    environmentVersions: 10 * 60 * 1000, // 10 min — poll each env's /api/status/version
    githubPRs: 60 * 1000,               // 1 min
  },

  // ── Discovery settings ──────────────────────────────────
  discovery: {
    // Only track releases created within this many days (0 = no limit)
    maxAgeDays: 0,
    // Max releases to track per repo (0 = no limit)
    maxPerRepo: 0,
  },

  // ── Slack channels ──────────────────────────────────────
  slack: {
    releases: '#releases',
    deploys: '#deploys',
  },

  // ── Standup tab ─────────────────────────────────────────
  standup: {
    // Fallback roster only shows people with dev/qa ticket activity within
    // this many days. Hides ex-employees whose names persist on old tickets.
    rosterActiveSinceDays: 90,
  },
};
