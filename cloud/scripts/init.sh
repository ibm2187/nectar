#!/bin/bash
# Nectar init script — one-time setup via EC2 user-data.
# Installs system dependencies, clones the repo, builds the client, and kicks off boot.sh.
# Run as root. Subsequent reboots use boot.sh via systemd.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

UBUNTU_HOME="/home/ubuntu"
NECTAR_DIR="${UBUNTU_HOME}/nectar"
REPO_URL="https://github.com/mavencare/nectar.git"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# ══════════════════════════════════════════════════════════════════════════════
# FIRST-RUN: Install system dependencies (skips if already done)
# ══════════════════════════════════════════════════════════════════════════════

if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  log "Installing system packages..."
  apt-get update -qq
  apt-get install -y -qq git jq curl unzip build-essential software-properties-common

  log "Installing Node.js 22 LTS..."
  # Node 22 LTS — required by Vite 7 (client build), supported until April 2027.
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v aws &>/dev/null; then
  log "Installing AWS CLI v2..."
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp/aws-install
  /tmp/aws-install/aws/install
  rm -rf /tmp/awscliv2.zip /tmp/aws-install
fi

if ! command -v gh &>/dev/null; then
  log "Installing GitHub CLI..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq gh
fi

# ── Configure ubuntu user (idempotent) ────────────────────────────────────
sudo -u ubuntu git config --global user.name "nectar-bot[bot]"
sudo -u ubuntu git config --global user.email "nectar-bot[bot]@users.noreply.github.com"

sudo -u ubuntu mkdir -p "${UBUNTU_HOME}/.ssh"
ssh-keyscan -t ed25519 github.com >> "${UBUNTU_HOME}/.ssh/known_hosts" 2>/dev/null || true
chown ubuntu:ubuntu "${UBUNTU_HOME}/.ssh/known_hosts"

timedatectl set-timezone America/Toronto 2>/dev/null || true

# ── Clone nectar repo if missing ──────────────────────────────────────────
if [ ! -d "${NECTAR_DIR}" ]; then
  log "Cloning nectar repo..."
  sudo -u ubuntu git clone "${REPO_URL}" "${NECTAR_DIR}"
fi

# ── npm install (server) ──────────────────────────────────────────────────
log "Installing server dependencies..."
cd "${NECTAR_DIR}"
sudo -u ubuntu npm install 2>&1 | tail -1

# ── Build client (React + Vite) ───────────────────────────────────────────
log "Building client..."
cd "${NECTAR_DIR}/client"
sudo -u ubuntu npm install 2>&1 | tail -1
sudo -u ubuntu npm run build 2>&1 | tail -1

# ── Install systemd service ───────────────────────────────────────────────
log "Installing nectar systemd service..."
cp "${NECTAR_DIR}/cloud/templates/nectar.service" /etc/systemd/system/nectar.service
systemctl daemon-reload
systemctl enable nectar.service

# ── Start Nectar (systemd runs boot.sh as ExecStartPre) ───────────────────
log "Starting nectar service..."
systemctl start nectar.service

log "Init complete."
