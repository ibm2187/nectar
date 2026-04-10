# Nectar Cloud Deployment

Deploy Nectar to a dedicated EC2 instance in the **Jenkins VPC** (Viv root AWS
account). Direct Node.js execution (no Docker), systemd-managed, Secrets Manager
for `.env`, ALB with TLS. Code updates happen via an `update.sh` script invoked
through SSM — no in-app updater.

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

- **HTTPS** (dashboard): via ALB at `https://nectar.vivtechnologies.com`, office
  IPs only (beanfield + rogers).
- **SSH** (break-glass): via the shared `toronto-office-jenkins-ssh` SG
  (`sg-043c84f65239ea620`) using the `jenkins` EC2 key pair. Also office IPs
  only.
- **Shell without SSH**: `aws ssm start-session --target <instance-id>` — works
  from anywhere the IAM user has SSM permissions, no key needed.

## One-time setup

### 1. Create the `nectar/env` secret in AWS Secrets Manager

Viv root account (140947722076), us-east-1. Store as JSON:

```json
{
  "WEB_PORT": "4000",
  "GITHUB_TOKEN": "<github-pat-with-repo-scope>",
  "JIRA_URL": "https://vivtechnologies.atlassian.net",
  "JIRA_USERNAME": "<jira-email>",
  "JIRA_API_TOKEN": "<jira-api-token>",
  "SLACK_BOT_TOKEN": "<slack-bot-token>",
  "SLACK_APP_TOKEN": "<slack-app-token>",
  "WEB_TOKEN": "<random-token-for-api-auth>",
  "GITHUB_WEBHOOK_SECRET": "<webhook-secret>"
}
```

```bash
aws secretsmanager create-secret \
  --name nectar/env \
  --secret-string file://nectar-env.json \
  --region us-east-1
```

### 2. Provision AWS resources (Terraform)

```bash
cd cloud/terraform
tofu init
tofu plan    # review
tofu apply   # requires confirmation
```

This creates:
- EC2 instance (t3.small, Ubuntu 22.04, 30GB gp3)
- ALB + target group + HTTPS listener
- Security groups (office IPs → ALB → EC2:4000)
- IAM role with Secrets Manager + SSM access

The EC2 user-data runs `scripts/init.sh` on first boot to install dependencies,
clone the repo, build the client, and install the systemd service.

### 3. Add DNS CNAME in GoDaddy

Point `nectar.vivtechnologies.com` → value of `tofu output alb_dns_name`.

### 4. Verify

```bash
# Wait ~5 minutes for init.sh to finish, then:
curl https://nectar.vivtechnologies.com/health
```

Expected: `{"status":"ok","uptime":...,"integrations":{...}}`

## How it runs

On every boot, systemd runs:

1. `ExecStartPre=boot.sh` — fetches the `nectar/env` secret from Secrets Manager
   and merges it into `/home/ubuntu/nectar/.env` (instance tag `nectar-secret-name`
   overrides the default secret name).
2. `ExecStart=node src/index.js` — starts Nectar.
3. If Nectar crashes, systemd restarts it after 10 seconds (`Restart=on-failure`).

Logs are appended to `/home/ubuntu/nectar.log`. Use `journalctl -u nectar -f` for
live tailing via SSM Session Manager.

## Updating Nectar (code)

Code updates are handled by `cloud/scripts/update.sh`, which is checked into
the repo and already on the instance after first boot. Trigger it via SSM.

### Option A — SSM send-command (one-shot)

```bash
INSTANCE_ID=$(tofu -chdir=cloud/terraform output -raw instance_id)

aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["bash /home/ubuntu/nectar/cloud/scripts/update.sh"]' \
  --region us-east-1
```

`update.sh` does:
- `git fetch origin` + `git pull --ff-only`
- `npm install` if `package-lock.json` changed
- `cd client && npm install && npm run build` if `client/` changed
- `sudo systemctl restart nectar`

No-op if HEAD hasn't moved.

### Option B — SSM Session Manager (interactive)

```bash
aws ssm start-session --target "$INSTANCE_ID"
# inside the session:
bash ~/nectar/cloud/scripts/update.sh
```

### Optional: auto-update on a timer

Add a systemd timer on the instance that runs `update.sh` every N minutes for
fully automatic deploys. Left off by default — easy to add later.

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
# Shell via SSM Session Manager:
aws ssm start-session --target "$INSTANCE_ID"

# Check status
sudo systemctl status nectar
sudo journalctl -u nectar -n 100 --no-pager

# Check log file
tail -100 /home/ubuntu/nectar.log
```

### boot.sh failing to fetch secret
- Confirm the IAM role attached to the instance has `secretsmanager:GetSecretValue`
  on `arn:aws:secretsmanager:us-east-1:140947722076:secret:nectar/*`.
- Confirm the `nectar/env` secret exists and is valid JSON.
- Check `ec2:DescribeTags` is present (for reading the `nectar-secret-name` tag).

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
│   ├── boot.sh                  # Every-boot secret fetch (ExecStartPre)
│   └── update.sh                # Pull latest code + restart (triggered via SSM)
└── templates/
    └── nectar.service           # systemd unit
```
