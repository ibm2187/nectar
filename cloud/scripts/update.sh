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
#
# Force a full rebuild + restart regardless of HEAD:
#
#   bash /home/ubuntu/nectar/cloud/scripts/update.sh --force

set -euo pipefail

NECTAR_DIR="/home/ubuntu/nectar"
FORCE=false

for arg in "$@"; do
  case "${arg}" in
    --force|-f) FORCE=true ;;
    *) echo "Unknown option: ${arg}" >&2; exit 1 ;;
  esac
done

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

if [ "${OLD_HEAD}" = "${NEW_HEAD}" ] && [ "${FORCE}" = false ]; then
  log "Already up to date. Nothing to do."
  exit 0
fi

if [ "${FORCE}" = true ] && [ "${OLD_HEAD}" = "${NEW_HEAD}" ]; then
  log "No new commits, but --force specified. Rebuilding anyway."
fi

log "Updated: ${OLD_HEAD:0:7} → ${NEW_HEAD:0:7}"

if [ "${FORCE}" = true ]; then
  log "Force mode — reinstalling all deps and rebuilding client..."
  sudo -u ubuntu npm install
  sudo -u ubuntu bash -c "cd '${NECTAR_DIR}/client' && npm install && npm run build"
else
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
fi

# Stop old single-process service if still active
if systemctl is-active --quiet nectar 2>/dev/null; then
  log "Stopping old single-process service..."
  sudo systemctl stop nectar
  sudo systemctl disable nectar
fi

# Copy service files in case they changed
sudo cp cloud/templates/nectar-web.service /etc/systemd/system/ 2>/dev/null || true
sudo cp cloud/templates/nectar-sync.service /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload

# Enable and restart two-process services
sudo systemctl enable nectar-web nectar-sync 2>/dev/null || true
log "Restarting nectar services..."
sudo systemctl restart nectar-sync
sudo systemctl restart nectar-web

log "Update complete."
sudo systemctl status nectar-web --no-pager | head -5
sudo systemctl status nectar-sync --no-pager | head -5
