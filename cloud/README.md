# Nectar Cloud Deployment

Deploy Nectar to a dedicated EC2 instance in the **Jenkins VPC** (Viv root AWS
account). Direct Node.js execution (no Docker), systemd-managed (a `web`
process and a `sync` process sharing one SQLite DB), Secrets Manager for
`.env`, ALB with TLS, automatic deploys via a systemd timer that polls
`origin/main` every 5 minutes.

## Architecture

```
Internet
    │
    ▼
ALB :443 (nectar.vivtechnologies.com)
    │
    ▼
EC2 t3.large (Ubuntu 22.04, Node 22 LTS) :4000
    │  [Jenkins VPC, internal-tools-1b subnet, us-east-1b]
    ├── nectar-web.service  — Node.js src/web-server.js  (HTTP + WS + MCP)
    ├── nectar-sync.service — Node.js src/sync-worker.js (JIRA/GitHub polling)
    ├── nectar-update.timer — pulls origin/main every 5 min
    ├── SQLite state    — /home/ubuntu/nectar/.nectar.db (+ .db-wal, .db-shm)
    └── Bare git clones — /home/ubuntu/.nectar/repos/    (read-mostly mirrors)
```

The web server and sync worker run as two separate systemd units sharing the
same SQLite file via WAL. They were split out of the original single-process
`nectar.service` so a slow JIRA/GitHub poll can't block dashboard requests
(and so each side has its own log stream and memory cap). See `How it runs`
below for the full unit list.

## Jenkins VPC placement

Nectar runs in the Jenkins VPC (`vpc-02651295c24f8bc7f`) alongside the Jenkins
master. Chosen because Jenkins and Nectar are both internal release-tooling
workloads managed by the same team.

| Resource | Value |
|----------|-------|
| VPC | `vpc-02651295c24f8bc7f` (jenkins-vpc) |
| EC2 subnet | `internal-tools-1b` (`subnet-094867cafbdcc387d`, `10.0.4.0/24`, us-east-1b, public) |
| ALB subnets | `internal-tools-1a` (`subnet-0d5dee6be35a20916`, `10.0.3.0/24`) + `internal-tools-1b` |
| Route table | Shares the existing Jenkins public RT (IGW default route) |
| `Project` tag | `nectar` (kept separate from Jenkins cost reports) |

### Shared "internal-tools" subnets

Nectar consumes two shared subnets that are NOT managed by this Terraform state:

- `internal-tools-1a` — `10.0.3.0/24`, us-east-1a, public
- `internal-tools-1b` — `10.0.4.0/24`, us-east-1b, public

These subnets are intentionally shared between Nectar and other always-on
internal developer tooling (Hive if/when it moves here, future services, etc.).
They're created outside this TF and looked up by Name tag via `data.aws_subnet`
in `subnets.tf`.

Why dedicated subnets: the existing Jenkins public subnets (`10.0.0.0/24`,
`10.0.1.0/24`) are heavily used by the Jenkins worker auto-scaling fleet —
they saturate to ~40%+ during peak CI load. Dedicated `/24`s give always-on
services stable IP allocation and isolate them from worker churn.

The shared subnets use the existing Jenkins VPC public route table, so egress
still goes out the same IGW as the Jenkins master — no NAT gateway cost.

If you need to recreate or modify these subnets, do it in the owning tool/state
— not here. This TF will automatically pick up changes via the Name-tag lookup.

### Access

- **HTTPS** (dashboard): via ALB at `https://nectar.vivtechnologies.com` — open
  to the internet (no IP restriction). Authentication is handled by **Google SSO**
  at the application level (login required, restricted to `@vivtechnologies.com`).
- **SSH** (break-glass): via the shared `toronto-office-jenkins-ssh` SG
  (`sg-043c84f65239ea620`) using the `jenkins` EC2 key pair. Office IPs only.
- **Shell without SSH**: `aws ssm start-session --target <instance-id>` — works
  from anywhere the IAM user has SSM permissions, no key needed.

## One-time setup

### 1. Create the `nectar/env` secret in AWS Secrets Manager

Viv root account (140947722076), us-east-1. Store as JSON:

```json
{
  "WEB_PORT": "4000",
  "GITHUB_TOKEN": "<github-pat-with-repo-scope>",
  "JIRA_BASE_URL": "https://vivtechnologies.atlassian.net",
  "JIRA_EMAIL": "<jira-email>",
  "JIRA_API_TOKEN": "<jira-api-token>",
  "JENKINS_BASE_URL": "https://jenkins.vivtechnologies.com",
  "JENKINS_USER": "<jenkins-user>",
  "JENKINS_TOKEN": "<jenkins-api-token>",
  "SLACK_BOT_TOKEN": "<slack-bot-token>",
  "SLACK_APP_TOKEN": "<slack-app-token>",
  "GOOGLE_CLIENT_ID": "<google-oauth-client-id>",
  "GOOGLE_CLIENT_SECRET": "<google-oauth-client-secret>",
  "GOOGLE_ALLOWED_DOMAIN": "vivtechnologies.com",
  "GOOGLE_REDIRECT_URI": "https://nectar.vivtechnologies.com/api/auth/google/callback",
  "JWT_SECRET": "<random-string-for-session-tokens>",
  "GITHUB_WEBHOOK_SECRET": "<optional-webhook-secret>"
}
```

```bash
aws secretsmanager create-secret \
  --name nectar/env \
  --secret-string file://nectar-env.json \
  --region us-east-1
```

**Google SSO**: create an OAuth 2.0 client in Google Cloud Console with the
authorized redirect URI set to
`https://nectar.vivtechnologies.com/api/auth/google/callback`. Only emails
matching `GOOGLE_ALLOWED_DOMAIN` are allowed to log in.

**Do NOT set `WEB_TOKEN`.** The server would require every WebSocket client to
authenticate with that token, but the React client doesn't send one — the
dashboard would hang on the loading screen forever.

### 2. Provision AWS resources (Terraform)

```bash
cd cloud/terraform
tofu init
tofu plan    # review
tofu apply   # requires confirmation
```

This creates:
- EC2 instance (t3.large, Ubuntu 22.04, 30GB gp3)
- ALB + target group + HTTPS listener
- Security groups (office IPs → ALB → EC2:4000)
- IAM role with Secrets Manager + SSM access

The EC2 user-data runs `scripts/init.sh` on first boot to install Node 22 and
other dependencies, clone the repo, build the client, install the systemd
service, install the auto-update timer, and install the logrotate config.

### 3. Add DNS CNAME in GoDaddy

Point `nectar.vivtechnologies.com` → value of `tofu output alb_dns_name`.

### 4. Verify

```bash
# Wait ~5 minutes for init.sh to finish, then:
curl https://nectar.vivtechnologies.com/health
```

Expected: `{"status":"ok","uptime":...,"integrations":{...}}`

## How it runs

Five systemd units work together on the instance (one of which — the legacy
`nectar.service` — is intentionally inactive in steady state):

| Unit | Type | What it does |
|------|------|--------------|
| `nectar-web.service` | long-running | Runs the HTTP/WebSocket/MCP server (`node src/web-server.js`). `ExecStartPre=boot.sh` fetches the `nectar/env` secret from Secrets Manager and merges it into `.env` before Node starts. `Restart=on-failure`, `RestartSec=5`. Heap capped at 2 GB (`NODE_OPTIONS=--max-old-space-size=2048`). Logs append to `/home/ubuntu/nectar.log`. |
| `nectar-sync.service` | long-running | Runs the JIRA/GitHub/Slack sync worker (`node src/sync-worker.js`). Same `ExecStartPre=boot.sh`. `Restart=on-failure`, `RestartSec=10`. Heap capped at 2 GB. Logs append to `/home/ubuntu/nectar-sync.log`. |
| `nectar-update.service` | oneshot | Runs `cloud/scripts/update.sh`: git fetch → `git pull --ff-only` → conditional `npm install` / client rebuild → `sudo systemctl restart nectar-sync nectar-web`. Hard timeout 600 s. Logs append to `/home/ubuntu/nectar-update.log`. |
| `nectar-update.timer` | timer | Fires `nectar-update.service` 2 min after boot, then every 5 min from the previous run's completion. `Persistent=true` catches up on missed runs after reboots. |
| `nectar.service` | long-running (**disabled**) | Legacy single-process unit (`node src/index.js`) installed by `init.sh` on first boot. The first run of `update.sh` stops and disables it, then enables `nectar-web` + `nectar-sync` in its place. You should expect this unit to be loaded but inactive on every running prod box — that is correct steady state, not a bug. |

The split into `nectar-web` + `nectar-sync` exists so the dashboard stays
responsive during long sync passes (and so each side gets its own log file
and own memory budget). Both processes open the same `/home/ubuntu/nectar/.nectar.db`
file in WAL mode — SQLite handles the cross-process locking.

The instance tag `nectar-secret-name` overrides the default `nectar/env` secret
name, letting you point one instance at a different secret if needed.

### Logs

| File | Source | Rotated? |
|------|--------|----------|
| `/home/ubuntu/nectar.log` | `nectar-web.service` (HTTP/WS/MCP) | Yes — daily, 100 MB cap, 14 kept, gzip |
| `/home/ubuntu/nectar-sync.log` | `nectar-sync.service` (poller) | **No** — currently outside the logrotate config. Watch its size on long-running boxes. |
| `/home/ubuntu/nectar-update.log` | `nectar-update.service` (every 5 min) | Yes — same policy as `nectar.log` |

Logrotate config lives at `/etc/logrotate.d/nectar` and uses `copytruncate`
because the long-running units hold an append-mode file descriptor that a
normal `mv`+`create` rotation would invalidate. The systemd journal also
captures everything (`journalctl -u nectar-web` etc.) regardless of the file
logs and is bounded by the journal's own retention.

Tail them live via SSM Session Manager:
```bash
aws ssm start-session --target <instance-id>
sudo tail -f /home/ubuntu/nectar.log            # web stdout/stderr
sudo tail -f /home/ubuntu/nectar-sync.log       # sync worker
sudo tail -f /home/ubuntu/nectar-update.log     # auto-update runs
```

Or the systemd journal (lets you filter by time, follow multiple units):
```bash
sudo journalctl -u nectar-web -f                       # web
sudo journalctl -u nectar-sync -f                      # sync worker
sudo journalctl -u nectar-update.service -f            # update runs
sudo journalctl -u nectar-web -u nectar-sync --since '15 min ago' --no-pager
```

## Updating Nectar (code)

**Automatic** — merge to `main` and wait up to 5 minutes. The `nectar-update.timer`
on the instance polls `origin/main`, detects the new commit, runs `update.sh`
(which git-pulls, reinstalls deps if changed, rebuilds the client if changed,
and restarts both `nectar-sync` and `nectar-web`), and logs everything to
`/home/ubuntu/nectar-update.log`.

No-op when HEAD hasn't moved — safe to fire every 5 minutes forever.

### Forcing an immediate update (bypass the timer)

```bash
INSTANCE_ID=$(tofu -chdir=cloud/terraform output -raw instance_id)

aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo systemctl start nectar-update.service"]' \
  --region us-east-1
```

Or via an SSM Session Manager shell:
```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo systemctl start nectar-update.service
# tail the log in another session:
sudo tail -f /home/ubuntu/nectar-update.log
```

### Checking the timer

```bash
sudo systemctl list-timers nectar-update.timer
sudo systemctl status nectar-update.service
```

### If an update breaks Nectar

`update.sh` exits non-zero if any step fails (bad pull, failed build, etc.),
which means the final `sudo systemctl restart nectar` is never reached — the
old Nectar keeps running. Fix the bad commit in `main`, and the next timer
fire (within 5 min) picks up the fix automatically.

To skip the broken commit manually, SSM in and run the update yourself:
```bash
sudo -u ubuntu bash -c 'cd ~/nectar && git pull && npm install'
sudo systemctl restart nectar-sync nectar-web
```

## Updating Nectar (environment variables)

**Always add env vars to the `nectar/env` Secrets Manager secret — never edit
`.env` on the instance directly.** `boot.sh` runs on every service start and
merges the secret into `.env`, so anything only in `.env` survives restarts but
is lost if the instance is ever re-provisioned. The secret is the durable
source of truth.

### Adding or changing a variable

```bash
# 1. Read current secret, add/update keys, write back
aws secretsmanager get-secret-value --secret-id nectar/env \
  --query SecretString --output text --region us-east-1 | \
  jq '. + {"NEW_KEY": "new-value"}' | \
  aws secretsmanager put-secret-value --secret-id nectar/env \
  --secret-string file:///dev/stdin --region us-east-1

# 2. Restart both processes so boot.sh merges the new key into .env on each
aws ssm send-command --instance-ids <instance-id> \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo systemctl restart nectar-sync nectar-web"]' \
  --region us-east-1
```

### Removing a variable

```bash
aws secretsmanager get-secret-value --secret-id nectar/env \
  --query SecretString --output text --region us-east-1 | \
  jq 'del(.OLD_KEY)' | \
  aws secretsmanager put-secret-value --secret-id nectar/env \
  --secret-string file:///dev/stdin --region us-east-1
```

Then SSH or SSM in and also remove it from the live `.env` (boot.sh upserts but
doesn't delete), then restart.

## MCP access from Hive

Add to Hive's `.mcp.json` (or any Claude Code client):

```json
{
  "mcpServers": {
    "nectar": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/home/ubuntu/nectar/src/mcp/stdio-bridge.mjs",
        "--url",
        "https://nectar.vivtechnologies.com/mcp"
      ]
    }
  }
}
```

For intra-VPC access (lower latency), use the private IP instead:

```json
"args": ["stdio-bridge.mjs", "--url", "http://<nectar-private-ip>:4000/mcp"]
```

## GitHub / JIRA webhooks (optional)

Nectar already polls on intervals — webhooks just make updates faster.

- **GitHub webhook** on `mavencare/webplatform`: `https://nectar.vivtechnologies.com/api/webhooks/github`
  - Events: `pull_request` (for cherry-pick detection)
  - Secret: value of `GITHUB_WEBHOOK_SECRET`
- **JIRA webhook** in vivtechnologies.atlassian.net: `https://nectar.vivtechnologies.com/api/webhooks/jira`
  - Events: `jira:issue_updated`

## Troubleshooting

### Service won't start
```bash
aws ssm start-session --target <instance-id>

# Inspect both processes — they fail independently
sudo systemctl status nectar-web nectar-sync --no-pager
sudo journalctl -u nectar-web -n 100 --no-pager
sudo journalctl -u nectar-sync -n 100 --no-pager
sudo tail -100 /home/ubuntu/nectar.log
sudo tail -100 /home/ubuntu/nectar-sync.log
```

If only `nectar-web` is up but `nectar-sync` isn't, the dashboard renders but
data goes stale (no JIRA/GitHub polling). If only `nectar-sync` is up,
`/health` will fail and the ALB target group will mark the instance
unhealthy. Both must be active for prod to be considered healthy.

### boot.sh failing to fetch secret
- Confirm the IAM role attached to the instance has `secretsmanager:GetSecretValue`
  on `arn:aws:secretsmanager:us-east-1:140947722076:secret:nectar/*`.
- Confirm the `nectar/env` secret exists and is valid JSON.
- Check `ec2:DescribeTags` is present (for reading the `nectar-secret-name` tag).

### Dashboard stuck on the loading screen
The WebSocket is failing auth. Most common cause: `WEB_TOKEN` is set in the
`nectar/env` secret. The React client doesn't send a WEB_TOKEN auth message, so
the server closes the connection after 5 seconds and the client loops forever.
Remove `WEB_TOKEN` from the secret and restart the service. (Dashboard
authentication is handled by Google SSO, not WEB_TOKEN.)

### Auto-updates stopped working
```bash
# Is the timer still running?
sudo systemctl list-timers nectar-update.timer
sudo systemctl status nectar-update.timer

# What did the last few runs do?
sudo tail -50 /home/ubuntu/nectar-update.log
sudo journalctl -u nectar-update.service -n 50 --no-pager

# Force an immediate run to see errors live
sudo systemctl start nectar-update.service
sudo journalctl -u nectar-update.service -f
```

A hung `git fetch` or `npm install` can block the next timer fire until
`TimeoutStartSec=600` expires. If you see "start operation timed out",
check the network path from the instance to GitHub and npm registry.

### Log file not rotating
```bash
# Validate the config parses
sudo logrotate -d /etc/logrotate.d/nectar

# Force a rotation manually (won't actually rotate if file is below maxsize
# and hasn't aged a day — pass -f to force)
sudo logrotate -f /etc/logrotate.d/nectar
ls -la /home/ubuntu/nectar*.log*
```

### ALB health check failing
- Target must return HTTP 200 on `GET /health:4000`.
- If Nectar is crashing, the health check will fail. Check logs first.
- Confirm the EC2 SG allows inbound 4000 from the ALB SG.

### ECR/Docker not needed
Nectar runs Node.js directly. No Docker, no ECR, no CodeBuild, no CodePipeline.

## Cost

| Resource | Monthly |
|----------|---------|
| t3.large EC2 | ~$60 |
| 30GB gp3 EBS | ~$2.40 |
| ALB | ~$16 |
| Secrets Manager | ~$0.40 |
| **Total** | **~$80** |

(Was a t3.medium for ~$30/mo — bumped to t3.large because Node was peaking
around 3.5 GB and OOM-looping on the 4 GB host.)

Costs are tagged `Project = nectar` so they don't roll into the Jenkins daily
cost report. Subnets themselves are free.

## Files

```
cloud/
├── README.md                    # This file
├── terraform/
│   ├── main.tf                  # AWS provider
│   ├── backend.tf               # S3 state backend
│   ├── variables.tf             # All inputs
│   ├── subnets.tf               # Data-source lookup for shared internal-tools subnets
│   ├── ec2.tf                   # EC2 instance + user_data
│   ├── alb.tf                   # ALB + target group + listeners
│   ├── sg.tf                    # Security groups
│   ├── iam.tf                   # EC2 role + instance profile
│   └── outputs.tf               # instance_id, alb_dns_name, etc.
├── scripts/
│   ├── init.sh                  # First-boot setup (EC2 user-data)
│   ├── boot.sh                  # Every-boot secret fetch (runs as ExecStartPre of nectar.service)
│   └── update.sh                # Pull latest code + restart (invoked by the timer or manually via SSM)
└── templates/
    ├── nectar.service           # Legacy single-process unit — installed by init.sh on first boot, then disabled by the first update.sh run
    ├── nectar-web.service       # HTTP/WebSocket/MCP server — long-running, logs to nectar.log
    ├── nectar-sync.service      # JIRA/GitHub/Slack sync worker — long-running, logs to nectar-sync.log
    ├── nectar-update.service    # Oneshot unit that runs update.sh and appends output to nectar-update.log
    ├── nectar-update.timer      # Fires nectar-update.service 2 min after boot, then every 5 min
    └── nectar.logrotate         # logrotate config for nectar.log and nectar-update.log (does NOT cover nectar-sync.log)
```
