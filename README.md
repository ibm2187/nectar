# Nectar

Release intelligence for Viv. Collects data from JIRA, Git, GitHub, and live environments to create a single source of truth for every release across every customer.

Companion to [Hive](https://github.com/mavencare/hive) -- Hive is the brain (AI execution), Nectar is the data layer (release tracking, environment state, deployment impact).

## What it does

- **Discovers releases** across webplatform, android, and iOS repos by scanning release branches and JIRA versions
- **Tracks 99 environments** across 7 customers (Bayada, CK, Tribute, Haven, Lumen, QualityCare, Viv) -- including all 39 CK franchises discovered from Tofu infrastructure configs
- **Verifies every JIRA ticket** against three sources: JIRA status, git branch presence, and GitHub PRs -- classifies each into a health state that surfaces discrepancies
- **Polls live environments** for version, feature flags (DB + config), integrations (DB + config), and upgrade status via webplatform's `/api/status/*` endpoints
- **Computes deployment impact** -- "what changes when we deploy 4.1.2 to environments running 4.1.1?" with ticket-level diffs
- **Exposes MCP tools** so Hive's Claude sessions can query customer/environment data directly
- **Real-time dashboard** with WebSocket updates, branded loading animations, and per-ticket health verdicts

## Architecture

```
                        +-----------+
                        |   HIVE    |
                        | (AI exec) |
                        +-----+-----+
                              | MCP tools
                              v
+--------+  +--------+  +---------+  +----------+  +-----------+
|  JIRA  |  | GitHub |  |         |  | Bare Git |  | Webplatform|
|  API   |  |  API   |->| NECTAR  |<-|  Clones  |  | /api/status|
+--------+  +--------+  |         |  +----------+  +-----------+
                         +---------+
                          |  |  |
                     REST | WS | MCP
                          v  v  v
                       Dashboard
```

**Backend**: Node.js + Express + WebSocket, JSON file persistence, plain JS (no build step)
**Frontend**: React 19 + TypeScript + Vite + Tailwind + Zustand
**Integrations**: JIRA REST API (paginated, `/search/jql`), GitHub API, Slack, local bare git clones
**MCP Server**: Streamable HTTP at `/mcp` with stdio bridge for Claude Code

## Infrastructure requirements

### Compute
- Single Node.js process (no clustering needed)
- ~512MB RAM typical (bare git clones are on disk, not in memory)
- CPU spikes during truth computation (JIRA + git queries) -- 1-2 cores sufficient

### Storage
- **Bare git clones**: `~/.nectar/repos/` -- ~2GB for webplatform, ~200MB each for android/iOS
  - First run: `git clone --bare --filter=blob:none` (partial clone, fast)
  - Subsequent: `git fetch` (incremental, seconds)
- **State files**: `~/.nectar/` directory
  - `.nectar-state.json` -- releases, tickets, audit trail (~5MB)
  - `.nectar-customers.json` -- customers, environments, polled data (~10MB)
- **No database required** -- all persistence is JSON files on disk

### Network access
- **GitHub API** (`api.github.com`) -- for PR queries, branch listing
- **JIRA API** (`vivtechnologies.atlassian.net`) -- for ticket sync, version management
- **Webplatform environments** (`*.vivtechnologies.com`, `*.mavencare.com`) -- for polling `/api/status/*` endpoints
- **Slack API** (optional) -- for deployment notifications
- **Git over SSH** (`github.com:mavencare/*`) -- for bare clone fetch

### Ports
- `4000` (configurable via `WEB_PORT`) -- HTTP server (REST API + WebSocket + MCP + static client)

## Setup

### 1. Clone and install

```bash
git clone git@github.com:mavencare/nectar.git
cd nectar
npm install
cd client && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with credentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `WEB_PORT` | No | HTTP server port (default: 4000) |
| `GITHUB_TOKEN` | Yes | GitHub personal access token with repo scope |
| `JIRA_URL` | Yes | `https://vivtechnologies.atlassian.net` |
| `JIRA_USERNAME` | Yes | JIRA email (e.g., `user@vivtechnologies.com`) |
| `JIRA_API_TOKEN` | Yes | JIRA API token |
| `SLACK_BOT_TOKEN` | No | Slack bot token for notifications |
| `SLACK_RELEASES_CHANNEL` | No | Slack channel for release updates |

### 3. Build the client

```bash
npm run build:client
```

### 4. Start

```bash
npm start
```

First run will:
1. Clone webplatform, android, iOS as bare repos into `~/.nectar/repos/`
2. Scan `devops/tofu/environments/` for all deployed environments (39 CK franchises, etc.)
3. Scan `server/config/environment/` for per-env configuration (feature flags, integrations)
4. Sync JIRA versions and tickets (paginated, top 50 unreleased versions)
5. Start polling live environments at `/api/status/version`, `/features`, `/integrations`, `/upgrades`

Dashboard available at `http://localhost:4000`.

### Development mode

```bash
# Terminal 1: backend with auto-restart
npm run dev

# Terminal 2: Vite dev server with HMR
npm run dev:client
```

Frontend dev server runs on port 5173 and proxies `/api` + `/ws` to port 4000.

## Configuration

### `nectar.config.js`

```js
module.exports = {
  dataDir: '~/.nectar',

  repos: [
    {
      name: 'webplatform',
      github: 'mavencare/webplatform',
      releaseBranchPrefix: 'releases/',
      versionSource: { type: 'file', path: '.version' },
      cherryPick: { label: 'CHERRY_PICK', ... },
      jiraProject: 'DEV',
    },
    {
      name: 'android',
      github: 'mavencare/android',
      releaseBranchPrefix: 'release/',
      versionSource: { type: 'gradle-toml', path: 'gradle/libs.versions.toml', key: 'versionName' },
    },
    {
      name: 'ios',
      github: 'mavencare/iOS',
      releaseBranchPrefix: 'release/',
      versionSource: { type: 'plist', pattern: 'MARKETING_VERSION' },
    },
  ],

  jira: {
    project: 'DEV',
    maxVersionsPerSync: 50,
  },

  polling: {
    jiraSync: 600000,       // 10 min
    discovery: 300000,      // 5 min
    envPoller: 120000,      // 2 min
    cherryPickWatcher: 300000,
  },
};
```

## Webplatform status endpoints

Nectar polls these public endpoints on each deployed environment (merged via PR #28844 and #28879):

| Endpoint | What it returns |
|----------|----------------|
| `GET /api/status/version` | Version, environment name, customer brand |
| `GET /api/status/features` | DB feature flags (from `features` collection), config flags, boolean toggles |
| `GET /api/status/integrations` | DB integrations (from `IntegrationsConfig`), config integrations, SQS queues |
| `GET /api/status/upgrades?page=1&pageSize=500` | Paginated upgrade pool with history joined |

Rate limit: 30 req/min per IP. Cache: 60s public.

## MCP server (Hive integration)

Nectar exposes an MCP server at `/mcp` (Streamable HTTP transport) with 10 tools:

| Tool | Description |
|------|-------------|
| `get_customer` | Customer metadata + environment summary |
| `get_environment` | Environment overview (version, tier, reachability) |
| `get_environment_features` | DB + config feature flags |
| `get_environment_integrations` | DB + config integrations |
| `get_environment_upgrades` | Upgrade status with bucketed counts |
| `search_environments` | Filter by customer, version, tier, free text |
| `get_release` | Release metadata, state, ticket count |
| `get_release_truth` | Full truth computation (JIRA + git + PRs) |
| `get_release_impact` | Deployment diff between two versions |
| `list_releases` | Filtered release list |

### Connecting Claude Code sessions

Add to `~/.claude.json` (global) or project `.mcp.json`:

```json
{
  "mcpServers": {
    "nectar": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/nectar/src/mcp/stdio-bridge.mjs"]
    }
  }
}
```

For remote Nectar:
```json
"args": ["/path/to/nectar/src/mcp/stdio-bridge.mjs", "--url", "https://nectar.vivtechnologies.com/mcp"]
```

The stdio bridge proxies MCP JSON-RPC over stdin/stdout to Nectar's HTTP endpoint.

## Environment discovery

Nectar discovers environments via a two-pass scan of the webplatform repo:

1. **Tofu scan** (primary): reads `devops/tofu/environments/{brand}/` directories from the bare git clone. Each subdirectory = a deployed environment. This is the authoritative list of what exists in infrastructure.

2. **Config scan** (enrichment): reads `server/config/environment/{brand}/` for per-environment config (feature flags, integrations, domain settings). Environments without an explicit config file use the brand template (e.g., `ck-template.js` for CK franchises).

### Brand mapping

| Brand | Tofu dir | URL pattern | Envs |
|-------|----------|-------------|------|
| Bayada | `bayada/` | `bayada-*.vivtechnologies.com` | 11 |
| CK | `ck/` | `comfortkeepers-*.vivtechnologies.com` | 49 |
| Tribute | `tribute/` | `tribute*.mavencare.com` | 5 |
| Haven | `tribute/haven` | `haven.mavencare.com` | 1 |
| Lumen | `lumen/` | `hah*.vivtechnologies.com` | 5 |
| QualityCare | `tribute/qualitycare` | `qualitycare.vivtechnologies.com` | 1 |
| Viv | `viv/` | `*.vivtechnologies.com` | 27 |

## Release truth engine

For each release, the truth engine (`src/core/release-truth.js`) reconciles:
- JIRA `fixVersion` tickets (what's planned)
- Git log on the release branch (what's actually there)
- Open GitHub PRs targeting the release branch (what's in flight)
- Live JIRA status refresh on each compute (not stale sync data)

Each ticket gets a health verdict:

| Health | Category | Meaning |
|--------|----------|---------|
| Healthy | done | Certified + on branch |
| In QA | in-qa | Active testing, on branch |
| PR Pending | in-qa | Cherry-pick PR open, not merged |
| JIRA Stale | in-qa | On branch but JIRA status behind |
| Awaiting CP | awaiting-cp | Waiting for cherry-pick |
| In Dev | in-dev | Active development |
| Needs Review | in-dev | "Re-verify Bug" investigation |
| Pre-Dev | in-dev | Not started |
| Lying | attention | JIRA says testable but NOT on branch |
| Stale Cert | attention | Certified but missing from branch |
| Failed QA | attention | Bounced from QA |
| Blocked | attention | Needs requirements or on hold |
| No Code | done | Resolved without code change |

**Deployment impact**: `computeImpact(repo, targetVersion, prodVersion)` computes the diff between two versions -- new tickets landing, health rollup, commit delta, and rogue commits.

## Repo structure

```
nectar/
+-- src/                          # Backend (plain JS, no build step)
|   +-- index.js                  # Entry point, service wiring
|   +-- core/
|   |   +-- release.js            # Release state machine + persistence
|   |   +-- release-truth.js      # Truth engine + impact computation
|   |   +-- jira-sync.js          # JIRA version/ticket sync (paginated)
|   |   +-- discovery.js          # Git branch discovery
|   |   +-- customer-store.js     # Customer/environment state
|   |   +-- webplatform-scanner.js# Tofu + config environment scanner
|   |   +-- environment-poller.js # Polls /api/status/* on live envs
|   |   +-- repo-manager.js       # Bare git clone management
|   |   +-- cherry-pick.js        # Cherry-pick PR watcher
|   |   +-- risk.js               # Risk scoring
|   +-- integrations/
|   |   +-- jira.js               # JIRA REST client
|   |   +-- github.js             # GitHub API client
|   |   +-- slack.js              # Slack notifications
|   +-- api/
|   |   +-- routes.js             # REST API routes
|   |   +-- webhooks.js           # GitHub/JIRA webhooks
|   +-- web/
|   |   +-- server.js             # Express + WebSocket + MCP mount
|   +-- mcp/
|       +-- server.js             # MCP tool definitions
|       +-- stdio-bridge.mjs      # Stdio-to-HTTP proxy for Claude Code
+-- client/                       # Frontend (React + Vite + Tailwind)
|   +-- src/
|   |   +-- features/releases/    # Release list, detail, truth view, compare selector
|   |   +-- features/customers/   # Customer matrix, environment detail (features/integrations/upgrades tabs)
|   |   +-- components/           # UI primitives, NectarLoader, layout
|   |   +-- stores/wsStore.ts     # Zustand + WebSocket
|   +-- public/
|       +-- favicon.svg           # Nectar icon (amber hex network)
|       +-- nectar-icon.svg       # Full icon with text
+-- nectar.config.js              # Repo configs, polling intervals
+-- .env                          # Secrets (not committed)
+-- .nectar-state.json            # Release state (not committed, auto-generated)
+-- .nectar-customers.json        # Customer/env state (not committed, auto-generated)
```

## Persistence

No database. Two JSON files on disk, auto-saved with 5s debounce:

- **`.nectar-state.json`** -- releases, tickets, cherry-picks, audit trail, approvals
- **`.nectar-customers.json`** -- customers, environments, polled feature/integration/upgrade data

Graceful shutdown (`SIGINT`/`SIGTERM`) flushes both files immediately.

These files should be on persistent storage (not ephemeral container filesystem). In cloud deployment, mount a volume at `~/.nectar/` or wherever `dataDir` points.

## Cloud deployment notes

1. **Git SSH access**: the server needs SSH key access to `github.com:mavencare/*` for bare clones
2. **Bare clones**: stored in `dataDir/repos/` (~2.5GB total). Persist across restarts.
3. **State files**: persist `.nectar-state.json` and `.nectar-customers.json` across restarts
4. **Environment polling**: production envs are rate-limited (30 req/min). With 45 prod envs polled every 2 min, that's ~1.5 req/min per env -- well within limits. Each poll hits 4 endpoints per env.
5. **JIRA sync**: runs every 10 min, syncs top 50 unreleased versions. ~30s per run.
6. **MCP endpoint**: expose `/mcp` for Hive sessions. Update stdio bridge `--url` arg to point to cloud URL.
7. **No auth on dashboard currently** -- add a reverse proxy with auth (or `WEB_TOKEN` for API-only access) before exposing publicly.
