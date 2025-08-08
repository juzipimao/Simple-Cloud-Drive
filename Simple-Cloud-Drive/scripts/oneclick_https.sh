#!/usr/bin/env bash
set -euo pipefail

# Simple Cloud Drive – Debian HTTPS One-Click Installer
# - Installs Docker, Nginx, Certbot
# - Starts the app (port 8089) via docker compose
# - Issues Let's Encrypt cert and enables HTTPS redirect

# ===== Defaults (can be overridden by env or flags) =====
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOMAIN="${DOMAIN:-cloud.example.com}"
EMAIL="${EMAIL:-admin@example.com}"
APP_DIR="${APP_DIR:-$APP_DIR_DEFAULT}"
PORT="${PORT:-8089}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-change_me}"
JWT_SECRET="${JWT_SECRET:-$(tr -dc A-Za-z0-9 </dev/urandom | head -c 48)}"

usage() {
  cat <<USAGE
Usage: $0 [-d domain] [-m email] [-a app_dir] [-u admin_user] [-p admin_pass] [-j jwt_secret] [-P port]
Defaults:
  -d DOMAIN        ${DOMAIN}
  -m EMAIL         ${EMAIL}
  -a APP_DIR       ${APP_DIR}
  -u ADMIN_USER    ${ADMIN_USERNAME}
  -p ADMIN_PASS    ${ADMIN_PASSWORD}
  -j JWT_SECRET    (auto-generated)
  -P PORT          ${PORT}
Examples:
  sudo $0 -d drive.example.com -m you@mail.com -p 'StrongPass123!'
USAGE
}

while getopts ":d:m:a:u:p:j:P:h" opt; do
  case "$opt" in
    d) DOMAIN="$OPTARG" ;;
    m) EMAIL="$OPTARG" ;;
    a) APP_DIR="$OPTARG" ;;
    u) ADMIN_USERNAME="$OPTARG" ;;
    p) ADMIN_PASSWORD="$OPTARG" ;;
    j) JWT_SECRET="$OPTARG" ;;
    P) PORT="$OPTARG" ;;
    h) usage; exit 0 ;;
    :) echo "Option -$OPTARG requires an argument" >&2; usage; exit 2 ;;
    *) usage; exit 2 ;;
  esac
done

echo "DOMAIN=$DOMAIN"
echo "EMAIL=$EMAIL"
echo "APP_DIR=$APP_DIR"
echo "PORT=$PORT"
sleep 1

# ===== Base packages =====
apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release

# Docker
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
apt-get install -y docker-compose-plugin

# Nginx & Certbot
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable --now nginx

# ===== Prepare app =====
if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR not found. Upload the project to this server first." >&2
  exit 1
fi
cd "$APP_DIR"

# .env
touch .env
grep -q '^PORT=' .env && sed -i "s/^PORT=.*/PORT=$PORT/" .env || echo "PORT=$PORT" >> .env
grep -q '^JWT_SECRET=' .env && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env || echo "JWT_SECRET=$JWT_SECRET" >> .env
grep -q '^STORAGE_ROOT=' .env || echo "STORAGE_ROOT=/storage" >> .env
grep -q '^ADMIN_USERNAME=' .env && sed -i "s/^ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USERNAME/" .env || echo "ADMIN_USERNAME=$ADMIN_USERNAME" >> .env
grep -q '^ADMIN_PASSWORD=' .env && sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASSWORD/" .env || echo "ADMIN_PASSWORD=$ADMIN_PASSWORD" >> .env

mkdir -p storage
chmod 755 storage

# ===== Start app =====
docker compose up -d --build

# ===== Nginx reverse proxy (80) =====
NGINX_CONF="/etc/nginx/sites-available/simple-cloud-drive.conf"
cat > "$NGINX_CONF" <<CONF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
CONF

rm -f /etc/nginx/sites-enabled/default || true
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/simple-cloud-drive.conf
nginx -t
systemctl reload nginx

# ===== Issue certs & enable HTTPS redirect =====
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect -n

echo
echo "Done! Visit: https://$DOMAIN"
echo "Admin account: $ADMIN_USERNAME"
echo "Important: Change ADMIN_PASSWORD and JWT_SECRET in $APP_DIR/.env then: docker compose restart"


