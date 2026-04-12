# Nectar Cloud Deployment

Deploy Nectar to a dedicated EC2 instance in the **Jenkins VPC** (Viv root AWS
account). Direct Node.js execution (no Docker), systemd-managed, Secrets Manager
for `.env`, ALB with TLS, automatic deploys via a systemd timer that polls
`origin/main` every 5 minutes. Server logs rotate daily.

## Architecture

```
Internet
    │
    ▼
ALB :443 (nectar.vivtechnologies.com)
    │  (office IPs only via SG)
    ▼
EC2 t3.medium (Ubuntu 22.04, Node 22 LTS) :4000
    │  [Jenkins VPC, new "services" subnet, us-east-1b]
    ├── Node.js — src/index.js (managed by systemd)
    ├── Bare git clones — ~/.nectar/repos/
    └── JSON state — ~/.nectar/
```

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
- EC2 instance (t3.medium, Ubuntu 22.04, 30GB gp3)
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

Three systemd units work together on the instance:

| Unit | Type | What it does |
|------|------|--------------|
| `nectar.service` | long-running | Runs Nectar. `ExecStartPre=boot.sh` fetches the `nectar/env` secret from Secrets Manager and merges it into `.env` before the Node process starts. `Restart=on-failure` auto-recovers on crashes. |
| `nectar-update.service` | oneshot | Runs `cloud/scripts/update.sh`: git fetch → `git pull --ff-only` → conditional `npm install` / client rebuild → `sudo systemctl restart nectar`. Logs append to `/home/ubuntu/nectar-update.log`. |
| `nectar-update.timer` | timer | Fires `nectar-update.service` 2 min after boot, then every 5 min from the previous run's completion. `Persistent=true` catches up on missed runs after reboots. |

The instance tag `nectar-secret-name` overrides the default `nectar/env` secret
name, letting you point one instance at a different secret if needed.

### Logs

| File | What's in it |
|------|--------------|
| `/home/ubuntu/nectar.log` | Nectar server stdout/stderr (from `nectar.service`) |
| `/home/ubuntu/nectar-update.log` | Output of every auto-update run (from `nectar-update.service`) |

Both files rotate daily via `/etc/logrotate.d/nectar` — also triggered early if
either file crosses 100 MB. 14 rotations kept, compressed with gzip. Uses
`copytruncate` because systemd holds an append-mode file descriptor that a
normal `mv`+`create` rotation would invalidate.

Tail them live via SSM Session Manager:
```bash
aws ssm start-session --target <instance-id>
sudo tail -f /home/ubuntu/nectar.log            # server output
sudo tail -f /home/ubuntu/nectar-update.log     # auto-update runs
```

Or the systemd journal:
```bash
sudo journalctl -u nectar -f                    # server
sudo journalctl -u nectar-update.service -f     # update runs
```

## Updating Nectar (code)

**Automatic** — merge to `main` and wait up to 5 minutes. The `nectar-update.timer`
on the instance polls `origin/main`, detects the new commit, runs `update.sh`
(which git-pulls, reinstalls deps if changed, rebuilds the client if changed,
and restarts the service), and logs everything to `/home/ubuntu/nectar-update.log`.

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
sudo systemctl restart nectar
```

## Updating Nectar (secrets)

1. Update the `nectar/env` secret in Secrets Manager.
2. `sudo systemctl restart nectar` via SSM — `boot.sh` re-merges secrets on every start.

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

sudo systemctl status nectar
sudo journalctl -u nectar -n 100 --no-pager
sudo tail -100 /home/ubuntu/nectar.log
```

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
| t3.medium EC2 | ~$30 |
| 30GB gp3 EBS | ~$2.40 |
| ALB | ~$16 |
| Secrets Manager | ~$0.40 |
| **Total** | **~$50** |

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
    ├── nectar.service           # Main Nectar systemd unit (Node.js server, Restart=on-failure)
    ├── nectar-update.service    # Oneshot unit that runs update.sh and appends output to nectar-update.log
    ├── nectar-update.timer      # Fires nectar-update.service 2 min after boot, then every 5 min
    └── nectar.logrotate         # logrotate config for nectar.log and nectar-update.log
```
