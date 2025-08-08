#!/usr/bin/env bash
set -euo pipefail

# Simple Cloud Drive – One-Click (No Domain, HTTP only)
# - Installs Docker & compose plugin
# - Starts app on port 8089 directly (no Nginx)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_DIR="${APP_DIR:-$APP_DIR_DEFAULT}"
PORT="${PORT:-8089}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-change_me}"
JWT_SECRET="${JWT_SECRET:-$(tr -dc A-Za-z0-9 </dev/urandom | head -c 48)}"

echo "APP_DIR=$APP_DIR"
echo "PORT=$PORT"
sleep 1

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
apt-get install -y docker-compose-plugin

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR not found. Upload the project and retry." >&2
  exit 1
fi
cd "$APP_DIR"

touch .env
grep -q '^PORT=' .env && sed -i "s/^PORT=.*/PORT=$PORT/" .env || echo "PORT=$PORT" >> .env
grep -q '^JWT_SECRET=' .env && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env || echo "JWT_SECRET=$JWT_SECRET" >> .env
grep -q '^STORAGE_ROOT=' .env || echo "STORAGE_ROOT=/storage" >> .env
grep -q '^ADMIN_USERNAME=' .env && sed -i "s/^ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USERNAME/" .env || echo "ADMIN_USERNAME=$ADMIN_USERNAME" >> .env
grep -q '^ADMIN_PASSWORD=' .env && sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASSWORD/" .env || echo "ADMIN_PASSWORD=$ADMIN_PASSWORD" >> .env

mkdir -p storage
chmod 755 storage

docker compose up -d --build

IPV4=$(hostname -I | awk '{print $1}')
echo
echo "App is running:  http://$IPV4:$PORT"
echo "Admin account:   $ADMIN_USERNAME"
echo "Security: Change ADMIN_PASSWORD & JWT_SECRET in $APP_DIR/.env, then: docker compose restart"


