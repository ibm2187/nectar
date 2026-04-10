#!/bin/bash
# Nectar update script — pulls latest code, reinstalls deps if changed,
# rebuilds client if changed, and restarts the systemd service.
#
# Run on the Nectar EC2 instance as any user (will sudo for systemctl).
# Invoke via SSM Session Manager or SSM send-command:
#
#   aws ssm send-command \
#     --instance-ids <instance-id> \
#     --document-name "AWS-RunShellScript" \
#     --parameters 'commands=["bash /home/ubuntu/nectar/cloud/scripts/update.sh"]' \
#     --region us-east-1

set -euo pipefail

NECTAR_DIR="/home/ubuntu/nectar"
log() { echo "[$(date '+%H:%M:%S')] $1"; }

cd "${NECTAR_DIR}"

# Run git operations as ubuntu user (repo is owned by ubuntu)
OLD_HEAD=$(sudo -u ubuntu git rev-parse HEAD)
log "Current HEAD: ${OLD_HEAD:0:7}"

log "Fetching..."
sudo -u ubuntu git fetch origin

log "Pulling..."
sudo -u ubuntu git pull --ff-only

NEW_HEAD=$(sudo -u ubuntu git rev-parse HEAD)

if [ "${OLD_HEAD}" = "${NEW_HEAD}" ]; then
  log "Already up to date. Nothing to do."
  exit 0
fi

log "Updated: ${OLD_HEAD:0:7} → ${NEW_HEAD:0:7}"

# Detect what changed
CHANGED=$(sudo -u ubuntu git diff --name-only "${OLD_HEAD}" "${NEW_HEAD}")

if echo "${CHANGED}" | grep -qE '^package(-lock)?\.json$'; then
  log "Server deps changed — running npm install..."
  sudo -u ubuntu npm install
fi

if echo "${CHANGED}" | grep -q '^client/'; then
  if echo "${CHANGED}" | grep -qE '^client/package(-lock)?\.json$'; then
    log "Client deps changed — running npm install in client/..."
    sudo -u ubuntu bash -c "cd '${NECTAR_DIR}/client' && npm install"
  fi
  log "Rebuilding client..."
  sudo -u ubuntu bash -c "cd '${NECTAR_DIR}/client' && npm run build"
fi

log "Restarting nectar service..."
sudo systemctl restart nectar

log "Update complete."
sudo systemctl status nectar --no-pager | head -10
