# Nectar

Release cycle management for Viv. Cross-references JIRA fixVersions, git branches, and GitHub PRs to answer: *"What is the actual state of this release, and where does reality differ from what JIRA claims?"*

Companion to [Hive](https://github.com/mavencare/hive) — Hive is the brain/execution layer, Nectar is the release tracking/validation/visibility layer.

## What it does

- **Auto-discovers releases** across multiple repos (webplatform, android, iOS) by scanning release branches and JIRA versions
- **Verifies every ticket** against three data sources:
  - **JIRA** — what's planned (`fixVersion`)
  - **Git** — what's actually on the release branch
  - **GitHub** — what's in flight (open cherry-pick PRs)
- **Classifies each ticket** into a health state (Healthy, In QA, Lying, Stale Cert, Failed QA, etc.) that surfaces discrepancies
- **Dashboards** release state with clickable pills, sortable tables, and JIRA-linked tickets
- **Real-time updates** via WebSocket as data refreshes

## Architecture

```
┌─────────┐         ┌──────────┐        ┌──────────┐
│  HIVE   │──API──▶│  NECTAR  │──API──▶│  JIRA    │
│  (brain)│◀──────│  (releases)│◀──────│  GitHub  │
└─────────┘         └──────────┘        └──────────┘
```

- **Backend**: Node.js + Express + WebSocket, JSON file persistence, plain JS (no build step)
- **Frontend**: React + TypeScript + Vite + Tailwind
- **Integrations**: JIRA REST API (paginated), GitHub API, local bare git clones, Slack notifications

## Repo structure

```
nectar/
├── src/                          # Backend (plain JS)
│   ├── index.js                  # Entry point
│   ├── core/                     # Release state machine, discovery, truth, JIRA sync, etc.
│   ├── integrations/             # JIRA, GitHub, Slack clients
│   ├── api/                      # REST routes + webhooks
│   └── web/                      # Express + WebSocket server
├── client/                       # Frontend (React + Vite + Tailwind)
│   └── src/
│       ├── features/             # Releases, customers views
│       ├── components/           # UI primitives + layout
│       └── stores/               # Zustand (WebSocket store)
├── nectar.config.js              # Repo configs, JIRA project, polling intervals
├── .env                          # Secrets (not committed)
└── .nectar-state.json            # Persisted state (not committed)
```

## Setup

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Configure
cp .env.example .env
# Edit .env with JIRA, GitHub, Slack credentials

# Run
npm start             # Backend + built client at http://localhost:4000
npm run dev:client    # Vite dev server for frontend (separate terminal)
```

First run will clone the configured repos as bare clones into `~/.nectar/repos/` and sync JIRA versions. Subsequent runs reuse the clones and fetch incrementally.

## Core concepts

**Release Truth Engine** (`src/core/release-truth.js`)

For each release, reconciles:
- JIRA `fixVersion` tickets (what's planned)
- Git log on the release branch (what's actually there)
- Open GitHub PRs targeting the release branch (what's in flight)

Each ticket gets a health verdict. Key health states:

| Health | Meaning |
|---|---|
| 🟢 Healthy | Certified + on branch |
| 🔬 In QA | Active testing, on branch |
| ⏳ PR Pending | Cherry-pick PR open |
| 🔎 Needs Review | "Re-verify Bug" — pre-work investigation |
| 🛠 In Dev | Active development |
| 🔴 Lying | JIRA says testable but no cherry-pick exists — **red flag** |
| 🔴 Stale Cert | Marked certified but missing from branch |
| 🔴 Failed QA | Bounced from QA |
| 🚫 Blocked | Needs requirements or explicitly blocked |

See `src/core/release-truth.js` for the full stage mapping and verification rules.

## Status

Phase 1 — actively being built. Core release truth engine + dashboard working against real data.
