#!/bin/bash
# Updates the droplet to the latest code of its branch. Run it on the droplet, as root:
#
#   bash /srv/cup/deploy/deploy.sh            from your computer: ssh root@<droplet> bash /srv/cup/deploy/deploy.sh
#   bash /srv/cup/deploy/deploy.sh --now      also restart the match server while a match is live
#
# The app restarts in a few seconds (pages carry on by themselves). The match server only
# restarts when its own code changed, and not while a match is live unless you add --now:
# a restart pauses the live match, which then carries on from its saved score. Run the
# script again after the match and it restarts the match server then.
set -euo pipefail
DIR=/srv/cup
MARK=/var/lib/cup/match-commit
NOW="${1:-}"
cd "$DIR"
G="sudo -u cup -H git"
before=$($G rev-parse HEAD)
$G pull --ff-only
after=$($G rev-parse HEAD)
if [ "$before" != "$after" ] || [ "$NOW" = "--rebuild" ]; then
  echo "== $before -> $after"
  sudo -u cup -H npm ci --no-audit --no-fund
  sudo -u cup -H npm run build
  systemctl restart cup-app
  echo "app restarted"
else
  echo "app up to date ($after)"
fi
running=$(cat "$MARK" 2>/dev/null || echo "$before")
if $G diff --quiet "$running" "$after" -- server lib/engine lib/ticket.ts lib/net package-lock.json 2>/dev/null; then
  echo "match server up to date"
  exit 0
fi
live=$(curl -fsS http://127.0.0.1:3001/health 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.matches.filter(m=>m.started&&!m.over).length)}catch{console.log(0)}})" || echo 0)
if [ "${live:-0}" != "0" ] && [ "$NOW" != "--now" ]; then
  echo "A match is live, so the match server was NOT restarted. Run this again after the match (or with --now)."
  exit 0
fi
systemctl restart cup-match
mkdir -p "$(dirname "$MARK")" && echo "$after" > "$MARK"
echo "match server restarted"
