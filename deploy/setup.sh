#!/bin/bash
# Sets up a fresh Ubuntu 24.04 droplet for The Coterie Cup. Run it once, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/BRANCH/deploy/setup.sh -o setup.sh
#   bash setup.sh cup.example.com https://github.com/OWNER/REPO.git BRANCH
#
# (or copy it over with scp). The domain is optional: without one the cup is served over
# plain HTTP on the droplet's address, which is fine for a test, not for the meeting.
# Installs Node 24, Redis, Caddy and the two services, builds the app and starts it all.
set -euo pipefail
DOMAIN="${1:-}"
REPO="${2:-https://github.com/nicolasdonagarcia/bueno-vamo-a-juga.git}"
BRANCH="${3:-main}"
DIR=/srv/cup

if [ "$(id -u)" != 0 ]; then echo "Run this as root." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https redis-server

echo "== Node.js 24 (NodeSource)"
if ! node -v 2>/dev/null | grep -q '^v24'; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
node -v

echo "== Caddy (its own repository)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== swap (a first build needs about 1.4 GB)"
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2500000 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Redis: on this machine only, saved to disk every second"
sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

echo "== the code, in $DIR"
id cup >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/cup --shell /usr/sbin/nologin cup
if [ ! -d "$DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
chown -R cup:cup "$DIR"

echo "== settings, in /etc/cup.env"
if [ ! -f /etc/cup.env ]; then
  cat > /etc/cup.env <<ENV
# The Coterie Cup. Both services read this; restart them after a change:
#   systemctl restart cup-app cup-match
REDIS_URL=redis://127.0.0.1:6379
MATCH_SECRET=$(openssl rand -hex 32)
MATCH_SERVER_URL=/ws
APP_URL=http://127.0.0.1:3000
ENV
  chmod 640 /etc/cup.env
  chown root:cup /etc/cup.env
fi

echo "== build"
cd "$DIR"
sudo -u cup -H npm ci --no-audit --no-fund
sudo -u cup -H npm run build

echo "== services"
cp deploy/cup-app.service deploy/cup-match.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cup-app cup-match
systemctl restart cup-app cup-match
mkdir -p /var/lib/cup && sudo -u cup -H git -C "$DIR" rev-parse HEAD > /var/lib/cup/match-commit

echo "== Caddy"
cp deploy/Caddyfile /etc/caddy/Caddyfile
if [ -n "$DOMAIN" ]; then echo "CUP_DOMAIN=$DOMAIN" > /etc/default/caddy; else echo "CUP_DOMAIN=:80" > /etc/default/caddy; fi
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/default/caddy\n' > /etc/systemd/system/caddy.service.d/cup.conf
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy

echo "== firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 3
echo
curl -fsS http://127.0.0.1:3001/health >/dev/null && echo "match server: up" || echo "match server: NOT answering (journalctl -u cup-match)"
curl -fsS -o /dev/null http://127.0.0.1:3000/ && echo "app: up" || echo "app: NOT answering (journalctl -u cup-app)"
echo
if [ -n "$DOMAIN" ]; then echo "Done: https://$DOMAIN (point its DNS A record at this droplet first)"; else echo "Done: http://$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | cut -d' ' -f1)"; fi
echo "Later updates: bash $DIR/deploy/deploy.sh"
