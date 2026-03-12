#!/bin/bash
# Deploy antidrain-bot to a VPS
# Usage: ./deploy.sh <user@host>
#
# Prerequisites on VPS:
#   - Docker + Docker Compose installed
#   - SSH access configured
#
# Cheapest VPS options (~$4-6/mo):
#   - Hetzner CX22 ($4.15/mo) - 2 vCPU, 4GB RAM
#   - DigitalOcean Basic ($4/mo) - 1 vCPU, 512MB RAM
#   - Vultr Cloud Compute ($5/mo) - 1 vCPU, 1GB RAM

set -euo pipefail

HOST="${1:?Usage: ./deploy.sh <user@host>}"
REMOTE_DIR="/opt/antidrain-bot"

echo "=== Deploying antidrain-bot to $HOST ==="

# Check .env exists locally
if [ ! -f .env ]; then
    echo "ERROR: .env file not found. Create it first."
    exit 1
fi

# Create remote directory
ssh "$HOST" "mkdir -p $REMOTE_DIR"

# Copy project files (excluding node_modules, dist, logs)
rsync -avz --exclude='node_modules' --exclude='dist' --exclude='*.log' \
    --exclude='.git' --exclude='docs' \
    ./ "$HOST:$REMOTE_DIR/"

# Copy .env separately
scp .env "$HOST:$REMOTE_DIR/.env"

# Build and start on remote
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d --build"

echo "=== Deployed! Check status with: ==="
echo "  ssh $HOST 'docker compose -f $REMOTE_DIR/docker-compose.yml logs -f'"
